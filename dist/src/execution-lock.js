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
exports.getExecutionLockTimeoutMilliseconds = getExecutionLockTimeoutMilliseconds;
exports.acquireExecutionLock = acquireExecutionLock;
exports.releaseExecutionLock = releaseExecutionLock;
exports.withExecutionLock = withExecutionLock;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_js_1 = require("./config.js");
let activeLock = null;
let activeLockDepth = 0;
function sleepMs(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function getExecutionLockTimeoutMilliseconds() {
    const raw = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return 300_000;
}
function acquireExecutionLock() {
    if (activeLock) {
        activeLockDepth += 1;
        return activeLock;
    }
    const runtimeRoot = (0, config_js_1.getRuntimeRoot)();
    const lockPath = path.join(runtimeRoot, 'execution.lock');
    (0, config_js_1.ensureDirectory)(path.dirname(lockPath));
    const timeoutMs = getExecutionLockTimeoutMilliseconds();
    const startedAt = Date.now();
    while (true) {
        try {
            const handle = fs.openSync(lockPath, 'wx');
            activeLock = { lockPath, handle };
            activeLockDepth = 1;
            return activeLock;
        }
        catch (error) {
            const exception = error;
            if (exception.code !== 'EEXIST') {
                throw error;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`SiftKit is busy. Timed out after ${timeoutMs} ms waiting for the execution lock.`);
            }
            sleepMs(25);
        }
    }
}
function releaseExecutionLock(lock) {
    if (!activeLock) {
        return;
    }
    activeLockDepth -= 1;
    if (activeLockDepth > 0) {
        return;
    }
    fs.closeSync(lock.handle);
    fs.rmSync(lock.lockPath, { force: true });
    activeLock = null;
}
async function withExecutionLock(fn) {
    const lock = acquireExecutionLock();
    try {
        return await fn();
    }
    finally {
        releaseExecutionLock(lock);
    }
}
