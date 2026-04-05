import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, writeJsonFile } from '../lib/fs.js';
import { resolvePathFromBase } from '../lib/paths.js';
import { getUtcTimestamp } from '../lib/time.js';
import { parseArguments } from './args.js';
import { getBenchmarkProcessPaths, invokeBenchmarkProcess } from './benchmark-runner.js';
import { invokeConfigGet } from './config-rpc.js';
import { createMatrixInterruptSignal, withMatrixInterrupt } from './interrupt.js';
import { buildLaunchSignature, restartLlamaForTarget } from './launcher.js';
import { readMatrixManifest } from './manifest.js';
import {
  repoRoot,
  type MatrixCliOptions,
  type MatrixIndex,
  type RunEntry,
} from './types.js';

function writeMatrixIndex(filePath: string, index: MatrixIndex): void {
  writeJsonFile(filePath, index);
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
    process.stdout.write(`Results  : ${manifest.resultsRoot}\n`);
    if (resolvedPromptPrefixFile) {
      process.stdout.write(`Prefix   : ${resolvedPromptPrefixFile}\n`);
    }
    process.stdout.write(`Run ids  : ${manifest.selectedRuns.map((run) => run.id).join(', ')}\n`);
    return;
  }

  const sessionDirectory = path.join(manifest.resultsRoot, getUtcTimestamp());
  ensureDirectory(sessionDirectory);
  const snapshotPath = path.join(sessionDirectory, 'pre_run_config_snapshot.json');
  const resolvedManifestPath = path.join(sessionDirectory, 'resolved_manifest.json');
  const indexPath = path.join(sessionDirectory, 'matrix_index.json');
  const initialConfig = await invokeConfigGet(manifest.configUrl);
  writeJsonFile(snapshotPath, initialConfig);
  writeJsonFile(resolvedManifestPath, manifest);

  const matrixIndex: MatrixIndex = {
    manifestPath: manifest.manifestPath,
    resolvedManifestPath,
    fixtureRoot: manifest.fixtureRoot,
    resultsRoot: manifest.resultsRoot,
    sessionDirectory,
    configUrl: manifest.configUrl,
    promptPrefixFile: resolvedPromptPrefixFile,
    selectedRunIds: manifest.selectedRuns.map((run) => run.id),
    startedAtUtc: new Date().toISOString(),
    completedAtUtc: null,
    status: 'running',
    configSnapshotPath: snapshotPath,
    baselineRestore: {
      status: 'pending',
      error: null,
    },
    runs: [],
  };
  writeMatrixIndex(indexPath, matrixIndex);

  let currentLaunchSignature: string | null = null;
  let capturedError: unknown = null;
  let restoreError: unknown = null;
  let activeRunEntry: RunEntry | null = null;
  const interruptSignal = interruptSignalOverride ?? createMatrixInterruptSignal((error) => {
    if (activeRunEntry && activeRunEntry.status === 'running') {
      activeRunEntry.status = 'failed';
      activeRunEntry.error = error.message;
      activeRunEntry.completedAtUtc = new Date().toISOString();
    }
    matrixIndex.status = 'failed';
    writeMatrixIndex(indexPath, matrixIndex);
  });

  try {
    await withMatrixInterrupt(
      restartLlamaForTarget(manifest, manifest.baseline, sessionDirectory),
      interruptSignal.interrupted,
    );
    currentLaunchSignature = buildLaunchSignature(manifest.baseline);

    for (const run of manifest.selectedRuns) {
      const outputPath = path.join(sessionDirectory, `${String(run.index).padStart(2, '0')}_${run.id}.json`);
      const benchmarkPaths = getBenchmarkProcessPaths(sessionDirectory, run);
      const runEntry: RunEntry = {
        index: run.index,
        id: run.id,
        label: run.label,
        modelId: run.modelId,
        modelPath: run.resolvedModelPath,
        startScript: run.startScript,
        promptPrefixFile: run.promptPrefixFile,
        reasoning: run.reasoning,
        sampling: run.sampling,
        outputPath,
        benchmarkStdoutPath: benchmarkPaths.stdoutPath,
        benchmarkStderrPath: benchmarkPaths.stderrPath,
        startedAtUtc: new Date().toISOString(),
        completedAtUtc: null,
        status: 'running',
        error: null,
      };
      activeRunEntry = runEntry;
      matrixIndex.runs.push(runEntry);
      writeMatrixIndex(indexPath, matrixIndex);

      process.stdout.write(`Running [${run.id}] ${run.label}\n`);
      try {
        const requiredLaunchSignature = buildLaunchSignature(run);
        if (currentLaunchSignature !== requiredLaunchSignature) {
          await withMatrixInterrupt(
            restartLlamaForTarget(manifest, run, sessionDirectory),
            interruptSignal.interrupted,
          );
          currentLaunchSignature = requiredLaunchSignature;
        }

        const benchmarkResult = await withMatrixInterrupt(
          invokeBenchmarkProcess(
            manifest,
            run,
            outputPath,
            sessionDirectory,
            run.promptPrefixFile ?? resolvedPromptPrefixFile
          ),
          interruptSignal.interrupted
        );
        runEntry.benchmarkStdoutPath = benchmarkResult.stdoutPath;
        runEntry.benchmarkStderrPath = benchmarkResult.stderrPath;
        runEntry.status = 'completed';
        runEntry.completedAtUtc = new Date().toISOString();
        writeMatrixIndex(indexPath, matrixIndex);
        activeRunEntry = null;
      } catch (error) {
        runEntry.status = 'failed';
        runEntry.error = error instanceof Error ? error.message : String(error);
        runEntry.completedAtUtc = new Date().toISOString();
        matrixIndex.status = 'failed';
        writeMatrixIndex(indexPath, matrixIndex);
        activeRunEntry = null;
        throw error;
      }
    }

    matrixIndex.status = 'completed';
  } catch (error) {
    capturedError = error;
    matrixIndex.status = 'failed';
  } finally {
    interruptSignal.dispose();
    try {
      await restartLlamaForTarget(manifest, manifest.baseline, sessionDirectory);
      matrixIndex.baselineRestore.status = 'completed';
    } catch (error) {
      restoreError = error;
      matrixIndex.baselineRestore.status = 'failed';
      matrixIndex.baselineRestore.error = error instanceof Error ? error.message : String(error);
    }

    matrixIndex.completedAtUtc = new Date().toISOString();
    writeMatrixIndex(indexPath, matrixIndex);
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

  process.stdout.write(`Benchmark matrix completed successfully. Session directory: ${sessionDirectory}\n`);
}

export async function runMatrix(options: MatrixCliOptions): Promise<void> {
  await runMatrixWithInterrupt(options);
}

export async function main(): Promise<void> {
  await runMatrix(parseArguments(process.argv.slice(2)));
}
