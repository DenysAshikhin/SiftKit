"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDerivedMaxInputCharacters = getDerivedMaxInputCharacters;
exports.getEffectiveInputCharactersPerContextToken = getEffectiveInputCharactersPerContextToken;
exports.getEffectiveMaxInputCharacters = getEffectiveMaxInputCharacters;
exports.getChunkThresholdCharacters = getChunkThresholdCharacters;
exports.resolveInputCharactersPerContextToken = resolveInputCharactersPerContextToken;
exports.addEffectiveConfigProperties = addEffectiveConfigProperties;
const observed_budget_js_1 = require("../state/observed-budget.js");
const constants_js_1 = require("./constants.js");
const errors_js_1 = require("./errors.js");
const getters_js_1 = require("./getters.js");
const status_backend_js_1 = require("./status-backend.js");
function getDerivedMaxInputCharacters(numCtx, inputCharactersPerContextToken = constants_js_1.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN) {
    const effectiveNumCtx = numCtx > 0 ? numCtx : (0, getters_js_1.getDefaultNumCtx)();
    const effectiveCharactersPerContextToken = inputCharactersPerContextToken > 0
        ? inputCharactersPerContextToken
        : constants_js_1.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
    return Math.max(Math.floor(effectiveNumCtx * effectiveCharactersPerContextToken), 1);
}
function getEffectiveInputCharactersPerContextToken(config) {
    const effectiveValue = Number(config.Effective?.InputCharactersPerContextToken);
    return effectiveValue > 0 ? effectiveValue : constants_js_1.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
}
function getEffectiveMaxInputCharacters(config) {
    return getDerivedMaxInputCharacters((0, getters_js_1.getConfiguredLlamaNumCtx)(config), getEffectiveInputCharactersPerContextToken(config));
}
function getChunkThresholdCharacters(config) {
    return Math.max(getEffectiveMaxInputCharacters(config), 1);
}
function getObservedInputCharactersPerContextToken(snapshot) {
    const inputCharactersTotal = Number(snapshot?.metrics?.inputCharactersTotal);
    const inputTokensTotal = Number(snapshot?.metrics?.inputTokensTotal);
    if (!Number.isFinite(inputCharactersTotal) || inputCharactersTotal <= 0) {
        return null;
    }
    if (!Number.isFinite(inputTokensTotal) || inputTokensTotal <= 0) {
        return null;
    }
    return inputCharactersTotal / inputTokensTotal;
}
async function resolveInputCharactersPerContextToken() {
    const persistedState = (0, observed_budget_js_1.readObservedBudgetState)();
    let snapshot;
    try {
        snapshot = await (0, status_backend_js_1.getStatusSnapshot)();
    }
    catch {
        if (persistedState.observedTelemetrySeen) {
            throw new errors_js_1.MissingObservedBudgetError('SiftKit previously recorded a valid observed chars-per-token budget, but the status server is unavailable or no longer exposes usable totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.');
        }
        return {
            value: constants_js_1.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
            budgetSource: 'ColdStartFixedCharsPerToken',
        };
    }
    const observedValue = getObservedInputCharactersPerContextToken(snapshot);
    if (observedValue !== null) {
        (0, observed_budget_js_1.tryWriteObservedBudgetState)({
            observedTelemetrySeen: true,
            lastKnownCharsPerToken: observedValue,
            updatedAtUtc: new Date().toISOString(),
        });
        return {
            value: observedValue,
            budgetSource: 'ObservedCharsPerToken',
        };
    }
    if (persistedState.observedTelemetrySeen) {
        throw new errors_js_1.MissingObservedBudgetError('SiftKit previously recorded a valid observed chars-per-token budget, but the status server no longer provides usable input character/token totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.');
    }
    return {
        value: constants_js_1.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
        budgetSource: 'ColdStartFixedCharsPerToken',
    };
}
async function addEffectiveConfigProperties(config, info) {
    const effectiveBudget = await resolveInputCharactersPerContextToken();
    const missingRuntimeFields = (0, getters_js_1.getMissingRuntimeFields)(config);
    const runtimeConfigReady = missingRuntimeFields.length === 0;
    const numCtx = runtimeConfigReady ? (0, getters_js_1.getConfiguredLlamaNumCtx)(config) : null;
    const maxInputCharacters = numCtx === null
        ? null
        : getDerivedMaxInputCharacters(numCtx, effectiveBudget.value);
    return {
        ...config,
        Effective: {
            ConfigAuthoritative: true,
            RuntimeConfigReady: runtimeConfigReady,
            MissingRuntimeFields: missingRuntimeFields,
            BudgetSource: effectiveBudget.budgetSource,
            NumCtx: numCtx,
            InputCharactersPerContextToken: effectiveBudget.value,
            ObservedTelemetrySeen: effectiveBudget.budgetSource !== 'ColdStartFixedCharsPerToken',
            ObservedTelemetryUpdatedAtUtc: (0, observed_budget_js_1.readObservedBudgetState)().updatedAtUtc,
            MaxInputCharacters: maxInputCharacters,
            ChunkThresholdCharacters: maxInputCharacters,
            LegacyMaxInputCharactersRemoved: info.legacyMaxInputCharactersRemoved,
            LegacyMaxInputCharactersValue: info.legacyMaxInputCharactersValue,
        },
    };
}
