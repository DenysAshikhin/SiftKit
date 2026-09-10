import { RunOperationTypeSchema } from '@siftkit/contracts';

import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../../src/repo-search/types.js';
import { upsertRuntimeTextArtifact } from '../../src/state/runtime-artifacts.js';
import { StatusEngineService } from '../../src/status-server/engine-service.js';
import { buildUserContent } from '../../src/llm-protocol/image-attachments.js';

class DeferredNotification {
  readonly promise: Promise<void>;
  private settle: (() => void) | null = null;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.settle = resolve; });
  }

  notify(): void {
    const settle = this.settle;
    if (!settle) return;
    this.settle = null;
    settle();
  }
}

export type StoppedChatEngineScenario = {
  prompt: string;
  progressEvents: readonly RepoSearchProgressEvent[];
  pauseAfterAbort?: boolean;
  /**
   * The full model-visible result of each completed tool, by tool call id. A completed tool
   * without an entry is one whose whole result is its preview.
   */
  canonicalOutputs?: Readonly<Record<string, string>>;
  /** False simulates a run that died before writing its transcript; the stop must then fail loudly. */
  recordEvidence?: boolean;
};

/**
 * A fake engine that streams a scripted transcript, waits to be aborted, and then — like the real
 * engine's failure path — records the canonical evidence of every tool it completed before the
 * abort error surfaces. The chat route hydrates its stopped turn from that record.
 */
export class StoppedChatEngineService extends StatusEngineService {
  private readonly entered = new DeferredNotification();
  private readonly aborted = new DeferredNotification();
  private readonly postAbortRelease = new DeferredNotification();

  constructor(private readonly scenario: StoppedChatEngineScenario) {
    super();
  }

  waitUntilEntered(): Promise<void> {
    return this.entered.promise;
  }

  waitUntilAborted(): Promise<void> {
    return this.aborted.promise;
  }

  releaseAfterAbort(): void {
    this.postAbortRelease.notify();
  }

  override async executeRepoSearch(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    if (request.prompt !== this.scenario.prompt) {
      return await super.executeRepoSearch(request);
    }
    const signal = request.abortSignal;
    if (!signal) {
      throw new Error('StoppedChatEngineService requires an abort signal.');
    }
    if (this.scenario.recordEvidence !== false) request.evidenceRecorder?.recordContextInitialized({
      messages: [...(request.history ?? []), { role: 'user', content: buildUserContent(request.prompt, request.initialUserImages ?? []) }],
      contextRevision: 0, turnBoundary: request.history?.length ?? 0,
    });
    const identities = new Map<string, { toolCallId: string; displayToolCallId: string; batchId: string; turn: number; indexInBatch: number }>();
    for (const event of this.scenario.progressEvents) {
      if (this.scenario.recordEvidence !== false && event.kind === 'tool_start') {
        const call = { toolCallId: event.toolCallId, displayToolCallId: event.toolCallId, batchId: `batch-${event.turn}`,
          turn: event.turn, indexInBatch: [...identities.values()].filter(value => value.turn === event.turn).length };
        identities.set(event.toolCallId, call);
        request.evidenceRecorder?.recordToolProposed({ call, toolName: event.activityKind, arguments: { command: event.command }, command: event.command,
          activityKind: event.activityKind, activitySubject: event.activitySubject, maxTurns: event.maxTurns,
          promptTokenCount: event.promptTokenCount, executionState: 'proposed' });
        request.evidenceRecorder?.recordToolStarted({ call, startedAtUtc: new Date().toISOString() });
      }
      if (this.scenario.recordEvidence !== false && event.kind === 'tool_result') {
        const call = identities.get(event.toolCallId);
        if (!call) throw new Error('Fixture tool result has no proposal');
        request.evidenceRecorder?.recordToolResult({ call, executionState: 'completed', exitCode: event.exitCode,
          output: this.scenario.canonicalOutputs?.[event.toolCallId] ?? event.outputSnippet, images: [], imageMeta: [],
          outputTokens: event.outputTokens, outputTokensEstimated: event.outputTokensEstimated,
          promptTokenCount: event.promptTokenCount, finishedAtUtc: new Date().toISOString() });
      }
      request.progressWriter?.write(event);
    }
    this.entered.notify();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    this.aborted.notify();
    if (this.scenario.pauseAfterAbort === true) {
      await this.postAbortRelease.promise;
    }
    if (this.scenario.recordEvidence !== false) {
      this.persistCanonicalEvidence(request);
    }
    throw new Error('Chat request aborted.');
  }

  private persistCanonicalEvidence(request: RepoSearchExecutionRequest): void {
    const requestId = request.requestId;
    if (!requestId) {
      throw new Error('StoppedChatEngineService requires the engine request id to record evidence.');
    }
    const lines: Record<string, string | number | null | boolean>[] = [{
      kind: 'run_start',
      repoRoot: request.repoRoot,
      configuredModel: 'mock-model',
      baseUrl: null,
      operationType: RunOperationTypeSchema.parse(request.taskKind ?? 'repo-search'),
      toolResultFormat: 'identified-v1',
    }];
    for (const event of this.scenario.progressEvents) {
      if (event.kind === 'tool_start') {
        lines.push({
          kind: 'turn_command_start', turn: event.turn, toolCallId: event.toolCallId,
          toolName: event.activityKind, requestedCommand: event.command, commandToRun: event.command, native: true,
        });
      }
      if (event.kind === 'tool_result') {
        const output = this.scenario.canonicalOutputs?.[event.toolCallId] ?? event.outputSnippet;
        lines.push({
          kind: 'turn_command_result', turn: event.turn, toolCallId: event.toolCallId,
          command: event.command, requestedCommand: event.command, executedCommand: event.command,
          exitCode: event.exitCode, output, insertedResultText: output,
        });
      }
    }
    upsertRuntimeTextArtifact({
      artifactKind: 'repo_search_transcript',
      requestId,
      title: `db://repo-search/failed/request_${requestId}.jsonl`,
      content: lines.map((line) => `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`).join(''),
    });
  }
}
