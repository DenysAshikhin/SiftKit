"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMatrixWithInterrupt = exports.runMatrix = exports.readMatrixManifest = exports.pruneOldLauncherLogs = exports.buildLauncherArgs = exports.buildLaunchSignature = exports.buildBenchmarkArgs = void 0;
const launcher_js_1 = require("./benchmark-matrix/launcher.js");
Object.defineProperty(exports, "buildBenchmarkArgs", { enumerable: true, get: function () { return launcher_js_1.buildBenchmarkArgs; } });
Object.defineProperty(exports, "buildLaunchSignature", { enumerable: true, get: function () { return launcher_js_1.buildLaunchSignature; } });
Object.defineProperty(exports, "buildLauncherArgs", { enumerable: true, get: function () { return launcher_js_1.buildLauncherArgs; } });
const manifest_js_1 = require("./benchmark-matrix/manifest.js");
Object.defineProperty(exports, "readMatrixManifest", { enumerable: true, get: function () { return manifest_js_1.readMatrixManifest; } });
const pruning_js_1 = require("./benchmark-matrix/pruning.js");
Object.defineProperty(exports, "pruneOldLauncherLogs", { enumerable: true, get: function () { return pruning_js_1.pruneOldLauncherLogs; } });
const runner_js_1 = require("./benchmark-matrix/runner.js");
Object.defineProperty(exports, "runMatrix", { enumerable: true, get: function () { return runner_js_1.runMatrix; } });
Object.defineProperty(exports, "runMatrixWithInterrupt", { enumerable: true, get: function () { return runner_js_1.runMatrixWithInterrupt; } });
if (require.main === module) {
    void (0, runner_js_1.main)().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
