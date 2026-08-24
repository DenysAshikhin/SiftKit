import type { IgnorePolicy } from '../command-safety.js';
import type { GitToolArgs } from '../repo-tool-arguments.js';
import { spawnDirectCommand } from '../../lib/command-spawn.js';
import {
  isRepoRelativePathIgnored,
  resolveRepoScopedPath,
} from './repo-paths.js';
import type { RepoToolExecution } from './repo-tools.js';

const BASE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '--no-optional-locks'];
const DIFF_SAFETY_ARGS = ['--no-ext-diff', '--no-textconv'];
const DEFAULT_LOG_LIMIT = 20;

type GitInvocation = {
  ok: true;
  args: string[];
  env: Record<string, string>;
  command: string;
  outputLimit?: number;
};

type RejectedGitInvocation = {
  ok: false;
  command: string;
  reason: string;
};

function quote(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function buildReadOnlyGitCommand(args: GitToolArgs): string {
  const fields: Array<[string, string | number | boolean | undefined]> = [];
  switch (args.operation) {
    case 'status':
      break;
    case 'log':
      fields.push(['limit', args.limit], ['ref', args.ref], ['path', args.path], ['patches', args.patches]);
      break;
    case 'show':
      fields.push(['ref', args.ref], ['path', args.path]);
      break;
    case 'diff':
      fields.push(['base', args.base], ['target', args.target], ['path', args.path]);
      break;
    case 'blame':
      fields.push(['path', args.path], ['startLine', args.startLine], ['endLine', args.endLine]);
      break;
    case 'grep':
      fields.push(
        ['path', args.path], ['pattern', args.pattern], ['ref', args.ref],
        ['ignoreCase', args.ignoreCase], ['limit', args.limit],
      );
      break;
    case 'ls_files':
      fields.push(['path', args.path], ['limit', args.limit]);
      break;
  }
  return ['git', `operation=${quote(args.operation)}`, ...fields
    .filter((field): field is [string, string | number | boolean] => field[1] !== undefined)
    .map(([key, value]) => `${key}=${quote(value)}`)]
    .join(' ');
}

function scrubGitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) {
      env[key] = value;
    }
  }
  return env;
}

function resolveGitPath(
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  rawPath: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (rawPath.startsWith('-')) {
    return { ok: false, reason: 'path must not begin with "-"' };
  }
  const resolved = resolveRepoScopedPath(repoRoot, rawPath);
  if (!resolved) {
    return { ok: false, reason: 'path must stay within the repository root' };
  }
  if (isRepoRelativePathIgnored(resolved.relativePath, ignorePolicy)) {
    return { ok: false, reason: 'path is ignored by runtime policy' };
  }
  return { ok: true, path: resolved.relativePath || '.' };
}

export function buildReadOnlyGitInvocation(
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  args: GitToolArgs,
): GitInvocation | RejectedGitInvocation {
  const command = buildReadOnlyGitCommand(args);
  const pathValue = 'path' in args ? args.path : undefined;
  const resolvedPath = pathValue === undefined ? undefined : resolveGitPath(repoRoot, ignorePolicy, pathValue);
  if (resolvedPath && !resolvedPath.ok) {
    return { ok: false, command, reason: resolvedPath.reason };
  }
  const path = resolvedPath?.path;
  const operationArgs: string[] = [];
  let outputLimit: number | undefined;

  switch (args.operation) {
    case 'status':
      operationArgs.push('status', '--short');
      break;
    case 'log':
      operationArgs.push('log');
      if (args.patches) operationArgs.push(...DIFF_SAFETY_ARGS, '-p');
      operationArgs.push('--oneline', '-n', String(args.limit ?? DEFAULT_LOG_LIMIT));
      if (args.ref) operationArgs.push(args.ref);
      if (path) operationArgs.push('--', path);
      break;
    case 'show':
      operationArgs.push('show', ...DIFF_SAFETY_ARGS, args.path ? `${args.ref}:${path}` : args.ref);
      break;
    case 'diff':
      operationArgs.push('diff', ...DIFF_SAFETY_ARGS);
      if (args.base) operationArgs.push(args.base);
      if (args.target) operationArgs.push(args.target);
      if (path) operationArgs.push('--', path);
      break;
    case 'blame':
      operationArgs.push('blame', ...DIFF_SAFETY_ARGS);
      if (args.startLine !== undefined && args.endLine !== undefined) {
        operationArgs.push('-L', `${args.startLine},${args.endLine}`);
      }
      operationArgs.push('--', path ?? '.');
      break;
    case 'grep':
      operationArgs.push('grep');
      if (args.ignoreCase) operationArgs.push('-i');
      if (args.limit !== undefined) operationArgs.push('-m', String(args.limit));
      operationArgs.push('-e', args.pattern);
      if (args.ref) operationArgs.push(args.ref);
      if (path) operationArgs.push('--', path);
      outputLimit = args.limit;
      break;
    case 'ls_files':
      operationArgs.push('ls-files');
      if (path) operationArgs.push('--', path);
      outputLimit = args.limit;
      break;
  }

  return {
    ok: true,
    args: [...BASE_ARGS, ...operationArgs],
    env: scrubGitEnvironment(),
    command,
    ...(outputLimit === undefined ? {} : { outputLimit }),
  };
}

function capOutputLines(output: string, limit: number | undefined): string {
  if (limit === undefined) return output;
  const hadTrailingNewline = /\r?\n$/u.test(output);
  const lines = output.replace(/\r?\n$/u, '').split(/\r?\n/u).slice(0, limit);
  if (lines.length === 1 && lines[0] === '') return '';
  return lines.join('\n') + (hadTrailingNewline ? '\n' : '');
}

export class ReadOnlyGitTool {
  readonly #repoRoot: string;
  readonly #ignorePolicy: IgnorePolicy;
  readonly #abortSignal?: AbortSignal;

  constructor(options: { repoRoot: string; ignorePolicy: IgnorePolicy; abortSignal?: AbortSignal }) {
    this.#repoRoot = options.repoRoot;
    this.#ignorePolicy = options.ignorePolicy;
    this.#abortSignal = options.abortSignal;
  }

  async execute(args: GitToolArgs): Promise<RepoToolExecution> {
    const invocation = buildReadOnlyGitInvocation(this.#repoRoot, this.#ignorePolicy, args);
    if (!invocation.ok) {
      return { ok: false, command: invocation.command, reason: invocation.reason, toolType: 'git' };
    }
    const result = await spawnDirectCommand('git', invocation.args, {
      cwd: this.#repoRoot,
      abortSignal: this.#abortSignal,
      env: invocation.env,
    });
    return {
      ok: true,
      requestedCommand: invocation.command,
      command: invocation.command,
      exitCode: result.exitCode,
      output: capOutputLines(result.output, invocation.outputLimit),
      toolType: 'git',
      outputUnit: 'lines',
    };
  }
}
