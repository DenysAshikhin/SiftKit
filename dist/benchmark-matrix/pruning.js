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
exports.isLauncherLogFile = isLauncherLogFile;
exports.collectLauncherLogPaths = collectLauncherLogPaths;
exports.pruneOldLauncherLogs = pruneOldLauncherLogs;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const types_js_1 = require("./types.js");
function isLauncherLogFile(fileName) {
    return /^launcher_.*_(stdout|stderr)\.log$/u.test(fileName);
}
function collectLauncherLogPaths(rootDirectory) {
    const pending = [rootDirectory];
    const launcherLogPaths = [];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) {
            continue;
        }
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
                continue;
            }
            if (entry.isFile() && isLauncherLogFile(entry.name)) {
                launcherLogPaths.push(entryPath);
            }
        }
    }
    return launcherLogPaths;
}
function pruneOldLauncherLogs(rootDirectory, nowMs = Date.now()) {
    const launcherLogPaths = collectLauncherLogPaths(rootDirectory);
    let deletedCount = 0;
    for (const logPath of launcherLogPaths) {
        try {
            const stat = fs.statSync(logPath);
            if (nowMs - stat.mtimeMs <= types_js_1.ONE_WEEK_MS) {
                continue;
            }
            fs.unlinkSync(logPath);
            deletedCount += 1;
        }
        catch {
            continue;
        }
    }
    return deletedCount;
}
