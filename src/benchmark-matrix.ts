import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { requestJson } from './lib/http.js';
import { ensureDirectory, readJsonFile, writeJsonFile } from './lib/fs.js';
import { resolveOptionalPathFromBase, resolvePathFromBase } from './lib/paths.js';
import { getUtcTimestamp } from './lib/time.js';

type BenchmarkSampling = {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repetitionPenalty: number;
};

type RawMatrixManifest = {
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

type ResolvedMatrixTarget = {
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

type ResolvedMatrixManifest = {
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

type MatrixCliOptions = {
  manifestPath: string;
  runIds: string[];
  promptPrefixFile: string | null;
  requestTimeoutSeconds: number | null;
  validateOnly: boolean;
};

type RunEntry = {
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

type MatrixIndex = {
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

type ConfigRecord = Record<string, unknown> & {
  Backend?: string;
  Model?: string;
  LlamaCpp?: Record<string, unknown>;
};

type LaunchResult = {
  hostProcessId: number;
  stdoutPath: string;
  stderrPath: string;
};

type BenchmarkProcessResult = {
  stdoutPath: string;
  stderrPath: string;
  exitCode: number;
};

class MatrixInterruptedError extends Error {
  constructor(signal: NodeJS.Signals) {
    super(`Benchmark matrix interrupted by ${signal}.`);
    this.name = 'MatrixInterruptedError';
  }
}

const repoRoot = path.resolve(__dirname, '..');
const defaultManifestPath = path.join(repoRoot, 'eval', 'benchmark-matrices', 'ai_core_60_tests.6run.json');
const powerShellExe = process.env.ComSpec?.toLowerCase().includes('cmd.exe')
  ? 'powershell.exe'
  : 'powershell.exe';
const nodeExe = process.execPath;

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isLauncherLogFile(fileName: string): boolean {
  return /^launcher_.*_(stdout|stderr)\.log$/u.test(fileName);
}

function collectLauncherLogPaths(rootDirectory: string): string[] {
  const pending = [rootDirectory];
  const launcherLogPaths: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && isLauncherLogFile(entry.name)) {
        launcherLogPaths.push(entryPath);
      }
    }
  }

  return launcherLogPaths;
}

export function pruneOldLauncherLogs(rootDirectory: string, nowMs = Date.now()): number {
  const launcherLogPaths = collectLauncherLogPaths(rootDirectory);
  let deletedCount = 0;
  for (const logPath of launcherLogPaths) {
    try {
      const stat = fs.statSync(logPath);
      if (nowMs - stat.mtimeMs <= ONE_WEEK_MS) {
        continue;
      }
      fs.unlinkSync(logPath);
      deletedCount += 1;
    } catch {
      continue;
    }
  }

  return deletedCount;
}

function readTrimmedFileText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content.trim();
}

function resolveModelPathForStartScript(modelPath: string, startScriptPath: string): string {
  return path.isAbsolute(modelPath)
    ? path.resolve(modelPath)
    : path.resolve(path.dirname(startScriptPath), modelPath);
}

function getRequiredString(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`Manifest field '${name}' is required.`);
  }

  return text;
}

function getRequiredInt(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Manifest field '${name}' must be an integer.`);
  }

  return parsed;
}

function getRequiredDouble(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Manifest field '${name}' must be numeric.`);
  }

  return parsed;
}

function getOptionalInt(value: unknown, name: string): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  return getRequiredInt(value, name);
}

function getOptionalPositiveInt(value: unknown, name: string): number | null {
  const parsed = getOptionalInt(value, name);
  if (parsed === null) {
    return null;
  }
  if (parsed <= 0) {
    throw new Error(`Manifest field '${name}' must be greater than zero.`);
  }

  return parsed;
}

function getOptionalBoolean(value: unknown, name: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Manifest field '${name}' must be boolean.`);
  }

  return value;
}

function parseArguments(argv: string[]): MatrixCliOptions {
  const parsed: MatrixCliOptions = {
    manifestPath: defaultManifestPath,
    runIds: [],
    promptPrefixFile: null,
    requestTimeoutSeconds: null,
    validateOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--manifest':
      case '--manifest-path':
        parsed.manifestPath = argv[++index];
        break;
      case '--run-id':
        parsed.runIds.push(argv[++index]);
        break;
      case '--prompt-prefix-file':
        parsed.promptPrefixFile = argv[++index];
        break;
      case '--request-timeout-seconds':
        parsed.requestTimeoutSeconds = getOptionalPositiveInt(argv[++index], 'requestTimeoutSeconds');
        break;
      case '--validate-only':
        parsed.validateOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}

function getSelectedRuns(enabledRuns: ResolvedMatrixTarget[], requestedRunIds: string[]): ResolvedMatrixTarget[] {
  if (requestedRunIds.length === 0) {
    return [...enabledRuns];
  }

  const requested = new Set(requestedRunIds.map((item) => item.trim().toLowerCase()).filter(Boolean));
  const selected = enabledRuns.filter((run) => requested.has(run.id.toLowerCase()));
  const selectedIds = new Set(selected.map((run) => run.id.toLowerCase()));
  const missing = [...requested].filter((runId) => !selectedIds.has(runId));
  if (missing.length > 0) {
    throw new Error(`Requested run ids were not found among enabled manifest runs: ${missing.join(', ')}`);
  }

  return selected;
}

export function readMatrixManifest(options: MatrixCliOptions): ResolvedMatrixManifest {
  const resolvedManifestPath = resolvePathFromBase(options.manifestPath, repoRoot);
  if (!fs.existsSync(resolvedManifestPath)) {
    throw new Error(`Manifest file not found: ${resolvedManifestPath}`);
  }

  const raw = readJsonFile<RawMatrixManifest>(resolvedManifestPath);
  const manifestDirectory = path.dirname(resolvedManifestPath);
  const fixtureRoot = resolvePathFromBase(getRequiredString(raw.fixtureRoot, 'fixtureRoot'), manifestDirectory);
  const startScript = resolvePathFromBase(getRequiredString(raw.startScript, 'startScript'), manifestDirectory);
  const stopScript = resolveOptionalPathFromBase(raw.stopScript ?? null, manifestDirectory);
  const resultsRoot = resolvePathFromBase(getRequiredString(raw.resultsRoot, 'resultsRoot'), manifestDirectory);
  const configUrl = getRequiredString(raw.configUrl, 'configUrl');
  const manifestPromptPrefixFile = resolveOptionalPathFromBase(raw.promptPrefixFile ?? null, manifestDirectory);
  const requestTimeoutSeconds = options.requestTimeoutSeconds
    ?? getOptionalPositiveInt(raw.requestTimeoutSeconds ?? null, 'requestTimeoutSeconds')
    ?? 1800;

  if (!fs.existsSync(fixtureRoot)) {
    throw new Error(`Fixture root does not exist: ${fixtureRoot}`);
  }
  if (!fs.existsSync(path.join(fixtureRoot, 'fixtures.json'))) {
    throw new Error(`Fixture root is missing fixtures.json: ${fixtureRoot}`);
  }
  if (!fs.existsSync(startScript)) {
    throw new Error(`Start script does not exist: ${startScript}`);
  }
  if (stopScript && !fs.existsSync(stopScript)) {
    throw new Error(`Stop script does not exist: ${stopScript}`);
  }
  if (manifestPromptPrefixFile && !fs.existsSync(manifestPromptPrefixFile)) {
    throw new Error(`Prompt prefix file does not exist: ${manifestPromptPrefixFile}`);
  }

  if (!raw.baseline) {
    throw new Error("Manifest field 'baseline' is required.");
  }

  const baselineModelId = getRequiredString(raw.baseline.modelId, 'baseline.modelId');
  const baselineModelPath = getRequiredString(raw.baseline.modelPath, 'baseline.modelPath');
  const baselineReasoning = getRequiredString(raw.baseline.reasoning, 'baseline.reasoning');
  if (baselineReasoning !== 'off') {
    throw new Error("Manifest baseline.reasoning must be 'off'.");
  }

  const baseline: ResolvedMatrixManifest['baseline'] = {
    index: 0,
    id: 'baseline',
    label: 'baseline',
    modelId: baselineModelId,
    modelPath: baselineModelPath,
    startScript,
    resolvedModelPath: resolveModelPathForStartScript(baselineModelPath, startScript),
    promptPrefixFile: null,
    sampling: null,
    contextSize: getRequiredInt(raw.baseline.contextSize, 'baseline.contextSize'),
    maxTokens: getRequiredInt(raw.baseline.maxTokens, 'baseline.maxTokens'),
    reasoning: baselineReasoning as 'on' | 'off' | 'auto',
    passReasoningArg: getOptionalBoolean(raw.baseline.passReasoningArg, 'baseline.passReasoningArg') ?? true,
  };

  if (!fs.existsSync(baseline.resolvedModelPath)) {
    throw new Error(`Baseline model file does not exist: ${baseline.resolvedModelPath}`);
  }

  if (!Array.isArray(raw.runs)) {
    throw new Error("Manifest field 'runs' is required.");
  }

  const enabledRuns: ResolvedMatrixTarget[] = [];
  const idSet = new Set<string>();
  for (const rawRun of raw.runs) {
    const runId = getRequiredString(rawRun.id, 'runs[].id');
    const normalizedId = runId.toLowerCase();
    if (idSet.has(normalizedId)) {
      throw new Error(`Duplicate run id found in manifest: ${runId}`);
    }
    idSet.add(normalizedId);

    if (!rawRun.sampling) {
      throw new Error(`Run '${runId}' is missing its sampling block.`);
    }

    const run: ResolvedMatrixTarget = {
      index: getRequiredInt(rawRun.index, `runs[${runId}].index`),
      id: runId,
      label: getRequiredString(rawRun.label, `runs[${runId}].label`),
      modelId: getRequiredString(rawRun.modelId, `runs[${runId}].modelId`),
      modelPath: getRequiredString(rawRun.modelPath, `runs[${runId}].modelPath`),
      startScript: resolveOptionalPathFromBase(rawRun.startScript ?? null, manifestDirectory) ?? startScript,
      resolvedModelPath: '',
      promptPrefixFile: resolveOptionalPathFromBase(rawRun.promptPrefixFile ?? null, manifestDirectory),
      reasoning: ((rawRun.reasoning ?? baseline.reasoning) as 'on' | 'off' | 'auto'),
      contextSize: getOptionalInt(rawRun.contextSize, `runs[${runId}].contextSize`) ?? baseline.contextSize,
      maxTokens: getOptionalInt(rawRun.maxTokens, `runs[${runId}].maxTokens`) ?? baseline.maxTokens,
      passReasoningArg: getOptionalBoolean(rawRun.passReasoningArg, `runs[${runId}].passReasoningArg`) ?? baseline.passReasoningArg,
      sampling: {
        temperature: getRequiredDouble(rawRun.sampling.temperature, `runs[${runId}].sampling.temperature`),
        topP: getRequiredDouble(rawRun.sampling.topP, `runs[${runId}].sampling.topP`),
        topK: getRequiredInt(rawRun.sampling.topK, `runs[${runId}].sampling.topK`),
        minP: getRequiredDouble(rawRun.sampling.minP, `runs[${runId}].sampling.minP`),
        presencePenalty: getRequiredDouble(rawRun.sampling.presencePenalty, `runs[${runId}].sampling.presencePenalty`),
        repetitionPenalty: getRequiredDouble(rawRun.sampling.repetitionPenalty, `runs[${runId}].sampling.repetitionPenalty`),
      },
    };
    run.resolvedModelPath = resolveModelPathForStartScript(run.modelPath, run.startScript);

    if (!fs.existsSync(run.resolvedModelPath)) {
      throw new Error(`Run '${runId}' points at a missing model file: ${run.resolvedModelPath}`);
    }
    if (!fs.existsSync(run.startScript)) {
      throw new Error(`Run '${runId}' points at a missing start script: ${run.startScript}`);
    }
    if (run.promptPrefixFile && !fs.existsSync(run.promptPrefixFile)) {
      throw new Error(`Run '${runId}' points at a missing prompt prefix file: ${run.promptPrefixFile}`);
    }

    if (Boolean(rawRun.enabled)) {
      enabledRuns.push(run);
    }
  }

  if (enabledRuns.length < 1) {
    throw new Error('Manifest must have at least one enabled run.');
  }

  const selectedRuns = getSelectedRuns(enabledRuns, options.runIds);
  if (selectedRuns.length === 0) {
    throw new Error('No runs were selected.');
  }

  ensureDirectory(resultsRoot);

  return {
    manifestPath: resolvedManifestPath,
    manifestDirectory,
    fixtureRoot,
    configUrl,
    promptPrefixFile: manifestPromptPrefixFile,
    requestTimeoutSeconds,
    startScript,
    stopScript,
    resultsRoot,
    baseline,
    enabledRuns,
    selectedRuns,
  };
}

export function buildLaunchSignature(target: ResolvedMatrixTarget): string {
  return [
    target.startScript,
    target.resolvedModelPath,
    String(target.contextSize),
    String(target.maxTokens),
    target.passReasoningArg ? target.reasoning : 'script-controlled',
  ].join('|');
}

export function buildLauncherArgs(manifest: ResolvedMatrixManifest, target: ResolvedMatrixTarget): string[] {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', target.startScript,
    '-ConfigUrl', manifest.configUrl,
    '-ModelPath', target.modelPath,
    '-ContextSize', String(target.contextSize),
    '-MaxTokens', String(target.maxTokens),
  ];
  if (target.passReasoningArg) {
    args.push('-Reasoning', target.reasoning);
  }

  return args;
}

export function buildBenchmarkArgs(
  manifest: ResolvedMatrixManifest,
  run: ResolvedMatrixTarget,
  outputPath: string,
  promptPrefixFile: string | null
): string[] {
  const args = [
    path.join(repoRoot, 'dist', 'benchmark.js'),
    '--fixture-root',
    manifest.fixtureRoot,
    '--model',
    run.modelId,
    '--output',
    outputPath,
  ];
  if (promptPrefixFile) {
    args.push('--prompt-prefix-file', promptPrefixFile);
  }
  args.push('--request-timeout-seconds', String(manifest.requestTimeoutSeconds));
  if (run.sampling) {
    args.push(
      '--temperature', String(run.sampling.temperature),
      '--top-p', String(run.sampling.topP),
      '--top-k', String(run.sampling.topK),
      '--min-p', String(run.sampling.minP),
      '--presence-penalty', String(run.sampling.presencePenalty),
      '--repetition-penalty', String(run.sampling.repetitionPenalty),
    );
  }
  args.push('--max-tokens', String(run.maxTokens));

  return args;
}

async function invokeConfigGet(configUrl: string): Promise<ConfigRecord> {
  return requestJson<ConfigRecord>({
    url: configUrl,
    method: 'GET',
    timeoutMs: 10_000,
  });
}

async function invokeConfigSet(configUrl: string, config: ConfigRecord): Promise<ConfigRecord> {
  return requestJson<ConfigRecord>({
    url: configUrl,
    method: 'PUT',
    timeoutMs: 10_000,
    body: JSON.stringify(config),
  });
}

function getRuntimeLlamaCppConfigValue(config: ConfigRecord, key: string): unknown {
  const runtime = typeof config.Runtime === 'object' && config.Runtime !== null
    ? config.Runtime as Record<string, unknown>
    : null;
  const runtimeLlamaCpp = runtime && typeof runtime.LlamaCpp === 'object' && runtime.LlamaCpp !== null
    ? runtime.LlamaCpp as Record<string, unknown>
    : null;
  if (runtimeLlamaCpp && Object.prototype.hasOwnProperty.call(runtimeLlamaCpp, key)) {
    return runtimeLlamaCpp[key];
  }

  const llamaCpp = typeof config.LlamaCpp === 'object' && config.LlamaCpp !== null
    ? config.LlamaCpp as Record<string, unknown>
    : null;
  return llamaCpp?.[key];
}

async function getLlamaModels(baseUrl: string): Promise<string[]> {
  const response = await requestJson<{ data?: Array<{ id?: string | null }> }>({
    url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
    method: 'GET',
    timeoutMs: 10_000,
  });

  return Array.isArray(response.data)
    ? response.data
      .map((item) => String(item?.id ?? '').trim())
      .filter(Boolean)
    : [];
}

async function waitForLlamaReadiness(baseUrl: string, expectedModelId: string, timeoutSeconds = 180): Promise<string[]> {
  const deadline = Date.now() + (timeoutSeconds * 1000);
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const models = await getLlamaModels(baseUrl);
      if (models.includes(expectedModelId)) {
        return models;
      }

      lastError = `llama-server is reachable but expected model '${expectedModelId}' is not loaded. Available models: ${models.length > 0 ? models.join(', ') : '<none>'}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for llama-server at ${baseUrl} to load model '${expectedModelId}'. Last error: ${lastError}`);
}

function spawnAndWait(options: {
  filePath: string;
  args: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; pid: number }> {
  return new Promise((resolve, reject) => {
    ensureDirectory(path.dirname(options.stdoutPath));
    ensureDirectory(path.dirname(options.stderrPath));
    const stdout = fs.openSync(options.stdoutPath, 'w');
    const stderr = fs.openSync(options.stderrPath, 'w');
    const child = spawn(options.filePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', stdout, stderr],
      windowsHide: true,
    });

    child.once('error', (error) => {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      reject(error);
    });

    child.once('exit', (code) => {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      resolve({
        exitCode: code ?? 0,
        pid: child.pid ?? 0,
      });
    });
  });
}

async function invokeStopScript(stopScriptPath: string): Promise<void> {
  const result = await spawnAndWait({
    filePath: powerShellExe,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScriptPath, '-Force'],
    cwd: path.dirname(stopScriptPath),
    stdoutPath: path.join(repoRoot, 'eval', 'results', 'tmp_stop_stdout.log'),
    stderrPath: path.join(repoRoot, 'eval', 'results', 'tmp_stop_stderr.log'),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Stop script failed with exit code ${result.exitCode}.`);
  }
}

async function forceStopLlamaServer(sessionDirectory: string): Promise<void> {
  const stdoutPath = path.join(sessionDirectory, 'tmp_force_stop_stdout.log');
  const stderrPath = path.join(sessionDirectory, 'tmp_force_stop_stderr.log');
  const result = await spawnAndWait({
    filePath: powerShellExe,
    args: [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "$existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue; if ($existing) { $existing | Stop-Process -Force }; exit 0",
    ],
    cwd: repoRoot,
    stdoutPath,
    stderrPath,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Force-stopping llama-server failed with exit code ${result.exitCode}.`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

async function startLlamaLauncher(manifest: ResolvedMatrixManifest, target: ResolvedMatrixTarget, sessionDirectory: string): Promise<LaunchResult> {
  pruneOldLauncherLogs(manifest.resultsRoot);
  const stdoutPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stdout.log`);
  const stderrPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stderr.log`);
  const args = buildLauncherArgs(manifest, target);

  ensureDirectory(sessionDirectory);
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const child = spawn(powerShellExe, args, {
    cwd: path.dirname(target.startScript),
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
    detached: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const exited = child.exitCode !== null || child.signalCode !== null;
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  if (exited) {
    const stderrText = readTrimmedFileText(stderrPath);
    const stdoutText = readTrimmedFileText(stdoutPath);
    const details = [stderrText, stdoutText].filter(Boolean).join(' ').trim();
    throw new Error(`Launcher process exited before llama-server became ready.${details ? ` ${details}` : ''}`);
  }

  return {
    hostProcessId: child.pid ?? 0,
    stdoutPath,
    stderrPath,
  };
}

async function restartLlamaForTarget(manifest: ResolvedMatrixManifest, target: ResolvedMatrixTarget, sessionDirectory: string): Promise<void> {
  process.stdout.write(`Restarting llama-server for [${target.id}] ${target.label}\n`);
  if (manifest.stopScript) {
    await invokeStopScript(manifest.stopScript);
  } else {
    await forceStopLlamaServer(sessionDirectory);
  }
  await startLlamaLauncher(manifest, target, sessionDirectory);
  const config = await invokeConfigGet(manifest.configUrl);
  const baseUrl = getRequiredString(getRuntimeLlamaCppConfigValue(config, 'BaseUrl'), 'config.Runtime.LlamaCpp.BaseUrl');
  await waitForLlamaReadiness(baseUrl, target.modelId);
}

async function invokeBenchmarkProcess(manifest: ResolvedMatrixManifest, run: ResolvedMatrixTarget, outputPath: string, sessionDirectory: string, promptPrefixFile: string | null): Promise<BenchmarkProcessResult> {
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

function writeMatrixIndex(filePath: string, index: MatrixIndex): void {
  writeJsonFile(filePath, index);
}

function getBenchmarkProcessPaths(sessionDirectory: string, run: ResolvedMatrixTarget): {
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

function createMatrixInterruptSignal(onInterrupt: (error: MatrixInterruptedError) => void): {
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
    const error = new MatrixInterruptedError(signal);
    onInterrupt(error);
    rejectInterrupted(error);
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

async function withMatrixInterrupt<T>(operation: Promise<T>, interrupted: Promise<never>): Promise<T> {
  return Promise.race([operation, interrupted]);
}

export async function runMatrixWithInterrupt(options: MatrixCliOptions, interruptSignalOverride?: {
  interrupted: Promise<never>;
  dispose: () => void;
}): Promise<void> {
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

async function main(): Promise<void> {
  await runMatrix(parseArguments(process.argv.slice(2)));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
