import { createHash } from 'node:crypto';
import { existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { z } from 'zod';
import { type IgnorePolicy } from '../command-safety.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import { findContiguousUnreadRange, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.js';
import { buildReadPathKey, getOrCreateFileReadState, type FileReadState } from './read-overlap.js';
import { parseJsonValueText } from '../../lib/json.js';
import { applyEolStyle, detectEolStyle, readSourceText, readTextFileWithEncoding } from '../../lib/text-encoding.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import type { ToolTranscriptAction } from '../../tool-call-messages.js';
import { spawnDirectCommand } from '../../lib/command-spawn.js';
import { AGENT_RUN_ID_ENV } from '../../lib/agent-run-marker.js';
import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../../lib/powershell.js';
import type {
  EditToolArgs,
  FindToolArgs,
  GrepToolArgs,
  LsToolArgs,
  RepoNativeToolCall,
  RunToolArgs,
  WriteToolArgs,
} from '../repo-tool-arguments.js';
import { GitToolArgsSchema } from '../repo-tool-arguments.js';
import { ReadOnlyGitTool, buildReadOnlyGitCommand } from './read-only-git-tool.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { ImageDataUrl, ImageMetadata, ImageTokenBudget } from '@siftkit/contracts';
import { isImagePath } from '../../llm-protocol/image-attachments.js';
import { executeImageRead } from './image-read.js';
import { isRepoRelativePathIgnored, resolveRepoScopedPath, toPosixPath } from './repo-paths.js';

export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;
export const LS_DEFAULT_LIMIT = 500;
export const READ_MAX_BYTES = 2_000_000;

export type RepoToolExecution =
  | {
    ok: true;
    requestedCommand?: string;
    command: string;
    exitCode: number;
    output: string;
    toolType: string;
    readFile?: {
      commandPath: string;
      pathKey: string;
      displayPath: string;
      startLine: number;
      endLineExclusive: number;
      totalEndLineExclusive: number;
      hasUnread: boolean;
    };
    /**
     * Repository-relative path a mutating tool wrote to, with its on-disk casing preserved. The
     * caller folds it into a read-window key and reports it as the file the run changed.
     */
    mutatedPath?: string;
    outputUnit?: ToolOutputTruncationUnit;
    // Which end survives per-tool truncation. Omitted → 'head'. Command output
    // (`run`) sets 'tail' so the trailing summary/errors survive.
    outputKeep?: ToolOutputKeep;
    lineReadStats?: {
      lineReadCalls: number;
      lineReadLinesTotal: number;
      lineReadTokensTotal: number;
    };
    /** Set by an image `read`; the engine appends this as a user-role message after the tool result. */
    imageDataUrl?: ImageDataUrl;
    imageMetadata?: ImageMetadata;
    /** Path key of the image, so the caller can track what is live in context. */
    imagePathKey?: string;
  }
  | {
    ok: false;
    command: string;
    reason: string;
    toolType: string;
  };

export type RepoToolContext = {
  repoRoot: string;
  ignorePolicy: IgnorePolicy;
  webTools: WebResearchTools;
  fileReadStateByPath?: Map<string, FileReadState>;
  abortSignal?: AbortSignal;
  expandReads: boolean;
  agentRunId: string;
  visionEnabled: boolean;
  /** 0 refuses images on every path, including this one. -1 is unbounded. */
  visionImageRetention: number;
  /** User pixel cap from Task 8b; 0 means the model ceiling is the only limit. */
  visionMaxImagePixels: number;
  imageTokenBudget: ImageTokenBudget;
  /** Path keys of images currently live in the transcript. */
  liveImagePathKeys: Set<string>;
};

export type ReadPlan = {
  requestedCommand: string;
  commandPath: string;
  requestedStartLine: number;
  requestedEndLine: number;
  effectiveStartLine: number;
  effectiveEndLineExclusive: number;
  totalEndLineExclusive: number;
  pathKey: string;
  displayPath: string;
  lines: string[];
  hasUnread: boolean;
  noUnreadOutput: string | null;
};

type FailedPlan = { ok: false; command: string; reason: string };

export function isFailedReadPlan(plan: ReadPlan | FailedPlan): plan is FailedPlan {
  return 'ok' in plan && plan.ok === false;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const PositiveIntegerSchema = z.number().int().positive().finite();
type PositiveInteger = z.infer<typeof PositiveIntegerSchema>;

function readString(value: OptionalJsonValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value: OptionalJsonValue): PositiveInteger | undefined {
  const parsed = PositiveIntegerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resolvePositiveInteger(
  value: OptionalJsonValue,
  fallback: PositiveInteger,
  reason: string,
): PositiveInteger | string {
  if (value === undefined) {
    return fallback;
  }
  return parsePositiveInteger(value) ?? reason;
}

function resolveOptionalPositiveInteger(
  value: OptionalJsonValue,
  reason: string,
): PositiveInteger | undefined | string {
  if (value === undefined) {
    return undefined;
  }
  return parsePositiveInteger(value) ?? reason;
}

function readBoolean(value: OptionalJsonValue, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Synthetic command strings — the dedup / transcript / progress key for a call
// ---------------------------------------------------------------------------

type CommandArg = [key: string, value: string | number | boolean | undefined];

function formatToolCommand(toolName: string, args: CommandArg[]): string {
  const parts = args
    .filter((arg): arg is [string, string | number | boolean] => arg[1] !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  return [toolName, ...parts].join(' ');
}

function rawString(value: OptionalJsonValue): string {
  return typeof value === 'string' ? value : '';
}

function shortSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10);
}

/** Order-stable digest over the (oldText, newText) pairs so key order in the model's JSON cannot split fingerprints. */
function editContentDigest(edits: OptionalJsonValue): string {
  const pairs = Array.isArray(edits)
    ? edits.map((edit) => (
      edit !== null && typeof edit === 'object' && !Array.isArray(edit)
        ? [rawString(edit.oldText), rawString(edit.newText)]
        : []
    ))
    : [];
  return shortSha256(JSON.stringify(pairs));
}

export function buildReadCommand(pathText: string, offset: PositiveInteger, limit?: PositiveInteger): string {
  return formatToolCommand('read', [
    ['path', pathText],
    ['offset', offset],
    ['limit', limit],
  ]);
}

function optionalBoolean(value: OptionalJsonValue): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalString(value: OptionalJsonValue): string | undefined {
  const text = readString(value);
  return text ? text : undefined;
}

export function buildRepoToolRequestedCommand(toolName: string, args: JsonObject): string {
  if (toolName === 'read') {
    return buildReadCommand(
      readString(args.path),
      parsePositiveInteger(args.offset) ?? 1,
      parsePositiveInteger(args.limit),
    );
  }
  if (toolName === 'grep') {
    return formatToolCommand('grep', [
      ['pattern', readString(args.pattern)],
      ['path', optionalString(args.path)],
      ['glob', optionalString(args.glob)],
      ['ignoreCase', optionalBoolean(args.ignoreCase)],
      ['literal', optionalBoolean(args.literal)],
      ['context', parsePositiveInteger(args.context)],
      ['limit', parsePositiveInteger(args.limit)],
    ]);
  }
  if (toolName === 'find') {
    return formatToolCommand('find', [
      ['pattern', readString(args.pattern)],
      ['path', optionalString(args.path)],
      ['limit', parsePositiveInteger(args.limit)],
    ]);
  }
  if (toolName === 'ls') {
    return formatToolCommand('ls', [
      ['path', readString(args.path) || '.'],
      ['limit', parsePositiveInteger(args.limit)],
    ]);
  }
  if (toolName === 'write') {
    const content = rawString(args.content);
    return formatToolCommand('write', [
      ['path', readString(args.path)],
      ['bytes', Buffer.byteLength(content, 'utf8')],
      ['sha', shortSha256(content)],
    ]);
  }
  if (toolName === 'edit') {
    return formatToolCommand('edit', [
      ['path', readString(args.path)],
      ['edits', Array.isArray(args.edits) ? args.edits.length : 0],
      ['sha', editContentDigest(args.edits)],
    ]);
  }
  if (toolName === 'run') {
    return formatToolCommand('run', [
      ['command', readString(args.command)],
      ['outputMode', optionalString(args.outputMode)],
      ['timeoutMs', parsePositiveInteger(args.timeoutMs)],
    ]);
  }
  if (toolName === 'git') {
    return buildReadOnlyGitCommand(GitToolArgsSchema.parse(args));
  }
  if (toolName === 'web_search') {
    return formatToolCommand('web_search', [['query', readString(args.query)]]);
  }
  if (toolName === 'web_fetch') {
    return formatToolCommand('web_fetch', [['url', readString(args.url)]]);
  }
  return formatToolCommand(toolName, []);
}

export function buildNativeToolRequestedCommand(call: RepoNativeToolCall): string {
  if (call.toolName === 'git') {
    return buildReadOnlyGitCommand(call.args);
  }
  return buildRepoToolRequestedCommand(call.toolName, call.args);
}

function parseEffectiveReadArgs(command: string, fallbackArgs: JsonObject): JsonObject {
  const match = /^read path=("(?:(?:\\")|[^"])*"|\S+) offset=(\d+)(?: limit=(\d+))?/u.exec(command.trim());
  if (!match) {
    return fallbackArgs;
  }
  let pathText = readString(fallbackArgs.path);
  try {
    const parsedPath = parseJsonValueText(match[1]);
    pathText = typeof parsedPath === 'string' ? parsedPath : pathText;
  } catch {
    pathText = readString(fallbackArgs.path);
  }
  return {
    path: pathText,
    offset: Number.parseInt(match[2], 10),
    ...(match[3] ? { limit: Number.parseInt(match[3], 10) } : {}),
  };
}

export function buildEffectiveTranscriptAction(options: {
  toolName: string;
  rawArgs: JsonObject;
  commandToRun: string;
}): ToolTranscriptAction {
  if (options.toolName === 'read') {
    return { tool_name: options.toolName, args: parseEffectiveReadArgs(options.commandToRun, options.rawArgs) };
  }
  return { tool_name: options.toolName, args: options.rawArgs };
}

/**
 * Serialized-argument size above which a rejected call's arguments are dropped. A rejected call
 * has no downstream value, but its arguments are re-sent on every later turn; small payloads are
 * cheaper to keep than to describe.
 */
export const REJECTED_ARGS_ELISION_LIMIT = 512;

/**
 * Transcript action for a call that was rejected before execution. Identical to the effective
 * action while the payload is small, and an elision marker once it is not.
 */
export function buildRejectedTranscriptAction(options: {
  toolName: string;
  rawArgs: JsonObject;
  commandToRun: string;
}): ToolTranscriptAction {
  const effective = buildEffectiveTranscriptAction(options);
  const serializedLength = JSON.stringify(effective.args).length;
  if (serializedLength <= REJECTED_ARGS_ELISION_LIMIT) {
    return effective;
  }
  return {
    tool_name: effective.tool_name,
    args: {
      elided: `rejected ${effective.tool_name} call; ${serializedLength.toLocaleString('en-US')} chars of arguments discarded`,
    },
  };
}

function failure(toolType: string, command: string, reason: string): RepoToolExecution {
  return { ok: false, command, reason, toolType };
}

// ---------------------------------------------------------------------------
// Output ordering — find and ls must agree on it
// ---------------------------------------------------------------------------

function compareDisplayNames(left: string, right: string): number {
  return left.localeCompare(right);
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      // `**/` spans zero or more directories, so `**/name.md` also matches a
      // search-root `name.md`. A bare `**` stays a cross-separator wildcard.
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
        continue;
      }
      pattern += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    if ('\\.[]{}()+^$|'.includes(char)) {
      pattern += `\\${char}`;
      continue;
    }
    pattern += char;
  }
  pattern += '$';
  return new RegExp(pattern, 'iu');
}

function matchesGlob(relativePath: string, globText: string): boolean {
  const normalizedPath = toPosixPath(relativePath);
  const normalizedGlob = toPosixPath(globText.trim());
  if (!normalizedGlob) {
    return true;
  }
  const target = normalizedGlob.includes('/') ? normalizedPath : posix.basename(normalizedPath);
  return globToRegExp(normalizedGlob).test(target);
}

function listFilesRecursive(
  currentAbsolutePath: string,
  currentRelativePath: string,
  ignorePolicy: IgnorePolicy,
  includeFiles: string[],
): void {
  for (const entry of readdirSync(currentAbsolutePath, { withFileTypes: true })) {
    const nextRelativePath = currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name;
    if (isRepoRelativePathIgnored(nextRelativePath, ignorePolicy)) {
      continue;
    }
    const nextAbsolutePath = join(currentAbsolutePath, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(nextAbsolutePath, nextRelativePath, ignorePolicy, includeFiles);
      continue;
    }
    if (entry.isFile()) {
      includeFiles.push(toPosixPath(nextRelativePath));
    }
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** A trailing newline terminates the last line; it does not start an empty one after it. */
function splitSourceLines(text: string): string[] {
  const lines = text.split('\n');
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function formatNumberedTextBlock(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

export function planRead(
  args: JsonObject,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
  expandReads = true,
): ReadPlan | FailedPlan {
  const commandPath = readString(args.path);
  const requestedCommand = buildRepoToolRequestedCommand('read', args);
  const offset = resolvePositiveInteger(args.offset, 1, 'offset must be a positive integer');
  if (typeof offset === 'string') {
    return { ok: false, command: requestedCommand, reason: offset };
  }
  const limit = resolveOptionalPositiveInteger(args.limit, 'limit must be a positive integer');
  if (typeof limit === 'string') {
    return { ok: false, command: requestedCommand, reason: limit };
  }
  const resolvedPath = resolveRepoScopedPath(repoRoot, args.path);
  if (!resolvedPath) {
    return { ok: false, command: requestedCommand, reason: 'path must stay within the repository root' };
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, ignorePolicy)) {
    return { ok: false, command: requestedCommand, reason: 'path is ignored by runtime policy' };
  }
  if (!existsSync(resolvedPath.absolutePath)) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }
  const fileStat = statSync(resolvedPath.absolutePath);
  if (!fileStat.isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }
  if (fileStat.size > READ_MAX_BYTES) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `file is ${fileStat.size} bytes; read supports files up to ${READ_MAX_BYTES} bytes — use grep to extract the lines you need`,
    };
  }

  const lines = splitSourceLines(readSourceText(resolvedPath.absolutePath));
  if (offset > lines.length) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `offset ${offset} is past the end of ${resolvedPath.relativePath} (${lines.length} line${lines.length === 1 ? '' : 's'})`,
    };
  }
  const displayPath = resolvedPath.relativePath;
  const pathKey = buildReadPathKey(displayPath);
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = offset;
  const requestedEndExclusive = limit === undefined
    ? totalEndLineExclusive
    : Math.max(clampedStart + 1, Math.min(clampedStart + limit, totalEndLineExclusive));
  const state = fileReadStateByPath ? getOrCreateFileReadState(fileReadStateByPath, pathKey) : null;
  // Both modes skip lines already returned. expandReads decides only whether the window may run
  // past the requested limit to end of file.
  const returnedRanges = state?.mergedReturnedRanges ?? [];
  const hasReturnedRanges = returnedRanges.length > 0;
  const unreadRange = findContiguousUnreadRange({
    requestedStart: clampedStart,
    totalEnd: expandReads && hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive,
    returnedRanges,
  });

  return {
    requestedCommand,
    commandPath,
    requestedStartLine: clampedStart,
    requestedEndLine: requestedEndExclusive - 1,
    effectiveStartLine: unreadRange.start,
    effectiveEndLineExclusive: unreadRange.end,
    totalEndLineExclusive,
    pathKey,
    displayPath,
    lines,
    hasUnread: unreadRange.hasUnread,
    noUnreadOutput: unreadRange.hasUnread
      ? null
      : `Lines ${clampedStart}-${requestedEndExclusive - 1} of ${displayPath} were already returned in this run. Read a different range, or edit/write the file to re-read it.`,
  };
}

export function buildReadExecution(
  toolName: string,
  plan: ReadPlan,
): RepoToolExecution {
  const readFile = {
    commandPath: plan.commandPath,
    pathKey: plan.pathKey,
    displayPath: plan.displayPath,
    startLine: plan.effectiveStartLine,
    endLineExclusive: plan.hasUnread ? plan.effectiveEndLineExclusive : plan.effectiveStartLine,
    totalEndLineExclusive: plan.totalEndLineExclusive,
    hasUnread: plan.hasUnread,
  };
  if (!plan.hasUnread) {
    return {
      ok: true,
      requestedCommand: plan.requestedCommand,
      command: plan.requestedCommand,
      exitCode: 0,
      output: String(plan.noUnreadOutput || '').trim(),
      toolType: toolName,
      outputUnit: 'lines',
      readFile,
      lineReadStats: { lineReadCalls: 0, lineReadLinesTotal: 0, lineReadTokensTotal: 0 },
    };
  }

  const selectedLines = plan.lines.slice(plan.effectiveStartLine - 1, plan.effectiveEndLineExclusive - 1);
  return {
    ok: true,
    requestedCommand: plan.requestedCommand,
    command: buildReadCommand(
      plan.commandPath,
      plan.effectiveStartLine,
      plan.effectiveEndLineExclusive - plan.effectiveStartLine,
    ),
    exitCode: 0,
    output: formatNumberedTextBlock(selectedLines, plan.effectiveStartLine).trim(),
    toolType: toolName,
    outputUnit: 'lines',
    readFile,
    lineReadStats: {
      lineReadCalls: 1,
      lineReadLinesTotal: selectedLines.length,
      lineReadTokensTotal: Math.max(1, estimateTokenCount(undefined, selectedLines.join('\n'))),
    },
  };
}

// ---------------------------------------------------------------------------
// grep — argv is built here, never parsed from a model-authored string
// ---------------------------------------------------------------------------

function buildGrepArgs(
  args: JsonObject,
  ignorePolicy: IgnorePolicy,
  searchPath: string,
  contextLines: PositiveInteger | undefined,
): string[] {
  const argv = ['--no-ignore', '--line-number', '--with-filename', '--color', 'never'];
  argv.push(readBoolean(args.ignoreCase, true) ? '--ignore-case' : '--case-sensitive');
  if (readBoolean(args.literal, false)) {
    argv.push('--fixed-strings');
  }
  if (contextLines !== undefined) {
    argv.push('--context', String(contextLines));
  }
  const glob = optionalString(args.glob);
  if (glob !== undefined) {
    // --iglob matches find's case-insensitive glob regex, so one planner glob means one thing.
    argv.push('--iglob', glob);
  }
  // Parity with isRepoRelativePathIgnored: names are ignored case-insensitively and whether the
  // segment is a directory or a plain file; paths exclude the entry itself and its contents.
  for (const name of ignorePolicy.names) {
    argv.push('--iglob', `!**/${name}`, '--iglob', `!**/${name}/**`);
  }
  for (const ignoredPath of ignorePolicy.paths) {
    argv.push('--iglob', `!${ignoredPath}`, '--iglob', `!${ignoredPath}/**`);
  }
  argv.push('--regexp', readString(args.pattern), '--', searchPath);
  return argv;
}

const GREP_MATCH_LINE_PATTERN = /^.+?:\d+:/u;

/**
 * Applies `limit` to match lines only. With context enabled, rg interleaves `path-12-text`
 * context lines and `--` group separators; counting those as matches made the cap fire early and
 * the "more matches" figure wrong.
 */
function truncateGrepOutput(outputLines: string[], limit: number): string {
  let totalMatches = 0;
  let lastRetainedMatchIndex = -1;
  let cutIndex = -1;
  for (let index = 0; index < outputLines.length; index += 1) {
    if (!GREP_MATCH_LINE_PATTERN.test(outputLines[index])) {
      continue;
    }
    totalMatches += 1;
    if (totalMatches <= limit) {
      lastRetainedMatchIndex = index;
      continue;
    }
    if (cutIndex === -1) {
      const separatorIndex = outputLines.lastIndexOf('--', index - 1);
      cutIndex = separatorIndex > lastRetainedMatchIndex ? separatorIndex : index;
    }
  }
  if (cutIndex === -1) {
    return outputLines.join('\n');
  }
  return `${outputLines.slice(0, cutIndex).join('\n')}\n... ${totalMatches - limit} more matches beyond limit=${limit}; narrow the pattern, glob, or path.`;
}

async function executeGrep(args: GrepToolArgs, context: RepoToolContext): Promise<RepoToolExecution> {
  const command = buildRepoToolRequestedCommand('grep', args);
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, args.path ?? '.');
  if (!resolvedPath) {
    return failure('grep', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('grep', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath)) {
    return failure('grep', command, 'path is not a readable file or directory');
  }

  // The planner tool schema documents context's default as 0, so 0 must parse as "matches only".
  const contextLines = args.context === 0 ? undefined : args.context;
  const limit = args.limit ?? GREP_DEFAULT_LIMIT;
  const searchPath = resolvedPath.relativePath === '' ? '.' : resolvedPath.relativePath;
  const result = await spawnDirectCommand('rg', buildGrepArgs(args, context.ignorePolicy, searchPath, contextLines), {
    cwd: context.repoRoot,
    abortSignal: context.abortSignal,
  });
  // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
  if (result.exitCode >= 2) {
    return failure('grep', command, `rg failed: ${result.output || `exit ${result.exitCode}`}`);
  }
  const matchLines = result.stdout.split('\n').map((line) => line.replace(/\r$/u, '')).filter(Boolean);
  if (matchLines.length === 0) {
    return {
      ok: true, requestedCommand: command, command, exitCode: 0,
      output: 'No matches found.', toolType: 'grep', outputUnit: 'lines',
    };
  }
  const output = truncateGrepOutput(matchLines, limit);
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'grep', outputUnit: 'lines' };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

function executeFind(args: FindToolArgs, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('find', args);
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, args.path ?? '.');
  if (!resolvedPath) {
    return failure('find', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('find', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isDirectory()) {
    return failure('find', command, 'path is not a readable directory');
  }

  // The walk must carry repository-root-relative paths, because that is the frame
  // ignorePolicy.paths is written in. The glob and the output are search-directory
  // relative, so the base prefix comes back off before matching.
  const basePath = resolvedPath.relativePath;
  const repoRelativeFiles: string[] = [];
  listFilesRecursive(resolvedPath.absolutePath, basePath, context.ignorePolicy, repoRelativeFiles);
  const basePrefixLength = basePath ? basePath.length + 1 : 0;
  const filtered = repoRelativeFiles
    .map((repoRelativePath) => repoRelativePath.slice(basePrefixLength))
    .filter((searchRelativePath) => matchesGlob(searchRelativePath, args.pattern))
    .sort(compareDisplayNames);
  const limit = args.limit ?? FIND_DEFAULT_LIMIT;
  const truncated = filtered.length > limit;
  const output = filtered.length === 0
    ? 'No files matched.'
    : truncated
      ? `${filtered.slice(0, limit).join('\n')}\n... ${filtered.length - limit} more files beyond limit=${limit}; narrow the pattern or path.`
      : filtered.join('\n');
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'find', outputUnit: 'files' };
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function executeLs(args: LsToolArgs, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('ls', args);
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, args.path ?? '.');
  if (!resolvedPath) {
    return failure('ls', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('ls', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isDirectory()) {
    return failure('ls', command, 'path is not a readable directory');
  }

  const basePath = resolvedPath.relativePath;
  const entries: string[] = [];
  for (const entry of readdirSync(resolvedPath.absolutePath, { withFileTypes: true })) {
    const entryRelativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (isRepoRelativePathIgnored(entryRelativePath, context.ignorePolicy)) {
      continue;
    }
    entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }
  entries.sort(compareDisplayNames);
  const limit = args.limit ?? LS_DEFAULT_LIMIT;
  const truncated = entries.length > limit;
  const output = entries.length === 0
    ? 'Directory is empty.'
    : truncated
      ? `${entries.slice(0, limit).join('\n')}\n... ${entries.length - limit} more entries beyond limit=${limit}.`
      : entries.join('\n');
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'ls', outputUnit: 'files' };
}

// ---------------------------------------------------------------------------
// write / edit / run — implemented and tested, never exposed to the model.
// See EXPOSED_REPO_TOOL_NAMES in planner-protocol.ts.
// ---------------------------------------------------------------------------

function executeWrite(args: WriteToolArgs, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('write', args);
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, args.path);
  if (!resolvedPath) {
    return failure('write', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('write', command, 'path is ignored by runtime policy');
  }
  mkdirSync(dirname(resolvedPath.absolutePath), { recursive: true });
  // Overwriting an existing uniformly-CRLF file keeps its endings; new files and
  // mixed/LF files are written exactly as the model composed them (LF).
  const overwriteTarget = existsSync(resolvedPath.absolutePath) && statSync(resolvedPath.absolutePath).isFile()
    ? readTextFileWithEncoding(resolvedPath.absolutePath)
    : null;
  const finalContent = overwriteTarget === null
    ? args.content
    : applyEolStyle(args.content, detectEolStyle(overwriteTarget));
  writeFileSync(resolvedPath.absolutePath, finalContent, 'utf8');
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Wrote ${Buffer.byteLength(finalContent, 'utf8')} bytes to ${resolvedPath.relativePath}.`,
    toolType: 'write', outputUnit: 'lines',
    mutatedPath: resolvedPath.relativePath,
  };
}

type ResolvedEdit = { start: number; end: number; newText: string };

function resolveEdits(originalText: string, rawEdits: EditToolArgs['edits']): ResolvedEdit[] | string {
  const resolved: ResolvedEdit[] = [];
  for (const rawEdit of rawEdits) {
    const { oldText, newText } = rawEdit;
    const start = originalText.indexOf(oldText);
    if (start < 0) {
      return `oldText not found in file: ${JSON.stringify(oldText.slice(0, 60))}`;
    }
    if (originalText.indexOf(oldText, start + 1) >= 0) {
      return `oldText is not unique in file: ${JSON.stringify(oldText.slice(0, 60))}`;
    }
    resolved.push({ start, end: start + oldText.length, newText });
  }
  const ordered = [...resolved].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      return 'edits[] entries overlap; merge nearby changes into one edit';
    }
  }
  return ordered;
}

function executeEdit(args: EditToolArgs, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('edit', args);
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, args.path);
  if (!resolvedPath) {
    return failure('edit', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('edit', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isFile()) {
    return failure('edit', command, 'path is not a readable file');
  }

  const rawText = readTextFileWithEncoding(resolvedPath.absolutePath);
  const eolStyle = detectEolStyle(rawText);
  // The model matches against LF (readSourceText contract); the on-disk style is
  // re-applied on write-back so an edit never rewrites unrelated line endings.
  const originalText = rawText.replace(/\r\n/gu, '\n');
  const resolved = resolveEdits(originalText, args.edits);
  if (typeof resolved === 'string') {
    return failure('edit', command, resolved);
  }
  let updatedText = '';
  let cursor = 0;
  for (const edit of resolved) {
    updatedText += originalText.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  updatedText += originalText.slice(cursor);
  writeFileSync(resolvedPath.absolutePath, applyEolStyle(updatedText, eolStyle), 'utf8');
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Applied ${resolved.length} edit(s) to ${resolvedPath.relativePath}.`,
    toolType: 'edit', outputUnit: 'lines',
    mutatedPath: resolvedPath.relativePath,
  };
}

async function executeRun(args: RunToolArgs, context: RepoToolContext): Promise<RepoToolExecution> {
  const command = buildRepoToolRequestedCommand('run', args);
  const result = await spawnPowerShellAsync(args.command, {
    cwd: context.repoRoot,
    abortSignal: context.abortSignal,
    timeoutMs: args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    env: { [AGENT_RUN_ID_ENV]: context.agentRunId },
  });
  return {
    ok: true, requestedCommand: command, command,
    exitCode: result.exitCode, output: result.output, toolType: 'run', outputUnit: 'lines', outputKeep: 'tail',
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function executeRepoToolUnguarded(
  call: RepoNativeToolCall,
  context: RepoToolContext,
): Promise<RepoToolExecution> {
  if (call.toolName === 'read') {
    const requestedCommand = buildRepoToolRequestedCommand('read', call.args);
    const resolvedPath = resolveRepoScopedPath(context.repoRoot, call.args.path);
    if (!resolvedPath) {
      return failure('read', requestedCommand, 'path must stay within the repository root');
    }
    if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
      return failure('read', requestedCommand, 'path is ignored by runtime policy');
    }
    if (isImagePath(resolvedPath.relativePath)) {
      return executeImageRead({
        args: call.args,
        requestedCommand,
        absolutePath: resolvedPath.absolutePath,
        displayPath: resolvedPath.relativePath,
        context,
      });
    }
    const plan = planRead(call.args, context.repoRoot, context.ignorePolicy, context.fileReadStateByPath, context.expandReads);
    return isFailedReadPlan(plan)
      ? failure('read', plan.command, plan.reason)
      : buildReadExecution('read', plan);
  }
  if (call.toolName === 'grep') {
    return executeGrep(call.args, context);
  }
  if (call.toolName === 'find') {
    return executeFind(call.args, context);
  }
  if (call.toolName === 'ls') {
    return executeLs(call.args, context);
  }
  if (call.toolName === 'write') {
    return executeWrite(call.args, context);
  }
  if (call.toolName === 'edit') {
    return executeEdit(call.args, context);
  }
  if (call.toolName === 'run') {
    return executeRun(call.args, context);
  }
  if (call.toolName === 'git') {
    return new ReadOnlyGitTool({
      repoRoot: context.repoRoot,
      ignorePolicy: context.ignorePolicy,
      abortSignal: context.abortSignal,
    }).execute(call.args);
  }
  if (call.toolName === 'web_search') {
    const command = buildRepoToolRequestedCommand('web_search', call.args);
    try {
      const result = await context.webTools.search(call.args);
      return {
        ok: true, requestedCommand: command, command: result.command, exitCode: 0,
        output: result.output, toolType: 'web_search', outputUnit: 'results',
      };
    } catch (error) {
      return failure('web_search', command, error instanceof Error ? error.message : String(error));
    }
  }
  const command = buildRepoToolRequestedCommand('web_fetch', call.args);
  try {
    const result = await context.webTools.fetch(call.args);
    return {
      ok: true, requestedCommand: command, command: result.command, exitCode: 0,
      output: result.output, toolType: 'web_fetch', outputUnit: 'characters',
    };
  } catch (error) {
    return failure('web_fetch', command, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Native tools run synchronous fs calls that can throw (EPERM, ENOTDIR, delete races). A throw
 * must cost one failed tool result — the same price as any other failure — not the whole run:
 * nothing above this function catches.
 */
export async function executeRepoTool(
  call: RepoNativeToolCall,
  context: RepoToolContext,
): Promise<RepoToolExecution> {
  try {
    return await executeRepoToolUnguarded(call, context);
  } catch (error) {
    return failure(
      call.toolName,
      buildNativeToolRequestedCommand(call),
      `tool error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
