import { existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, posix } from 'node:path';
import { type IgnorePolicy } from '../command-safety.js';
import { estimateTokenCount } from '../prompt-budget.js';
import { findContiguousUnreadRange, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.js';
import { getOrCreateFileReadState, type FileReadState } from './read-overlap.js';
import { parseJsonValueText } from '../../lib/json.js';
import { readTextFileWithEncoding } from '../../lib/text-encoding.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import type { ToolTranscriptAction } from '../../tool-call-messages.js';
import { spawnDirectCommand } from '../../lib/command-spawn.js';
import { spawnPowerShellAsync } from '../../lib/powershell.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { WebFetchToolArgs, WebSearchToolArgs } from '../../web-search/types.js';

export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;
export const LS_DEFAULT_LIMIT = 500;

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
    };
    outputUnit?: ToolOutputTruncationUnit;
    // Which end survives per-tool truncation. Omitted → 'head'. Command output
    // (`run`) sets 'tail' so the trailing summary/errors survive.
    outputKeep?: ToolOutputKeep;
    lineReadStats?: {
      lineReadCalls: number;
      lineReadLinesTotal: number;
      lineReadTokensTotal: number;
    };
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
// Arg coercion
// ---------------------------------------------------------------------------

function readString(value: OptionalJsonValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveInteger(value: OptionalJsonValue, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

export function buildReadCommand(pathText: string, offset: number, limit?: number): string {
  return formatToolCommand('read', [
    ['path', pathText],
    ['offset', Math.max(1, Math.trunc(Number(offset) || 1))],
    ['limit', Math.trunc(Number(limit) || 0) > 0 ? Math.trunc(Number(limit)) : undefined],
  ]);
}

function optionalPositive(value: OptionalJsonValue): number | undefined {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
    return buildReadCommand(readString(args.path), readPositiveInteger(args.offset, 1), optionalPositive(args.limit));
  }
  if (toolName === 'grep') {
    return formatToolCommand('grep', [
      ['pattern', readString(args.pattern)],
      ['path', optionalString(args.path)],
      ['glob', optionalString(args.glob)],
      ['ignoreCase', optionalBoolean(args.ignoreCase)],
      ['literal', optionalBoolean(args.literal)],
      ['context', optionalPositive(args.context)],
      ['limit', optionalPositive(args.limit)],
    ]);
  }
  if (toolName === 'find') {
    return formatToolCommand('find', [
      ['pattern', readString(args.pattern)],
      ['path', optionalString(args.path)],
      ['limit', optionalPositive(args.limit)],
    ]);
  }
  if (toolName === 'ls') {
    return formatToolCommand('ls', [
      ['path', readString(args.path) || '.'],
      ['limit', optionalPositive(args.limit)],
    ]);
  }
  if (toolName === 'write') {
    return formatToolCommand('write', [
      ['path', readString(args.path)],
      ['bytes', Buffer.byteLength(typeof args.content === 'string' ? args.content : '', 'utf8')],
    ]);
  }
  if (toolName === 'edit') {
    return formatToolCommand('edit', [
      ['path', readString(args.path)],
      ['edits', Array.isArray(args.edits) ? args.edits.length : 0],
    ]);
  }
  if (toolName === 'run') {
    return formatToolCommand('run', [['command', readString(args.command)]]);
  }
  if (toolName === 'web_search') {
    return formatToolCommand('web_search', [['query', readString(args.query)]]);
  }
  if (toolName === 'web_fetch') {
    return formatToolCommand('web_fetch', [['url', readString(args.url)]]);
  }
  return formatToolCommand(toolName, []);
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
  isNativeTool: boolean;
  commandToRun: string;
}): ToolTranscriptAction {
  if (!options.isNativeTool) {
    return { tool_name: options.toolName, args: { command: options.commandToRun } };
  }
  if (options.toolName === 'read') {
    return { tool_name: options.toolName, args: parseEffectiveReadArgs(options.commandToRun, options.rawArgs) };
  }
  return { tool_name: options.toolName, args: options.rawArgs };
}

// ---------------------------------------------------------------------------
// Repo-scoped path resolution
// ---------------------------------------------------------------------------

function toPosixPath(value: string): string {
  return value.replace(/\\/gu, '/');
}

function isRepoRelativePathIgnored(relativePath: string, ignorePolicy: IgnorePolicy): boolean {
  const normalized = toPosixPath(relativePath).replace(/^\.\/+/u, '');
  if (!normalized) {
    return false;
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ignorePolicy.namesLower.has(segment.toLowerCase()))) {
    return true;
  }
  return ignorePolicy.paths.some((ignoredPath) => (
    normalized === ignoredPath || normalized.startsWith(`${ignoredPath}/`)
  ));
}

function resolveRepoScopedPath(repoRoot: string, rawPath: OptionalJsonValue): {
  absolutePath: string;
  relativePath: string;
} | null {
  const pathText = readString(rawPath);
  if (!pathText) {
    return null;
  }
  const absolutePath = resolve(repoRoot, pathText);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return { absolutePath, relativePath: toPosixPath(relativePath) };
}

function failure(toolType: string, command: string, reason: string): RepoToolExecution {
  return { ok: false, command, reason, toolType };
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
        continue;
      }
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
    pattern += char === '\\' ? '/' : char;
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

function formatNumberedTextBlock(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

export function planRead(
  args: JsonObject,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
): ReadPlan | FailedPlan {
  const commandPath = readString(args.path);
  const offset = readPositiveInteger(args.offset, 1);
  const limit = optionalPositive(args.limit);
  const requestedCommand = buildReadCommand(commandPath, offset, limit);
  const resolvedPath = resolveRepoScopedPath(repoRoot, args.path);
  if (!resolvedPath) {
    return { ok: false, command: requestedCommand, reason: 'path must stay within the repository root' };
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, ignorePolicy)) {
    return { ok: false, command: requestedCommand, reason: 'path is ignored by runtime policy' };
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }

  const lines = readTextFileWithEncoding(resolvedPath.absolutePath).replace(/\r\n/gu, '\n').split('\n');
  const displayPath = resolvedPath.relativePath;
  const pathKey = displayPath.toLowerCase();
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = Math.min(offset, lines.length || 1);
  const requestedEndExclusive = limit === undefined
    ? totalEndLineExclusive
    : Math.max(clampedStart + 1, Math.min(clampedStart + limit, totalEndLineExclusive));
  const state = fileReadStateByPath ? getOrCreateFileReadState(fileReadStateByPath, pathKey) : null;
  const hasReturnedRanges = Boolean(state && state.mergedReturnedRanges.length > 0);
  const unreadRange = findContiguousUnreadRange({
    requestedStart: clampedStart,
    totalEnd: hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive,
    returnedRanges: state?.mergedReturnedRanges || [],
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
    noUnreadOutput: unreadRange.hasUnread ? null : `No unread lines remain for ${displayPath}.`,
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

function buildGrepArgs(args: JsonObject, ignorePolicy: IgnorePolicy, searchPath: string): string[] {
  const argv = ['--no-ignore', '--line-number', '--with-filename', '--color', 'never'];
  argv.push(readBoolean(args.ignoreCase, true) ? '--ignore-case' : '--case-sensitive');
  if (readBoolean(args.literal, false)) {
    argv.push('--fixed-strings');
  }
  const context = optionalPositive(args.context);
  if (context !== undefined) {
    argv.push('--context', String(context));
  }
  const glob = optionalString(args.glob);
  if (glob !== undefined) {
    argv.push('--glob', glob);
  }
  for (const name of ignorePolicy.names) {
    argv.push('--glob', `!**/${name}/**`);
  }
  for (const ignoredPath of ignorePolicy.paths) {
    argv.push('--glob', `!${ignoredPath}/**`);
  }
  argv.push('--regexp', readString(args.pattern), '--', searchPath);
  return argv;
}

async function executeGrep(args: JsonObject, context: RepoToolContext): Promise<RepoToolExecution> {
  const command = buildRepoToolRequestedCommand('grep', args);
  if (!readString(args.pattern)) {
    return failure('grep', command, 'grep requires a non-empty pattern');
  }
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, readString(args.path) || '.');
  if (!resolvedPath) {
    return failure('grep', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('grep', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath)) {
    return failure('grep', command, 'path is not a readable file or directory');
  }

  const searchPath = resolvedPath.relativePath === '' ? '.' : resolvedPath.relativePath;
  const result = await spawnDirectCommand('rg', buildGrepArgs(args, context.ignorePolicy, searchPath), {
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
  const limit = readPositiveInteger(args.limit, GREP_DEFAULT_LIMIT);
  const truncated = matchLines.length > limit;
  const output = truncated
    ? `${matchLines.slice(0, limit).join('\n')}\n... ${matchLines.length - limit} more matches beyond limit=${limit}; narrow the pattern, glob, or path.`
    : matchLines.join('\n');
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'grep', outputUnit: 'lines' };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

function executeFind(args: JsonObject, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('find', args);
  const pattern = readString(args.pattern);
  if (!pattern) {
    return failure('find', command, 'find requires a non-empty pattern');
  }
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, readString(args.path) || '.');
  if (!resolvedPath) {
    return failure('find', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('find', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isDirectory()) {
    return failure('find', command, 'path is not a readable directory');
  }

  const matches: string[] = [];
  listFilesRecursive(resolvedPath.absolutePath, '', context.ignorePolicy, matches);
  const filtered = matches.filter((relativePath) => matchesGlob(relativePath, pattern)).sort();
  const limit = readPositiveInteger(args.limit, FIND_DEFAULT_LIMIT);
  const truncated = filtered.length > limit;
  const output = truncated
    ? `${filtered.slice(0, limit).join('\n')}\n... ${filtered.length - limit} more files beyond limit=${limit}; narrow the pattern or path.`
    : filtered.join('\n');
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'find', outputUnit: 'files' };
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function executeLs(args: JsonObject, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('ls', args);
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, readString(args.path) || '.');
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
  entries.sort((left, right) => left.localeCompare(right));
  const limit = readPositiveInteger(args.limit, LS_DEFAULT_LIMIT);
  const truncated = entries.length > limit;
  const output = truncated
    ? `${entries.slice(0, limit).join('\n')}\n... ${entries.length - limit} more entries beyond limit=${limit}.`
    : entries.join('\n');
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'ls', outputUnit: 'files' };
}

// ---------------------------------------------------------------------------
// write / edit / run — implemented and tested, never exposed to the model.
// See EXPOSED_REPO_TOOL_NAMES in planner-protocol.ts.
// ---------------------------------------------------------------------------

function executeWrite(args: JsonObject, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('write', args);
  const content = typeof args.content === 'string' ? args.content : null;
  if (content === null) {
    return failure('write', command, 'write requires args.content');
  }
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, readString(args.path));
  if (!resolvedPath) {
    return failure('write', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('write', command, 'path is ignored by runtime policy');
  }
  mkdirSync(dirname(resolvedPath.absolutePath), { recursive: true });
  writeFileSync(resolvedPath.absolutePath, content, 'utf8');
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${resolvedPath.relativePath}.`,
    toolType: 'write', outputUnit: 'lines',
  };
}

type ResolvedEdit = { start: number; end: number; newText: string };

function resolveEdits(originalText: string, rawEdits: readonly OptionalJsonValue[]): ResolvedEdit[] | string {
  const resolved: ResolvedEdit[] = [];
  for (const rawEdit of rawEdits) {
    if (!rawEdit || typeof rawEdit !== 'object' || Array.isArray(rawEdit)) {
      return 'each entry in edits[] must be an object with oldText and newText';
    }
    const oldText = typeof rawEdit.oldText === 'string' ? rawEdit.oldText : '';
    const newText = typeof rawEdit.newText === 'string' ? rawEdit.newText : '';
    if (!oldText) {
      return 'each entry in edits[] requires a non-empty oldText';
    }
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

function executeEdit(args: JsonObject, context: RepoToolContext): RepoToolExecution {
  const command = buildRepoToolRequestedCommand('edit', args);
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  if (rawEdits.length === 0) {
    return failure('edit', command, 'edit requires at least one entry in edits[]');
  }
  const resolvedPath = resolveRepoScopedPath(context.repoRoot, readString(args.path));
  if (!resolvedPath) {
    return failure('edit', command, 'path must stay within the repository root');
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
    return failure('edit', command, 'path is ignored by runtime policy');
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isFile()) {
    return failure('edit', command, 'path is not a readable file');
  }

  const originalText = readTextFileWithEncoding(resolvedPath.absolutePath);
  const resolved = resolveEdits(originalText, rawEdits);
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
  writeFileSync(resolvedPath.absolutePath, updatedText, 'utf8');
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Applied ${resolved.length} edit(s) to ${resolvedPath.relativePath}.`,
    toolType: 'edit', outputUnit: 'lines',
  };
}

async function executeRun(args: JsonObject, context: RepoToolContext): Promise<RepoToolExecution> {
  const command = buildRepoToolRequestedCommand('run', args);
  const commandText = readString(args.command);
  if (!commandText) {
    return failure('run', command, 'run requires args.command');
  }
  const timeoutSeconds = optionalPositive(args.timeout);
  const result = await spawnPowerShellAsync(commandText, {
    cwd: context.repoRoot,
    abortSignal: context.abortSignal,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
  });
  return {
    ok: true, requestedCommand: command, command,
    exitCode: result.exitCode, output: result.output, toolType: 'run', outputUnit: 'lines', outputKeep: 'tail',
  };
}

// ---------------------------------------------------------------------------
// Web tools
// ---------------------------------------------------------------------------

function toWebSearchToolArgs(args: JsonObject): WebSearchToolArgs {
  const timeFilter = args.timeFilter;
  return {
    query: typeof args.query === 'string' ? args.query : '',
    ...(timeFilter === 'day' || timeFilter === 'week' || timeFilter === 'month' || timeFilter === 'year'
      ? { timeFilter }
      : {}),
  };
}

function toWebFetchToolArgs(args: JsonObject): WebFetchToolArgs {
  return { url: typeof args.url === 'string' ? args.url : '' };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function executeRepoTool(
  toolName: string,
  args: JsonObject,
  context: RepoToolContext,
): Promise<RepoToolExecution> {
  if (toolName === 'read') {
    const plan = planRead(args, context.repoRoot, context.ignorePolicy, context.fileReadStateByPath);
    return isFailedReadPlan(plan)
      ? failure('read', plan.command, plan.reason)
      : buildReadExecution('read', plan);
  }
  if (toolName === 'grep') {
    return executeGrep(args, context);
  }
  if (toolName === 'find') {
    return executeFind(args, context);
  }
  if (toolName === 'ls') {
    return executeLs(args, context);
  }
  if (toolName === 'write') {
    return executeWrite(args, context);
  }
  if (toolName === 'edit') {
    return executeEdit(args, context);
  }
  if (toolName === 'run') {
    return executeRun(args, context);
  }
  if (toolName === 'web_search') {
    const command = buildRepoToolRequestedCommand('web_search', args);
    try {
      const result = await context.webTools.search(toWebSearchToolArgs(args));
      return {
        ok: true, requestedCommand: command, command: result.command, exitCode: 0,
        output: result.output, toolType: 'web_search', outputUnit: 'results',
      };
    } catch (error) {
      return failure('web_search', command, error instanceof Error ? error.message : String(error));
    }
  }
  if (toolName === 'web_fetch') {
    const command = buildRepoToolRequestedCommand('web_fetch', args);
    try {
      const result = await context.webTools.fetch(toWebFetchToolArgs(args));
      return {
        ok: true, requestedCommand: command, command: result.command, exitCode: 0,
        output: result.output, toolType: 'web_fetch', outputUnit: 'characters',
      };
    } catch (error) {
      return failure('web_fetch', command, error instanceof Error ? error.message : String(error));
    }
  }
  return failure(toolName, buildRepoToolRequestedCommand(toolName, args), `unknown repo tool "${toolName}"`);
}
