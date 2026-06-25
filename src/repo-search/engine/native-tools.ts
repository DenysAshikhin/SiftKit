import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, posix } from 'node:path';
import { type IgnorePolicy } from '../command-safety.js';
import { estimateTokenCount } from '../prompt-budget.js';
import { findContiguousUnreadRange, type ToolOutputTruncationUnit } from '../../tool-output-fit.js';
import { getOrCreateFileReadState, type FileReadState } from './read-overlap.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import type { ToolTranscriptAction } from '../../tool-call-messages.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { WebFetchToolArgs, WebSearchToolArgs } from '../../web-search/types.js';

export type NativeRepoToolExecution =
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

export type RepoReadFilePlan = {
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

export function isFailedRepoReadFilePlan(
  plan: RepoReadFilePlan | { ok: false; command: string; reason: string },
): plan is { ok: false; command: string; reason: string } {
  return 'ok' in plan && plan.ok === false;
}

type EffectiveTranscriptActionOptions = {
  toolName: string;
  rawArgs: JsonObject;
  isNativeTool: boolean;
  commandToRun: string;
};

function parseEffectiveReadFileArgs(command: string, fallbackArgs: JsonObject): JsonObject {
  const match = /^repo_read_file path=("(?:(?:\\")|[^"])*"|\S+) startLine=(\d+)(?: endLine=(\d+))?/u.exec(command.trim());
  if (!match) {
    return fallbackArgs;
  }
  let pathText = String(fallbackArgs.path || '');
  try {
    const parsedPath = parseJsonValueText(match[1]);
    pathText = typeof parsedPath === 'string' ? parsedPath : String(fallbackArgs.path || '');
  } catch {
    pathText = String(fallbackArgs.path || '');
  }
  return {
    path: pathText,
    startLine: Number.parseInt(match[2], 10),
    ...(match[3] ? { endLine: Number.parseInt(match[3], 10) } : {}),
  };
}

export function buildEffectiveTranscriptAction(options: EffectiveTranscriptActionOptions): ToolTranscriptAction {
  if (!options.isNativeTool) {
    return {
      tool_name: options.toolName,
      args: { command: options.commandToRun },
    };
  }

  if (options.toolName === 'repo_read_file') {
    return {
      tool_name: options.toolName,
      args: parseEffectiveReadFileArgs(options.commandToRun, options.rawArgs),
    };
  }

  return {
    tool_name: options.toolName,
    args: options.rawArgs,
  };
}

function normalizeRepoRelativePathForDisplay(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function isRepoRelativePathIgnored(relativePath: string, ignorePolicy: IgnorePolicy): boolean {
  const normalized = normalizeRepoRelativePathForDisplay(relativePath).replace(/^\.\/+/u, '');
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
  const pathText = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!pathText) {
    return null;
  }
  const absolutePath = resolve(repoRoot, pathText);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return {
    absolutePath,
    relativePath: normalizeRepoRelativePathForDisplay(relativePath),
  };
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      const next = glob[index + 1];
      if (next === '*') {
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

function matchesRepoListGlob(relativePath: string, globText: string): boolean {
  const normalizedPath = normalizeRepoRelativePathForDisplay(relativePath);
  const normalizedGlob = normalizeRepoRelativePathForDisplay(globText.trim());
  if (!normalizedGlob) {
    return true;
  }
  const target = normalizedGlob.includes('/') ? normalizedPath : posix.basename(normalizedPath);
  return globToRegExp(normalizedGlob).test(target);
}

function formatNumberedTextBlock(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

export function buildRepoReadFileCommand(pathText: string, startLine: number, endLine?: number): string {
  const boundedStartLine = Math.max(1, Math.trunc(Number(startLine) || 1));
  const boundedEndLine = Math.trunc(Number(endLine) || 0);
  return `repo_read_file path=${JSON.stringify(pathText)} startLine=${boundedStartLine}${boundedEndLine > 0 ? ` endLine=${boundedEndLine}` : ''}`;
}

export function buildRepoListFilesCommand(args: JsonObject): string {
  const pathText = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const recurse = args.recurse === undefined ? true : args.recurse === true;
  const globText = typeof args.glob === 'string' ? args.glob.trim() : '';
  return `repo_list_files path=${JSON.stringify(pathText)}${globText ? ` glob=${JSON.stringify(globText)}` : ''} recurse=${recurse}`;
}

export function buildNativeRepoToolRequestedCommand(toolName: string, args: JsonObject): string {
  if (toolName === 'repo_read_file') {
    const startLine = Math.max(1, Math.trunc(Number(args.startLine) || 1));
    const endLineCandidate = Math.trunc(Number(args.endLine) || 0);
    return buildRepoReadFileCommand(String(args.path || ''), startLine, endLineCandidate > 0 ? endLineCandidate : undefined);
  }
  if (toolName === 'web_search') {
    return `web_search query=${JSON.stringify(String(args.query || '').trim())}`;
  }
  if (toolName === 'web_fetch') {
    return `web_fetch url=${JSON.stringify(String(args.url || '').trim())}`;
  }
  return buildRepoListFilesCommand(args);
}

export function planRepoReadFile(
  args: JsonObject,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
): RepoReadFilePlan | { ok: false; command: string; reason: string } {
  const commandPath = String(args.path || '');
  const startLine = Math.max(1, Math.trunc(Number(args.startLine) || 1));
  const endLineCandidate = Math.trunc(Number(args.endLine) || 0);
  const requestedCommand = buildRepoReadFileCommand(commandPath, startLine, endLineCandidate > 0 ? endLineCandidate : undefined);
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

  const lines = readFileSync(resolvedPath.absolutePath, 'utf8').replace(/\r\n/gu, '\n').split('\n');
  const pathKey = normalizeRepoRelativePathForDisplay(resolvedPath.relativePath).toLowerCase();
  const displayPath = normalizeRepoRelativePathForDisplay(resolvedPath.relativePath);
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = Math.min(startLine, lines.length || 1);
  const requestedEnd = endLineCandidate > 0 ? endLineCandidate : lines.length;
  const requestedEndExclusive = Math.max(clampedStart + 1, Math.min(requestedEnd + 1, totalEndLineExclusive));
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

export function buildRepoReadFileExecution(
  toolName: string,
  plan: RepoReadFilePlan,
  noteText: string | null,
): NativeRepoToolExecution {
  if (!plan.hasUnread) {
    const output = [noteText, plan.noUnreadOutput || ''].filter((part) => String(part || '').trim()).join('\n').trim();
    return {
      ok: true,
      requestedCommand: plan.requestedCommand,
      command: plan.requestedCommand,
      exitCode: 0,
      output,
      toolType: toolName,
      outputUnit: 'lines',
      readFile: {
        commandPath: plan.commandPath,
        pathKey: plan.pathKey,
        displayPath: plan.displayPath,
        startLine: plan.effectiveStartLine,
        endLineExclusive: plan.effectiveStartLine,
        totalEndLineExclusive: plan.totalEndLineExclusive,
      },
      lineReadStats: {
        lineReadCalls: 0,
        lineReadLinesTotal: 0,
        lineReadTokensTotal: 0,
      },
    };
  }

  const selectedLines = plan.lines.slice(plan.effectiveStartLine - 1, plan.effectiveEndLineExclusive - 1);
  const output = [noteText, formatNumberedTextBlock(selectedLines, plan.effectiveStartLine)]
    .filter((part) => String(part || '').trim())
    .join('\n')
    .trim();
  const executedCommand = buildRepoReadFileCommand(plan.commandPath, plan.effectiveStartLine, plan.effectiveEndLineExclusive - 1);
  return {
    ok: true,
    requestedCommand: plan.requestedCommand,
    command: executedCommand,
    exitCode: 0,
    output,
    toolType: toolName,
    outputUnit: 'lines',
    readFile: {
      commandPath: plan.commandPath,
      pathKey: plan.pathKey,
      displayPath: plan.displayPath,
      startLine: plan.effectiveStartLine,
      endLineExclusive: plan.effectiveEndLineExclusive,
      totalEndLineExclusive: plan.totalEndLineExclusive,
    },
    lineReadStats: {
      lineReadCalls: 1,
      lineReadLinesTotal: selectedLines.length,
      lineReadTokensTotal: Math.max(1, estimateTokenCount(undefined, selectedLines.join('\n'))),
    },
  };
}

function listRepoFilesRecursive(
  currentAbsolutePath: string,
  currentRelativePath: string,
  ignorePolicy: IgnorePolicy,
  includeFiles: string[],
  recurse: boolean,
): void {
  for (const entry of readdirSync(currentAbsolutePath, { withFileTypes: true })) {
    const nextRelativePath = currentRelativePath
      ? `${currentRelativePath}/${entry.name}`
      : entry.name;
    if (isRepoRelativePathIgnored(nextRelativePath, ignorePolicy)) {
      continue;
    }
    const nextAbsolutePath = join(currentAbsolutePath, entry.name);
    if (entry.isDirectory()) {
      if (recurse) {
        listRepoFilesRecursive(nextAbsolutePath, nextRelativePath, ignorePolicy, includeFiles, recurse);
      }
      continue;
    }
    if (entry.isFile()) {
      includeFiles.push(normalizeRepoRelativePathForDisplay(nextRelativePath));
    }
  }
}

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

export async function executeNativeRepoTool(
  toolName: string,
  args: JsonObject,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  webTools: WebResearchTools,
  fileReadStateByPath?: Map<string, FileReadState>,
): Promise<NativeRepoToolExecution> {
  if (toolName === 'repo_read_file') {
    const plan = planRepoReadFile(args, repoRoot, ignorePolicy, fileReadStateByPath);
    if (isFailedRepoReadFilePlan(plan)) {
      return { ok: false, command: plan.command, reason: plan.reason, toolType: toolName };
    }
    return buildRepoReadFileExecution(toolName, plan, null);
  }

  if (toolName === 'web_search') {
    try {
      const result = await webTools.search(toWebSearchToolArgs(args));
      return { ok: true, command: result.command, exitCode: 0, output: result.output, toolType: 'web_search', outputUnit: 'results' };
    } catch (error) {
      return { ok: false, command: `web_search query=${JSON.stringify(String(args.query || '').trim())}`, reason: error instanceof Error ? error.message : String(error), toolType: 'web_search' };
    }
  }
  if (toolName === 'web_fetch') {
    try {
      const result = await webTools.fetch(toWebFetchToolArgs(args));
      return { ok: true, command: result.command, exitCode: 0, output: result.output, toolType: 'web_fetch', outputUnit: 'characters' };
    } catch (error) {
      return { ok: false, command: `web_fetch url=${JSON.stringify(String(args.url || '').trim())}`, reason: error instanceof Error ? error.message : String(error), toolType: 'web_fetch' };
    }
  }

  const pathText = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const recurse = args.recurse === undefined ? true : args.recurse === true;
  const globText = typeof args.glob === 'string' ? args.glob.trim() : '';
  const command = buildRepoListFilesCommand(args);
  const resolvedPath = resolveRepoScopedPath(repoRoot, pathText);
  if (!resolvedPath) {
    return { ok: false, command, reason: 'path must stay within the repository root', toolType: toolName };
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, ignorePolicy)) {
    return { ok: false, command, reason: 'path is ignored by runtime policy', toolType: toolName };
  }
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isDirectory()) {
    return { ok: false, command, reason: 'path is not a readable directory', toolType: toolName };
  }
  const matches: string[] = [];
  listRepoFilesRecursive(
    resolvedPath.absolutePath,
    resolvedPath.relativePath === '.' ? '' : resolvedPath.relativePath,
    ignorePolicy,
    matches,
    recurse,
  );
  const filteredMatches = globText
    ? matches.filter((relativePath) => matchesRepoListGlob(relativePath, globText))
    : matches;
  return {
    ok: true,
    requestedCommand: command,
    command,
    exitCode: 0,
    output: filteredMatches.join('\n'),
    toolType: toolName,
    outputUnit: 'files',
  };
}
