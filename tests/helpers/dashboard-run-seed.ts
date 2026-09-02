import Database from 'better-sqlite3';

import {
  upsertRepoSearchRun,
  upsertRunArtifactPayload,
} from '../../src/status-server/dashboard-runs.js';
import type { StatusArtifactType } from '../../src/state/status-artifacts.js';
import type { JsonObject } from '../../src/lib/json-types.js';

type DatabaseInstance = InstanceType<typeof Database>;

/**
 * Seeds `run_logs` through the same calls the status server uses when a run
 * finishes, so dashboard E2Es exercise rows shaped exactly like production ones.
 */
export class DashboardRunSeeder {
  private readonly database: DatabaseInstance;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
  }

  artifact(artifactType: StatusArtifactType, requestId: string, artifactPayload: JsonObject): void {
    upsertRunArtifactPayload({
      database: this.database,
      requestId,
      artifactType,
      artifactPayload,
    });
  }

  summaryRun(options: {
    requestId: string;
    question: string;
    createdAtUtc: string;
    payload?: JsonObject;
  }): void {
    this.artifact('summary_request', options.requestId, {
      requestId: options.requestId,
      question: options.question,
      backend: 'exl3',
      model: 'Qwen3.5-9B-Q8_0.gguf',
      summary: `Summary output for ${options.requestId}`,
      createdAtUtc: options.createdAtUtc,
      ...options.payload,
    });
  }

  repoSearchRun(options: {
    requestId: string;
    prompt: string;
    repoRoot: string;
    createdAtUtc: string;
    transcriptText: string;
    requestDurationMs: number;
  }): void {
    upsertRepoSearchRun({
      database: this.database,
      requestId: options.requestId,
      taskKind: 'repo-search',
      prompt: options.prompt,
      repoRoot: options.repoRoot,
      model: 'mock-model',
      backend: 'exl3',
      requestMaxTokens: 512,
      maxTurns: 2,
      transcriptText: options.transcriptText,
      artifactPayload: {
        requestId: options.requestId,
        prompt: options.prompt,
        repoRoot: options.repoRoot,
        verdict: 'fail',
        totals: { commandsExecuted: 1 },
        createdAtUtc: options.createdAtUtc,
      },
      terminalState: 'failed',
      startedAtUtc: options.createdAtUtc,
      finishedAtUtc: options.createdAtUtc,
      requestDurationMs: options.requestDurationMs,
      promptTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      toolTokens: null,
      promptCacheTokens: null,
      promptEvalTokens: null,
      promptEvalDurationMs: null,
      generationDurationMs: null,
    });
  }

  close(): void {
    this.database.close();
  }
}

/** `NN`-suffixed request id used by the bulk seeding loops in the run-log E2Es. */
export function getOrdinalRequestId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, '0')}`;
}

export function buildRepoSearchTranscriptText(startAtUtc: string, endAtUtc: string): string {
  return [
    JSON.stringify({ at: startAtUtc, kind: 'turn_model_response', text: '{"action":"finish"}' }),
    JSON.stringify({ at: endAtUtc, kind: 'run_done', scorecard: { verdict: 'fail' } }),
  ].join('\n') + '\n';
}
