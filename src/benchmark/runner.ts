import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfiguredModel, loadConfig } from '../config/index.js';
import { summarizeRequest } from '../summary/core.js';
import { formatElapsed } from '../lib/time.js';
import {
  getDefaultOutputPath,
  getPromptLabel,
  getRepoRoot,
  getValidatedRequestTimeoutSeconds,
  parseArguments,
  resolvePromptPrefix,
} from './args.js';
import { getFixtureManifest } from './fixtures.js';
import {
  createFixtureHeartbeat,
  createInterruptSignal,
  isTimeoutError,
  runWithFixtureDeadline,
} from './interrupt.js';
import { buildBenchmarkArtifact, roundDuration } from './report.js';
import {
  FatalBenchmarkError,
  type BenchmarkCaseResult,
  type BenchmarkRunResult,
  type BenchmarkRunnerOptions,
} from './types.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import { persistBenchmarkRun } from '../state/runtime-results.js';

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
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  const persistedBenchmarkRun = persistBenchmarkRun({
    payload: artifact as unknown as Record<string, unknown>,
  });
  upsertRuntimeJsonArtifact({
    artifactKind: 'benchmark_run',
    id: persistedBenchmarkRun.id,
    title: outputPath,
    payload: artifact as unknown as Record<string, unknown>,
  });
  if (fatalException !== null) {
    throw new FatalBenchmarkError(fatalError ?? (fatalException instanceof Error ? fatalException.message : String(fatalException)));
  }

  return {
    ...artifact,
    OutputPath: outputPath,
    BenchmarkRunUri: persistedBenchmarkRun.uri,
  };
}

export async function main(): Promise<void> {
  const result = await runBenchmarkSuite(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${result.BenchmarkRunUri || result.OutputPath}\n`);
}
