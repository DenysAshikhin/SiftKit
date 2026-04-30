import { inspect } from 'node:util';
import type { ShellName } from '../capture/process.js';

export type CliRunOptions = {
  argv: string[];
  stdinText?: string | Buffer;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  timing?: {
    processStartedAtMs?: number | null;
    stdinWaitMs?: number | null;
    serverPreflightMs?: number | null;
  };
};

export type ParsedArgs = {
  positionals: string[];
  question?: string;
  text?: string;
  file?: string;
  backend?: string;
  model?: string;
  profile?: string;
  format?: string;
  path?: string;
  fullPath?: boolean;
  key?: string;
  value?: string;
  command?: string;
  argList?: string[];
  risk?: 'informational' | 'debug' | 'risky';
  reducer?: 'smart' | 'errors' | 'tail' | 'diff' | 'none';
  fixtureRoot?: string;
  codexHome?: string;
  binDir?: string;
  moduleRoot?: string;
  startupDir?: string;
  statusPath?: string;
  requestFile?: string;
  responseFormat?: 'json' | 'text';
  op?: string;
  prompt?: string;
  logFile?: string;
  preset?: string;
  repoRoot?: string;
  maxTurns?: number;
  shell?: ShellName;
};

export const KNOWN_COMMANDS = new Set([
  'summary',
  'repo-search',
  'preset',
  'run',
  'find-files',
  'internal',
]);

export const BLOCKED_PUBLIC_COMMANDS = new Set([
  'install',
  'test',
  'eval',
  'codex-policy',
  'install-global',
  'config-get',
  'config-set',
  'capture-internal',
]);

export const SERVER_DEPENDENT_COMMANDS = new Set([
  'install',
  'test',
  'eval',
  'config-get',
  'config-set',
  'capture-internal',
  'repo-search',
]);

export const SERVER_DEPENDENT_INTERNAL_OPS = new Set([
  'install',
  'test',
  'config-get',
  'config-set',
  'summary',
  'command',
  'command-analyze',
  'eval',
  'interactive-capture',
  'repo-search',
]);

export function getCommandName(argv: string[]): string {
  if (argv.length > 0 && KNOWN_COMMANDS.has(argv[0])) {
    return argv[0];
  }
  if (argv[0] === '--prompt' || argv[0] === '-prompt') {
    return 'repo-search';
  }

  return 'summary';
}

export function getCommandArgs(argv: string[]): string[] {
  const commandName = getCommandName(argv);
  if (commandName === 'repo-search' && (argv[0] === '--prompt' || argv[0] === '-prompt')) {
    return argv;
  }
  if (commandName === 'summary' && (argv.length === 0 || !KNOWN_COMMANDS.has(argv[0]))) {
    return argv;
  }

  return argv.slice(1);
}

export function validateRepoSearchTokens(tokens: string[]): void {
  const flagsWithValues = new Set(['--prompt', '-prompt', '--model', '--log-file']);
  const helpFlags = new Set(['-h', '--h', '--help', '-help']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (helpFlags.has(token)) {
      continue;
    }
    if (flagsWithValues.has(token)) {
      if (tokens[index + 1] === undefined) {
        throw new Error(`Missing value for repo-search option: ${token}`);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option for repo-search: ${token}`);
    }
  }
}

export function parseArguments(tokens: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    switch (token) {
      case '--question':
        parsed.question = tokens[++index];
        break;
      case '--text':
        parsed.text = tokens[++index];
        break;
      case '--file':
        parsed.file = tokens[++index];
        break;
      case '--backend':
        parsed.backend = tokens[++index];
        break;
      case '--model':
        parsed.model = tokens[++index];
        break;
      case '--profile':
        parsed.profile = tokens[++index];
        break;
      case '--format':
        parsed.format = tokens[++index];
        break;
      case '--path':
        parsed.path = tokens[++index];
        break;
      case '--full-path':
        parsed.fullPath = true;
        break;
      case '--key':
        parsed.key = tokens[++index];
        break;
      case '--value':
        parsed.value = tokens[++index];
        break;
      case '--command':
        parsed.command = tokens[++index];
        break;
      case '--arg':
        parsed.argList ??= [];
        parsed.argList.push(tokens[++index]);
        break;
      case '--risk':
        parsed.risk = tokens[++index] as ParsedArgs['risk'];
        break;
      case '--reducer':
        parsed.reducer = tokens[++index] as ParsedArgs['reducer'];
        break;
      case '--fixture-root':
        parsed.fixtureRoot = tokens[++index];
        break;
      case '--codex-home':
        parsed.codexHome = tokens[++index];
        break;
      case '--bin-dir':
        parsed.binDir = tokens[++index];
        break;
      case '--module-root':
        parsed.moduleRoot = tokens[++index];
        break;
      case '--startup-dir':
        parsed.startupDir = tokens[++index];
        break;
      case '--status-path':
        parsed.statusPath = tokens[++index];
        break;
      case '--request-file':
        parsed.requestFile = tokens[++index];
        break;
      case '--response-format':
        parsed.responseFormat = tokens[++index] as ParsedArgs['responseFormat'];
        break;
      case '--op':
        parsed.op = tokens[++index];
        break;
      case '--prompt':
      case '-prompt':
        parsed.prompt = tokens[++index];
        break;
      case '--log-file':
        parsed.logFile = tokens[++index];
        break;
      case '--preset':
        parsed.preset = tokens[++index];
        break;
      case '--repo-root':
        parsed.repoRoot = tokens[++index];
        break;
      case '--max-turns':
        parsed.maxTurns = Number.parseInt(tokens[++index] || '', 10);
        break;
      case '--shell':
        parsed.shell = tokens[++index] as ShellName;
        break;
      default:
        parsed.positionals.push(token);
        break;
    }
  }

  return parsed;
}

export function formatPsList(value: unknown): string {
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  return `${entries.map(([key, item]) => {
    const rendered = Array.isArray(item) ? item.join(', ') : inspect(item, { depth: 6, breakLength: Infinity });
    return `${key} : ${rendered}`;
  }).join('\n')}\n`;
}
