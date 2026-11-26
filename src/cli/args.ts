import { inspect } from 'node:util';
import type { JsonSerializable } from '../lib/json-types.ts';
import {
  normalizeCliReducerProfile,
  normalizeCliRiskLevel,
} from './request-normalizers.ts';
import { parseOptionalSummaryProvider } from '../summary/types.ts';
import type { SummaryProviderId } from '../summary/types.ts';

/** Canonical repo-search synopsis — single source for `help` and `repo-search --help`. */
export const REPO_SEARCH_SYNOPSIS =
  'siftkit repo-search --prompt "find x y z in this repo" [--model <model>] [--log-file <path>] [--interactive] [--progress]';

export type CliRunOptions = {
  argv: string[];
  stdinText?: string | Buffer;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  timing?: {
    processStartedAtMs?: number | null;
    stdinWaitMs?: number | null;
    serverPreflightMs?: number | null;
  };
};

export type ResolvedCliArgs = {
  args: string[];
};

export type ParsedArgs = {
  positionals: string[];
  question?: string;
  text?: string;
  file?: string;
  provider?: SummaryProviderId;
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
  shell?: string;
  wait?: boolean;
  interactive?: boolean;
  progress?: boolean;
  images?: string[];
};

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

export function validateRepoSearchTokens(tokens: string[]): void {
  const flagsWithValues = new Set(['--prompt', '-prompt', '--model', '--log-file', '--image']);
  const booleanFlags = new Set(['--interactive', '--progress']);
  const helpFlags = new Set(['-h', '--h', '--help', '-help']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (helpFlags.has(token)) {
      continue;
    }
    if (booleanFlags.has(token)) {
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

function readOptionValue(tokens: readonly string[], index: number, option: string): string {
  const value = tokens[index];
  if (value === undefined) throw new Error(`Missing value for option: ${option}`);
  return value;
}

export function parseArguments(tokens: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    switch (token) {
      case '--question':
        parsed.question = readOptionValue(tokens, ++index, token);
        break;
      case '--text':
        parsed.text = readOptionValue(tokens, ++index, token);
        break;
      case '--file':
        parsed.file = readOptionValue(tokens, ++index, token);
        break;
      case '--provider':
        parsed.provider = parseOptionalSummaryProvider(readOptionValue(tokens, ++index, token));
        break;
      case '--model':
        parsed.model = readOptionValue(tokens, ++index, token);
        break;
      case '--profile':
        parsed.profile = readOptionValue(tokens, ++index, token);
        break;
      case '--format':
        parsed.format = readOptionValue(tokens, ++index, token);
        break;
      case '--path':
        parsed.path = readOptionValue(tokens, ++index, token);
        break;
      case '--full-path':
        parsed.fullPath = true;
        break;
      case '--key':
        parsed.key = readOptionValue(tokens, ++index, token);
        break;
      case '--value':
        parsed.value = readOptionValue(tokens, ++index, token);
        break;
      case '--command':
        parsed.command = readOptionValue(tokens, ++index, token);
        break;
      case '--arg':
        parsed.argList ??= [];
        parsed.argList.push(readOptionValue(tokens, ++index, token));
        break;
      case '--risk':
        parsed.risk = normalizeCliRiskLevel(readOptionValue(tokens, ++index, token));
        break;
      case '--reducer':
        parsed.reducer = normalizeCliReducerProfile(readOptionValue(tokens, ++index, token));
        break;
      case '--fixture-root':
        parsed.fixtureRoot = readOptionValue(tokens, ++index, token);
        break;
      case '--codex-home':
        parsed.codexHome = readOptionValue(tokens, ++index, token);
        break;
      case '--bin-dir':
        parsed.binDir = readOptionValue(tokens, ++index, token);
        break;
      case '--module-root':
        parsed.moduleRoot = readOptionValue(tokens, ++index, token);
        break;
      case '--startup-dir':
        parsed.startupDir = readOptionValue(tokens, ++index, token);
        break;
      case '--status-path':
        parsed.statusPath = readOptionValue(tokens, ++index, token);
        break;
      case '--request-file':
        parsed.requestFile = readOptionValue(tokens, ++index, token);
        break;
      case '--response-format': {
        const responseFormatValue = readOptionValue(tokens, ++index, token);
        parsed.responseFormat = responseFormatValue === 'json' || responseFormatValue === 'text'
          ? responseFormatValue
          : undefined;
        break;
      }
      case '--op':
        parsed.op = readOptionValue(tokens, ++index, token);
        break;
      case '--prompt':
      case '-prompt':
        parsed.prompt = readOptionValue(tokens, ++index, token);
        break;
      case '--log-file':
        parsed.logFile = readOptionValue(tokens, ++index, token);
        break;
      case '--preset':
        parsed.preset = readOptionValue(tokens, ++index, token);
        break;
      case '--repo-root':
        parsed.repoRoot = readOptionValue(tokens, ++index, token);
        break;
      case '--max-turns':
        parsed.maxTurns = Number.parseInt(readOptionValue(tokens, ++index, token), 10);
        break;
      case '--shell':
        parsed.shell = readOptionValue(tokens, ++index, token);
        break;
      case '--wait':
        parsed.wait = true;
        break;
      case '--interactive':
        parsed.interactive = true;
        break;
      case '--progress':
        parsed.progress = true;
        break;
      case '--image':
        parsed.images = [...(parsed.images ?? []), readOptionValue(tokens, ++index, token)];
        break;
      default:
        parsed.positionals.push(token);
        break;
    }
  }

  return parsed;
}

export function formatPsList(value: Record<string, JsonSerializable>): string {
  const entries = Object.entries(value);
  return `${entries.map(([key, item]) => {
    const rendered = Array.isArray(item) ? item.join(', ') : inspect(item, { depth: 6, breakLength: Infinity });
    return `${key} : ${rendered}`;
  }).join('\n')}\n`;
}
