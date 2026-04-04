"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultObservedBudgetState = getDefaultObservedBudgetState;
exports.normalizeObservedBudgetState = normalizeObservedBudgetState;
exports.readObservedBudgetState = readObservedBudgetState;
exports.writeObservedBudgetState = writeObservedBudgetState;
exports.tryWriteObservedBudgetState = tryWriteObservedBudgetState;
const fs = __importStar(require("node:fs"));
const fs_js_1 = require("../lib/fs.js");
const json_js_1 = require("../lib/json.js");
const paths_js_1 = require("../config/paths.js");
function getDefaultObservedBudgetState() {
    return {
        observedTelemetrySeen: false,
        lastKnownCharsPerToken: null,
        updatedAtUtc: null,
    };
}
function normalizeObservedBudgetState(input) {
    const fallback = getDefaultObservedBudgetState();
    if (!input || typeof input !== 'object') {
        return fallback;
    }
    const parsed = input;
    const lastKnownCharsPerToken = Number(parsed.lastKnownCharsPerToken);
    return {
        observedTelemetrySeen: parsed.observedTelemetrySeen === true
            && Number.isFinite(lastKnownCharsPerToken)
            && lastKnownCharsPerToken > 0,
        lastKnownCharsPerToken: Number.isFinite(lastKnownCharsPerToken) && lastKnownCharsPerToken > 0
            ? lastKnownCharsPerToken
            : null,
        updatedAtUtc: typeof parsed.updatedAtUtc === 'string' && parsed.updatedAtUtc.trim()
            ? parsed.updatedAtUtc
            : null,
    };
}
function readObservedBudgetState() {
    const statePath = (0, paths_js_1.getObservedBudgetStatePath)();
    if (!fs.existsSync(statePath)) {
        return getDefaultObservedBudgetState();
    }
    try {
        return normalizeObservedBudgetState((0, json_js_1.parseJsonText)(fs.readFileSync(statePath, 'utf8')));
    }
    catch {
        return getDefaultObservedBudgetState();
    }
}
function writeObservedBudgetState(state) {
    (0, fs_js_1.saveContentAtomically)((0, paths_js_1.getObservedBudgetStatePath)(), `${JSON.stringify(normalizeObservedBudgetState(state), null, 2)}\n`);
}
function tryWriteObservedBudgetState(state) {
    try {
        writeObservedBudgetState(state);
    }
    catch {
        // Observed-budget persistence is advisory. Request execution should continue.
    }
}
