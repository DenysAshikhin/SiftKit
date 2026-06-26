import path from 'node:path';
import { z } from '../../src/lib/zod.js';
import { JsonObjectSchema, type JsonObject } from '../../src/lib/json-types.js';
import { getRepoRoot } from '../common/paths.js';

export const RawMatrixManifestSchema = z.object({
  fixtureRoot: z.string(),
  configUrl: z.string(),
  promptPrefixFile: z.string().nullable().optional(),
  requestTimeoutSeconds: z.number().nullable().optional(),
  startScript: z.string(),
  stopScript: z.string().nullable().optional(),
  resultsRoot: z.string(),
  baseline: z.object({
    modelId: z.string(),
    modelPath: z.string(),
    contextSize: z.number(),
    maxTokens: z.number(),
    reasoning: z.string(),
    passReasoningArg: z.boolean().optional(),
  }),
  runs: z.array(z.object({
    index: z.number(),
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    modelId: z.string(),
    modelPath: z.string(),
    startScript: z.string().nullable().optional(),
    promptPrefixFile: z.string().nullable().optional(),
    contextSize: z.number().optional(),
    maxTokens: z.number().optional(),
    passReasoningArg: z.boolean().optional(),
    reasoning: z.enum(['on', 'off', 'auto']).optional(),
  })),
});
export type RawMatrixManifest = z.infer<typeof RawMatrixManifestSchema>;

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
  id: string;
  uri: string;
  index: number;
  runId: string;
  label: string;
  modelId: string;
  modelPath: string;
  startScript: string;
  promptPrefixFile: string | null;
  reasoning: 'on' | 'off' | 'auto';
  benchmarkRunUri: string | null;
  startedAtUtc: string;
  completedAtUtc: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
};

export type MatrixIndex = {
  id: string;
  uri: string;
  manifestPath: string;
  fixtureRoot: string;
  configUrl: string;
  promptPrefixFile: string | null;
  selectedRunIds: string[];
  startedAtUtc: string;
  completedAtUtc: string | null;
  status: 'running' | 'completed' | 'failed';
  baselineRestore: {
    status: 'pending' | 'completed' | 'failed';
    error: string | null;
  };
  runs: RunEntry[];
};

export type ConfigRecord = JsonObject & {
  Backend?: string;
  Model?: string;
  LlamaCpp?: JsonObject;
};

// Bench config mirror is an open record (callers index arbitrary keys), so the
// RPC boundary validates only that the payload is a JSON object.
export const ConfigRecordSchema = z.custom<ConfigRecord>((value) => JsonObjectSchema.safeParse(value).success);

export type LaunchResult = {
  runId: string;
  hostProcessId: number;
};

export type BenchmarkProcessResult = {
  runId: string;
  benchmarkRunUri: string;
  stdoutText: string;
  stderrText: string;
  exitCode: number;
};

export class MatrixInterruptedError extends Error {
  constructor(signal: NodeJS.Signals) {
    super(`Benchmark matrix interrupted by ${signal}.`);
    this.name = 'MatrixInterruptedError';
  }
}

export const repoRoot = getRepoRoot();
export const defaultManifestPath = path.join(repoRoot, 'eval', 'benchmark-matrices', 'ai_core_60_tests.6run.json');
export const powerShellExe = process.env.ComSpec?.toLowerCase().includes('cmd.exe')
  ? 'powershell.exe'
  : 'powershell.exe';
export const nodeExe = process.execPath;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
