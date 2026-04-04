"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultNumCtx = getDefaultNumCtx;
exports.getCompatRuntimeLlamaCpp = getCompatRuntimeLlamaCpp;
exports.getFinitePositiveNumber = getFinitePositiveNumber;
exports.getConfiguredModel = getConfiguredModel;
exports.getConfiguredPromptPrefix = getConfiguredPromptPrefix;
exports.getConfiguredLlamaBaseUrl = getConfiguredLlamaBaseUrl;
exports.getConfiguredLlamaNumCtx = getConfiguredLlamaNumCtx;
exports.getConfiguredLlamaSetting = getConfiguredLlamaSetting;
exports.getMissingRuntimeFields = getMissingRuntimeFields;
const constants_js_1 = require("./constants.js");
function getDefaultNumCtx() {
    return constants_js_1.SIFT_DEFAULT_NUM_CTX;
}
function getCompatRuntimeLlamaCpp(config) {
    return config.Runtime?.LlamaCpp ?? config.LlamaCpp ?? {};
}
function getFinitePositiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function getConfiguredModel(config) {
    const model = config.Runtime?.Model ?? config.Model;
    if (typeof model === 'string' && model.trim()) {
        return model.trim();
    }
    throw new Error('SiftKit runtime config is missing Model. Start a launcher script first.');
}
function getConfiguredPromptPrefix(config) {
    const promptPrefix = config.PromptPrefix;
    return typeof promptPrefix === 'string' && promptPrefix.trim() ? promptPrefix : undefined;
}
function getConfiguredLlamaBaseUrl(config) {
    const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
        return baseUrl.trim();
    }
    throw new Error('SiftKit runtime config is missing LlamaCpp.BaseUrl. Start a launcher script first.');
}
function getConfiguredLlamaNumCtx(config) {
    const numCtx = getFinitePositiveNumber(getCompatRuntimeLlamaCpp(config).NumCtx);
    if (numCtx !== null) {
        return numCtx;
    }
    throw new Error('SiftKit runtime config is missing LlamaCpp.NumCtx. Start a launcher script first.');
}
function getConfiguredLlamaSetting(config, key) {
    const runtimeValue = getCompatRuntimeLlamaCpp(config)[key];
    return (runtimeValue === undefined || runtimeValue === null) ? undefined : runtimeValue;
}
function getMissingRuntimeFields(config) {
    const missing = [];
    try {
        getConfiguredModel(config);
    }
    catch {
        missing.push('Model');
    }
    try {
        getConfiguredLlamaBaseUrl(config);
    }
    catch {
        missing.push('LlamaCpp.BaseUrl');
    }
    try {
        getConfiguredLlamaNumCtx(config);
    }
    catch {
        missing.push('LlamaCpp.NumCtx');
    }
    return missing;
}
