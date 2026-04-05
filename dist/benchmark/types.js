"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FatalBenchmarkError = exports.BENCHMARK_HEARTBEAT_MS = exports.DEFAULT_REQUEST_TIMEOUT_SECONDS = void 0;
exports.DEFAULT_REQUEST_TIMEOUT_SECONDS = 1800;
exports.BENCHMARK_HEARTBEAT_MS = 15_000;
class FatalBenchmarkError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FatalBenchmarkError';
    }
}
exports.FatalBenchmarkError = FatalBenchmarkError;
