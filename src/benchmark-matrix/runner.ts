import * as fs from 'node:fs';
import { resolvePathFromBase } from '../lib/paths.js';
import {
  createBenchmarkMatrixRun,
  createBenchmarkMatrixSession,
  getBenchmarkMatrixRunUri,
  getBenchmarkMatrixSessionUri,
  updateBenchmarkMatrixRun,
  updateBenchmarkMatrixSession,
} from '../state/benchmark-matrix.js';
import { parseArguments } from './args.js';
import { invokeBenchmarkProcess } from './benchmark-runner.js';
import { createMatrixInterruptSignal, withMatrixInterrupt } from './interrupt.js';
import { buildLaunchSignature, restartLlamaForTarget } from './launcher.js';
import { readMatrixManifest } from './manifest.js';
import {
  repoRoot,
  type MatrixCliOptions,
  type MatrixIndex,
  type RunEntry,
} from './types.js';

function toRunEntry(params: {
  recordId: string;
  runId: string;
  index: number;
  label: string;
  modelId: string;
  modelPath: string;
  startScript: string;
  promptPrefixFile: string | null;
  reasoning: 'on' | 'off' | 'auto';
  sampling: RunEntry['sampling'];
  startedAtUtc: string;
}): RunEntry {
  return {
    id: params.recordId,
    uri: getBenchmarkMatrixRunUri(params.recordId),
    runId: params.runId,
    index: params.index,
    label: params.label,
    modelId: params.modelId,
    modelPath: params.modelPath,
    startScript: params.startScript,
    promptPrefixFile: params.promptPrefixFile,
    reasoning: params.reasoning,
    sampling: params.sampling,
    benchmarkRunUri: null,
    startedAtUtc: params.startedAtUtc,
    completedAtUtc: null,
    status: 'running',
    error: null,
  };
}

export async function runMatrixWithInterrupt(
  options: MatrixCliOptions,
  interruptSignalOverride?: {
    interrupted: Promise<never>;
    dispose: () => void;
  },
): Promise<void> {
  const manifest = readMatrixManifest(options);
  const resolvedPromptPrefixFile = options.promptPrefixFile
    ? resolvePathFromBase(options.promptPrefixFile, repoRoot)
    : manifest.promptPrefixFile;

  if (resolvedPromptPrefixFile && !fs.existsSync(resolvedPromptPrefixFile)) {
    throw new Error(`Prompt prefix file does not exist: ${resolvedPromptPrefixFile}`);
  }

  if (options.validateOnly) {
    process.stdout.write('Manifest validation passed.\n');
    process.stdout.write(`Manifest : ${manifest.manifestPath}\n`);
    process.stdout.write(`Fixture  : ${manifest.fixtureRoot}\n`);
    process.stdout.write(`Run ids  : ${manifest.selectedRuns.map((run) => run.id).join(', ')}\n`);
    return;
  }

  const startedAtUtc = new Date().toISOString();
  const sessionRecord = createBenchmarkMatrixSession({
    manifestPath: manifest.manifestPath,
    fixtureRoot: manifest.fixtureRoot,
    configUrl: manifest.configUrl,
    promptPrefixFile: resolvedPromptPrefixFile,
    requestTimeoutSeconds: manifest.requestTimeoutSeconds,
    selectedRunIds: manifest.selectedRuns.map((run) => run.id),
  });
  const matrixIndex: MatrixIndex = {
    id: sessionRecord.id,
    uri: getBenchmarkMatrixSessionUri(sessionRecord.id),
    manifestPath: manifest.manifestPath,
    fixtureRoot: manifest.fixtureRoot,
    configUrl: manifest.configUrl,
    promptPrefixFile: resolvedPromptPrefixFile,
    selectedRunIds: manifest.selectedRuns.map((run) => run.id),
    startedAtUtc,
    completedAtUtc: null,
    status: 'running',
    baselineRestore: {
      status: 'pending',
      error: null,
    },
    runs: [],
  };

  let currentLaunchSignature: string | null = null;
  let capturedError: unknown = null;
  let restoreError: unknown = null;
  let activeRunEntry: RunEntry | null = null;
  const interruptSignal = interruptSignalOverride ?? createMatrixInterruptSignal((error) => {
    if (activeRunEntry && activeRunEntry.status === 'running') {
      activeRunEntry.status = 'failed';
      activeRunEntry.error = error.message;
      activeRunEntry.completedAtUtc = new Date().toISOString();
      updateBenchmarkMatrixRun({
        id: activeRunEntry.id,
        status: 'failed',
        errorMessage: error.message,
        completedAtUtc: activeRunEntry.completedAtUtc,
      });
    }
    matrixIndex.status = 'failed';
    updateBenchmarkMatrixSession({
      id: sessionRecord.id,
      status: 'failed',
    });
  });

  try {
    await withMatrixInterrupt(
      restartLlamaForTarget(manifest, manifest.baseline, null),
      interruptSignal.interrupted,
    );
    currentLaunchSignature = buildLaunchSignature(manifest.baseline);

    for (const run of manifest.selectedRuns) {
      const runRecord = createBenchmarkMatrixRun({
        sessionId: sessionRecord.id,
        runIndex: run.index,
        runIdentifier: run.id,
        label: run.label,
        modelId: run.modelId,
        modelPath: run.resolvedModelPath,
        startScript: run.startScript,
        promptPrefixFile: run.promptPrefixFile,
        reasoning: run.reasoning,
        sampling: run.sampling || null,
      });
      const runEntry = toRunEntry({
        recordId: runRecord.id,
        runId: run.id,
        index: run.index,
        label: run.label,
        modelId: run.modelId,
        modelPath: run.resolvedModelPath,
        startScript: run.startScript,
        promptPrefixFile: run.promptPrefixFile,
        reasoning: run.reasoning,
        sampling: run.sampling,
        startedAtUtc: runRecord.startedAtUtc,
      });
      activeRunEntry = runEntry;
      matrixIndex.runs.push(runEntry);

      process.stdout.write(`Running [${run.id}] ${run.label}\n`);
      try {
        const requiredLaunchSignature = buildLaunchSignature(run);
        if (currentLaunchSignature !== requiredLaunchSignature) {
          await withMatrixInterrupt(
            restartLlamaForTarget(manifest, run, runRecord.id),
            interruptSignal.interrupted,
          );
          currentLaunchSignature = requiredLaunchSignature;
        }

        const benchmarkResult = await withMatrixInterrupt(
          invokeBenchmarkProcess(
            manifest,
            run,
            run.promptPrefixFile ?? resolvedPromptPrefixFile,
            runRecord.id,
          ),
          interruptSignal.interrupted,
        );

        const completedAtUtc = new Date().toISOString();
        updateBenchmarkMatrixRun({
          id: runRecord.id,
          status: 'completed',
          benchmarkRunUri: benchmarkResult.benchmarkRunUri,
          completedAtUtc,
        });
        runEntry.benchmarkRunUri = benchmarkResult.benchmarkRunUri;
        runEntry.status = 'completed';
        runEntry.completedAtUtc = completedAtUtc;
        activeRunEntry = null;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const completedAtUtc = new Date().toISOString();
        updateBenchmarkMatrixRun({
          id: runRecord.id,
          status: 'failed',
          errorMessage,
          completedAtUtc,
        });
        runEntry.status = 'failed';
        runEntry.error = errorMessage;
        runEntry.completedAtUtc = completedAtUtc;
        matrixIndex.status = 'failed';
        updateBenchmarkMatrixSession({
          id: sessionRecord.id,
          status: 'failed',
        });
        activeRunEntry = null;
        throw error;
      }
    }

    matrixIndex.status = 'completed';
    updateBenchmarkMatrixSession({
      id: sessionRecord.id,
      status: 'completed',
    });
  } catch (error) {
    capturedError = error;
    matrixIndex.status = 'failed';
    updateBenchmarkMatrixSession({
      id: sessionRecord.id,
      status: 'failed',
    });
  } finally {
    interruptSignal.dispose();
    try {
      await restartLlamaForTarget(manifest, manifest.baseline, null);
      matrixIndex.baselineRestore.status = 'completed';
      updateBenchmarkMatrixSession({
        id: sessionRecord.id,
        baselineRestoreStatus: 'completed',
      });
    } catch (error) {
      restoreError = error;
      matrixIndex.baselineRestore.status = 'failed';
      matrixIndex.baselineRestore.error = error instanceof Error ? error.message : String(error);
      updateBenchmarkMatrixSession({
        id: sessionRecord.id,
        baselineRestoreStatus: 'failed',
        baselineRestoreError: matrixIndex.baselineRestore.error,
      });
    }

    matrixIndex.completedAtUtc = new Date().toISOString();
    updateBenchmarkMatrixSession({
      id: sessionRecord.id,
      status: matrixIndex.status,
      completedAtUtc: matrixIndex.completedAtUtc,
    });
  }

  if (capturedError !== null && restoreError !== null) {
    const runError = capturedError instanceof Error ? capturedError.message : String(capturedError);
    const baselineError = restoreError instanceof Error ? restoreError.message : String(restoreError);
    throw new Error(`Benchmark matrix failed: ${runError} Baseline restore also failed: ${baselineError}`);
  }
  if (capturedError !== null) {
    throw capturedError;
  }
  if (restoreError !== null) {
    throw restoreError;
  }

  process.stdout.write(`Benchmark matrix completed successfully. Session URI: ${matrixIndex.uri}\n`);
}

export async function runMatrix(options: MatrixCliOptions): Promise<void> {
  await runMatrixWithInterrupt(options);
}

export async function main(): Promise<void> {
  await runMatrix(parseArguments(process.argv.slice(2)));
}
