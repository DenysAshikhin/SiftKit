import * as path from 'node:path';

export type BenchmarkSampling = {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repetitionPenalty: number;
};

export type RawMatrixManifest = {
  fixtureRoot: string;
  configUrl: string;
  promptPrefixFile?: string | null;
  requestTimeoutSeconds?: number | null;
  startScript: string;
  stopScript?: string | null;
  resultsRoot: string;
  baseline: {
    modelId: string;
    modelPath: string;
    contextSize: number;
    maxTokens: number;
    reasoning: string;
    passReasoningArg?: boolean;
  };
  runs: Array<{
    index: number;
    id: string;
    label: string;
    enabled: boolean;
    modelId: string;
    modelPath: string;
    startScript?: string | null;
    promptPrefixFile?: string | null;
    contextSize?: number;
    maxTokens?: number;
    passReasoningArg?: boolean;
    reasoning?: 'on' | 'off' | 'auto';
    sampling: {
      temperature: number;
      topP: number;
      topK: number;
      minP: number;
      presencePenalty: number;
      repetitionPenalty: number;
    };
  }>;
};

export type ResolvedMatrixTarget = {
  index: number;
  id: string;
  label: string;
  modelId: string;
  modelPath: string;
  startScript: string;
  resolvedModelPath: string;
  promptPrefixFile: string | null;
  reasoning: 'on' | 'off' | 'auto';
  sampling: BenchmarkSampling | null;
  contextSize: number;
  maxTokens: number;
  passReasoningArg: boolean;
};

export type ResolvedMatrixManifest = {
  manifestPath: string;
  manifestDirectory: string;
  fixtureRoot: string;
  configUrl: string;
  promptPrefixFile: string | null;
  requestTimeoutSeconds: number;
  startScript: string;
  stopScript: string | null;
  resultsRoot: string;
  baseline: ResolvedMatrixTarget;
  enabledRuns: ResolvedMatrixTarget[];
  selectedRuns: ResolvedMatrixTarget[];
};

export type MatrixCliOptions = {
  manifestPath: string;
  runIds: string[];
  promptPrefixFile: string | null;
  requestTimeoutSeconds: number | null;
  validateOnly: boolean;
};

export type RunEntry = {
  index: number;
  id: string;
  label: string;
  modelId: string;
  modelPath: string;
  startScript: string;
  promptPrefixFile: string | null;
  reasoning: 'on' | 'off' | 'auto';
  sampling: BenchmarkSampling | null;
  outputPath: string;
  benchmarkStdoutPath: string | null;
  benchmarkStderrPath: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
};

export type MatrixIndex = {
  manifestPath: string;
  resolvedManifestPath: string;
  fixtureRoot: string;
  resultsRoot: string;
  sessionDirectory: string;
  configUrl: string;
  promptPrefixFile: string | null;
  selectedRunIds: string[];
  startedAtUtc: string;
  completedAtUtc: string | null;
  status: 'running' | 'completed' | 'failed';
  configSnapshotPath: string;
  baselineRestore: {
    status: 'pending' | 'completed' | 'failed';
    error: string | null;
  };
  runs: RunEntry[];
};

export type ConfigRecord = Record<string, unknown> & {
  Backend?: string;
  Model?: string;
  LlamaCpp?: Record<string, unknown>;
};

export type LaunchResult = {
  hostProcessId: number;
  stdoutPath: string;
  stderrPath: string;
};

export type BenchmarkProcessResult = {
  stdoutPath: string;
  stderrPath: string;
  exitCode: number;
};

export class MatrixInterruptedError extends Error {
  constructor(signal: NodeJS.Signals) {
    super(`Benchmark matrix interrupted by ${signal}.`);
    this.name = 'MatrixInterruptedError';
  }
}

export const repoRoot = path.resolve(__dirname, '..', '..');
export const defaultManifestPath = path.join(repoRoot, 'eval', 'benchmark-matrices', 'ai_core_60_tests.6run.json');
export const powerShellExe = process.env.ComSpec?.toLowerCase().includes('cmd.exe')
  ? 'powershell.exe'
  : 'powershell.exe';
export const nodeExe = process.execPath;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
