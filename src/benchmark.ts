import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfiguredModel, initializeRuntime, loadConfig, saveContentAtomically, type RuntimeLlamaCppConfig } from './config.js';
import { buildPrompt, summarizeRequest, type SummaryClassification, type SummaryRequest } from './summary.js';

type BenchmarkFixture = {
  Name: string;
  File: string;
  Question: string;
  Format: 'text' | 'json';
  PolicyProfile: SummaryRequest['policyProfile'];
  SourceCommand?: string;
};

export type BenchmarkRunnerOptions = {
  fixtureRoot?: string;
  outputPath?: string;
  backend?: string;
  model?: string;
  promptPrefix?: string;
  promptPrefixFile?: string;
  llamaCppOverrides?: Pick<
    RuntimeLlamaCppConfig,
    'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'
  >;
};

export type BenchmarkCaseResult = {
  Prompt: string;
  Output: string | null;
  DurationMs: number;
  PolicyDecision: string;
  Classification: SummaryClassification | null;
  RawReviewRequired: boolean;
  ModelCallSucceeded: boolean;
  Error: string | null;
};

export type BenchmarkRunResult = {
  TotalDurationMs: number;
  StartedAtUtc: string;
  CompletedAtUtc: string;
  Backend: string;
  Model: string;
  FixtureRoot: string;
  OutputPath: string;
  PromptPrefix: string | null;
  Results: BenchmarkCaseResult[];
};

function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function parseArguments(argv: string[]): BenchmarkRunnerOptions {
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

function getFixtureManifest(fixtureRoot: string): BenchmarkFixture[] {
  const manifestPath = path.join(fixtureRoot, 'fixtures.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BenchmarkFixture[];
}

function resolvePromptPrefix(options: BenchmarkRunnerOptions): string | undefined {
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

function getTimestamp(): string {
  const current = new Date();
  const yyyy = current.getFullYear();
  const MM = String(current.getMonth() + 1).padStart(2, '0');
  const dd = String(current.getDate()).padStart(2, '0');
  const hh = String(current.getHours()).padStart(2, '0');
  const mm = String(current.getMinutes()).padStart(2, '0');
  const ss = String(current.getSeconds()).padStart(2, '0');
  const fff = String(current.getMilliseconds()).padStart(3, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}

function getDefaultOutputPath(fixtureRoot?: string): string {
  if (fixtureRoot && fixtureRoot.trim()) {
    return path.join(path.resolve(fixtureRoot), `benchmark_run_${getTimestamp()}.json`);
  }

  const paths = initializeRuntime();
  return path.join(paths.EvalResults, `benchmark_run_${getTimestamp()}.json`);
}

function getPromptLabel(options: {
  fixture: BenchmarkFixture;
}): string {
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

export async function runBenchmarkSuite(options: BenchmarkRunnerOptions = {}): Promise<BenchmarkRunResult> {
  const fixtureRoot = path.resolve(options.fixtureRoot || path.join(getRepoRoot(), 'eval', 'fixtures'));
  const outputPath = path.resolve(options.outputPath || getDefaultOutputPath(fixtureRoot));
  const manifest = getFixtureManifest(fixtureRoot);
  const config = await loadConfig({ ensure: true });
  const backend = options.backend || config.Backend;
  const model = options.model || getConfiguredModel(config);
  const promptPrefix = resolvePromptPrefix(options);
  const startedAt = new Date();
  const startedAtHr = process.hrtime.bigint();
  const results: BenchmarkCaseResult[] = [];

  for (const fixture of manifest) {
    const sourcePath = path.join(fixtureRoot, fixture.File);
    const inputText = fs.readFileSync(sourcePath, 'utf8');
    const prompt = getPromptLabel({ fixture });

    const caseStartedAtHr = process.hrtime.bigint();
    try {
      const response = await summarizeRequest({
        question: fixture.Question,
        inputText,
        format: fixture.Format,
        policyProfile: fixture.PolicyProfile,
        backend,
        model,
        promptPrefix,
        llamaCppOverrides: options.llamaCppOverrides,
        sourceKind: 'standalone',
      });
      const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;

      results.push({
        Prompt: prompt,
        Output: response.Summary,
        DurationMs: Math.round(caseDurationMs * 1000) / 1000,
        PolicyDecision: response.PolicyDecision,
        Classification: response.Classification,
        RawReviewRequired: response.RawReviewRequired,
        ModelCallSucceeded: response.ModelCallSucceeded,
        Error: response.ProviderError,
      });
    } catch (error) {
      const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        Prompt: prompt,
        Output: null,
        DurationMs: Math.round(caseDurationMs * 1000) / 1000,
        PolicyDecision: 'provider-error',
        Classification: null,
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        Error: message,
      });
    }
  }

  const completedAt = new Date();
  const totalDurationMs = Number(process.hrtime.bigint() - startedAtHr) / 1_000_000;
  const artifact: BenchmarkRunResult = {
    TotalDurationMs: Math.round(totalDurationMs * 1000) / 1000,
    StartedAtUtc: startedAt.toISOString(),
    CompletedAtUtc: completedAt.toISOString(),
    Backend: backend,
    Model: model,
    FixtureRoot: fixtureRoot,
    OutputPath: outputPath,
    PromptPrefix: promptPrefix ?? null,
    Results: results,
  };

  saveContentAtomically(outputPath, JSON.stringify(artifact, null, 2));
  return artifact;
}

async function main(): Promise<void> {
  const result = await runBenchmarkSuite(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${result.OutputPath}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
