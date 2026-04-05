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
exports.traceRepoSearch = traceRepoSearch;
exports.ensureRepoSearchLogFolders = ensureRepoSearchLogFolders;
exports.moveFileSafe = moveFileSafe;
exports.createJsonLogger = createJsonLogger;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_js_1 = require("../config/paths.js");
function traceRepoSearch(message) {
    if (process.env.SIFTKIT_TRACE_REPO_SEARCH !== '1') {
        return;
    }
    process.stderr.write(`[siftkit-trace ${new Date().toISOString()}] repo-search ${message}\n`);
}
function ensureRepoSearchLogFolders() {
    const root = (0, paths_js_1.getRepoSearchLogRoot)();
    const successful = (0, paths_js_1.getRepoSearchSuccessfulDirectory)();
    const failed = (0, paths_js_1.getRepoSearchFailedDirectory)();
    fs.mkdirSync(successful, { recursive: true });
    fs.mkdirSync(failed, { recursive: true });
    return { root, successful, failed };
}
function moveFileSafe(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath)) {
        return;
    }
    try {
        fs.renameSync(sourcePath, targetPath);
        return;
    }
    catch {
        // Fall through to copy+delete for cross-volume moves.
    }
    fs.copyFileSync(sourcePath, targetPath);
    fs.unlinkSync(sourcePath);
}
function createJsonLogger(logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '', 'utf8');
    return {
        path: logPath,
        write(event) {
            fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
        },
    };
}
