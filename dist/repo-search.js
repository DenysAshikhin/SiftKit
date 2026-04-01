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
exports.executeRepoSearchRequest = executeRepoSearchRequest;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
function getRuntimeLogsPath() {
    const statusPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH || '';
    if (statusPath && statusPath.trim()) {
        const absoluteStatusPath = path.resolve(statusPath.trim());
        const statusDirectory = path.dirname(absoluteStatusPath);
        const runtimeRoot = path.basename(statusDirectory).toLowerCase() === 'status'
            ? path.dirname(statusDirectory)
            : statusDirectory;
        return path.join(runtimeRoot, 'logs');
    }
    return path.join(process.cwd(), '.siftkit', 'logs');
}
function ensureRepoSearchLogFolders() {
    const root = path.join(getRuntimeLogsPath(), 'repo_search');
    const successful = path.join(root, 'succesful');
    const failed = path.join(root, 'failed');
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
async function executeRepoSearchRequest(request) {
    const prompt = String(request.prompt || '').trim();
    if (!prompt) {
        throw new Error('A --prompt is required for repo-search.');
    }
    const repoRoot = path.resolve(String(request.repoRoot || process.cwd()));
    const requestId = (0, node_crypto_1.randomUUID)();
    const folders = ensureRepoSearchLogFolders();
    const tempTranscriptPath = request.logFile
        ? path.resolve(request.logFile)
        : path.join(folders.root, `request_${requestId}.jsonl`);
    const logger = createJsonLogger(tempTranscriptPath);
    const module = require('../scripts/mock-repo-search-loop.js');
    try {
        const scorecard = await module.runMockRepoSearch({
            repoRoot,
            config: request.config,
            model: request.model,
            maxTurns: request.maxTurns,
            taskPrompt: prompt,
            logger,
            availableModels: request.availableModels,
            mockResponses: request.mockResponses,
            mockCommandResults: request.mockCommandResults,
        });
        const targetFolder = scorecard?.verdict === 'pass' ? folders.successful : folders.failed;
        const transcriptPath = path.join(targetFolder, `request_${requestId}.jsonl`);
        const artifactPath = path.join(targetFolder, `request_${requestId}.json`);
        moveFileSafe(tempTranscriptPath, transcriptPath);
        const artifact = {
            requestId,
            prompt,
            repoRoot,
            model: request.model ?? null,
            maxTurns: request.maxTurns ?? null,
            verdict: scorecard?.verdict ?? 'unknown',
            totals: scorecard?.totals ?? null,
            transcriptPath,
            scorecard,
        };
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        return {
            requestId,
            transcriptPath,
            artifactPath,
            scorecard,
        };
    }
    catch (error) {
        const transcriptPath = path.join(folders.failed, `request_${requestId}.jsonl`);
        const artifactPath = path.join(folders.failed, `request_${requestId}.json`);
        moveFileSafe(tempTranscriptPath, transcriptPath);
        const message = error instanceof Error ? error.message : String(error);
        const artifact = {
            requestId,
            prompt,
            repoRoot,
            model: request.model ?? null,
            maxTurns: request.maxTurns ?? null,
            error: message,
            transcriptPath,
        };
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        throw error;
    }
}
