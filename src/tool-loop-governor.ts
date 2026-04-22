type ToolLoopKind = 'repo-search' | 'planner';

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
  args?: Record<string, unknown>;
};

type ClassifyToolResultNoveltyOptions = {
  promptResultText: string;
  recentEvidenceKeys: Set<string>;
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

function isNegativeGlobToken(token: string): boolean {
  return /^["']?!/u.test(token) || /^![^\s]+/u.test(token);
}

function normalizeRepoSearchFingerprint(command: string): string {
  let normalized = normalizeWhitespace(String(command || '').toLowerCase());
  normalized = normalized.replace(/\s--no-ignore\b/gu, '');
  normalized = normalized.replace(/\s(?:--glob|-g)\s+(?:"![^"]*"|'![^']*'|![^\s]+)/gu, '');
  return normalizeWhitespace(normalized);
}

function isRepoSearchCommandTool(toolName: string): boolean {
  const normalized = String(toolName || '').trim().toLowerCase();
  return normalized === 'run_repo_cmd' || normalized.startsWith('repo_');
}

function buildJsonFilterFingerprint(args: Record<string, unknown>): string {
  const filters = Array.isArray(args.filters)
    ? args.filters
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
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

function buildReadLinesFingerprint(args: Record<string, unknown>): string {
  const startLine = Math.max(1, Number(args.startLine) || 1);
  const endLine = Math.max(startLine, Number(args.endLine) || startLine);
  const midpoint = Math.floor((startLine + endLine) / 2);
  const size = endLine - startLine + 1;
  return `read_lines:${size <= 120 ? 'small' : 'large'}:${Math.floor(midpoint / 100)}`;
}

export function fingerprintToolCall(options: FingerprintToolCallOptions): string {
  if (isRepoSearchCommandTool(options.toolName)) {
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
    .filter((line) => !/^note:/iu.test(line))
    .filter((line) => !/^exit_code=\d+$/iu.test(line))
    .filter((line) => !/^(read_lines|find_text|json_filter)\b.*=/iu.test(line))
    .filter((line) => !/^error:\srequested output would consume/iu.test(line));
  if (lines.length === 0) {
    return [];
  }
  return Array.from(new Set(lines.map(normalizeEvidenceLine)));
}

export function classifyToolResultNovelty(options: ClassifyToolResultNoveltyOptions): ToolResultNovelty {
  const evidenceKeys = extractEvidenceKeys(options.promptResultText);
  return {
    evidenceKeys,
    hasNewEvidence: evidenceKeys.some((key) => !options.recentEvidenceKeys.has(key)),
  };
}

export function buildPromptToolResult(options: BuildPromptToolResultOptions): string {
  if (!isRepoSearchCommandTool(options.toolName)) {
    return stripLeadingSuccessExitCode(String(options.rawOutput || '').trim());
  }
  const meaningfulLines = String(options.rawOutput || '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .filter((line) => !/^note:/iu.test(line.trim()))
    .filter((line) => line.trim().length > 0);
  const trimmed = meaningfulLines.join('\n').trim();
  const exitCode = Number(options.exitCode);
  if (!trimmed) {
    if (Number.isFinite(exitCode) && exitCode !== 0) {
      return `exit_code=${exitCode}`;
    }
    return '';
  }
  if (Number.isFinite(exitCode) && exitCode !== 0) {
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
