import { getErrorMessage } from '../../lib/errors.js';
import type {
  PlannerToolCall,
  PlannerToolDefinition,
  PlannerToolName,
} from '../types.js';
import {
  formatCompactJsonBlock,
  formatNumberedLineBlock,
  formatPlannerResult,
  formatPlannerToolResultHeader,
  formatPlannerToolResultTokenGuardError,
  truncatePlannerText,
} from './formatters.js';
import {
  getFiniteInteger,
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

export function getPlannerToolName(value: unknown): PlannerToolName | null {
  return value === 'find_text' || value === 'read_lines' || value === 'json_filter'
    ? value
    : null;
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

export function buildPlannerToolDefinitions(allowedTools: readonly PlannerToolName[] = ['find_text', 'read_lines', 'json_filter']): PlannerToolDefinition[] {
  const allowed = new Set<PlannerToolName>(allowedTools);
  const definitions: PlannerToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'find_text',
        description: 'Search the input text for a literal string or regex and return matching lines with optional surrounding context. Regex patterns must be valid JavaScript regex source without surrounding slashes; do not escape ordinary quotes unless the regex itself requires it. Example: {"query":"Lumbridge","mode":"literal","maxHits":5,"contextLines":1}',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The literal text or regex pattern to search for.' },
            mode: { type: 'string', enum: ['literal', 'regex'], description: 'Whether query is treated as literal text or regex.' },
            maxHits: { type: 'integer', description: 'Maximum number of matching locations to return.' },
            contextLines: { type: 'integer', description: 'Number of surrounding lines to include before and after each hit.' },
          },
          required: ['query', 'mode'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_lines',
        description: 'Read a specific 1-based line range from the input text. Prefer larger contiguous windows after a find_text anchor; avoid many tiny adjacent slices unless verifying one exact line or symbol. Example: {"startLine":1340,"endLine":1405}',
        parameters: {
          type: 'object',
          properties: {
            startLine: { type: 'integer', description: 'Inclusive 1-based start line.' },
            endLine: { type: 'integer', description: 'Inclusive 1-based end line.' },
          },
          required: ['startLine', 'endLine'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'json_filter',
        description: 'Parse JSON, filter array items by field conditions, and project only the selected fields. Use collectionPath when the root JSON value is an object with an array under a child key; for example use {"collectionPath":"states","filters":[{"path":"timestamp","op":"gte","value":"2026-03-30T18:40:00Z"},{"path":"timestamp","op":"lte","value":"2026-03-30T18:50:00Z"}],"select":["timestamp","lifecycle_state","bridge_state","scenario_id","step_id","state_json"],"limit":100} for a root object with a states array. Use separate filters for gte/lte bounds; each filter value should be a single scalar value, not an object containing multiple operators. Do not use "value":{"gte":3200,"lte":3215}. Example: {"filters":[{"path":"from.worldX","op":"gte","value":3200},{"path":"from.worldX","op":"lte","value":3215}],"select":["id","label","from","to","bidirectional"],"limit":20}',
        parameters: {
          type: 'object',
          properties: {
            collectionPath: { type: 'string', description: 'Optional dot-path to the array collection. Omit for a root array.' },
            filters: {
              type: 'array',
              description: 'Field predicates applied to each item in the collection.',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  op: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] },
                  value: {},
                },
                required: ['path', 'op'],
              },
            },
            select: {
              type: 'array',
              description: 'Optional list of dot-path fields to project from each matched item.',
              items: { type: 'string' },
            },
            limit: { type: 'integer', description: 'Maximum number of matched items to return.' },
          },
          required: ['filters'],
        },
      },
    },
  ];
  return definitions.filter((definition) => allowed.has(definition.function.name));
}

function executeFindTextTool(inputText: string, args: Record<string, unknown>): Record<string, unknown> {
  const query = typeof args.query === 'string' ? args.query : '';
  const mode = args.mode === 'regex' ? 'regex' : args.mode === 'literal' ? 'literal' : null;
  if (!query.trim() || !mode) {
    throw new Error('find_text requires query and mode.');
  }

  const maxHits = Math.max(1, Math.min(getFiniteInteger(args.maxHits) ?? 5, 20));
  const contextLines = Math.max(0, Math.min(getFiniteInteger(args.contextLines) ?? 0, 3));
  const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
  let matcher: RegExp | null = null;
  let normalizedQuery: string | null = null;
  if (mode === 'regex') {
    try {
      matcher = new RegExp(query, 'u');
    } catch (error) {
      const escapedBraceQuery = escapeUnescapedRegexBraces(query);
      if (escapedBraceQuery !== query) {
        try {
          matcher = new RegExp(escapedBraceQuery, 'u');
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
      ? line.includes(query)
      : Boolean(matcher?.test(line));
    if (!matched) {
      continue;
    }

    hitCount += 1;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    hitBlocks.push(formatNumberedLineBlock(lines.slice(start, end + 1), start + 1));
    if (hitCount >= maxHits) {
      break;
    }
  }

  return {
    tool: 'find_text',
    mode,
    query,
    normalizedQuery,
    hitCount,
    text: hitBlocks.join('\n\n'),
  };
}

function executeReadLinesTool(inputText: string, args: Record<string, unknown>): Record<string, unknown> {
  const startLine = Math.max(getFiniteInteger(args.startLine) ?? 1, 1);
  const endLine = Math.max(getFiniteInteger(args.endLine) ?? startLine, startLine);
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

function executeJsonFilterTool(inputText: string, args: Record<string, unknown>): Record<string, unknown> {
  const parsedContext = parseJsonForJsonFilter(inputText);
  const parsed = parsedContext.parsed;
  const filters = Array.isArray(args.filters)
    ? normalizeJsonFilterFilters(args.filters.map((item) => getRecord(item)).filter(Boolean) as Record<string, unknown>[])
    : [];
  if (filters.length === 0) {
    throw new Error('json_filter requires at least one filter.');
  }

  const collectionPath = typeof args.collectionPath === 'string' ? args.collectionPath : '';
  const collection = collectionPath ? getValueByPath(parsed, collectionPath) : parsed;
  if (!Array.isArray(collection)) {
    throw new Error('json_filter collection is not an array.');
  }

  const select = Array.isArray(args.select)
    ? args.select.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : null;
  const limit = Math.max(1, Math.min(getFiniteInteger(args.limit) ?? 10, 50));
  const matches: unknown[] = [];
  for (const item of collection) {
    if (!filters.every((filter) => matchesJsonFilter(item, filter))) {
      continue;
    }

    matches.push(projectJsonFilterItem(item, select));
    if (matches.length >= limit) {
      break;
    }
  }

  return {
    tool: 'json_filter',
    collectionPath: collectionPath || '$',
    matchedCount: matches.length,
    usedFallback: parsedContext.usedFallback,
    ignoredPrefixPreview: parsedContext.usedFallback ? parsedContext.ignoredPrefixPreview : undefined,
    parsedSectionPreview: parsedContext.usedFallback ? parsedContext.parsedSectionPreview : undefined,
    text: formatCompactJsonBlock(matches),
  };
}

export function executePlannerTool(
  inputText: string,
  action: PlannerToolCall,
  allowedTools: readonly PlannerToolName[] = ['find_text', 'read_lines', 'json_filter'],
): Record<string, unknown> {
  if (!allowedTools.includes(action.tool_name)) {
    throw new Error(`Planner tool is not allowed by the active preset: ${action.tool_name}`);
  }
  switch (action.tool_name) {
    case 'find_text':
      return executeFindTextTool(inputText, action.args);
    case 'read_lines':
      return executeReadLinesTool(inputText, action.args);
    case 'json_filter':
      return executeJsonFilterTool(inputText, action.args);
    default:
      throw new Error(`Unsupported planner tool: ${String(action.tool_name)}`);
  }
}
