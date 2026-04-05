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
exports.spawnAndWait = spawnAndWait;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const fs_js_1 = require("../lib/fs.js");
function spawnAndWait(options) {
    return new Promise((resolve, reject) => {
        (0, fs_js_1.ensureDirectory)(path.dirname(options.stdoutPath));
        (0, fs_js_1.ensureDirectory)(path.dirname(options.stderrPath));
        const stdout = fs.openSync(options.stdoutPath, 'w');
        const stderr = fs.openSync(options.stderrPath, 'w');
        const child = (0, node_child_process_1.spawn)(options.filePath, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', stdout, stderr],
            windowsHide: true,
        });
        child.once('error', (error) => {
            fs.closeSync(stdout);
            fs.closeSync(stderr);
            reject(error);
        });
        child.once('exit', (code) => {
            fs.closeSync(stdout);
            fs.closeSync(stderr);
            resolve({
                exitCode: code ?? 0,
                pid: child.pid ?? 0,
            });
        });
    });
}
