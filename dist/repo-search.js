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
const config_js_1 = require("./config.js");
function traceRepoSearch(message) {
    if (process.env.SIFTKIT_TRACE_REPO_SEARCH !== '1') {
        return;
    }
    process.stderr.write(`[siftkit-trace ${new Date().toISOString()}] repo-search ${message}\n`);
}
function getOutputCharacterCount(scorecard) {
    const tasks = (scorecard
        && typeof scorecard === 'object'
        && !Array.isArray(scorecard)
        && Array.isArray(scorecard.tasks))
        ? scorecard.tasks
        : [];
    if (tasks.length === 0) {
        return 0;
    }
    const outputText = tasks
        .map((task) => (typeof task?.finalOutput === 'string' ? task.finalOutput.trim() : ''))
        .filter((value) => value.length > 0)
        .join('\n\n');
    return outputText.length;
}
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
    const startedAt = Date.now();
    const repoRoot = path.resolve(String(request.repoRoot || process.cwd()));
    const requestId = (0, node_crypto_1.randomUUID)();
    traceRepoSearch(`execute start request_id=${requestId} prompt_chars=${prompt.length}`);
    try {
        await (0, config_js_1.notifyStatusBackend)({
            running: true,
            statusBackendUrl: request.statusBackendUrl,
            requestId,
            rawInputCharacterCount: prompt.length,
            promptCharacterCount: prompt.length,
            chunkInputCharacterCount: prompt.length,
            chunkPath: 'repo-search',
        });
    }
    catch {
        traceRepoSearch(`notify running=true failed request_id=${requestId}`);
    }
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
            requestMaxTokens: request.requestMaxTokens,
            maxTurns: request.maxTurns,
            taskPrompt: prompt,
            logger,
            availableModels: request.availableModels,
            mockResponses: request.mockResponses,
            mockCommandResults: request.mockCommandResults,
            onProgress: request.onProgress ?? null,
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
            requestMaxTokens: request.requestMaxTokens ?? null,
            maxTurns: request.maxTurns ?? null,
            verdict: scorecard?.verdict ?? 'unknown',
            totals: scorecard?.totals ?? null,
            transcriptPath,
            scorecard,
        };
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        const outputCharacterCount = getOutputCharacterCount(scorecard);
        try {
            await (0, config_js_1.notifyStatusBackend)({
                running: false,
                statusBackendUrl: request.statusBackendUrl,
                requestId,
                terminalState: 'completed',
                promptCharacterCount: prompt.length,
                outputCharacterCount,
                requestDurationMs: Date.now() - startedAt,
            });
        }
        catch {
            traceRepoSearch(`notify running=false failed request_id=${requestId} state=completed`);
        }
        traceRepoSearch(`execute done request_id=${requestId} verdict=${String(scorecard?.verdict ?? 'unknown')} `
            + `duration_ms=${Date.now() - startedAt} output_chars=${outputCharacterCount}`);
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
            requestMaxTokens: request.requestMaxTokens ?? null,
            maxTurns: request.maxTurns ?? null,
            error: message,
            transcriptPath,
        };
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        try {
            await (0, config_js_1.notifyStatusBackend)({
                running: false,
                statusBackendUrl: request.statusBackendUrl,
                requestId,
                terminalState: 'failed',
                errorMessage: message,
                promptCharacterCount: prompt.length,
                outputCharacterCount: 0,
                requestDurationMs: Date.now() - startedAt,
            });
        }
        catch {
            traceRepoSearch(`notify running=false failed request_id=${requestId} state=failed`);
        }
        traceRepoSearch(`execute failed request_id=${requestId} duration_ms=${Date.now() - startedAt} error=${message}`);
        throw error;
    }
}
