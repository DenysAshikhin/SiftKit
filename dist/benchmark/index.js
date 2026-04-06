"use strict";
// Benchmark module public API barrel.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBenchmarkSuite = exports.main = void 0;
var runner_js_1 = require("./runner.js");
Object.defineProperty(exports, "main", { enumerable: true, get: function () { return runner_js_1.main; } });
Object.defineProperty(exports, "runBenchmarkSuite", { enumerable: true, get: function () { return runner_js_1.runBenchmarkSuite; } });
if (require.main === module) {
    void import('./runner.js').then(({ main: run }) => run().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    }));
}
