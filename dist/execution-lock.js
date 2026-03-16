"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExecutionLockTimeoutMilliseconds = getExecutionLockTimeoutMilliseconds;
exports.acquireExecutionLock = acquireExecutionLock;
exports.releaseExecutionLock = releaseExecutionLock;
exports.withExecutionLock = withExecutionLock;
const config_js_1 = require("./config.js");
let activeLeaseToken = null;
let activeLockDepth = 0;
let activeHeartbeat = null;
function sleepMs(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function stopHeartbeat() {
    if (!activeHeartbeat) {
        return;
    }
    clearInterval(activeHeartbeat);
    activeHeartbeat = null;
}
function startHeartbeat(token) {
    stopHeartbeat();
    activeHeartbeat = setInterval(() => {
        void (0, config_js_1.refreshExecutionLease)(token).catch(() => {
            // The owning operation will surface the canonical server-unavailable error.
        });
    }, 3_000);
    if (typeof activeHeartbeat.unref === 'function') {
        activeHeartbeat.unref();
    }
}
function getExecutionLockTimeoutMilliseconds() {
    const raw = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return 300_000;
}
async function acquireExecutionLock() {
    if (activeLeaseToken) {
        activeLockDepth += 1;
        return { token: activeLeaseToken };
    }
    const timeoutMs = getExecutionLockTimeoutMilliseconds();
    const startedAt = Date.now();
    while (true) {
        const lease = await (0, config_js_1.tryAcquireExecutionLease)();
        if (lease.acquired && lease.token) {
            activeLeaseToken = lease.token;
            activeLockDepth = 1;
            startHeartbeat(lease.token);
            return { token: lease.token };
        }
        const state = await (0, config_js_1.getExecutionServerState)();
        if (Date.now() - startedAt >= timeoutMs) {
            throw new Error(`SiftKit is busy. Timed out after ${timeoutMs} ms waiting for the server to report idle.`);
        }
        if (!state.busy) {
            continue;
        }
        await sleepMs(250);
    }
}
function releaseExecutionLock(lock) {
    if (!activeLeaseToken) {
        return;
    }
    activeLockDepth -= 1;
    if (activeLockDepth > 0) {
        return;
    }
    stopHeartbeat();
    activeLeaseToken = null;
    return (0, config_js_1.releaseExecutionLease)(lock.token);
}
async function withExecutionLock(fn) {
    const lock = await acquireExecutionLock();
    try {
        return await fn();
    }
    finally {
        await releaseExecutionLock(lock);
    }
}
