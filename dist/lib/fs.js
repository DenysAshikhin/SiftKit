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
exports.ensureDirectory = ensureDirectory;
exports.writeUtf8NoBom = writeUtf8NoBom;
exports.isRetryableFsError = isRetryableFsError;
exports.saveContentAtomically = saveContentAtomically;
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
exports.readTextIfExists = readTextIfExists;
exports.readTrimmedFileText = readTrimmedFileText;
exports.listFiles = listFiles;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const json_js_1 = require("./json.js");
function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}
function writeUtf8NoBom(filePath, content) {
    fs.writeFileSync(filePath, content, { encoding: 'utf8' });
}
function isRetryableFsError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = 'code' in error ? String(error.code ?? '') : '';
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}
function saveContentAtomically(filePath, content) {
    const directory = path.dirname(filePath);
    ensureDirectory(directory);
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const tempPath = path.join(directory, `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`);
        try {
            writeUtf8NoBom(tempPath, content);
            fs.renameSync(tempPath, filePath);
            return;
        }
        catch (error) {
            lastError = error;
            try {
                fs.rmSync(tempPath, { force: true });
            }
            catch {
                // Ignore temp cleanup failures during retry handling.
            }
            if (!isRetryableFsError(error) || attempt === 4) {
                break;
            }
        }
    }
    if (isRetryableFsError(lastError)) {
        writeUtf8NoBom(filePath, content);
        return;
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to save ${filePath} atomically.`);
}
function readJsonFile(filePath) {
    return (0, json_js_1.parseJsonText)(fs.readFileSync(filePath, 'utf8'));
}
function writeJsonFile(filePath, value) {
    ensureDirectory(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function readTextIfExists(targetPath) {
    if (!fs.existsSync(targetPath)) {
        return null;
    }
    return fs.readFileSync(targetPath, 'utf8');
}
function readTrimmedFileText(filePath) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    return fs.readFileSync(filePath, 'utf8').trim();
}
function listFiles(targetPath) {
    if (!fs.existsSync(targetPath)) {
        return [];
    }
    return fs
        .readdirSync(targetPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(targetPath, entry.name));
}
