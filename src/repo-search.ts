import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { notifyStatusBackend } from './config.js';

type JsonLogger = {
  path: string;
  write: (event: Record<string, unknown>) => void;
};

type RepoSearchExecutionRequest = {
  prompt: string;
  repoRoot: string;
  statusBackendUrl?: string;
  config?: Record<string, unknown>;
  model?: string;
  requestMaxTokens?: number;
  maxTurns?: number;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, { exitCode?: number; stdout?: string; stderr?: string; delayMs?: number }>;
};

type RepoSearchExecutionResult = {
  requestId: string;
  transcriptPath: string;
  artifactPath: string;
  scorecard: Record<string, unknown>;
};

function traceRepoSearch(message: string): void {
  if (process.env.SIFTKIT_TRACE_REPO_SEARCH !== '1') {
    return;
  }
  process.stderr.write(`[siftkit-trace ${new Date().toISOString()}] repo-search ${message}\n`);
}

function getOutputCharacterCount(scorecard: unknown): number {
  const tasks = (
    scorecard
    && typeof scorecard === 'object'
    && !Array.isArray(scorecard)
    && Array.isArray((scorecard as { tasks?: unknown }).tasks)
  )
    ? (scorecard as { tasks: Array<{ finalOutput?: unknown }> }).tasks
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

function getRuntimeLogsPath(): string {
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

function ensureRepoSearchLogFolders(): {
  root: string;
  successful: string;
  failed: string;
} {
  const root = path.join(getRuntimeLogsPath(), 'repo_search');
  const successful = path.join(root, 'succesful');
  const failed = path.join(root, 'failed');
  fs.mkdirSync(successful, { recursive: true });
  fs.mkdirSync(failed, { recursive: true });
  return { root, successful, failed };
}

function moveFileSafe(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch {
    // Fall through to copy+delete for cross-volume moves.
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.unlinkSync(sourcePath);
}

function createJsonLogger(logPath: string): JsonLogger {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '', 'utf8');
  return {
    path: logPath,
    write(event: Record<string, unknown>): void {
      fs.appendFileSync(
        logPath,
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        'utf8'
      );
    },
  };
}

export async function executeRepoSearchRequest(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
  const prompt = String(request.prompt || '').trim();
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const startedAt = Date.now();
  const repoRoot = path.resolve(String(request.repoRoot || process.cwd()));
  const requestId = randomUUID();
  traceRepoSearch(`execute start request_id=${requestId} prompt_chars=${prompt.length}`);
  try {
    await notifyStatusBackend({
      running: true,
      statusBackendUrl: request.statusBackendUrl,
      requestId,
      rawInputCharacterCount: prompt.length,
      promptCharacterCount: prompt.length,
      chunkInputCharacterCount: prompt.length,
      chunkPath: 'repo-search',
    });
  } catch {
    traceRepoSearch(`notify running=true failed request_id=${requestId}`);
  }
  const folders = ensureRepoSearchLogFolders();
  const tempTranscriptPath = request.logFile
    ? path.resolve(request.logFile)
    : path.join(folders.root, `request_${requestId}.jsonl`);
  const logger = createJsonLogger(tempTranscriptPath);

  const module = require('../scripts/mock-repo-search-loop.js') as {
    runMockRepoSearch: (options: {
      repoRoot: string;
      config?: Record<string, unknown>;
      model?: string;
      requestMaxTokens?: number;
      maxTurns?: number;
      taskPrompt: string;
      logger: JsonLogger;
      availableModels?: string[];
      mockResponses?: string[];
      mockCommandResults?: Record<string, { exitCode?: number; stdout?: string; stderr?: string; delayMs?: number }>;
    }) => Promise<Record<string, unknown>>;
  };

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
      await notifyStatusBackend({
        running: false,
        statusBackendUrl: request.statusBackendUrl,
        requestId,
        terminalState: 'completed',
        promptCharacterCount: prompt.length,
        outputCharacterCount,
        requestDurationMs: Date.now() - startedAt,
      });
    } catch {
      traceRepoSearch(`notify running=false failed request_id=${requestId} state=completed`);
    }
    traceRepoSearch(
      `execute done request_id=${requestId} verdict=${String(scorecard?.verdict ?? 'unknown')} `
      + `duration_ms=${Date.now() - startedAt} output_chars=${outputCharacterCount}`
    );
    return {
      requestId,
      transcriptPath,
      artifactPath,
      scorecard,
    };
  } catch (error) {
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
      await notifyStatusBackend({
        running: false,
        statusBackendUrl: request.statusBackendUrl,
        requestId,
        terminalState: 'failed',
        errorMessage: message,
        promptCharacterCount: prompt.length,
        outputCharacterCount: 0,
        requestDurationMs: Date.now() - startedAt,
      });
    } catch {
      traceRepoSearch(`notify running=false failed request_id=${requestId} state=failed`);
    }
    traceRepoSearch(`execute failed request_id=${requestId} duration_ms=${Date.now() - startedAt} error=${message}`);
    throw error;
  }
}
