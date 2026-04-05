"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInterruptSignal = createInterruptSignal;
exports.createFixtureHeartbeat = createFixtureHeartbeat;
exports.runWithFixtureDeadline = runWithFixtureDeadline;
exports.isTimeoutError = isTimeoutError;
const time_js_1 = require("../lib/time.js");
const types_js_1 = require("./types.js");
function createInterruptSignal() {
    let rejectInterrupted = () => { };
    const interrupted = new Promise((_resolve, reject) => {
        rejectInterrupted = reject;
    });
    let active = true;
    const onSignal = (signal) => {
        if (!active) {
            return;
        }
        active = false;
        rejectInterrupted(new types_js_1.FatalBenchmarkError(`Benchmark interrupted by ${signal}.`));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return {
        interrupted,
        dispose: () => {
            active = false;
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        },
    };
}
function createFixtureHeartbeat(options) {
    const handle = setInterval(() => {
        const elapsedMs = Date.now() - options.startedAtMs;
        process.stdout.write(`Fixture ${options.fixtureIndex}/${options.fixtureCount} [${options.fixtureLabel}] still running after ${(0, time_js_1.formatElapsed)(elapsedMs)}\n`);
    }, types_js_1.BENCHMARK_HEARTBEAT_MS);
    if (typeof handle.unref === 'function') {
        handle.unref();
    }
    return handle;
}
async function runWithFixtureDeadline(operation, options) {
    return new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
            reject(new types_js_1.FatalBenchmarkError(`Benchmark fixture '${options.fixtureLabel}' timed out after ${options.requestTimeoutSeconds} seconds.`));
        }, options.requestTimeoutSeconds * 1000);
        if (typeof timeoutHandle.unref === 'function') {
            timeoutHandle.unref();
        }
        const resolveOnce = (value) => {
            clearTimeout(timeoutHandle);
            resolve(value);
        };
        const rejectOnce = (error) => {
            clearTimeout(timeoutHandle);
            reject(error);
        };
        operation.then((value) => resolveOnce(value), (error) => rejectOnce(error));
        options.interrupted.then(() => undefined, (error) => rejectOnce(error));
    });
}
function isTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /\btimed out after\b/iu.test(message);
}
