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
exports.estimateTokenCount = estimateTokenCount;
exports.getChatSessionsRoot = getChatSessionsRoot;
exports.listChatSessionPaths = listChatSessionPaths;
exports.readChatSessionFromPath = readChatSessionFromPath;
exports.readChatSessions = readChatSessions;
exports.getChatSessionPath = getChatSessionPath;
exports.saveChatSession = saveChatSession;
const crypto = __importStar(require("node:crypto"));
const path = __importStar(require("node:path"));
const http_utils_js_1 = require("../status-server/http-utils.js");
function estimateTokenCount(value) {
    const text = String(value || '');
    if (!text.trim()) {
        return 0;
    }
    return Math.max(1, Math.ceil(text.length / 4));
}
function getChatSessionsRoot(runtimeRoot) {
    return path.join(runtimeRoot, 'chat', 'sessions');
}
function listChatSessionPaths(runtimeRoot) {
    return (0, http_utils_js_1.listFiles)(getChatSessionsRoot(runtimeRoot))
        .filter((targetPath) => /^session_.+\.json$/iu.test(path.basename(targetPath)));
}
function readChatSessionFromPath(targetPath) {
    const payload = (0, http_utils_js_1.safeReadJson)(targetPath);
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    if (typeof payload.id !== 'string' || !payload.id.trim()) {
        return null;
    }
    if (typeof payload.thinkingEnabled !== 'boolean') {
        payload.thinkingEnabled = true;
    }
    if (payload.mode !== 'plan') {
        payload.mode = 'chat';
    }
    if (typeof payload.planRepoRoot !== 'string' || !payload.planRepoRoot.trim()) {
        payload.planRepoRoot = process.cwd();
    }
    if (!Array.isArray(payload.hiddenToolContexts)) {
        payload.hiddenToolContexts = [];
    }
    else {
        payload.hiddenToolContexts = payload.hiddenToolContexts
            .filter((entry) => Boolean(entry) && typeof entry === 'object')
            .map((entry) => {
            const content = typeof entry.content === 'string' ? entry.content.trim() : '';
            if (!content) {
                return null;
            }
            const tokenEstimate = Number.isFinite(entry.tokenEstimate) && Number(entry.tokenEstimate) >= 0
                ? Number(entry.tokenEstimate)
                : estimateTokenCount(content);
            return {
                id: typeof entry.id === 'string' && entry.id.trim() ? entry.id : crypto.randomUUID(),
                content,
                tokenEstimate,
                sourceMessageId: typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim()
                    ? entry.sourceMessageId
                    : null,
                createdAtUtc: typeof entry.createdAtUtc === 'string' && entry.createdAtUtc.trim()
                    ? entry.createdAtUtc
                    : new Date().toISOString(),
            };
        })
            .filter((entry) => entry !== null);
    }
    return payload;
}
function readChatSessions(runtimeRoot) {
    return listChatSessionPaths(runtimeRoot)
        .map(readChatSessionFromPath)
        .filter((entry) => entry !== null)
        .sort((left, right) => String(right.updatedAtUtc || '').localeCompare(String(left.updatedAtUtc || '')));
}
function getChatSessionPath(runtimeRoot, sessionId) {
    return path.join(getChatSessionsRoot(runtimeRoot), `session_${sessionId}.json`);
}
function saveChatSession(runtimeRoot, session) {
    const targetPath = getChatSessionPath(runtimeRoot, session.id);
    (0, http_utils_js_1.saveContentAtomically)(targetPath, `${JSON.stringify(session, null, 2)}\n`);
}
