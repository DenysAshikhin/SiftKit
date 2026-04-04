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
exports.normalizeWindowsPath = normalizeWindowsPath;
exports.findNearestSiftKitRepoRoot = findNearestSiftKitRepoRoot;
exports.resolvePathFromBase = resolvePathFromBase;
exports.resolveOptionalPathFromBase = resolveOptionalPathFromBase;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const json_js_1 = require("./json.js");
function normalizeWindowsPath(value) {
    return value.replace(/\//gu, '\\').toLowerCase();
}
/**
 * Walks upward from `startPath` looking for a `package.json` whose `name` is
 * `"siftkit"`. Returns the directory that contains it, or `null` when no
 * SiftKit repo root is reachable.
 */
function findNearestSiftKitRepoRoot(startPath = process.cwd()) {
    let currentPath = path.resolve(startPath);
    for (;;) {
        const packagePath = path.join(currentPath, 'package.json');
        if (fs.existsSync(packagePath)) {
            try {
                const parsed = (0, json_js_1.parseJsonText)(fs.readFileSync(packagePath, 'utf8'));
                if (parsed?.name === 'siftkit') {
                    return currentPath;
                }
            }
            catch {
                // Ignore malformed package.json files while walking upward.
            }
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            return null;
        }
        currentPath = parentPath;
    }
}
function resolvePathFromBase(targetPath, baseDirectory) {
    if (!targetPath.trim()) {
        throw new Error('Path value cannot be empty.');
    }
    return path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(baseDirectory, targetPath);
}
function resolveOptionalPathFromBase(targetPath, baseDirectory) {
    if (targetPath === null || targetPath === undefined || !String(targetPath).trim()) {
        return null;
    }
    return resolvePathFromBase(String(targetPath).trim(), baseDirectory);
}
