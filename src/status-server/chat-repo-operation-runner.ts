import { WEB_RESEARCH_PRESET_TOOLS } from '@siftkit/contracts';
import type { ImageMetadata } from '@siftkit/contracts';

import {
  getActiveModelPreset,
  type SiftConfig,
} from '../config/index.js';
import type {
  RepoSearchExecutionResult,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from '../repo-search/types.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import {
  getGenerationTokensPerSecond,
  getPromptTokensPerSecond,
} from '../lib/telemetry-metrics.js';
import {
  normalizeOperationModeAllowedTools,
  resolvePresetAllowedTools,
  type SiftPreset,
} from '../presets.js';
import {
  getChatSessionPath,
  readChatSessionFromPath,
  type ChatSession,
} from '../state/chat-sessions.js';
import {
  appendChatMessagesWithUsage,
  buildPersistTurnsFromRepoSearchResult,
  buildPlanMarkdownFromRepoSearch,
  buildPlanRequestPrompt,
  buildRepoSearchMarkdown,
  getScorecardTotal,
  resolveChatSessionConfig,
} from './chat.js';
import { ChatOperationPresetSelector } from './chat-operation-preset.js';
import { admitImagesForPreset } from '../llm-protocol/preset-image-admission.js';
import {
  ChatTurnPhaseTracker,
  type ChatTurnPhaseTimestamps,
} from './chat-turn-phase-tracker.js';
import { ChatTurnTelemetry } from './chat-turn-telemetry.js';
import type { StatusEngineService } from './engine-service.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  diagnoseManagedLlamaOom,
  getManagedLlamaSpeculativeMetricsDelta,
  ManagedLlamaStartupError,
} from './managed-llama.js';
import {
  normalizeRepoSearchScorecard,
  type RepoSearchScorecard,
  type RepoSearchTotals,
} from './repo-search-scorecard-types.js';

type ChatRepoOperation = 'plan' | 'repo-search';

export type ChatRepoOperationRequest = {
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
  maxTurns?: number;
  logFile?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  managedLlamaRunId: string | null;
};

export type ChatRepoOperationResult = {
  updatedSession: ChatSession;
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

  observeAnswer(content: string): void {
    this.phaseTracker.observeAnswer(content);
  }

  snapshot(): ChatTurnPhaseTimestamps {
    return this.phaseTracker.snapshot();
  }
}

export class ChatRepoOperationRunner {
  runPlan(request: ChatRepoOperationRequest): Promise<ChatRepoOperationResult> {
    return this.run(request, 'plan');
  }

  runRepoSearch(request: ChatRepoOperationRequest): Promise<ChatRepoOperationResult> {
    return this.run(request, 'repo-search');
  }

  private async run(
    request: ChatRepoOperationRequest,
    operation: ChatRepoOperation,
  ): Promise<ChatRepoOperationResult> {
    const startedAt = Date.now();
    const progress = new ChatRepoOperationProgressTracker(request.progressWriter);
    const selected = new ChatOperationPresetSelector(request.config.Presets)
      .select(request.session, operation);
    const effectiveConfig = resolveChatSessionConfig(request.config, selected.session);
    const activePreset = getActiveModelPreset(effectiveConfig);
    const admitted = admitImagesForPreset(activePreset, request.images);
    const admittedImages = admitted.map((image) => image.dataUrl);
    const admittedImageMeta = admitted.map((image) => image.metadata);
    const session = {
      ...selected.session,
      planRepoRoot: request.repoRoot,
    };
    const speculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(
      request.managedLlamaRunId,
    );
    let engineResult: RepoSearchExecutionResult;
    try {
      engineResult = await request.engineService.executeRepoSearch({
        presetId: selected.preset.id,
        taskKind: operation,
        prompt: this.buildPrompt(operation, request.content),
        initialUserImages: admittedImages,
        repoRoot: request.repoRoot,
        statusBackendUrl: request.statusBackendUrl,
        config: effectiveConfig,
        allowedTools: this.getAllowedTools(request.config, selected.preset, session),
        maxTurns: request.maxTurns ?? selected.preset.maxTurns ?? undefined,
        logFile: request.logFile,
        availableModels: request.availableModels,
        mockResponses: request.mockResponses,
        mockCommandResults: request.mockCommandResults,
        requestId: request.requestId,
        progressWriter: progress,
      });
    } catch (error) {
      const diagnosis = diagnoseManagedLlamaOom(
        error instanceof Error ? error : String(error),
        {
          hasImages: request.images.length > 0,
          visionMaxImagePixels: activePreset.VisionMaxImagePixels,
        },
      );
      if (diagnosis) {
        if (diagnosis.phase === 'startup') {
          throw new ManagedLlamaStartupError(diagnosis.guidance, diagnosis.failure);
        }
        throw new Error(diagnosis.guidance);
      }
      throw error;
    }
    const assistantContent = this.buildAssistantContent(
      operation,
      request.content,
      request.repoRoot,
      engineResult,
    );
    progress.observeAnswer(assistantContent);
    const updatedSession = await this.persistResult({
      request,
      operation,
      session,
      engineResult,
      assistantContent,
      admittedImages,
      admittedImageMeta,
      startedAt,
      progress,
      speculativeSnapshot,
    });
    return {
      updatedSession,
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

  private getAllowedTools(
    config: SiftConfig,
    preset: SiftPreset,
    session: ChatSession,
  ): SiftPreset['allowedTools'] {
    const allowedTools = resolvePresetAllowedTools(
      preset,
      normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
    );
    if (session.webSearchEnabled !== true) {
      return allowedTools;
    }
    return [...new Set([...allowedTools, ...WEB_RESEARCH_PRESET_TOOLS])];
  }

  private async persistResult(options: {
    request: ChatRepoOperationRequest;
    operation: ChatRepoOperation;
    session: ChatSession;
    engineResult: RepoSearchExecutionResult;
    assistantContent: string;
    admittedImages: string[];
    admittedImageMeta: ImageMetadata[];
    startedAt: number;
    progress: ChatRepoOperationProgressTracker;
    speculativeSnapshot: ReturnType<typeof captureManagedLlamaSpeculativeMetricsSnapshot>;
  }): Promise<ChatSession> {
    const scorecard = options.engineResult.scorecard;
    const tokenConfig = Array.isArray(options.request.mockResponses)
      ? undefined
      : options.request.config;
    const telemetry = new ChatTurnTelemetry(options.request.config, tokenConfig);
    const inputTokenCount = await telemetry.countInputTokens(options.request.content);
    const turns = await telemetry.countThinkingTokens(
      buildPersistTurnsFromRepoSearchResult(options.engineResult),
    );
    const trackedSpeculative = getManagedLlamaSpeculativeMetricsDelta(
      options.request.managedLlamaRunId,
      options.speculativeSnapshot,
    );
    const promptEvalTokens = getScorecardTotal(scorecard, 'promptEvalTokens');
    const promptEvalDurationMs = getScorecardTotal(scorecard, 'promptEvalDurationMs');
    appendChatMessagesWithUsage(
      options.request.runtimeRoot,
      options.session,
      options.request.content,
      options.assistantContent,
      {
        promptTokens: getScorecardTotal(scorecard, 'promptTokens'),
        promptCacheTokens: getScorecardTotal(scorecard, 'promptCacheTokens'),
        promptEvalTokens,
      },
      {
        turns,
        images: options.admittedImages,
        imageMeta: options.admittedImageMeta,
        maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(options.session),
        inputTokens: inputTokenCount.tokenCount,
        inputTokensEstimated: inputTokenCount.estimated,
        requestDurationMs: Date.now() - options.startedAt,
        promptEvalDurationMs,
        generationDurationMs: getScorecardTotal(scorecard, 'generationDurationMs'),
        promptTokensPerSecond: getPromptTokensPerSecond(
          promptEvalTokens,
          promptEvalDurationMs,
        ),
        generationTokensPerSecond: getGenerationTokensPerSecond(
          getScorecardTotal(scorecard, 'outputTokens'),
          getScorecardTotal(scorecard, 'thinkingTokens'),
          getScorecardTotal(scorecard, 'generationDurationMs'),
        ),
        ...options.progress.snapshot(),
        speculativeAcceptedTokens: trackedSpeculative?.speculativeAcceptedTokens
          ?? getScorecardTotal(scorecard, 'speculativeAcceptedTokens'),
        speculativeGeneratedTokens: trackedSpeculative?.speculativeGeneratedTokens
          ?? getScorecardTotal(scorecard, 'speculativeGeneratedTokens'),
        outputTokens: getScorecardTotal(scorecard, 'outputTokens'),
        outputTokensEstimated: this.hasEstimatedTokens(scorecard, 'outputTokensEstimatedCount'),
        thinkingTokens: getScorecardTotal(scorecard, 'thinkingTokens'),
        thinkingTokensEstimated: this.hasEstimatedTokens(scorecard, 'thinkingTokensEstimatedCount'),
        sourceRunId: options.engineResult.requestId,
        groundingStatus: options.operation === 'repo-search'
          ? normalizeRepoSearchScorecard(scorecard).tasks[0]?.groundingStatus ?? null
          : null,
      },
    );
    const authoritativeSession = readChatSessionFromPath(
      getChatSessionPath(options.request.runtimeRoot, options.session.id),
    );
    if (!authoritativeSession) {
      throw new Error(`Chat session disappeared after persistence: ${options.session.id}`);
    }
    return authoritativeSession;
  }

  private hasEstimatedTokens(
    scorecard: RepoSearchExecutionResult['scorecard'],
    key: keyof RepoSearchTotals,
  ): boolean {
    const count = getScorecardTotal(scorecard, key);
    return count !== null && count > 0;
  }
}
