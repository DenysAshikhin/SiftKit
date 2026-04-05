import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBenchmarkArgs } from './launcher.js';
import { readTrimmedFileText } from './manifest.js';
import { spawnAndWait } from './process.js';
import {
  nodeExe,
  repoRoot,
  type BenchmarkProcessResult,
  type ResolvedMatrixManifest,
  type ResolvedMatrixTarget,
} from './types.js';

export function getBenchmarkProcessPaths(
  sessionDirectory: string,
  run: ResolvedMatrixTarget,
): {
  stdoutPath: string;
  stderrPath: string;
  runtimeStatusPath: string;
} {
  return {
    stdoutPath: path.join(sessionDirectory, `benchmark_${run.index}_${run.id}_stdout.log`),
    stderrPath: path.join(sessionDirectory, `benchmark_${run.index}_${run.id}_stderr.log`),
    runtimeStatusPath: path.join(sessionDirectory, `runtime_${run.index}_${run.id}`, 'status', 'inference.txt'),
  };
}

export async function invokeBenchmarkProcess(
  manifest: ResolvedMatrixManifest,
  run: ResolvedMatrixTarget,
  outputPath: string,
  sessionDirectory: string,
  promptPrefixFile: string | null,
): Promise<BenchmarkProcessResult> {
  const { stdoutPath, stderrPath, runtimeStatusPath } = getBenchmarkProcessPaths(sessionDirectory, run);
  const benchmarkScriptPath = path.join(repoRoot, 'dist', 'benchmark.js');

  if (!fs.existsSync(benchmarkScriptPath)) {
    throw new Error(`Benchmark entrypoint not found: ${benchmarkScriptPath}. Run 'npm run build' first.`);
  }

  const args = buildBenchmarkArgs(manifest, run, outputPath, promptPrefixFile);

  const env = {
    ...process.env,
    sift_kit_status: runtimeStatusPath,
  };
  const result = await spawnAndWait({
    filePath: nodeExe,
    args,
    cwd: repoRoot,
    stdoutPath,
    stderrPath,
    env,
  });

  if (result.exitCode !== 0) {
    const stderrText = readTrimmedFileText(stderrPath);
    const stdoutText = readTrimmedFileText(stdoutPath);
    const details = [stderrText, stdoutText].filter(Boolean).join(' ').trim();
    throw new Error(`Benchmark command failed for run '${run.id}' with exit code ${result.exitCode}.${details ? ` ${details}` : ''}`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Benchmark run '${run.id}' completed without producing the expected artifact at ${outputPath}`);
  }

  return {
    stdoutPath,
    stderrPath,
    exitCode: result.exitCode,
  };
}
