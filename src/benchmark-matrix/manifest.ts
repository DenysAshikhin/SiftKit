import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, readJsonFile } from '../lib/fs.js';
import { resolveOptionalPathFromBase, resolvePathFromBase } from '../lib/paths.js';
import {
  getOptionalBoolean,
  getOptionalInt,
  getOptionalPositiveInt,
  getRequiredDouble,
  getRequiredInt,
  getRequiredString,
} from './args.js';
import {
  repoRoot,
  type MatrixCliOptions,
  type RawMatrixManifest,
  type ResolvedMatrixManifest,
  type ResolvedMatrixTarget,
} from './types.js';

export function readTrimmedFileText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return content.trim();
}

export function resolveModelPathForStartScript(modelPath: string, startScriptPath: string): string {
  return path.isAbsolute(modelPath)
    ? path.resolve(modelPath)
    : path.resolve(path.dirname(startScriptPath), modelPath);
}

export function getSelectedRuns(
  enabledRuns: ResolvedMatrixTarget[],
  requestedRunIds: string[],
): ResolvedMatrixTarget[] {
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
