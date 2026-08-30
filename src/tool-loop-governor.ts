import type { JsonObject } from './lib/json-types.js';
import type { GitToolArgs } from './repo-search/repo-tool-arguments.js';

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
  args?: JsonObject;
  exitCode?: number | null;
  /** Command output only. Callers must not prepend an `exit_code=` line — this function adds it. */
  output: string;
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

function isHttpClientLogLine(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+http_client\b/u.test(line.trim());
}

/**
 * A unified diff carries blank context lines as payload: dropping them desynchronizes the hunk
 * body from its own `@@ -a,b +c,d @@` line counts, so any file:line the model derives is wrong.
 * Detected by shape rather than by subcommand so `diff`, `log -p`, `format-patch --stdout`,
 * `range-diff`, and `stash show -p` are all covered by one rule.
 */
const UNIFIED_DIFF_MARKER = /^(?:diff --git |@@ .+ @@)/mu;

function containsUnifiedDiff(output: string): boolean {
  return UNIFIED_DIFF_MARKER.test(output);
}

function isContentBearingGitCall(args: GitToolArgs): boolean {
  return args.operation === 'show';
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
  if (options.toolName === 'git') {
    throw new Error('Invalid Git tool call: use fingerprintGitToolCall with typed arguments.');
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

export function fingerprintGitToolCall(args: GitToolArgs): string {
  return JSON.stringify({
    toolName: 'git',
    args: Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right))),
  });
}

function extractEvidenceKeys(promptResultText: string): string[] {
  const lines = String(promptResultText || '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isHttpClientLogLine(line))
    .filter((line) => !/^exit_code=\d+(?: \(no output\))?$/iu.test(line))
    .filter((line) => !/^(read_lines|find_text|json_filter)\b.*=/iu.test(line));
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

function filterDecorativeLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !isHttpClientLogLine(line))
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

export function buildPromptToolResult(options: BuildPromptToolResultOptions): string {
  const body = String(options.output || '').replace(/\r\n/gu, '\n');
  if (options.toolName === 'git') {
    throw new Error('Invalid Git tool call: use buildGitPromptToolResult with typed arguments.');
  }
  return body.trim();
}

export function buildGitPromptToolResult(options: {
  args: GitToolArgs;
  exitCode?: number | null;
  output: string;
}): string {
  const body = String(options.output || '').replace(/\r\n/gu, '\n');
  const exitCode = Number(options.exitCode);
  const failed = Number.isFinite(exitCode) && exitCode !== 0;
  // Blank lines are payload for file content (git show / cat-file) and for unified diffs.
  // Everywhere else — log, status, branch — they are decoration and cost tokens.
  const preserveBlankLines = isContentBearingGitCall(options.args)
    || containsUnifiedDiff(body);
  const visible = preserveBlankLines ? body.trim() : filterDecorativeLines(body);
  if (!failed) {
    // An empty result must still say the command ran: on its own, the zero-output warning
    // reads as "nothing happened" rather than "this search legitimately matched nothing".
    return visible || 'exit_code=0 (no output)';
  }
  return visible ? `exit_code=${exitCode}\n${visible}` : `exit_code=${exitCode}`;
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
