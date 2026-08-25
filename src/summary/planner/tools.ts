import { getErrorMessage } from '../../lib/errors.js';
import type { JsonObject, JsonValue, OptionalJsonValue } from '../../lib/json-types.js';
import {
  SUMMARY_PLANNER_TOOL_NAMES,
  SummaryNativeToolCallSchema,
  type FindTextToolArgs,
  type JsonFilterToolArgs,
  type JsonGetToolArgs,
  type ReadLinesToolArgs,
  type SummaryPlannerToolName as PlannerToolName,
} from '../../planner-protocol/summary-tools.js';
import {
  formatCompactJsonBlock,
  formatNumberedLineBlock,
  formatPlannerResult,
  formatPlannerToolResultHeader,
  formatPlannerToolResultTokenGuardError,
  truncatePlannerText,
} from './formatters.js';
import {
  getRecord,
  getValueByPath,
  matchesJsonFilter,
  normalizeJsonFilterFilters,
  parseJsonForJsonFilter,
  projectJsonFilterItem,
} from './json-filter.js';

// Re-export formatters so callers can pick them up without importing from
// planner/formatters directly.
export {
  formatCompactJsonBlock,
  formatNumberedLineBlock,
  formatPlannerResult,
  formatPlannerToolResultHeader,
  formatPlannerToolResultTokenGuardError,
  truncatePlannerText,
};

// Planner tool executors always return a `text` rendering plus tool-specific
// metadata fields. The JsonValue index signature keeps the type a structural
// JsonObject so results flow into JSON surfaces (debug logs, prompt rendering)
// with no cast; per-tool metadata fields are read back via the index signature.
export interface PlannerToolResult {
  text: string;
  [key: string]: JsonValue;
}

function isRegexCharEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

export function escapeUnescapedRegexBraces(query: string): string {
  let normalized = '';
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if ((char === '{' || char === '}') && !isRegexCharEscaped(query, index)) {
      normalized += `\\${char}`;
      continue;
    }
    normalized += char;
  }
  return normalized;
}

type JsonFilterCollectionCandidate = {
  path: string;
  collection: JsonValue[];
  sampleKeys: string[];
};

function getJsonFilterCollectionCandidates(parsed: OptionalJsonValue): JsonFilterCollectionCandidate[] {
  const parsedRecord = getRecord(parsed);
  if (!parsedRecord) {
    return [];
  }

  return Object.entries(parsedRecord)
    .filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]))
    .map(([path, collection]) => {
      const firstRecord = collection.map((item) => getRecord(item)).find(Boolean);
      return {
        path,
        collection,
        sampleKeys: firstRecord ? Object.keys(firstRecord) : [],
      };
    });
}

function getJsonFilterPathHints(args: JsonFilterToolArgs): string[] {
  const hints = new Set<string>();
  const addHint = (value: OptionalJsonValue) => {
    if (typeof value !== 'string') {
      return;
    }
    const segment = value.split('.').map((part) => part.trim()).find(Boolean);
    if (segment) {
      hints.add(segment);
    }
  };

  for (const filter of args.filters) {
    addHint(filter.path);
  }
  for (const path of args.select ?? []) {
    addHint(path);
  }

  return Array.from(hints);
}

function selectJsonFilterCollectionCandidate(
  candidates: JsonFilterCollectionCandidate[],
  args: JsonFilterToolArgs,
): JsonFilterCollectionCandidate | null {
  if (candidates.length === 1) {
    return candidates[0];
  }

  const pathHints = getJsonFilterPathHints(args);
  if (pathHints.length === 0) {
    return null;
  }

  const ranked = candidates.map((candidate) => ({
    candidate,
    score: pathHints.reduce((count, hint) => (
      candidate.sampleKeys.includes(hint) ? count + 1 : count
    ), 0),
  }));
  const bestScore = Math.max(...ranked.map((entry) => entry.score));
  if (bestScore <= 0) {
    return null;
  }

  const bestMatches = ranked.filter((entry) => entry.score === bestScore);
  return bestMatches.length === 1 ? bestMatches[0].candidate : null;
}

function buildJsonFilterCollectionPathGuidanceResult(options: {
  collectionPath: string;
  candidates: JsonFilterCollectionCandidate[];
  error: string;
}): PlannerToolResult {
  const candidatePaths = options.candidates.map((candidate) => candidate.path);
  const guidance = candidatePaths.length > 0
    ? `Candidate collectionPath values: ${candidatePaths.join(', ')}.`
    : 'No top-level array collectionPath candidates were found.';
  return {
    tool: 'json_filter',
    collectionPath: options.collectionPath || '$',
    matchedCount: 0,
    candidateCollectionPaths: candidatePaths,
    error: `${options.error} ${guidance}`.trim(),
    text: `${options.error} ${guidance}`.trim(),
  };
}

function resolveJsonFilterCollection(
  parsed: OptionalJsonValue,
  args: JsonFilterToolArgs,
): { collectionPath: string; collection: JsonValue[] } | { recoverableResult: PlannerToolResult } {
  const collectionPath = args.collectionPath?.trim() ?? '';
  if (collectionPath) {
    const collection = getValueByPath(parsed, collectionPath);
    if (Array.isArray(collection)) {
      return { collectionPath, collection };
    }

    const candidates = getJsonFilterCollectionCandidates(parsed);
    if (candidates.length > 0) {
      return {
        recoverableResult: buildJsonFilterCollectionPathGuidanceResult({
          collectionPath,
          candidates,
          error: `json_filter collectionPath "${collectionPath}" is not an array.`,
        }),
      };
    }

    throw new Error(`json_filter collectionPath "${collectionPath}" is not an array.`);
  }

  if (Array.isArray(parsed)) {
    return { collectionPath: '$', collection: parsed };
  }

  const candidates = getJsonFilterCollectionCandidates(parsed);
  const selectedCandidate = selectJsonFilterCollectionCandidate(candidates, args);
  if (selectedCandidate) {
    return {
      collectionPath: selectedCandidate.path,
      collection: selectedCandidate.collection,
    };
  }

  if (candidates.length > 0) {
    return {
      recoverableResult: buildJsonFilterCollectionPathGuidanceResult({
        collectionPath: '$',
        candidates,
        error: 'json_filter collection is not an array.',
      }),
    };
  }

  throw new Error('json_filter collection is not an array.');
}

function executeFindTextTool(inputText: string, args: FindTextToolArgs): PlannerToolResult {
  const { query, mode } = args;
  const maxHits = args.maxHits ?? 5;
  const contextLines = args.contextLines ?? 0;
  const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
  let matcher: RegExp | null = null;
  const literalQuery = query.toLowerCase();
  let normalizedQuery: string | null = null;
  if (mode === 'regex') {
    try {
      matcher = new RegExp(query, 'iu');
    } catch (error) {
      const escapedBraceQuery = escapeUnescapedRegexBraces(query);
      if (escapedBraceQuery !== query) {
        try {
          matcher = new RegExp(escapedBraceQuery, 'iu');
          normalizedQuery = escapedBraceQuery;
        } catch {
          // Preserve original parser error below when fallback still fails.
        }
      }
      if (!matcher) {
        const errorText = `find_text invalid regex: ${getErrorMessage(error)}.`;
        return {
          tool: 'find_text',
          mode,
          query,
          hitCount: 0,
          error: errorText,
          text: errorText,
        };
      }
    }
  }
  const hitBlocks: string[] = [];
  let hitCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matched = mode === 'literal'
      ? line.toLowerCase().includes(literalQuery)
      : Boolean(matcher?.test(line));
    if (!matched) {
      continue;
    }

    hitCount += 1;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    if (hitBlocks.length < maxHits) {
      hitBlocks.push(formatNumberedLineBlock(lines.slice(start, end + 1), start + 1));
    }
  }

  return {
    tool: 'find_text',
    mode,
    query,
    normalizedQuery,
    hitCount,
    returnedHits: hitBlocks.length,
    truncated: hitCount > hitBlocks.length,
    text: hitBlocks.join('\n\n'),
  };
}

function executeReadLinesTool(inputText: string, args: ReadLinesToolArgs): PlannerToolResult {
  const { startLine, endLine } = args;
  const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
  const clampedStart = Math.min(startLine, lines.length || 1);
  const clampedEnd = Math.min(endLine, lines.length || clampedStart);
  const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
  return {
    tool: 'read_lines',
    startLine: clampedStart,
    endLine: clampedEnd,
    lineCount: selectedLines.length,
    text: formatNumberedLineBlock(selectedLines, clampedStart),
  };
}

function executeJsonFilterTool(inputText: string, args: JsonFilterToolArgs): PlannerToolResult {
  const parsedContext = parseJsonForJsonFilter(inputText);
  const parsed = parsedContext.parsed;
  const filters = normalizeJsonFilterFilters(args.filters);

  const resolvedCollection = resolveJsonFilterCollection(parsed, args);
  if ('recoverableResult' in resolvedCollection) {
    return {
      ...resolvedCollection.recoverableResult,
      usedFallback: parsedContext.usedFallback,
      ignoredPrefixPreview: parsedContext.usedFallback ? parsedContext.ignoredPrefixPreview : null,
      parsedSectionPreview: parsedContext.usedFallback ? parsedContext.parsedSectionPreview : null,
    };
  }
  const { collectionPath, collection } = resolvedCollection;

  const select = args.select ?? null;
  const limit = args.limit ?? 10;
  const matches: JsonValue[] = [];
  for (const item of collection) {
    if (!filters.every((filter) => matchesJsonFilter(item, filter))) {
      continue;
    }

    matches.push(projectJsonFilterItem(item, select) ?? null);
    if (matches.length >= limit) {
      break;
    }
  }

  return {
    tool: 'json_filter',
    collectionPath: collectionPath || '$',
    matchedCount: matches.length,
    usedFallback: parsedContext.usedFallback,
    ignoredPrefixPreview: parsedContext.usedFallback ? parsedContext.ignoredPrefixPreview : null,
    parsedSectionPreview: parsedContext.usedFallback ? parsedContext.parsedSectionPreview : null,
    text: formatCompactJsonBlock(matches),
  };
}

function executeJsonGetTool(inputText: string, args: JsonGetToolArgs): PlannerToolResult {
  const path = args.path.trim();

  const parsedContext = parseJsonForJsonFilter(inputText);
  const value = getValueByPath(parsedContext.parsed, path);
  const found = value !== undefined;

  return {
    tool: 'json_get',
    path,
    found,
    usedFallback: parsedContext.usedFallback,
    ignoredPrefixPreview: parsedContext.usedFallback ? parsedContext.ignoredPrefixPreview : null,
    parsedSectionPreview: parsedContext.usedFallback ? parsedContext.parsedSectionPreview : null,
    text: found ? JSON.stringify(value) : `json_get path not found: ${path}`,
  };
}

export function executePlannerTool(
  inputText: string,
  action: { toolName: PlannerToolName; args: JsonObject },
  allowedTools: readonly PlannerToolName[] = SUMMARY_PLANNER_TOOL_NAMES,
): PlannerToolResult {
  const parsed = SummaryNativeToolCallSchema.parse({
    toolName: action.toolName,
    args: action.args,
  });
  if (!allowedTools.includes(parsed.toolName)) {
    throw new Error(`Planner tool is not allowed by the active preset: ${parsed.toolName}`);
  }
  switch (parsed.toolName) {
    case 'find_text':
      return executeFindTextTool(inputText, parsed.args);
    case 'read_lines':
      return executeReadLinesTool(inputText, parsed.args);
    case 'json_filter':
      return executeJsonFilterTool(inputText, parsed.args);
    case 'json_get':
      return executeJsonGetTool(inputText, parsed.args);
  }
}
