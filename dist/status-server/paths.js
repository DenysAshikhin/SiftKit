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
exports.findNearestSiftKitRepoRoot = findNearestSiftKitRepoRoot;
exports.getRuntimeRoot = getRuntimeRoot;
exports.getStatusPath = getStatusPath;
exports.getConfigPath = getConfigPath;
exports.getMetricsPath = getMetricsPath;
exports.getIdleSummarySnapshotsPath = getIdleSummarySnapshotsPath;
exports.getManagedLlamaLogRoot = getManagedLlamaLogRoot;
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const paths_js_1 = require("../lib/paths.js");
function findNearestSiftKitRepoRoot(startPath = process.cwd()) {
    return (0, paths_js_1.findNearestSiftKitRepoRoot)(startPath);
}
function getRuntimeRoot() {
    const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
    if (configuredPath && configuredPath.trim()) {
        const statusPath = path.resolve(configuredPath);
        const statusDirectory = path.dirname(statusPath);
        if (path.basename(statusDirectory).toLowerCase() === 'status') {
            return path.dirname(statusDirectory);
        }
        return statusDirectory;
    }
    const repoRoot = findNearestSiftKitRepoRoot();
    if (repoRoot) {
        return path.join(repoRoot, '.siftkit');
    }
    return path.join(process.env.USERPROFILE || os.homedir(), '.siftkit');
}
function getStatusPath() {
    const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.join(getRuntimeRoot(), 'status', 'inference.txt');
}
function getConfigPath() {
    const configuredPath = process.env.SIFTKIT_CONFIG_PATH;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.join(getRuntimeRoot(), 'config.json');
}
function getMetricsPath() {
    const configuredPath = process.env.SIFTKIT_METRICS_PATH;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.join(getRuntimeRoot(), 'metrics', 'compression.json');
}
function getIdleSummarySnapshotsPath() {
    const configuredPath = process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.join(path.dirname(getStatusPath()), 'idle-summary.sqlite');
}
function getManagedLlamaLogRoot() {
    return path.join(getRuntimeRoot(), 'logs', 'managed-llama');
}
