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
exports.readJsonlEvents = readJsonlEvents;
exports.getTranscriptDurationMs = getTranscriptDurationMs;
const fs = __importStar(require("node:fs"));
function readJsonlEvents(transcriptPath) {
    if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
        return [];
    }
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const results = [];
    for (const raw of content.split(/\r?\n/gu)) {
        const line = raw.trim();
        if (!line)
            continue;
        try {
            const parsed = JSON.parse(line);
            results.push({
                kind: typeof parsed.kind === 'string' ? parsed.kind : 'event',
                at: typeof parsed.at === 'string' ? parsed.at : null,
                payload: parsed,
            });
        }
        catch {
            // skip malformed line
        }
    }
    return results;
}
function getTranscriptDurationMs(transcriptPath) {
    const events = readJsonlEvents(transcriptPath);
    const eventTimes = events
        .map((event) => Date.parse(event.at || ''))
        .filter((time) => Number.isFinite(time));
    if (eventTimes.length < 2) {
        return null;
    }
    return Math.max(0, Math.max(...eventTimes) - Math.min(...eventTimes));
}
