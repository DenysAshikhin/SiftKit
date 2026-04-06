"use strict";
// Benchmark-matrix module public API barrel.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMatrixWithInterrupt = exports.runMatrix = exports.main = exports.pruneOldLauncherLogs = exports.readMatrixManifest = exports.buildLauncherArgs = exports.buildLaunchSignature = exports.buildBenchmarkArgs = void 0;
var launcher_js_1 = require("./launcher.js");
Object.defineProperty(exports, "buildBenchmarkArgs", { enumerable: true, get: function () { return launcher_js_1.buildBenchmarkArgs; } });
Object.defineProperty(exports, "buildLaunchSignature", { enumerable: true, get: function () { return launcher_js_1.buildLaunchSignature; } });
Object.defineProperty(exports, "buildLauncherArgs", { enumerable: true, get: function () { return launcher_js_1.buildLauncherArgs; } });
var manifest_js_1 = require("./manifest.js");
Object.defineProperty(exports, "readMatrixManifest", { enumerable: true, get: function () { return manifest_js_1.readMatrixManifest; } });
var pruning_js_1 = require("./pruning.js");
Object.defineProperty(exports, "pruneOldLauncherLogs", { enumerable: true, get: function () { return pruning_js_1.pruneOldLauncherLogs; } });
var runner_js_1 = require("./runner.js");
Object.defineProperty(exports, "main", { enumerable: true, get: function () { return runner_js_1.main; } });
Object.defineProperty(exports, "runMatrix", { enumerable: true, get: function () { return runner_js_1.runMatrix; } });
Object.defineProperty(exports, "runMatrixWithInterrupt", { enumerable: true, get: function () { return runner_js_1.runMatrixWithInterrupt; } });
if (require.main === module) {
    void import('./runner.js').then(({ main: run }) => run().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    }));
}
