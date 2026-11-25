import fs from 'node:fs';
import path from 'node:path';

import { parseJsonValueText } from '../../lib/json.ts';
import { z } from '../../lib/zod.ts';
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

/** A command that asks another service to start a process, which no job can hold or stop. */
const ESCAPE_FORMS = [
  { heads: ['invoke-cimmethod', 'icim', 'invoke-wmimethod', 'iwmi'], args: /\bwin32_process\b/iu, named: 'Win32_Process' },
  { heads: ['wmic'], args: /\bprocess\s+call\s+create\b/iu, named: 'wmic process call create' },
  { heads: ['schtasks'], args: /(?:^|\s)[/-]create\b/iu, named: 'schtasks /create' },
  { heads: ['register-scheduledtask'], args: /^/u, named: 'Register-ScheduledTask' },
  { heads: ['new-service'], args: /^/u, named: 'New-Service' },
  // A service needs binPath=, which tells it from PowerShell's `sc`, an alias of Set-Content.
  { heads: ['sc'], args: /^create\s.*\bbinpath=/iu, named: 'sc create' },
  { heads: ['docker'], args: /^(?:container\s+)?run\b.*\s(?:-[it]*d[it]*|--detach)(?:\s|$)/iu, named: 'docker run -d' },
  { heads: ['docker'], args: /^compose\b.*\sup\b.*\s(?:-d|--detach)(?:\s|$)/iu, named: 'docker compose up -d' },
  { heads: ['docker-compose'], args: /^(?:.*\s)?up\b.*\s(?:-d|--detach)(?:\s|$)/iu, named: 'docker compose up -d' },
] as const;

function findEscapeForm(command: string): string | null {
  for (const { tokens, commandStarts } of splitStatements(command)) {
    for (const start of commandStarts) {
      const index = commandHead(tokens, start);
      const head = path.win32.basename(tokens[index] ?? '').toLowerCase().replace(/\.exe$/u, '');
      const rest = tokens.slice(index + 1).join(' ');
      for (const { heads, args, named } of ESCAPE_FORMS) {
        if (heads.some((name) => name === head) && args.test(rest)) {
          return `\`${named}\` starts a process this run could not stop. Run it as a normal command, or as \`run\` with background=true.`;
        }
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
// Options whose operand is a module, inline code, or tests: no script file follows them.
const NO_SCRIPT_OPTION = /^(?:-m|-e|-c|-p|--eval|--print|--test|-command)$/iu;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_LIFECYCLE = new Map([['test', 'test'], ['t', 'test'], ['tst', 'test'], ['start', 'start'], ['stop', 'stop'], ['restart', 'restart']]);
// Options that run the script of another directory's or workspace's package.json.
const PACKAGE_ELSEWHERE = /^(?:-w|-C|-F|--workspaces?|--prefix|--dir|--cwd|--filter|--include-workspace-root)(?:=|$)/u;
const RETURN_COMMANDS = new Set(['popd', 'pop-location']);
const PackageJsonSchema = z.object({ scripts: z.record(z.string(), z.string()).default({}) });

export type RunScript = { relativePath: string; absolutePath: string; sizeBytes: number };
/** A package.json script a command runs; its command is null when it is missing or which package it belongs to is unclear. */
export type RunPackageScript = { name: string; command: string | null };
export type RunScripts = { packageScripts: RunPackageScript[]; files: RunScript[] };

type NamedPackageScript = { name: string; elsewhere: boolean; onlyIfPresent: boolean };

/** The package script a package-manager command names. Every manager but npm also runs one by its bare name, if there is one. */
function namedPackageScript(manager: string, args: readonly string[]): NamedPackageScript | null {
  const option = args.findIndex((arg) => PACKAGE_ELSEWHERE.test(arg));
  const valueIndex = option >= 0 && !(args[option] ?? '').includes('=') ? option + 1 : -1;
  const positional = args.filter((arg, index) => index !== valueIndex && !arg.startsWith('-'));
  const workspace = manager === 'yarn' && positional[0] === 'workspace';
  const [verb, target] = workspace ? positional.slice(2) : positional;
  if (verb === undefined) return null;
  const elsewhere = workspace || option >= 0;
  if (verb === 'run' || verb === 'run-script') return target === undefined ? null : { name: target, elsewhere, onlyIfPresent: false };
  const lifecycle = PACKAGE_LIFECYCLE.get(verb);
  if (manager === 'npm') return lifecycle === undefined ? null : { name: lifecycle, elsewhere, onlyIfPresent: false };
  return { name: lifecycle ?? verb, elsewhere, onlyIfPresent: true };
}

/** The package npm would use from a directory: the nearest package.json at or above it, inside the repository. */
function findPackage(cwd: string, repoRoot: string): { directory: string; scripts: Record<string, string> } | null {
  for (let directory = cwd; resolveRepoScopedPath(repoRoot, directory) !== null; directory = path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (!fs.existsSync(file)) continue;
    const scripts = parsePackageScripts(fs.readFileSync(file, 'utf8'));
    return scripts === null ? null : { directory, scripts };
  }
  return null;
}

/** Null for text that is no package.json, which npm would refuse too. */
function parsePackageScripts(text: string): Record<string, string> | null {
  try {
    return PackageJsonSchema.parse(parseJsonValueText(text)).scripts;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return null;
    throw error;
  }
}

/** Collects what a command runs, following its directory changes and the package scripts it starts. */
class RunScriptCollector {
  private readonly repoRoot: string;
  /** Keyed by package directory and name, so the same name in two packages stays two scripts. */
  private readonly packageScripts = new Map<string, RunPackageScript>();
  /** Names whose package is not known. */
  private readonly unplacedScripts = new Set<string>();
  private readonly files = new Map<string, RunScript>();

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  collect(command: string, startCwd: string): void {
    let cwd: string | null = startCwd;
    for (const { tokens, commandStarts } of splitStatements(command)) {
      for (const [order, start] of commandStarts.entries()) {
        const head = commandHead(tokens, start);
        const name = path.win32.basename(tokens[head] ?? '').toLowerCase().replace(/\.(?:exe|cmd)$/u, '');
        const args = tokens.slice(head + 1, commandStarts[order + 1]);
        if (RETURN_COMMANDS.has(name)) cwd = null;
        else if (LOCATION_COMMANDS.has(name)) cwd = this.follow(cwd, args);
        else {
          if (PACKAGE_MANAGERS.has(name)) this.addPackageScript(namedPackageScript(name, args), cwd);
          else if (name === 'node' && args[0] === '--run') this.addPackageScript(namedPackageScript('npm', ['run', ...args.slice(1)]), cwd);
          this.addFiles(tokens[head] ?? '', name, args, cwd);
        }
      }
    }
  }

  result(): RunScripts {
    return {
      packageScripts: [...this.packageScripts.values(), ...[...this.unplacedScripts].map((name) => ({ name, command: null }))],
      files: [...this.files.values()],
    };
  }

  private follow(cwd: string | null, args: readonly string[]): string | null {
    const target = args.find((arg) => !arg.startsWith('-'));
    return cwd === null || target === undefined || target.startsWith('$') ? null : resolveInside(this.repoRoot, cwd, target);
  }

  private addPackageScript(named: NamedPackageScript | null, cwd: string | null): void {
    if (named === null) return;
    const { name } = named;
    const owner = cwd === null || named.elsewhere ? null : findPackage(cwd, this.repoRoot);
    if (owner === null) {
      this.unplacedScripts.add(name);
      return;
    }
    if (named.onlyIfPresent && owner.scripts[name] === undefined) return;
    for (const step of [`pre${name}`, name, `post${name}`]) {
      const command = owner.scripts[step] ?? null;
      const key = `${owner.directory}:${step}`;
      if (this.packageScripts.has(key) || (command === null && step !== name)) continue;
      this.packageScripts.set(key, { name: step, command });
      if (command !== null) this.collect(command, owner.directory);
    }
  }

  /** Script files run directly or by their host: option values (`--import ./a.ts`), then the first operand. */
  private addFiles(head: string, host: string, args: readonly string[], cwd: string | null): void {
    if (cwd === null) return;
    if (!SCRIPT_HOSTS.has(host)) {
      this.addFile(head, cwd);
      return;
    }
    for (const [index, arg] of args.entries()) {
      if (NO_SCRIPT_OPTION.test(arg)) return;
      if (arg.startsWith('-')) continue;
      this.addFile(arg, cwd);
      if (!(args[index - 1] ?? '').startsWith('-')) return;
    }
  }

  private addFile(script: string, cwd: string): void {
    if (!SCRIPT_FILE.test(script)) return;
    const resolved = resolveRepoScopedPath(this.repoRoot, path.resolve(cwd, script));
    const stats = resolved === null ? undefined : fs.statSync(resolved.absolutePath, { throwIfNoEntry: false });
    if (resolved === null || stats?.isFile() !== true) return;
    const relativePath = resolved.relativePath.replace(/\\/gu, '/');
    this.files.set(resolved.absolutePath, { relativePath, absolutePath: resolved.absolutePath, sizeBytes: stats.size });
  }
}

/** The package scripts and repository files a command runs (`npm test`, `node probe.ts`, `.\probe.ps1`). */
export function findRunScripts(command: string, repoRoot: string): RunScripts {
  const collector = new RunScriptCollector(repoRoot);
  collector.collect(command, repoRoot);
  return collector.result();
}

/** Absolute paths in free text, such as a child's instruction, that lie outside the repository root. */
export function findPathsOutsideRepo(text: string, repoRoot: string): string[] {
  const named = [...text.matchAll(DRIVE_PATH)].map((match) => match[0].replace(/[.:]+$/u, ''));
  return [...new Set(named)].filter((candidate) => resolveInside(repoRoot, repoRoot, candidate) === null);
}

/** Why a run or run_check command may not run, judged before approval so no reviewer call is spent on it. */
export function findShellCommandProblem(call: RepoNativeToolCall, repoRoot: string): string | null {
  if (call.toolName !== 'run' && call.toolName !== 'run_check') return null;
  const cwdText = call.toolName === 'run_check' ? call.args.cwd : '.';
  const cwd = resolveInside(repoRoot, repoRoot, cwdText);
  if (cwd === null) return outsideRoot(cwdText, repoRoot);
  return findEscapingPath(call.args.command, cwd, repoRoot)
    ?? findSiftKitInvocation(call.args.command)
    ?? findEscapeForm(call.args.command)
    ?? findCutCheckOutput(call.args.command);
}
