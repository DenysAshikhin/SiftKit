"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBenchmarkSuite = void 0;
const runner_js_1 = require("./benchmark/runner.js");
Object.defineProperty(exports, "runBenchmarkSuite", { enumerable: true, get: function () { return runner_js_1.runBenchmarkSuite; } });
if (require.main === module) {
    void (0, runner_js_1.main)().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
