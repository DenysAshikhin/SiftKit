import fs from 'node:fs';
import path from 'node:path';

import { UNFILTERED_CHECK_OUTPUT_RULE } from '../../output-digest/types.ts';
import type { RepoNativeToolCall } from '../repo-tool-arguments.ts';
import { resolveRepoScopedPath } from './repo-paths.ts';

/**
 * One shell statement: its tokens with quotes removed, where each token starts in its text, the text with quoted
 * content blanked, and which tokens start a command (after a pipe, `(`, `{`, or an assignment's `=`).
 */
type Statement = { tokens: string[]; offsets: number[]; bare: string; commandStarts: number[] };

const LOCATION_COMMANDS = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location']);
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`;|,(){}]*/gu;
// A bare `..` is also PowerShell's range operator, so outside a cd only `..` joined to a separator is a path.
const PARENT_SEGMENT = /(?:^|[\\/])\.\.[\\/]|[\\/]\.\.$/u;
const HOME_REFERENCE = /(?<![\w$])(?:~(?:[\\/]|$)|\$HOME\b|\$env:(?:USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP)\b)/iu;
// A check as a command runs it: the executable, by name or path, and the arguments that make it a check.
const CHECK_INVOCATION = new RegExp(String.raw`^(?:[^\s|]*[\\/])?(?:(?:node|tsx)(?:\s+[^\s|]+)*?\s+[^\s|]*run-tests\.ts|node\s+--test`
  + String.raw`|npm(?:\.cmd)?\s+(?:run\s+)?(?:test|lint|typecheck|build|check)[\w:-]*|(?:python3?|py)\s+-m\s+(?:pytest|mypy)`
  + String.raw`|tsc|vitest|eslint|jest|playwright|pytest|mypy|pyright|ruff|msbuild`
  + String.raw`|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build))(?![\w.-])`, 'iu');
// A redirect into a file; `2>&1` only merges streams.
const FILE_REDIRECT = String.raw`(?<![\w-])[1-6*]?(>>?)(?!&)`;
const OUTPUT_CUT = new RegExp(String.raw`\|\s*(Select-Object|Select-String|Where-Object|ForEach-Object|Out-File|Out-Null|Tee-Object|Get-Content`
  + String.raw`|findstr|select|sls|where|tee|\?|%)(?![\w-])|${FILE_REDIRECT}`, 'iu');
// Words that run the command after them, so the word they wrap is judged as the command.
const COMMAND_WRAPPERS = new Set(['&', '.', 'npx', 'pnpx', 'bunx', 'call', 'start', 'start-process', 'cmd', 'cmd.exe', 'iex', 'invoke-expression']);
const SIFTKIT_EXECUTABLE = /(?:^|[\\/])siftkit(?:\.(?:cmd|ps1|exe|js))?$/iu;
// Commands that only read or format what they read; the read, grep, find, ls, and git tools do the same work.
const READ_ONLY_COMMANDS = new Set(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'findstr', 'test-path',
  'get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi', 'resolve-path', 'out-string', 'select-object', 'select',
  'measure-object', 'measure', 'where-object', 'where', '?', 'sort-object', 'sort', 'format-list', 'fl', 'format-table',
  'ft', 'write-output', 'echo', 'write-host']);
const READ_ONLY_GIT = new Set(['show', 'grep', 'log', 'status', 'diff', 'blame', 'ls-files']);
const WRITES_FILE = new RegExp(FILE_REDIRECT, 'u');
// Statements with no output of their own: an exit code says nothing about what the call read.
const CONTROL_COMMANDS = new Set(['exit']);

/** Splits a PowerShell command into statements on `;`, newlines, `&&`, and `||` outside quotes. */
function splitStatements(command: string): Statement[] {
  const statements: Statement[] = [];
  let tokens: string[] = [];
  let offsets: number[] = [];
  let commandStarts: number[] = [];
  let atCommandStart = true;
  let token = '';
  let tokenStart: number | null = null;
  let bare = '';
  let quote: string | null = null;
  const endToken = (): void => {
    if (token !== '' && tokenStart !== null) {
      if (atCommandStart) commandStarts.push(tokens.length);
      atCommandStart = token === '=';
      tokens.push(token);
      offsets.push(tokenStart);
    }
    token = '';
    tokenStart = null;
  };
  const endStatement = (): void => {
    endToken();
    if (tokens.length > 0) statements.push({ tokens, offsets, bare, commandStarts });
    tokens = [];
    offsets = [];
    commandStarts = [];
    atCommandStart = true;
    bare = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (quote !== null) {
      if (char === '`' && quote === '"') {
        token += command.charAt(index + 1);
        index += 1;
      } else if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      bare += ' ';
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (char === "'" || char === '"') {
      quote = char;
      tokenStart ??= bare.length;
      bare += ' ';
    } else if (pair === '&&' || pair === '||') {
      endStatement();
      index += 1;
    } else if (char === ';' || char === '\n' || char === '\r') {
      endStatement();
    } else {
      if (/[\s|(){},]/u.test(char)) {
        endToken();
      } else {
        tokenStart ??= bare.length;
        token += char;
      }
      bare += char;
      if (char === '|' || char === '(' || char === '{') atCommandStart = true;
    }
  }
  endStatement();
  return statements;
}

function outsideRoot(named: string, repoRoot: string): string {
  return `\`${named}\` is outside the repository root ${repoRoot}; run every command inside the repository, with repository-relative paths.`;
}

function resolveInside(repoRoot: string, cwd: string, candidate: string): string | null {
  return resolveRepoScopedPath(repoRoot, path.resolve(cwd, candidate))?.absolutePath ?? null;
}

/** The paths a token names: absolute drive paths anywhere in it, a UNC path, or a path that climbs with `..`. */
function pathCandidates(token: string): string[] {
  const drives = [...token.matchAll(DRIVE_PATH)].map((match) => match[0]);
  if (drives.length > 0) return drives;
  return token.startsWith('\\\\') || PARENT_SEGMENT.test(token) ? [token] : [];
}

/** Follows `cd`-style statements so a relative path is judged from where the shell will be. */
function findEscapingPath(command: string, startCwd: string, repoRoot: string): string | null {
  let cwd = startCwd;
  for (const { tokens } of splitStatements(command)) {
    let locationIndex = -1;
    if (LOCATION_COMMANDS.has((tokens.at(0) ?? '').toLowerCase())) {
      locationIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith('-'));
      const target = tokens.at(locationIndex);
      if (locationIndex > 0 && target !== undefined && !target.startsWith('$')) {
        const resolved = resolveInside(repoRoot, cwd, target);
        if (resolved === null) return outsideRoot(target, repoRoot);
        cwd = resolved;
      }
    }
    for (const [index, token] of tokens.entries()) {
      const home = HOME_REFERENCE.exec(token);
      if (home !== null) return outsideRoot(home[0], repoRoot);
      if (index === locationIndex) continue;
      const escaping = pathCandidates(token).find((candidate) => resolveInside(repoRoot, cwd, candidate) === null);
      if (escaping !== undefined) return outsideRoot(escaping, repoRoot);
    }
  }
  return null;
}

/** The token a command runs, past wrappers such as `npx` or `cmd /c` and their flags. */
function commandHead(tokens: readonly string[], start: number): number {
  let index = start;
  while (COMMAND_WRAPPERS.has((tokens[index] ?? '').toLowerCase()) || (index > start && /^[-/]/u.test(tokens[index] ?? ''))) index += 1;
  return index;
}

/** A check run as a command whose output the rest of its statement pipes or redirects away. */
function findCutCheckOutput(command: string): string | null {
  for (const { tokens, offsets, bare, commandStarts } of splitStatements(command)) {
    for (const start of commandStarts) {
      const offset = offsets[commandHead(tokens, start)];
      if (offset === undefined) continue;
      const check = CHECK_INVOCATION.exec(bare.slice(offset));
      if (check === null) continue;
      const cut = OUTPUT_CUT.exec(bare.slice(offset + check[0].length));
      if (cut !== null) return `\`${cut[1] ?? cut[2] ?? ''}\` cuts the output of a test, build, lint, or typecheck command. ${UNFILTERED_CHECK_OUTPUT_RULE}`;
    }
  }
  return null;
}

/** A command that starts SiftKit: agents search with their own tools, and only the orchestrator dispatches work. */
function findSiftKitInvocation(command: string): string | null {
  for (const { tokens, commandStarts } of splitStatements(command)) {
    for (const start of commandStarts) {
      if (SIFTKIT_EXECUTABLE.test(tokens[commandHead(tokens, start)] ?? '')) {
        return 'Agents may not run `siftkit`: search with your own read, grep, find, and ls tools, and leave repo-agent work to the orchestrator.';
      }
    }
  }
  return null;
}

/**
 * A run or run_check whose every command only reads: it is refused with the tool to use instead. A variable
 * expression (`$x`, `$_`) is no command; a redirect or any other command makes the whole call real work.
 */
export function findShellReadCommand(call: RepoNativeToolCall): string | null {
  if (call.toolName !== 'run' && call.toolName !== 'run_check') return null;
  let first: string | null = null;
  for (const { tokens, bare, commandStarts } of splitStatements(call.args.command)) {
    if (WRITES_FILE.test(bare)) return null;
    for (const start of commandStarts) {
      const index = commandHead(tokens, start);
      const token = tokens[index] ?? '';
      const head = token.toLowerCase();
      if (token.startsWith('$') || CONTROL_COMMANDS.has(head)) continue;
      const subcommand = (tokens[index + 1] ?? '').toLowerCase();
      if (head === 'git' ? !READ_ONLY_GIT.has(subcommand) : !READ_ONLY_COMMANDS.has(head)) return null;
      first ??= head === 'git' ? `git ${subcommand}` : token;
    }
  }
  return first === null ? null
    : `\`${first}\` only reads: use your read, grep, find, ls, or git tool instead. run and run_check are for tests, builds, `
      + 'and commands that execute or change something.';
}

const SCRIPT_HOSTS = new Set(['node', 'tsx', 'python', 'python3', 'py', 'pwsh', 'powershell', 'bun', 'deno']);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|tsx|py|ps1)$/iu;

export type RunScript = { relativePath: string; absolutePath: string; sizeBytes: number };

/** Repository files a command runs as scripts (`node probe.ts`, `.\probe.ps1`), outside the repository's own checks. */
export function findRunScripts(command: string, repoRoot: string): RunScript[] {
  const scripts = new Map<string, RunScript>();
  for (const { tokens, offsets, bare, commandStarts } of splitStatements(command)) {
    for (const start of commandStarts) {
      const head = commandHead(tokens, start);
      const offset = offsets[head];
      if (offset === undefined || CHECK_INVOCATION.test(bare.slice(offset))) continue;
      const host = (tokens[head] ?? '').toLowerCase().replace(/\.exe$/u, '');
      const scriptIndex = SCRIPT_HOSTS.has(host) ? tokens.findIndex((token, index) => index > head && !token.startsWith('-')) : head;
      const script = tokens[scriptIndex];
      if (scriptIndex < 0 || script === undefined || !SCRIPT_FILE.test(script)) continue;
      const resolved = resolveRepoScopedPath(repoRoot, path.resolve(repoRoot, script));
      const stats = resolved === null ? undefined : fs.statSync(resolved.absolutePath, { throwIfNoEntry: false });
      if (resolved !== null && stats?.isFile() === true) {
        const relativePath = resolved.relativePath.replace(/\\/gu, '/');
        scripts.set(resolved.absolutePath, { relativePath, absolutePath: resolved.absolutePath, sizeBytes: stats.size });
      }
    }
  }
  return [...scripts.values()];
}

/** Absolute paths in free text, such as a child's instruction, that lie outside the repository root. */
export function findPathsOutsideRepo(text: string, repoRoot: string): string[] {
  const named = [...text.matchAll(DRIVE_PATH)].map((match) => match[0].replace(/[.:]+$/u, ''));
  return [...new Set(named)].filter((candidate) => resolveInside(repoRoot, repoRoot, candidate) === null);
}

/**
 * Why a run or run_check command may not run: it reaches outside the repository root, starts SiftKit, or
 * cuts the output of a check the digest must read whole. Judged before approval, so no reviewer call is spent on it.
 */
export function findShellCommandProblem(call: RepoNativeToolCall, repoRoot: string): string | null {
  if (call.toolName !== 'run' && call.toolName !== 'run_check') return null;
  const cwdText = call.toolName === 'run_check' ? call.args.cwd : '.';
  const cwd = resolveInside(repoRoot, repoRoot, cwdText);
  if (cwd === null) return outsideRoot(cwdText, repoRoot);
  return findEscapingPath(call.args.command, cwd, repoRoot)
    ?? findSiftKitInvocation(call.args.command)
    ?? findCutCheckOutput(call.args.command);
}
