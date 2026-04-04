import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfiguredModel, initializeRuntime, loadConfig, saveContentAtomically, type RuntimeLlamaCppConfig } from './config.js';
import { buildPrompt, summarizeRequest, type SummaryClassification, type SummaryRequest } from './summary.js';
import { formatElapsed, getLocalTimestamp } from './lib/time.js';

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
  requestTimeoutSeconds?: number;
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
  Status: 'completed' | 'failed';
  TotalDurationMs: number;
  StartedAtUtc: string;
  CompletedAtUtc: string;
  Backend: string;
  Model: string;
  FixtureRoot: string;
  OutputPath: string;
  PromptPrefix: string | null;
  CompletedFixtureCount: number;
  FatalError: string | null;
  Results: BenchmarkCaseResult[];
};

const DEFAULT_REQUEST_TIMEOUT_SECONDS = 1800;
const BENCHMARK_HEARTBEAT_MS = 15_000;

class FatalBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalBenchmarkError';
  }
}

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

function getValidatedRequestTimeoutSeconds(options: BenchmarkRunnerOptions): number {
  const timeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Request timeout seconds must be a positive number.');
  }

  return timeoutSeconds;
}

function getDefaultOutputPath(fixtureRoot?: string): string {
  if (fixtureRoot && fixtureRoot.trim()) {
    return path.join(path.resolve(fixtureRoot), `benchmark_run_${getLocalTimestamp()}.json`);
  }

  const paths = initializeRuntime();
  return path.join(paths.EvalResults, `benchmark_run_${getLocalTimestamp()}.json`);
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

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 1000) / 1000;
}

function buildBenchmarkArtifact(options: {
  status: BenchmarkRunResult['Status'];
  startedAt: Date;
  backend: string;
  model: string;
  fixtureRoot: string;
  outputPath: string;
  promptPrefix: string | undefined;
  results: BenchmarkCaseResult[];
  startedAtHr: bigint;
  fatalError: string | null;
}): BenchmarkRunResult {
  const completedAt = new Date();
  const totalDurationMs = Number(process.hrtime.bigint() - options.startedAtHr) / 1_000_000;
  return {
    Status: options.status,
    TotalDurationMs: roundDuration(totalDurationMs),
    StartedAtUtc: options.startedAt.toISOString(),
    CompletedAtUtc: completedAt.toISOString(),
    Backend: options.backend,
    Model: options.model,
    FixtureRoot: options.fixtureRoot,
    OutputPath: options.outputPath,
    PromptPrefix: options.promptPrefix ?? null,
    CompletedFixtureCount: options.results.length,
    FatalError: options.fatalError,
    Results: options.results,
  };
}

function createInterruptSignal(): {
  interrupted: Promise<never>;
  dispose: () => void;
} {
  let rejectInterrupted: (reason?: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  let active = true;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!active) {
      return;
    }
    active = false;
    rejectInterrupted(new FatalBenchmarkError(`Benchmark interrupted by ${signal}.`));
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    interrupted,
    dispose: () => {
      active = false;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

function createFixtureHeartbeat(options: {
  fixtureLabel: string;
  fixtureIndex: number;
  fixtureCount: number;
  startedAtMs: number;
}): NodeJS.Timeout {
  const handle = setInterval(() => {
    const elapsedMs = Date.now() - options.startedAtMs;
    process.stdout.write(
      `Fixture ${options.fixtureIndex}/${options.fixtureCount} [${options.fixtureLabel}] still running after ${formatElapsed(elapsedMs)}\n`
    );
  }, BENCHMARK_HEARTBEAT_MS);
  if (typeof handle.unref === 'function') {
    handle.unref();
  }

  return handle;
}

async function runWithFixtureDeadline<T>(operation: Promise<T>, options: {
  fixtureLabel: string;
  requestTimeoutSeconds: number;
  interrupted: Promise<never>;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new FatalBenchmarkError(
        `Benchmark fixture '${options.fixtureLabel}' timed out after ${options.requestTimeoutSeconds} seconds.`
      ));
    }, options.requestTimeoutSeconds * 1000);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    const resolveOnce = (value: T): void => {
      clearTimeout(timeoutHandle);
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      clearTimeout(timeoutHandle);
      reject(error);
    };

    operation.then(
      (value) => resolveOnce(value),
      (error) => rejectOnce(error),
    );
    options.interrupted.then(
      () => undefined,
      (error) => rejectOnce(error),
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\btimed out after\b/iu.test(message);
}

export async function runBenchmarkSuite(options: BenchmarkRunnerOptions = {}): Promise<BenchmarkRunResult> {
  const fixtureRoot = path.resolve(options.fixtureRoot || path.join(getRepoRoot(), 'eval', 'fixtures'));
  const outputPath = path.resolve(options.outputPath || getDefaultOutputPath(fixtureRoot));
  const manifest = getFixtureManifest(fixtureRoot);
  const config = await loadConfig({ ensure: true });
  const backend = options.backend || config.Backend;
  const model = options.model || getConfiguredModel(config);
  const promptPrefix = resolvePromptPrefix(options);
  const requestTimeoutSeconds = getValidatedRequestTimeoutSeconds(options);
  const startedAt = new Date();
  const startedAtHr = process.hrtime.bigint();
  const results: BenchmarkCaseResult[] = [];
  const interruptSignal = createInterruptSignal();
  let fatalError: string | null = null;
  let fatalException: unknown = null;

  try {
    for (let index = 0; index < manifest.length; index += 1) {
      const fixture = manifest[index];
      const fixtureLabel = fixture.Name || fixture.File;
      const sourcePath = path.join(fixtureRoot, fixture.File);
      const inputText = fs.readFileSync(sourcePath, 'utf8');
      const prompt = getPromptLabel({ fixture });
      const caseStartedAtHr = process.hrtime.bigint();
      const caseStartedAtMs = Date.now();
      const heartbeat = createFixtureHeartbeat({
        fixtureLabel,
        fixtureIndex: index + 1,
        fixtureCount: manifest.length,
        startedAtMs: caseStartedAtMs,
      });

      process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] start\n`);
      try {
        const response = await runWithFixtureDeadline(
          summarizeRequest({
            question: fixture.Question,
            inputText,
            format: fixture.Format,
            policyProfile: fixture.PolicyProfile,
            backend,
            model,
            promptPrefix,
            requestTimeoutSeconds,
            llamaCppOverrides: options.llamaCppOverrides,
            sourceKind: 'standalone',
          }),
          {
            fixtureLabel,
            requestTimeoutSeconds,
            interrupted: interruptSignal.interrupted,
          }
        );
        const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
        clearInterval(heartbeat);

        results.push({
          Prompt: prompt,
          Output: response.Summary,
          DurationMs: roundDuration(caseDurationMs),
          PolicyDecision: response.PolicyDecision,
          Classification: response.Classification,
          RawReviewRequired: response.RawReviewRequired,
          ModelCallSucceeded: response.ModelCallSucceeded,
          Error: response.ProviderError,
        });
        process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] completed in ${formatElapsed(caseDurationMs)}\n`);
      } catch (error) {
        const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
        clearInterval(heartbeat);
        const message = error instanceof Error ? error.message : String(error);
        fatalError = error instanceof FatalBenchmarkError || isTimeoutError(error)
          ? message
          : `Benchmark fixture '${fixtureLabel}' failed: ${message}`;
        fatalException = error;
        process.stdout.write(
          `Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] failed fatally after ${formatElapsed(caseDurationMs)}: ${message}\n`
        );
        break;
      }
    }
  } finally {
    interruptSignal.dispose();
  }

  const artifact = buildBenchmarkArtifact({
    status: fatalError === null ? 'completed' : 'failed',
    startedAt,
    backend,
    model,
    fixtureRoot,
    outputPath,
    promptPrefix,
    results,
    startedAtHr,
    fatalError,
  });

  saveContentAtomically(outputPath, JSON.stringify(artifact, null, 2));
  if (fatalException !== null) {
    throw new FatalBenchmarkError(fatalError ?? (fatalException instanceof Error ? fatalException.message : String(fatalException)));
  }

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
