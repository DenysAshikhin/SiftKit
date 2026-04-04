"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExecutionServiceUrl = getExecutionServiceUrl;
exports.getExecutionServerState = getExecutionServerState;
exports.tryAcquireExecutionLease = tryAcquireExecutionLease;
exports.refreshExecutionLease = refreshExecutionLease;
exports.releaseExecutionLease = releaseExecutionLease;
const http_js_1 = require("../lib/http.js");
const status_backend_js_1 = require("./status-backend.js");
function getExecutionServiceUrl() {
    return (0, status_backend_js_1.deriveServiceUrl)((0, status_backend_js_1.getStatusBackendUrl)(), '/execution');
}
async function getExecutionServerState() {
    try {
        const response = await (0, http_js_1.requestJson)({
            url: getExecutionServiceUrl(),
            method: 'GET',
            timeoutMs: 2000,
        });
        if (typeof response?.busy !== 'boolean') {
            throw new Error('Execution endpoint did not return a usable busy flag.');
        }
        return {
            busy: response.busy,
        };
    }
    catch {
        throw (0, status_backend_js_1.toStatusServerUnavailableError)();
    }
}
async function tryAcquireExecutionLease() {
    try {
        const response = await (0, http_js_1.requestJson)({
            url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/acquire`,
            method: 'POST',
            timeoutMs: 2000,
            body: JSON.stringify({ pid: process.pid }),
        });
        if (typeof response?.acquired !== 'boolean') {
            throw new Error('Execution acquire endpoint did not return a usable acquired flag.');
        }
        return {
            acquired: response.acquired,
            token: response.acquired && typeof response.token === 'string' && response.token.trim()
                ? response.token
                : null,
        };
    }
    catch {
        throw (0, status_backend_js_1.toStatusServerUnavailableError)();
    }
}
async function refreshExecutionLease(token) {
    try {
        await (0, http_js_1.requestJson)({
            url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/heartbeat`,
            method: 'POST',
            timeoutMs: 2000,
            body: JSON.stringify({ token }),
        });
    }
    catch {
        throw (0, status_backend_js_1.toStatusServerUnavailableError)();
    }
}
async function releaseExecutionLease(token) {
    try {
        await (0, http_js_1.requestJson)({
            url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/release`,
            method: 'POST',
            timeoutMs: 2000,
            body: JSON.stringify({ token }),
        });
    }
    catch {
        throw (0, status_backend_js_1.toStatusServerUnavailableError)();
    }
}
