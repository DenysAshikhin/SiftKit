import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeRuntime } from '../config/index.js';
import { buildPrompt } from '../summary/prompt.js';
import { getLocalTimestamp } from '../lib/time.js';
import {
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  type BenchmarkFixture,
  type BenchmarkRunnerOptions,
} from './types.js';

export function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

export function parseArguments(argv: string[]): BenchmarkRunnerOptions {
  const parsed: BenchmarkRunnerOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--fixture-root':
        parsed.fixtureRoot = argv[++index];
        break;
      case '--output':
        parsed.outputPath = argv[++index];
        break;
      case '--backend':
        parsed.backend = argv[++index];
        break;
      case '--model':
        parsed.model = argv[++index];
        break;
      case '--prompt-prefix':
        parsed.promptPrefix = argv[++index];
        break;
      case '--prompt-prefix-file':
        parsed.promptPrefixFile = argv[++index];
        break;
      case '--request-timeout-seconds':
        parsed.requestTimeoutSeconds = Number(argv[++index]);
        break;
      case '--temperature':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.Temperature = Number(argv[++index]);
        break;
      case '--top-p':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.TopP = Number(argv[++index]);
        break;
      case '--top-k':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.TopK = Number(argv[++index]);
        break;
      case '--min-p':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.MinP = Number(argv[++index]);
        break;
      case '--presence-penalty':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.PresencePenalty = Number(argv[++index]);
        break;
      case '--repetition-penalty':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.RepetitionPenalty = Number(argv[++index]);
        break;
      case '--max-tokens':
        parsed.llamaCppOverrides ??= {};
        parsed.llamaCppOverrides.MaxTokens = Number(argv[++index]);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}

export function resolvePromptPrefix(options: BenchmarkRunnerOptions): string | undefined {
  if (options.promptPrefix && options.promptPrefixFile) {
    throw new Error('Pass only one of --prompt-prefix or --prompt-prefix-file.');
  }

  if (options.promptPrefixFile?.trim()) {
    return fs.readFileSync(path.resolve(options.promptPrefixFile.trim()), 'utf8');
  }

  if (options.promptPrefix?.trim()) {
    return options.promptPrefix;
  }

  return undefined;
}

export function getValidatedRequestTimeoutSeconds(options: BenchmarkRunnerOptions): number {
  const timeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Request timeout seconds must be a positive number.');
  }

  return timeoutSeconds;
}

export function getDefaultOutputPath(fixtureRoot?: string): string {
  if (fixtureRoot && fixtureRoot.trim()) {
    return path.join(path.resolve(fixtureRoot), `benchmark_run_${getLocalTimestamp()}.json`);
  }

  const paths = initializeRuntime();
  return path.join(paths.EvalResults, `benchmark_run_${getLocalTimestamp()}.json`);
}

export function getPromptLabel(options: { fixture: BenchmarkFixture }): string {
  if (options.fixture.SourceCommand?.trim()) {
    return options.fixture.SourceCommand.trim();
  }

  return buildPrompt({
    question: options.fixture.Question,
    inputText: '<benchmark fixture input>',
    format: options.fixture.Format,
    policyProfile: options.fixture.PolicyProfile,
    rawReviewRequired: false,
    sourceKind: 'standalone',
  });
}
