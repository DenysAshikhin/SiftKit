"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokeConfigGet = invokeConfigGet;
exports.invokeConfigSet = invokeConfigSet;
exports.getRuntimeLlamaCppConfigValue = getRuntimeLlamaCppConfigValue;
exports.getLlamaModels = getLlamaModels;
exports.waitForLlamaReadiness = waitForLlamaReadiness;
const http_js_1 = require("../lib/http.js");
async function invokeConfigGet(configUrl) {
    return (0, http_js_1.requestJson)({
        url: configUrl,
        method: 'GET',
        timeoutMs: 10_000,
    });
}
async function invokeConfigSet(configUrl, config) {
    return (0, http_js_1.requestJson)({
        url: configUrl,
        method: 'PUT',
        timeoutMs: 10_000,
        body: JSON.stringify(config),
    });
}
function getRuntimeLlamaCppConfigValue(config, key) {
    const runtime = typeof config.Runtime === 'object' && config.Runtime !== null
        ? config.Runtime
        : null;
    const runtimeLlamaCpp = runtime && typeof runtime.LlamaCpp === 'object' && runtime.LlamaCpp !== null
        ? runtime.LlamaCpp
        : null;
    if (runtimeLlamaCpp && Object.prototype.hasOwnProperty.call(runtimeLlamaCpp, key)) {
        return runtimeLlamaCpp[key];
    }
    const llamaCpp = typeof config.LlamaCpp === 'object' && config.LlamaCpp !== null
        ? config.LlamaCpp
        : null;
    return llamaCpp?.[key];
}
async function getLlamaModels(baseUrl) {
    const response = await (0, http_js_1.requestJson)({
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
async function waitForLlamaReadiness(baseUrl, expectedModelId, timeoutSeconds = 180) {
    const deadline = Date.now() + (timeoutSeconds * 1000);
    let lastError = '';
    while (Date.now() < deadline) {
        try {
            const models = await getLlamaModels(baseUrl);
            if (models.includes(expectedModelId)) {
                return models;
            }
            lastError = `llama-server is reachable but expected model '${expectedModelId}' is not loaded. Available models: ${models.length > 0 ? models.join(', ') : '<none>'}`;
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Timed out waiting for llama-server at ${baseUrl} to load model '${expectedModelId}'. Last error: ${lastError}`);
}
