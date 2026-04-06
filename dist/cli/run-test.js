"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTestResult = buildTestResult;
exports.runTest = runTest;
const index_js_1 = require("../config/index.js");
const llama_cpp_js_1 = require("../providers/llama-cpp.js");
const args_js_1 = require("./args.js");
async function buildTestResult() {
    const config = await (0, index_js_1.loadConfig)({ ensure: true });
    let model = null;
    let modelError = null;
    try {
        model = (0, index_js_1.getConfiguredModel)(config);
    }
    catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
    }
    const providerStatus = config.Backend === 'llama.cpp'
        ? await (0, llama_cpp_js_1.getLlamaCppProviderStatus)(config)
        : {
            Available: true,
            Reachable: true,
            BaseUrl: 'mock://local',
            Error: null,
        };
    const models = config.Backend === 'llama.cpp' && providerStatus.Reachable ? await (0, llama_cpp_js_1.listLlamaCppModels)(config) : ['mock-model'];
    const modelPresent = model === null || models.length === 0 ? null : models.includes(model);
    const issues = [];
    if (!providerStatus.Available) {
        issues.push('Backend is not available.');
    }
    if (!providerStatus.Reachable) {
        issues.push('llama.cpp server is not reachable.');
    }
    if (modelError) {
        issues.push(modelError);
    }
    if (modelPresent === false && model) {
        issues.push(`Configured model not found: ${model}`);
    }
    return {
        Ready: issues.length === 0,
        ConfigPath: (0, index_js_1.getConfigPath)(),
        RuntimeRoot: config.Paths?.RuntimeRoot,
        LogsPath: config.Paths?.Logs,
        EvalFixturesPath: config.Paths?.EvalFixtures,
        EvalResultsPath: config.Paths?.EvalResults,
        Backend: config.Backend,
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
async function runTest(stdout) {
    const result = await buildTestResult();
    stdout.write((0, args_js_1.formatPsList)(result));
    return 0;
}
