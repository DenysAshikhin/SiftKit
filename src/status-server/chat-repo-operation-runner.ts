import { WEB_RESEARCH_PRESET_TOOLS } from '@siftkit/contracts';

import {
  getActiveModelPreset,
  type SiftConfig,
} from '../config/index.js';
import { countTokensWithFallbackDetailed } from '../repo-search/prompt-budget.js';
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
  resolveChatSessionModel,
  type PersistTurn,
} from './chat.js';
import { ChatOperationPresetSelector } from './chat-operation-preset.js';
import type { StatusEngineService } from './engine-service.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaSpeculativeMetricsDelta,
} from './managed-llama.js';
import {
  normalizeRepoSearchScorecard,
  type RepoSearchScorecard,
  type RepoSearchTotals,
} from './repo-search-scorecard-types.js';

type ChatRepoOperation = 'plan' | 'repo-search';

type ChatTurnPhaseTimestamps = {
  requestStartedAtUtc: string;
  thinkingStartedAtUtc: string | null;
  thinkingEndedAtUtc: string | null;
  answerStartedAtUtc: string | null;
  answerEndedAtUtc: string | null;
};

export type ChatRepoOperationRequest = {
  runtimeRoot: string;
  session: ChatSession;
  config: SiftConfig;
  content: string;
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
  private readonly requestStartedAtUtc = new Date().toISOString();
  private thinkingStartedAtUtc: string | null = null;
  private thinkingEndedAtUtc: string | null = null;
  private answerStartedAtUtc: string | null = null;
  private answerEndedAtUtc: string | null = null;

  constructor(private readonly writer: ProgressWriter<RepoSearchProgressEvent>) {
    super();
  }

  get enabled(): boolean {
    return this.writer.enabled;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'thinking') {
      this.observeThinking(event.thinkingText ?? '');
    }
    if (event.kind === 'answer') {
      this.observeAnswer(event.answerText ?? '');
    }
    this.writer.write(event);
  }

  observeAnswer(content: string): void {
    if (!content.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.answerStartedAtUtc ??= now;
    this.answerEndedAtUtc = now;
  }

  snapshot(): ChatTurnPhaseTimestamps {
    return {
      requestStartedAtUtc: this.requestStartedAtUtc,
      thinkingStartedAtUtc: this.thinkingStartedAtUtc,
      thinkingEndedAtUtc: this.thinkingEndedAtUtc,
      answerStartedAtUtc: this.answerStartedAtUtc,
      answerEndedAtUtc: this.answerEndedAtUtc,
    };
  }

  private observeThinking(content: string): void {
    if (!content.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.thinkingStartedAtUtc ??= now;
    this.thinkingEndedAtUtc = now;
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
    const session = {
      ...selected.session,
      planRepoRoot: request.repoRoot,
    };
    const speculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(
      request.managedLlamaRunId,
    );
    const engineResult = await request.engineService.executeRepoSearch({
      presetId: selected.preset.id,
      taskKind: operation,
      prompt: this.buildPrompt(operation, request.content),
      repoRoot: request.repoRoot,
      statusBackendUrl: request.statusBackendUrl,
      config: request.config,
      allowedTools: this.getAllowedTools(request.config, selected.preset, session),
      model: resolveChatSessionModel(request.config, session),
      maxTurns: request.maxTurns ?? selected.preset.maxTurns ?? undefined,
      logFile: request.logFile,
      availableModels: request.availableModels,
      mockResponses: request.mockResponses,
      mockCommandResults: request.mockCommandResults,
      requestId: request.requestId,
      progressWriter: progress,
    });
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
    startedAt: number;
    progress: ChatRepoOperationProgressTracker;
    speculativeSnapshot: ReturnType<typeof captureManagedLlamaSpeculativeMetricsSnapshot>;
  }): Promise<ChatSession> {
    const scorecard = options.engineResult.scorecard;
    const tokenConfig = Array.isArray(options.request.mockResponses)
      ? undefined
      : options.request.config;
    const inputTokenCount = await this.countInputTokens(tokenConfig, options.request.content);
    const turns = await this.countThinkingTokens(
      tokenConfig,
      this.buildPersistTurns(options.engineResult),
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
        maintainPerStepThinking: this.shouldMaintainPerStepThinking(
          options.request.config,
          options.session,
        ),
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

  private buildPersistTurns(result: RepoSearchExecutionResult): PersistTurn[] {
    const promptTokens = getScorecardTotal(result.scorecard, 'promptTokens');
    return buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
      thinkingText: turn.thinkingText,
      toolMessages: turn.toolMessages.map((message) => ({
        ...message,
        toolCallPromptTokenCount: promptTokens,
      })),
    }));
  }

  private shouldMaintainPerStepThinking(config: SiftConfig, session: ChatSession): boolean {
    const activePreset = getActiveModelPreset(config);
    return session.thinkingEnabled !== false
      && activePreset.Reasoning === 'on'
      && activePreset.MaintainPerStepThinking !== false;
  }

  private async countInputTokens(
    config: SiftConfig | undefined,
    content: string,
  ): Promise<{ tokenCount: number; estimated: boolean }> {
    const count = await countTokensWithFallbackDetailed(config, content, {
      timeoutMs: 1000,
      retryMaxWaitMs: 1000,
    });
    return {
      tokenCount: count.tokenCount,
      estimated: count.source !== 'llama.cpp',
    };
  }

  private async countThinkingTokens(
    config: SiftConfig | undefined,
    turns: PersistTurn[],
  ): Promise<PersistTurn[]> {
    const countedTurns: PersistTurn[] = [];
    for (const turn of turns) {
      const thinkingText = turn.thinkingText.trim();
      if (!thinkingText) {
        countedTurns.push(turn);
        continue;
      }
      const count = await countTokensWithFallbackDetailed(config, thinkingText, {
        timeoutMs: 1000,
        retryMaxWaitMs: 1000,
      });
      countedTurns.push({
        ...turn,
        thinkingTokens: count.tokenCount,
        thinkingTokensEstimated: count.source !== 'llama.cpp',
      });
    }
    return countedTurns;
  }

  private hasEstimatedTokens(
    scorecard: RepoSearchExecutionResult['scorecard'],
    key: keyof RepoSearchTotals,
  ): boolean {
    const count = getScorecardTotal(scorecard, key);
    return count !== null && count > 0;
  }
}
