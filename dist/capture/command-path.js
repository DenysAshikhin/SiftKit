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
exports.findCommandInPath = findCommandInPath;
exports.resolveExternalCommand = resolveExternalCommand;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
function findCommandInPath(commandName) {
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const candidates = process.platform === 'win32' && !path.extname(commandName)
        ? [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`]
        : [commandName];
    for (const entry of pathEntries) {
        for (const candidate of candidates) {
            const fullPath = path.join(entry, candidate);
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
    }
    if (process.platform === 'win32') {
        const windowsRoot = process.env.WINDIR || 'C:\\Windows';
        const extraCandidates = [
            path.join(windowsRoot, 'System32', commandName),
            path.join(windowsRoot, 'System32', `${commandName}.exe`),
            path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', commandName),
            path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', `${commandName}.exe`),
        ];
        for (const candidate of extraCandidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}
function resolveExternalCommand(commandName) {
    if (path.isAbsolute(commandName) || commandName.includes('\\') || commandName.includes('/')) {
        if (fs.existsSync(commandName)) {
            return commandName;
        }
        throw new Error(`Unable to resolve external command: ${commandName}`);
    }
    const direct = (0, node_child_process_1.spawnSync)('where.exe', [commandName], { encoding: 'utf8', shell: false, windowsHide: true });
    if (direct.status === 0 && direct.stdout.trim()) {
        return direct.stdout.split(/\r?\n/u)[0].trim();
    }
    const fallback = findCommandInPath(commandName);
    if (fallback) {
        return fallback;
    }
    throw new Error(`Unable to resolve external command: ${commandName}`);
}
