import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendBenchmarkMatrixLogChunk } from '../../src/state/benchmark-matrix.js';
import { buildBenchmarkArgs } from './launcher.js';
import { spawnAndWait } from './process.js';
import {
  nodeExe,
  repoRoot,
  type BenchmarkProcessResult,
  type ResolvedMatrixManifest,
  type ResolvedMatrixTarget,
} from './types.js';

function extractBenchmarkRunUri(stdoutText: string): string | null {
  const lines = stdoutText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^db:\/\/benchmark-runs\//u.test(lines[index])) {
      return lines[index];
    }
  }
  return null;
}

export async function invokeBenchmarkProcess(
  manifest: ResolvedMatrixManifest,
  run: ResolvedMatrixTarget,
  promptPrefixFile: string | null,
  matrixRunRecordId: string,
  interrupted?: Promise<never>,
): Promise<BenchmarkProcessResult> {
  const benchmarkEntrypoint = path.join(repoRoot, 'bench', 'benchmark', 'index.ts');
  if (!fs.existsSync(benchmarkEntrypoint)) {
    throw new Error(`Benchmark entrypoint not found: ${benchmarkEntrypoint}.`);
  }

  const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const args = [tsxCliPath, benchmarkEntrypoint, ...buildBenchmarkArgs(manifest, run, promptPrefixFile)];
  const result = await spawnAndWait({
    filePath: nodeExe,
    args,
    cwd: repoRoot,
    env: process.env,
    interrupted,
    onStdoutChunk(chunk: string) {
      appendBenchmarkMatrixLogChunk({
        runId: matrixRunRecordId,
        streamKind: 'benchmark_stdout',
        chunkText: chunk,
      });
    },
    onStderrChunk(chunk: string) {
      appendBenchmarkMatrixLogChunk({
        runId: matrixRunRecordId,
        streamKind: 'benchmark_stderr',
        chunkText: chunk,
      });
    },
  });

  if (result.exitCode !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join(' ').trim();
    throw new Error(`Benchmark command failed for run '${run.id}' with exit code ${result.exitCode}.${details ? ` ${details}` : ''}`);
  }

  const benchmarkRunUri = extractBenchmarkRunUri(result.stdout);
  if (!benchmarkRunUri) {
    throw new Error(`Benchmark run '${run.id}' completed but did not emit a benchmark DB URI.`);
  }

  return {
    runId: matrixRunRecordId,
    benchmarkRunUri,
    stdoutText: result.stdout,
    stderrText: result.stderr,
    exitCode: result.exitCode,
  };
}
