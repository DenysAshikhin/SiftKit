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
exports.findFiles = findFiles;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
function wildcardToRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    const regexBody = escaped.replace(/\*/gu, '.*').replace(/\?/gu, '.');
    return new RegExp(`^${regexBody}$`, 'i');
}
function walkFiles(rootPath, results) {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, results);
            continue;
        }
        if (entry.isFile()) {
            results.push(fullPath);
        }
    }
}
function findFiles(names, searchPath = '.') {
    const resolvedPath = path.resolve(searchPath);
    const patterns = names.map((name) => wildcardToRegex(name));
    const files = [];
    walkFiles(resolvedPath, files);
    return files
        .filter((filePath) => patterns.some((pattern) => pattern.test(path.basename(filePath))))
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({
        Name: path.basename(filePath),
        RelativePath: path.relative(resolvedPath, filePath),
        FullPath: filePath,
    }));
}
