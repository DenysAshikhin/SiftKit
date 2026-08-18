import type { JsonObject } from './lib/json-types.js';
import { isRepoSearchCommandToolName } from './repo-search/planner-protocol.js';

type ToolLoopKind = 'repo-search' | 'planner' | 'chat' | 'repo-agent';

type SuccessfulToolCall = {
  toolName: string;
  promptResultText: string;
};

type EvaluateFinishAttemptOptions = {
  loopKind: ToolLoopKind;
  finalOutput: string;
  successfulToolCalls: SuccessfulToolCall[];
};

type FingerprintToolCallOptions = {
  toolName: string;
  command?: string;
  args?: JsonObject;
};

type BuildPromptToolResultOptions = {
  toolName: string;
  command?: string;
  exitCode?: number | null;
  rawOutput: string;
};

type BuildToolReplayFingerprintOptions = {
  toolName: string;
  promptResultText: string;
};

type FinishAttemptEvaluation = {
  allowed: boolean;
  warning: string | null;
};

type ToolResultNovelty = {
  evidenceKeys: string[];
  hasNewEvidence: boolean;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeEvidenceLine(line: string): string {
  return normalizeWhitespace(line).replace(/[\\/]+/gu, '/');
}

function stripLeadingSuccessExitCode(text: string): string {
  return String(text || '').replace(/^exit_code=0\s*\n?/u, '').trim();
}

function isHttpClientLogLine(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+http_client\b/u.test(line.trim());
}

/** Subcommands whose stdout is file content: blank lines are payload, not noise. */
const CONTENT_BEARING_GIT_SUBCOMMANDS = new Set(['show', 'cat-file']);

/** Global git flags that consume a separate value token (e.g. `git -C sub show ...`). */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--exec-path']);

function isContentBearingGitCommand(command: string): boolean {
  const tokens = normalizeWhitespace(String(command || '')).split(' ');
  if (tokens[0] !== 'git') {
    return false;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    return CONTENT_BEARING_GIT_SUBCOMMANDS.has(token);
  }
  return false;
}

/** `git` is the only repo tool whose call is a command string rather than typed args. */
function normalizeRepoSearchFingerprint(command: string): string {
  return normalizeWhitespace(String(command || '').toLowerCase());
}

function buildJsonFilterFingerprint(args: JsonObject): string {
  const filters = Array.isArray(args.filters)
    ? args.filters
      .filter((value): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      .map((filter) => ({
        path: String(filter.path || ''),
        op: String(filter.op || ''),
        value: JSON.stringify(filter.value ?? null),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const select = Array.isArray(args.select)
    ? args.select.filter((value): value is string => typeof value === 'string').slice().sort()
    : [];
  return JSON.stringify({
    tool: 'json_filter',
    collectionPath: typeof args.collectionPath === 'string' ? args.collectionPath : '',
    filters,
    select,
  });
}

function buildReadLinesFingerprint(args: JsonObject): string {
  const startLine = Math.max(1, Number(args.startLine) || 1);
  const endLine = Math.max(startLine, Number(args.endLine) || startLine);
  const midpoint = Math.floor((startLine + endLine) / 2);
  const size = endLine - startLine + 1;
  return `read_lines:${size <= 120 ? 'small' : 'large'}:${Math.floor(midpoint / 100)}`;
}

export function fingerprintToolCall(options: FingerprintToolCallOptions): string {
  if (isRepoSearchCommandToolName(options.toolName)) {
    return normalizeRepoSearchFingerprint(String(options.command || ''));
  }
  if (options.toolName === 'find_text') {
    const args = options.args || {};
    return JSON.stringify({
      tool: 'find_text',
      mode: args.mode === 'regex' ? 'regex' : 'literal',
      query: String(args.query || ''),
    });
  }
  if (options.toolName === 'json_filter') {
    return buildJsonFilterFingerprint(options.args || {});
  }
  if (options.toolName === 'read_lines') {
    return buildReadLinesFingerprint(options.args || {});
  }
  return JSON.stringify({
    tool: options.toolName,
    command: normalizeWhitespace(String(options.command || '')),
    args: options.args || {},
  });
}

function extractEvidenceKeys(promptResultText: string): string[] {
  const lines = String(promptResultText || '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isHttpClientLogLine(line))
    .filter((line) => !/^exit_code=\d+$/iu.test(line))
    .filter((line) => !/^(read_lines|find_text|json_filter)\b.*=/iu.test(line))
    .filter((line) => !/^error:\srequested output would consume/iu.test(line));
  if (lines.length === 0) {
    return [];
  }
  return Array.from(new Set(lines.map(normalizeEvidenceLine)));
}

/**
 * The novelty of one executed tool call. An empty output carries no anchors and so cannot be
 * novel — reporting it as new evidence hides a stalling planner from the no-new-evidence counter.
 */
export function classifyToolOutputNovelty(options: {
  baseOutput: string;
  promptResultText: string;
  recentEvidenceKeys: Set<string>;
}): ToolResultNovelty {
  if (options.baseOutput.length === 0) {
    return { evidenceKeys: [], hasNewEvidence: false };
  }
  const evidenceKeys = extractEvidenceKeys(options.promptResultText);
  return {
    evidenceKeys,
    hasNewEvidence: evidenceKeys.some((key) => !options.recentEvidenceKeys.has(key)),
  };
}

export function buildPromptToolResult(options: BuildPromptToolResultOptions): string {
  if (!isRepoSearchCommandToolName(options.toolName)) {
    return stripLeadingSuccessExitCode(String(options.rawOutput || '').trim());
  }
  const exitCode = Number(options.exitCode);
  const failed = Number.isFinite(exitCode) && exitCode !== 0;
  // Successful content-bearing commands (git show / cat-file) return the payload
  // verbatim apart from CRLF→LF: interior blank lines are part of the file, and
  // the direct-spawn git tool cannot emit http_client noise. Filtering stays for
  // log/status/branch, where blank lines are decoration.
  if (!failed && isContentBearingGitCommand(String(options.command || ''))) {
    return stripLeadingSuccessExitCode(String(options.rawOutput || '').replace(/\r\n/gu, '\n'));
  }
  const meaningfulLines = String(options.rawOutput || '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .filter((line) => !isHttpClientLogLine(line))
    .filter((line) => line.trim().length > 0);
  const trimmed = meaningfulLines.join('\n').trim();
  if (!trimmed) {
    if (failed) {
      return `exit_code=${exitCode}`;
    }
    return '';
  }
  if (failed) {
    if (new RegExp(`^exit_code=${exitCode}(?:\\s|$)`, 'u').test(trimmed)) {
      return trimmed;
    }
    return `exit_code=${exitCode}\n${trimmed}`.trim();
  }
  return stripLeadingSuccessExitCode(trimmed);
}

export function buildToolReplayFingerprint(options: BuildToolReplayFingerprintOptions): string {
  return `${String(options.toolName || '').trim().toLowerCase()}|${normalizeEvidenceLine(String(options.promptResultText || ''))}`;
}

export function buildRepeatedToolCallSummary(_toolName: string, repeatCount: number): string {
  const normalizedRepeatCount = Math.max(2, Math.floor(Number(repeatCount) || 2));
  return `duplicate command requested x${normalizedRepeatCount}. Issue a different/unique tool call`;
}

export function evaluateFinishAttempt(options: EvaluateFinishAttemptOptions): FinishAttemptEvaluation {
  if (options.loopKind !== 'repo-search') {
    return { allowed: true, warning: null };
  }
  const outputHasAnchors = /(?:^|[\s(])[\w./\\-]+\.\w+:\d+/u.test(options.finalOutput);
  const supportedCalls = options.successfulToolCalls.filter(
    (call) => extractEvidenceKeys(call.promptResultText).length > 0,
  );
  if (!outputHasAnchors || supportedCalls.length === 0) {
    return { allowed: true, warning: null };
  }
  if (supportedCalls.length >= 2) {
    return { allowed: true, warning: null };
  }
  if (supportedCalls.length === 1) {
    return {
      allowed: false,
      warning: 'Need one corroborating read or second supporting search before finishing.',
    };
  }
  return {
    allowed: false,
    warning: 'No repository evidence yet. Run a targeted search or read a supporting file section before finishing.',
  };
}
