import { buildChatAnswerCompletion,type ChatRunRecorder } from './chat-run-recorder.js';
import type { QuestionGate } from '../repo-search/engine/question-gate.js';

import {
getActiveModelPreset,
type SiftConfig,
} from '../config/index.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import { throwIfAborted } from '../lib/abort.js';
import { admitImagesForPreset } from '../llm-protocol/preset-image-admission.js';
import type { MockPlannerResponseInput } from '../planner-protocol/mock-response.js';
import type { ChatMessageQueueDelivery } from '../repo-search/engine/queue-delivery.js';
import type {
RepoSearchExecutionResult,
RepoSearchMockCommandResult,
RepoSearchProgressEvent,
} from '../repo-search/types.js';
import {
type ChatSession, saveChatSessionMetadata
} from '../state/chat-sessions.js';
import {
resolveChatRunAllowedTools,
ChatOperationPresetSelector,
} from './chat-operation-preset.js';
import {
ChatTurnPhaseTracker,
type ChatTurnPhaseTimestamps,
} from './chat-turn-phase-tracker.js';
import { auditCompletedChatSessionThroughput } from './chat-turn-telemetry.js';
import {
buildPlanMarkdownFromRepoSearch,
buildPlanRequestPrompt,
buildRepoSearchMarkdown,
getChatRunFailure,
} from './chat.js';
import type { StatusEngineService } from './engine-service.js';
import {
normalizeRepoSearchScorecard,
type RepoSearchScorecard,
} from './repo-search-scorecard-types.js';

type ChatRepoOperation = 'plan' | 'repo-search';

export type ChatRepoOperationRequest = {
  recorder: ChatRunRecorder;
  questionGate: QuestionGate;
  runtimeRoot: string;
  session: ChatSession;
  config: SiftConfig;
  content: string;
  images: string[];
  repoRoot: string;
  statusBackendUrl: string;
  engineService: StatusEngineService;
  progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  requestId: string;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: MockPlannerResponseInput[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  abortSignal?: AbortSignal;
  queueDelivery?: ChatMessageQueueDelivery;
};

export type ChatRepoOperationResult = {
  updatedSession: ChatSession;
  failure: string | null;
  repoSearch: {
    requestId: string;
    transcriptPath: string | null;
    artifactPath: string | null;
    scorecard: RepoSearchScorecard;
  };
};

class ChatRepoOperationProgressTracker extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly phaseTracker = new ChatTurnPhaseTracker();

  constructor(private readonly writer: ProgressWriter<RepoSearchProgressEvent>) {
    super();
  }

  get enabled(): boolean {
    return this.writer.enabled;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'thinking') {
      this.phaseTracker.observeThinking(event.thinkingText ?? '');
    }
    if (event.kind === 'answer') {
      this.phaseTracker.observeAnswer(event.answerText ?? '');
    }
    this.writer.write(event);
  }

  override recordActivity(): void {
    this.writer.recordActivity();
  }

  observeAnswer(content: string): void {
    this.phaseTracker.observeAnswer(content);
  }

  snapshot(): ChatTurnPhaseTimestamps {
    return this.phaseTracker.snapshot();
  }
}

export class ChatRepoOperationRunner {
  async run(
    operation: ChatRepoOperation,
    request: ChatRepoOperationRequest,
  ): Promise<ChatRepoOperationResult> {
    const abortSignal = request.abortSignal ? AbortSignal.any([request.abortSignal, request.recorder.abortSignal]) : request.recorder.abortSignal;
    throwIfAborted(abortSignal);
    const startedAt = Date.now();
    const progress = new ChatRepoOperationProgressTracker(request.progressWriter);
    const selected = new ChatOperationPresetSelector(request.config.Presets)
      .select(request.session, operation);
    const admitted = admitImagesForPreset(getActiveModelPreset(request.config), request.images);
    const admittedImages = admitted.map((image) => image.dataUrl);
    saveChatSessionMetadata(request.runtimeRoot, selected.session);
    const settings = request.recorder.settings;
    request.recorder.bindEngine({ requestId: request.requestId, repoAgentSessionId: null });
    const engineResult: RepoSearchExecutionResult = await request.engineService.executeRepoSearch({
        evidenceRecorder: request.recorder,
        questionGate: request.questionGate,
        presetId: selected.preset.id,
        taskKind: operation,
        prompt: this.buildPrompt(operation, request.content),
        history: request.recorder.readHistory(),
        initialUserImages: admittedImages,
        repoRoot: request.repoRoot,
        statusBackendUrl: request.statusBackendUrl,
        config: request.config,
        allowedTools: resolveChatRunAllowedTools({ operation, config: request.config, preset: selected.preset }),
        webToolsEnabled: settings.webSearchEnabled,
        maxTurns: settings.maxTurns ?? undefined,
        logFile: request.logFile,
        availableModels: request.availableModels,
        mockResponses: request.mockResponses,
        mockCommandResults: request.mockCommandResults,
        requestId: request.requestId,
        progressWriter: progress,
        queueDelivery: request.queueDelivery,
        abortSignal,
    });
    throwIfAborted(abortSignal);
    const assistantContent = this.buildAssistantContent(
      operation,
      request.content,
      request.repoRoot,
      engineResult,
    );
    progress.observeAnswer(assistantContent);
    const failure = getChatRunFailure(engineResult);
    const updatedSession = request.recorder.completeAnswer({
      ...buildChatAnswerCompletion(engineResult, assistantContent, {
        operationType: operation,
        operationId: engineResult.scorecard.runId,
        requestId: engineResult.requestId,
        model: engineResult.scorecard.model,
        presetId: request.recorder.admittedModel.id,
      }),
      requestDurationMs: Date.now() - startedAt,
      ...progress.snapshot(),
      groundingStatus: operation === 'repo-search' ? normalizeRepoSearchScorecard(engineResult.scorecard).tasks[0]?.groundingStatus ?? null : null,
    }, failure ? 'execution_failure' : 'completed', failure);
    auditCompletedChatSessionThroughput(updatedSession, {
      requestId: engineResult.requestId,
      model: engineResult.scorecard.model,
      presetId: request.recorder.admittedModel.id,
    });
    return {
      updatedSession,
      failure: getChatRunFailure(engineResult),
      repoSearch: {
        requestId: engineResult.requestId,
        transcriptPath: engineResult.transcriptPath || null,
        artifactPath: engineResult.artifactPath || null,
        scorecard: normalizeRepoSearchScorecard(engineResult.scorecard),
      },
    };
  }

  private buildPrompt(operation: ChatRepoOperation, content: string): string {
    if (operation === 'plan') {
      return buildPlanRequestPrompt(content);
    }
    return content;
  }

  private buildAssistantContent(
    operation: ChatRepoOperation,
    content: string,
    repoRoot: string,
    result: RepoSearchExecutionResult,
  ): string {
    if (operation === 'plan') {
      return buildPlanMarkdownFromRepoSearch(content, repoRoot, result);
    }
    return buildRepoSearchMarkdown(content, repoRoot, result);
  }

}
