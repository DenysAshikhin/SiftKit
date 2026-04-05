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
exports.requestText = requestText;
exports.requestJson = requestJson;
exports.readBody = readBody;
exports.sleep = sleep;
exports.parseJsonBody = parseJsonBody;
exports.sendJson = sendJson;
exports.ensureDirectory = ensureDirectory;
exports.writeText = writeText;
exports.readTextIfExists = readTextIfExists;
exports.listFiles = listFiles;
exports.saveContentAtomically = saveContentAtomically;
exports.safeReadJson = safeReadJson;
exports.getIsoDateFromStat = getIsoDateFromStat;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
function requestText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: 'GET',
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                resolve({
                    statusCode: response.statusCode || 0,
                    body,
                });
            });
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`));
        });
        request.on('error', reject);
        request.end();
    });
}
function requestJson(url, options = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === 'https:' ? https : http;
        const body = typeof options.body === 'string' ? options.body : '';
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: options.method || 'GET',
            headers: body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body, 'utf8'),
            } : undefined,
        }, (response) => {
            let responseText = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                responseText += chunk;
            });
            response.on('end', () => {
                if (!responseText.trim()) {
                    resolve({ statusCode: response.statusCode || 0, body: {}, rawText: '' });
                    return;
                }
                try {
                    resolve({
                        statusCode: response.statusCode || 0,
                        body: JSON.parse(responseText),
                        rawText: responseText,
                    });
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(Number(options.timeoutMs || 60000), () => {
            request.destroy(new Error(`Request timed out after ${Number(options.timeoutMs || 60000)} ms.`));
        });
        request.on('error', reject);
        if (body) {
            request.write(body);
        }
        request.end();
    });
}
function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}
function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function parseJsonBody(bodyText) {
    if (!bodyText || !bodyText.trim()) {
        return {};
    }
    return JSON.parse(bodyText);
}
function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}
function ensureDirectory(targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}
function writeText(targetPath, content) {
    ensureDirectory(targetPath);
    fs.writeFileSync(targetPath, content, 'utf8');
}
function readTextIfExists(targetPath) {
    try {
        if (!targetPath || !fs.existsSync(targetPath)) {
            return '';
        }
        return fs.readFileSync(targetPath, 'utf8');
    }
    catch {
        return '';
    }
}
function listFiles(targetPath) {
    if (!fs.existsSync(targetPath)) {
        return [];
    }
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(targetPath, entry.name));
}
function saveContentAtomically(targetPath, content) {
    ensureDirectory(targetPath);
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const tempPath = path.join(path.dirname(targetPath), `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`);
        try {
            fs.writeFileSync(tempPath, content, 'utf8');
            fs.renameSync(tempPath, targetPath);
            return;
        }
        catch (error) {
            lastError = error;
            try {
                fs.rmSync(tempPath, { force: true });
            }
            catch {
                // Ignore cleanup failures.
            }
            if (!error || typeof error !== 'object') {
                break;
            }
            const code = String(error.code || '');
            if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt === 4) {
                break;
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to save ${targetPath}.`);
}
function safeReadJson(targetPath) {
    try {
        return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    }
    catch {
        return null;
    }
}
function getIsoDateFromStat(targetPath) {
    try {
        return fs.statSync(targetPath).mtime.toISOString();
    }
    catch {
        return new Date(0).toISOString();
    }
}
