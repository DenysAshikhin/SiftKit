import { getActiveInferenceBackend, getConfigPath, getConfiguredModel, loadConfig } from '../config/index.js';
import { getLlamaCppProviderStatus, listLlamaCppModels } from '../providers/llama-cpp.js';
import { formatPsList } from './args.js';

export type TestResult = {
  Ready: boolean;
  ConfigPath: string;
  RuntimeRoot: string | undefined;
  LogsPath: string | undefined;
  EvalFixturesPath: string | undefined;
  EvalResultsPath: string | undefined;
  Backend: string;
  Model: string | null;
  LlamaCppBaseUrl: string | null;
  LlamaCppReachable: boolean;
  AvailableModels: string[];
  ModelPresent: boolean | null;
  EffectiveNumCtx: number | null;
  EffectiveInputCharactersPerToken: number | null;
  EffectiveBudgetSource: string | null;
  EffectiveObservedTelemetrySeen: boolean | null;
  EffectiveObservedTelemetryUpdatedAtUtc: string | null;
  EffectiveMaxInputCharacters: number | null;
  EffectiveChunkThresholdCharacters: number | null;
  ProviderError: string | null;
  Issues: string[];
};

export async function buildTestResult(): Promise<TestResult> {
  const config = await loadConfig({ ensure: true });
  let model: string | null = null;
  let modelError: string | null = null;
  try {
    model = getConfiguredModel(config);
  } catch (error) {
    modelError = error instanceof Error ? error.message : String(error);
  }
  const engine = getActiveInferenceBackend(config);
  const providerStatus = await getLlamaCppProviderStatus(config);
  const models = providerStatus.Reachable ? await listLlamaCppModels(config) : [];
  const modelPresent = model === null || models.length === 0 ? null : models.includes(model);
  const issues: string[] = [];

  if (!providerStatus.Available) {
    issues.push('Backend is not available.');
  }
  if (!providerStatus.Reachable) {
    issues.push('Inference server is not reachable.');
  }
  if (modelError) {
    issues.push(modelError);
  }
  if (modelPresent === false && model) {
    issues.push(`Configured model not found: ${model}`);
  }

  return {
    Ready: issues.length === 0,
    ConfigPath: getConfigPath(),
    RuntimeRoot: config.Paths?.RuntimeRoot,
    LogsPath: config.Paths?.Logs,
    EvalFixturesPath: config.Paths?.EvalFixtures,
    EvalResultsPath: config.Paths?.EvalResults,
    Backend: engine,
    Model: model,
    LlamaCppBaseUrl: providerStatus.BaseUrl,
    LlamaCppReachable: providerStatus.Reachable,
    AvailableModels: models,
    ModelPresent: modelPresent,
    EffectiveNumCtx: config.Effective?.NumCtx ?? null,
    EffectiveInputCharactersPerToken: config.Effective?.InputCharactersPerContextToken ?? null,
    EffectiveBudgetSource: config.Effective?.BudgetSource ?? null,
    EffectiveObservedTelemetrySeen: config.Effective?.ObservedTelemetrySeen ?? null,
    EffectiveObservedTelemetryUpdatedAtUtc: config.Effective?.ObservedTelemetryUpdatedAtUtc ?? null,
    EffectiveMaxInputCharacters: config.Effective?.MaxInputCharacters ?? null,
    EffectiveChunkThresholdCharacters: config.Effective?.ChunkThresholdCharacters ?? null,
    ProviderError: providerStatus.Error,
    Issues: issues,
  };
}

export async function runTest(stdout: NodeJS.WritableStream): Promise<number> {
  const result = await buildTestResult();
  stdout.write(formatPsList(result));
  return 0;
}
