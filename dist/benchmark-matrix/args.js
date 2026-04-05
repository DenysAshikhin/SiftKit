"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRequiredString = getRequiredString;
exports.getRequiredInt = getRequiredInt;
exports.getRequiredDouble = getRequiredDouble;
exports.getOptionalInt = getOptionalInt;
exports.getOptionalPositiveInt = getOptionalPositiveInt;
exports.getOptionalBoolean = getOptionalBoolean;
exports.parseArguments = parseArguments;
const types_js_1 = require("./types.js");
function getRequiredString(value, name) {
    const text = String(value ?? '').trim();
    if (!text) {
        throw new Error(`Manifest field '${name}' is required.`);
    }
    return text;
}
function getRequiredInt(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`Manifest field '${name}' must be an integer.`);
    }
    return parsed;
}
function getRequiredDouble(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Manifest field '${name}' must be numeric.`);
    }
    return parsed;
}
function getOptionalInt(value, name) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }
    return getRequiredInt(value, name);
}
function getOptionalPositiveInt(value, name) {
    const parsed = getOptionalInt(value, name);
    if (parsed === null) {
        return null;
    }
    if (parsed <= 0) {
        throw new Error(`Manifest field '${name}' must be greater than zero.`);
    }
    return parsed;
}
function getOptionalBoolean(value, name) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`Manifest field '${name}' must be boolean.`);
    }
    return value;
}
function parseArguments(argv) {
    const parsed = {
        manifestPath: types_js_1.defaultManifestPath,
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
