import { inspect } from 'node:util';
import type { JsonSerializable } from '../lib/json-types.js';
import {
  normalizeCliReducerProfile,
  normalizeCliRiskLevel,
} from './request-normalizers.js';
import { parseOptionalSummaryProvider } from '../summary/types.js';
import type { SummaryProviderId } from '../summary/types.js';

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
  backend?: SummaryProviderId;
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
        parsed.backend = parseOptionalSummaryProvider(tokens[++index]);
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
        parsed.risk = normalizeCliRiskLevel(tokens[++index]);
        break;
      case '--reducer':
        parsed.reducer = normalizeCliReducerProfile(tokens[++index]);
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
      case '--response-format': {
        const responseFormatValue = tokens[++index];
        parsed.responseFormat = responseFormatValue === 'json' || responseFormatValue === 'text'
          ? responseFormatValue
          : undefined;
        break;
      }
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
        parsed.shell = tokens[++index];
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
      case '--image': {
        const value = tokens[++index];
        if (value === undefined) {
          throw new Error('Missing value for option: --image');
        }
        parsed.images = [...(parsed.images ?? []), value];
        break;
      }
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
