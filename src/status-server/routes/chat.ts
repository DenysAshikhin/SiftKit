/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ChatSession as WireChatSession,
  ChatMessage as WireChatMessage,
  ChatSessionResponse,
  ChatSessionsResponse,
} from '@siftkit/contracts';
import type { ChatMessage as PersistedChatMessage } from '../../state/chat-sessions.js';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { OptionalJsonValue, JsonSerializable } from '../../lib/json-types.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import type { ChatGroundingStatus } from '../../repo-search/chat-grounding-policy.js';
import { getRuntimeRoot } from '../paths.js';
import { buildIgnorePolicy } from '../../repo-search/command-safety.js';
import { readAgentsMd, scanRepoFiles } from '../../repo-search/prompts.js';
import { countTokensWithFallbackDetailed } from '../../repo-search/prompt-budget.js';
import {
  readBody,
  parseJsonBody,
  sendJson,
} from '../http-utils.js';
import { readConfig } from '../config-store.js';
import {
  applyHostLlamaRuntimeSettings,
  getActiveModelPreset,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredReasoning,
  notifyStatusBackend,
  SIFT_DEFAULT_LLAMA_BASE_URL,
  type SiftConfig,
} from '../../config/index.js';
import {
  type RepoSearchProgressEvent,
  buildRepoSearchProgressLogMessage,
  removeDashboardRunCommandFromLogs,
} from '../dashboard-runs.js';
import {
  buildContextUsage,
  resolveChatSessionModel,
  resolveChatSessionContextWindow,
  type ContextUsage,
  type ChatUsage,
  type PersistToolMessage,
  type PersistTurn,
  appendChatMessagesWithUsage,
  buildChatSystemContent,
  buildChatHistoryMessages,
  condenseChatSession,
  buildPlanRequestPrompt,
  buildPlanMarkdownFromRepoSearch,
  getScorecardTotal,
  buildPersistTurnsFromRepoSearchResult,
  buildRepoSearchMarkdown,
  buildRetainedWebToolCalls,
} from '../chat.js';
import { buildChatPromptContext } from '../chat-prompt-context.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import {
  parseChatMessageRequest,
  parseChatRepoAppendPreviewRequest,
  parseChatRepoRequest,
  parseChatSessionCreateRequest,
  parseChatSessionUpdateRequest,
} from '../chat-route-request-normalizers.js';
import { normalizeRepoSearchScorecard, type RepoSearchTotals } from '../repo-search-scorecard-types.js';
import {
  type ChatSession,
  readChatSessionFromPath,
  readChatSessions,
  getChatSessionPath,
  deleteChatSession,
  deleteChatMessage,
  saveChatSession,
} from '../../state/chat-sessions.js';
import { getRuntimeDatabase } from '../../state/runtime-db.js';
import {
  findPresetById,
  mapLegacyModeToPresetId,
  mapPresetIdToLegacyMode,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  resolvePresetAllowedTools,
  WEB_RESEARCH_TOOLS,
  type SiftPreset,
} from '../../presets.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaSpeculativeMetricsDelta,
  logLine,
} from '../managed-llama.js';
import {
  getGenerationTokensPerSecond,
  getPromptTokensPerSecond,
} from '../../lib/telemetry-metrics.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
  ensureActivePresetReadyForModelRequest,
} from '../server-ops.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';

const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_MS = 30_000;

async function readEffectiveChatRouteConfig(configPath: string): Promise<SiftConfig> {
  const localConfig = readConfig(configPath);
  return await applyHostLlamaRuntimeSettings(localConfig);
}

function normalizeChatGroundingStatus(value: ChatGroundingStatus | null | undefined): ChatGroundingStatus | null {
  if (value === 'ungrounded' || value === 'snippet_only' || value === 'fetched') {
    return value;
  }
  return null;
}

function getChatGroundingStatus(scorecard: OptionalJsonValue): ChatGroundingStatus | null {
  return normalizeChatGroundingStatus(normalizeRepoSearchScorecard(scorecard).tasks[0]?.groundingStatus);
}

function getEffectivePresetAllowedTools(config: SiftConfig, preset: SiftPreset | null): SiftPreset['allowedTools'] | undefined {
  if (!preset) {
    return undefined;
  }
  return resolvePresetAllowedTools(
    preset,
    normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
  );
}

export function withEffectiveWebTools(
  allowedTools: SiftPreset['allowedTools'] | undefined,
  enabled: boolean,
): SiftPreset['allowedTools'] | undefined {
  if (!enabled || !allowedTools) {
    return allowedTools;
  }
  return [...new Set([...allowedTools, ...WEB_RESEARCH_TOOLS])];
}

type SseWriter = (eventName: string, payload: JsonSerializable) => void;

function requireToolCallId(event: RepoSearchProgressEvent): string {
  const value = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
  if (!value) {
    throw new Error(`repo-search ${event.kind} progress event missing toolCallId`);
  }
  return value;
}

function forwardRepoSearchToolEvent(
  writeSse: SseWriter,
  event: RepoSearchProgressEvent,
  logTag: 'planner' | 'repo_search',
  logLineFn: (message: string) => void,
): void {
  if (event.kind === 'tool_start') {
    const logMessage = buildRepoSearchProgressLogMessage(event, logTag);
    if (logMessage) logLineFn(logMessage);
    writeSse('tool_start', {
      toolCallId: requireToolCallId(event),
      turn: event.turn,
      maxTurns: event.maxTurns,
      command: event.command,
      promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
    });
    return;
  }
  if (event.kind === 'tool_result') {
    writeSse('tool_result', {
      toolCallId: requireToolCallId(event),
      turn: event.turn,
      maxTurns: event.maxTurns,
      command: event.command,
      exitCode: event.exitCode,
      outputSnippet: event.outputSnippet,
      outputTokens: Number.isFinite(event.outputTokens) ? Number(event.outputTokens) : null,
      outputTokensEstimated: event.outputTokensEstimated === true,
      promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
    });
  }
}

function shouldMaintainPerStepThinking(config: SiftConfig, session: ChatSession): boolean {
  const activePreset = getActiveModelPreset(config);
  return session.thinkingEnabled !== false
    && activePreset.Reasoning === 'on'
    && activePreset.MaintainPerStepThinking !== false;
}

function withPromptContext(config: SiftConfig, session: ChatSession): ChatSession {
  return {
    ...session,
    promptContext: buildChatPromptContext(config, session),
  };
}

function toWireChatMessage(message: PersistedChatMessage): WireChatMessage {
  return { ...message, sourceRunId: message.sourceRunId ?? null };
}

function toWireChatSession(config: SiftConfig, session: ChatSession): WireChatSession {
  return {
    id: session.id,
    title: session.title ?? '',
    modelPresetId: session.modelPresetId,
    model: resolveChatSessionModel(config, session),
    contextWindowTokens: resolveChatSessionContextWindow(config, session),
    thinkingEnabled: session.thinkingEnabled,
    webSearchEnabled: session.webSearchEnabled,
    presetId: session.presetId,
    mode: session.mode,
    planRepoRoot: session.planRepoRoot,
    condensedSummary: session.condensedSummary ?? '',
    createdAtUtc: session.createdAtUtc ?? '',
    updatedAtUtc: session.updatedAtUtc ?? '',
    messages: (session.messages ?? []).map(toWireChatMessage),
    promptContext: session.promptContext,
  };
}

function buildChatSessionResponse(config: SiftConfig, session: ChatSession): ChatSessionResponse {
  return {
    session: toWireChatSession(config, withPromptContext(config, session)),
    contextUsage: buildContextUsage(config, session),
  };
}

function isRepoSearchCapablePreset(preset: SiftPreset | null): preset is SiftPreset {
  if (!preset) {
    return false;
  }
  return preset.presetKind === 'plan' || preset.presetKind === 'repo-search';
}

function resolveRepoSearchRoutePreset(
  presets: SiftPreset[],
  sessionPresetId: string | null | undefined,
  fallbackPresetId: 'plan' | 'repo-search',
): SiftPreset | null {
  const sessionPreset = findPresetById(presets, sessionPresetId || '');
  if (isRepoSearchCapablePreset(sessionPreset)) {
    return sessionPreset;
  }
  const fallbackPreset = findPresetById(presets, fallbackPresetId);
  if (isRepoSearchCapablePreset(fallbackPreset)) {
    return fallbackPreset;
  }
  return presets.find((preset) => preset.presetKind === 'plan' || preset.presetKind === 'repo-search') || null;
}

export function resolveEffectiveRepoFileListing(config: Partial<Pick<SiftConfig, 'IncludeRepoFileListing'>>, preset: Pick<SiftPreset, 'includeRepoFileListing'> | null): boolean {
  return config.IncludeRepoFileListing !== false && preset?.includeRepoFileListing !== false;
}

export function resolveEffectiveAgentsMd(config: Partial<Pick<SiftConfig, 'IncludeAgentsMd'>>, preset: Pick<SiftPreset, 'includeAgentsMd'> | null): boolean {
  return config.IncludeAgentsMd !== false && preset?.includeAgentsMd !== false;
}

export function resolveRepoSearchAutoAppendOverrides(
  config: Pick<SiftConfig, 'IncludeAgentsMd' | 'IncludeRepoFileListing'>,
  preset: Pick<SiftPreset, 'includeAgentsMd' | 'includeRepoFileListing'> | null,
  overrides: { includeAgentsMd?: OptionalJsonValue; includeRepoFileListing?: OptionalJsonValue },
): { includeAgentsMd: boolean; includeRepoFileListing: boolean } {
  return {
    includeAgentsMd: typeof overrides.includeAgentsMd === 'boolean'
      ? overrides.includeAgentsMd
      : resolveEffectiveAgentsMd(config, preset),
    includeRepoFileListing: typeof overrides.includeRepoFileListing === 'boolean'
      ? overrides.includeRepoFileListing
      : resolveEffectiveRepoFileListing(config, preset),
  };
}

type RepoSearchAutoAppendPreviewItem = {
  key: 'agentsMd' | 'repoFileListing';
  label: string;
  enabledDefault: boolean;
  available: boolean;
  tokenCount: number;
  tokenSource: 'llama.cpp' | 'estimate';
};

async function buildRepoSearchAutoAppendPreviewItem(options: {
  key: RepoSearchAutoAppendPreviewItem['key'];
  label: string;
  enabledDefault: boolean;
  content: string;
  config: SiftConfig;
}): Promise<RepoSearchAutoAppendPreviewItem> {
  const content = options.content.trim();
  if (!content) {
    return {
      key: options.key,
      label: options.label,
      enabledDefault: options.enabledDefault,
      available: false,
      tokenCount: 0,
      tokenSource: 'estimate',
    };
  }
  const count = await countTokensWithFallbackDetailed(getLocalTokenConfig(options.config), content, {
    timeoutMs: 150,
    retryMaxWaitMs: 150,
  });
  return {
    key: options.key,
    label: options.label,
    enabledDefault: options.enabledDefault,
    available: true,
    tokenCount: count.tokenCount,
    tokenSource: count.source,
  };
}

export function getRepoSearchGenerationTokensPerSecond(scorecard: OptionalJsonValue): number | null {
  return getGenerationTokensPerSecond(
    getScorecardTotal(scorecard, 'outputTokens'),
    getScorecardTotal(scorecard, 'thinkingTokens'),
    getScorecardTotal(scorecard, 'generationDurationMs'),
  );
}

function hasEstimatedScorecardTokens(scorecard: OptionalJsonValue, key: keyof RepoSearchTotals): boolean {
  const count = getScorecardTotal(scorecard, key);
  return count !== null && count > 0;
}

async function countPersistTurnThinkingTokens(config: SiftConfig | undefined, turns: PersistTurn[]): Promise<PersistTurn[]> {
  const countedTurns: PersistTurn[] = [];
  for (const turn of turns) {
    const thinkingText = String(turn.thinkingText || '').trim();
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

async function countPersistedInputTokens(
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

function getMockTokenConfig(config: SiftConfig, mockResponses: string[] | undefined): SiftConfig | undefined {
  return Array.isArray(mockResponses) ? undefined : config;
}

function getLocalTokenConfig(config: SiftConfig): SiftConfig | undefined {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  return baseUrl === SIFT_DEFAULT_LLAMA_BASE_URL ? undefined : config;
}

function readRouteStringArray(reader: JsonRecordReader, key: string): string[] | undefined {
  const value = reader.value(key);
  return Array.isArray(value) ? value.map((entry) => String(entry)) : undefined;
}

function readRouteNumber(reader: JsonRecordReader, key: string): number | undefined {
  return reader.number(key) ?? undefined;
}

function readSessionRepoRoot(session: ChatSession): string {
  return typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
    ? session.planRepoRoot.trim()
    : process.cwd();
}

function resolveChatRepoRoot(request: { repoRoot?: string }, session: ChatSession): string {
  return resolve(request.repoRoot || readSessionRepoRoot(session));
}

async function notifyChatStatus(options: {
  ctx: ServerContext;
  requestId: string;
  running: boolean;
  promptChars: number;
  terminalState?: 'completed' | 'failed';
  errorMessage?: string;
  inputTokens?: number | null;
  outputChars?: number;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  requestDurationMs?: number;
}): Promise<void> {
  await notifyStatusBackend({
    running: options.running,
    taskKind: 'chat',
    statusBackendUrl: `${options.ctx.getServiceBaseUrl()}/status`,
    requestId: options.requestId,
    rawInputCharacterCount: options.running ? options.promptChars : undefined,
    promptCharacterCount: options.promptChars,
    terminalState: options.terminalState,
    errorMessage: options.errorMessage,
    inputTokens: options.inputTokens,
    outputCharacterCount: options.outputChars,
    outputTokens: options.outputTokens,
    thinkingTokens: options.thinkingTokens,
    promptCacheTokens: options.promptCacheTokens,
    promptEvalTokens: options.promptEvalTokens,
    requestDurationMs: options.requestDurationMs,
  });
}

type SessionSpeculativeMetrics = {
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
};

type ChatTurnPhaseTimestamps = {
  requestStartedAtUtc: string | null;
  thinkingStartedAtUtc: string | null;
  thinkingEndedAtUtc: string | null;
  answerStartedAtUtc: string | null;
  answerEndedAtUtc: string | null;
};

function createChatTurnPhaseTracker(requestStartedAtUtc: string): {
  observeThinking(content: string): void;
  observeAnswer(content: string): void;
  snapshot(): ChatTurnPhaseTimestamps;
} {
  let thinkingStartedAtUtc: string | null = null;
  let thinkingEndedAtUtc: string | null = null;
  let answerStartedAtUtc: string | null = null;
  let answerEndedAtUtc: string | null = null;
  const getNowUtc = (): string => new Date().toISOString();
  const hasContent = (value: string): boolean => String(value || '').trim().length > 0;
  return {
    observeThinking(content: string): void {
      if (!hasContent(content)) {
        return;
      }
      const nowUtc = getNowUtc();
      if (!thinkingStartedAtUtc) {
        thinkingStartedAtUtc = nowUtc;
      }
      thinkingEndedAtUtc = nowUtc;
    },
    observeAnswer(content: string): void {
      if (!hasContent(content)) {
        return;
      }
      const nowUtc = getNowUtc();
      if (!answerStartedAtUtc) {
        answerStartedAtUtc = nowUtc;
      }
      answerEndedAtUtc = nowUtc;
    },
    snapshot(): ChatTurnPhaseTimestamps {
      return {
        requestStartedAtUtc,
        thinkingStartedAtUtc,
        thinkingEndedAtUtc,
        answerStartedAtUtc,
        answerEndedAtUtc,
      };
    },
  };
}

function captureManagedLlamaSessionCursor(ctx: ServerContext) {
  return captureManagedLlamaSpeculativeMetricsSnapshot(ctx.managedLlamaLastStartupLogs);
}

function readManagedLlamaSessionSpeculativeMetrics(
  ctx: ServerContext,
  cursor: ReturnType<typeof captureManagedLlamaSessionCursor>,
): SessionSpeculativeMetrics {
  if (!cursor) {
    return {
      speculativeAcceptedTokens: null,
      speculativeGeneratedTokens: null,
    };
  }
  const metrics = getManagedLlamaSpeculativeMetricsDelta(ctx.managedLlamaLastStartupLogs, cursor);
  return {
    speculativeAcceptedTokens: metrics?.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: metrics?.speculativeGeneratedTokens ?? null,
  };
}

class ListChatSessionsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const config = readConfig(configPath);
    const sessionsResponse: ChatSessionsResponse = {
      sessions: readChatSessions(runtimeRoot).map((session) => toWireChatSession(config, withPromptContext(config, session))),
    };
    sendJson(res, 200, sessionsResponse);
    return;
  }
}

class GetChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), session));
    return;
  }
}

class UpdateChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const updateRequest = parseChatSessionUpdateRequest(parsedBody);
    const updated: ChatSession = { ...session, updatedAtUtc: new Date().toISOString() };
    if (updateRequest.title) {
      updated.title = updateRequest.title;
    }
    if (updateRequest.thinkingEnabled !== undefined) {
      updated.thinkingEnabled = updateRequest.thinkingEnabled;
    }
    if (updateRequest.webSearchEnabled !== undefined) {
      updated.webSearchEnabled = updateRequest.webSearchEnabled;
    }
    const currentConfig = readConfig(configPath);
    const presets = normalizePresets(currentConfig.Presets);
    if (updateRequest.presetId) {
      updated.presetId = findPresetById(presets, updateRequest.presetId)?.id || updateRequest.presetId;
      updated.mode = mapPresetIdToLegacyMode(updated.presetId, presets);
    }
    if (updateRequest.mode) {
      updated.mode = updateRequest.mode;
      updated.presetId = mapLegacyModeToPresetId(updateRequest.mode);
    }
    if (updateRequest.planRepoRoot) {
      updated.planRepoRoot = resolve(updateRequest.planRepoRoot);
    }
    saveChatSession(runtimeRoot, updated);
    sendJson(res, 200, buildChatSessionResponse(currentConfig, updated));
    return;
  }
}

class DeleteChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const deleted = deleteChatSession(runtimeRoot, sessionId);
    if (!deleted) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    sendJson(res, 200, { ok: true, deleted: true, id: sessionId });
    return;
  }
}

class DeleteChatMessageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const match = /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/u.exec(pathname);
    const sessionId = decodeURIComponent(match?.[1] || '');
    const messageId = decodeURIComponent(match?.[2] || '');
    const result = deleteChatMessage(runtimeRoot, sessionId, messageId);
    if (!result) {
      sendJson(res, 404, { error: 'Message not found.' });
      return;
    }
    const deletedMessage = result.deletedMessage;
    const runId = typeof deletedMessage.sourceRunId === 'string' ? deletedMessage.sourceRunId.trim() : '';
    const commandText = typeof deletedMessage.toolCallCommand === 'string'
      ? deletedMessage.toolCallCommand.trim()
      : '';
    if (runId && commandText) {
      removeDashboardRunCommandFromLogs(getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite')), runId, commandText);
    }
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId)) || result.session;
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), session));
    return;
  }
}

class CreateChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const createRequest = parseChatSessionCreateRequest(parsedBody);
    const now = new Date().toISOString();
    const currentConfig = await readEffectiveChatRouteConfig(configPath);
    const presets = normalizePresets(currentConfig.Presets);
    const activePreset = getActiveModelPreset(currentConfig);
    const presetId = findPresetById(presets, createRequest.presetId)?.id || 'chat';
    const session: ChatSession = {
      id: randomUUID(),
      title: createRequest.title || 'New Session',
      modelPresetId: activePreset.id,
      model: createRequest.model || activePreset.Model,
      contextWindowTokens: getConfiguredLlamaNumCtx(currentConfig),
      thinkingEnabled: getConfiguredReasoning(currentConfig) !== 'off',
      webSearchEnabled: currentConfig.WebSearch.EnabledDefault === true,
      presetId,
      mode: mapPresetIdToLegacyMode(presetId, presets),
      planRepoRoot: process.cwd(),
      condensedSummary: '',
      createdAtUtc: now,
      updatedAtUtc: now,
      messages: [],
    };
    saveChatSession(runtimeRoot, session);
    sendJson(res, 200, buildChatSessionResponse(currentConfig, session));
    return;
  }
}

class CreateChatMessageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const messageRequest = parseChatMessageRequest(parsedBody);
    if (!messageRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const usesProvidedAssistantContent = Boolean(messageRequest.assistantContent);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    if (!usesProvidedAssistantContent) {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        releaseModelRequest(ctx, modelRequestLock.token);
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    const userContent = messageRequest.content;
    const requestId = randomUUID();
    const startedAt = Date.now();
    const requestStartedAtUtc = new Date(startedAt).toISOString();
    const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
    try {
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: true,
          promptChars: userContent.length,
        });
      } catch {
        // Best-effort metrics notification.
      }
      let assistantContent: string;
      let usage: Partial<ChatUsage>;
      let persistTurns: { thinkingText: string; toolMessages: PersistToolMessage[] }[] = [{ thinkingText: '', toolMessages: [] }];
      let groundingStatus: ChatGroundingStatus | null = null;
      const config = readConfig(configPath);
      const tokenConfig = usesProvidedAssistantContent ? getLocalTokenConfig(config) : config;
      if (usesProvidedAssistantContent) {
        assistantContent = messageRequest.assistantContent || '';
        usage = {};
      } else {
        const presets = normalizePresets(config.Presets);
        const chatPreset = findPresetById(presets, activeSession.presetId);
        const result = await ctx.engineService.executeRepoSearch({
          taskKind: 'chat',
          prompt: userContent,
          repoRoot: process.cwd(),
          statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
          config,
          systemPrompt: buildChatSystemContent(config, activeSession, { promptPrefix: chatPreset?.promptPrefix || undefined }),
          history: buildChatHistoryMessages(config, activeSession),
          thinkingEnabled: activeSession.thinkingEnabled !== false,
          allowedTools: [],
        });
        const scorecardTasks = normalizeRepoSearchScorecard(result.scorecard).tasks;
        assistantContent = String(scorecardTasks[0]?.finalOutput || '').trim();
        groundingStatus = null;
        usage = {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          completionTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          outputTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'outputTokensEstimatedCount'),
          thinkingTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'thinkingTokensEstimatedCount'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        };
        persistTurns = await countPersistTurnThinkingTokens(tokenConfig, buildPersistTurnsFromRepoSearchResult(result));
      }
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'completed',
          inputTokens: getProcessedPromptTokens(
            usage.promptTokens,
            usage.promptCacheTokens,
            usage.promptEvalTokens,
          ),
          outputChars: assistantContent.length,
          outputTokens: Number.isFinite(Number(usage.completionTokens)) ? Number(usage.completionTokens) : null,
          thinkingTokens: Number.isFinite(Number(usage.thinkingTokens)) ? Number(usage.thinkingTokens) : null,
          promptCacheTokens: Number.isFinite(Number(usage.promptCacheTokens)) ? Number(usage.promptCacheTokens) : null,
          promptEvalTokens: Number.isFinite(Number(usage.promptEvalTokens)) ? Number(usage.promptEvalTokens) : null,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
      const inputTokenCount = await countPersistedInputTokens(tokenConfig, userContent);
      const sessionWithTelemetry = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, assistantContent, usage, {
        turns: persistTurns,
        maintainPerStepThinking: shouldMaintainPerStepThinking(config, activeSession),
        inputTokens: inputTokenCount.tokenCount,
        inputTokensEstimated: inputTokenCount.estimated,
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
        groundingStatus,
        sourceRunId: requestId,
      });
      sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), sessionWithTelemetry));
    } catch (error) {
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          outputChars: 0,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class StreamChatMessageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const messageRequest = parseChatMessageRequest(parsedBody);
    if (!messageRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: JsonSerializable): void => {
      if (clientDisconnected) return;
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* client gone */ }
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    const userContent = messageRequest.content;
    const requestId = randomUUID();
    const startedAt = Date.now();
    const requestStartedAtUtc = new Date(startedAt).toISOString();
    const phaseTracker = createChatTurnPhaseTracker(requestStartedAtUtc);
    const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
    try {
      await notifyChatStatus({
        ctx,
        requestId,
        running: true,
        promptChars: userContent.length,
      });
    } catch {
      // Best-effort metrics notification.
    }
    try {
      const config = readConfig(configPath);
      const presets = normalizePresets(config.Presets);
      const chatPreset = findPresetById(presets, activeSession.presetId);
      const reader = new JsonRecordReader(parsedBody);
      const webOverrideRaw = reader.optionalString('webSearchOverride');
      const webEnabled = webOverrideRaw === 'on'
        ? true
        : webOverrideRaw === 'off'
          ? false
          : activeSession.webSearchEnabled === true;
      const mockResponses = readRouteStringArray(reader, 'mockResponses');
      const mockTokenConfig = getMockTokenConfig(config, mockResponses);
      const result = await ctx.engineService.executeRepoSearch({
        taskKind: 'chat',
        prompt: userContent,
        repoRoot: process.cwd(),
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        systemPrompt: buildChatSystemContent(config, activeSession, { promptPrefix: chatPreset?.promptPrefix || undefined }),
        history: buildChatHistoryMessages(config, activeSession),
        thinkingEnabled: activeSession.thinkingEnabled !== false,
        allowedTools: webEnabled ? ['web_search', 'web_fetch'] : [],
        retainedWebToolCalls: webEnabled ? buildRetainedWebToolCalls(activeSession) : [],
        model: reader.optionalString('model'),
        maxTurns: readRouteNumber(reader, 'maxTurns'),
        availableModels: readRouteStringArray(reader, 'availableModels'),
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        ...(mockResponses ? { mockResponses } : {}),
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'thinking') {
            phaseTracker.observeThinking(event.thinkingText || '');
            writeSse('thinking', { thinking: event.thinkingText || '' });
            return;
          }
          if (event.kind === 'answer') {
            phaseTracker.observeAnswer(event.answerText || '');
            writeSse('answer', { answer: event.answerText || '' });
            return;
          }
          forwardRepoSearchToolEvent(writeSse, event, 'planner', logLine);
        },
      });
      const scorecardTasks = normalizeRepoSearchScorecard(result.scorecard).tasks;
      const assistantContent = String(scorecardTasks[0]?.finalOutput || '').trim();
      const usage: ChatUsage = {
        promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
        completionTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
        thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
        outputTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'outputTokensEstimatedCount'),
        thinkingTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'thinkingTokensEstimatedCount'),
        promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
        promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
        generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
      };
      const persistTurns = await countPersistTurnThinkingTokens(mockTokenConfig, buildPersistTurnsFromRepoSearchResult(result));
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'completed',
          inputTokens: getProcessedPromptTokens(
            usage.promptTokens,
            usage.promptCacheTokens,
            usage.promptEvalTokens,
          ),
          outputChars: assistantContent.length,
          outputTokens: usage.completionTokens,
          thinkingTokens: usage.thinkingTokens,
          promptCacheTokens: usage.promptCacheTokens,
          promptEvalTokens: usage.promptEvalTokens,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
      phaseTracker.observeAnswer(assistantContent);
      const phaseTimestamps = phaseTracker.snapshot();
      const inputTokenCount = await countPersistedInputTokens(mockTokenConfig, userContent);
      const updatedSession = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, assistantContent, usage, {
        turns: persistTurns,
        maintainPerStepThinking: shouldMaintainPerStepThinking(config, activeSession),
        inputTokens: inputTokenCount.tokenCount,
        inputTokensEstimated: inputTokenCount.estimated,
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc: phaseTimestamps.requestStartedAtUtc,
        thinkingStartedAtUtc: phaseTimestamps.thinkingStartedAtUtc,
        thinkingEndedAtUtc: phaseTimestamps.thinkingEndedAtUtc,
        answerStartedAtUtc: phaseTimestamps.answerStartedAtUtc,
        answerEndedAtUtc: phaseTimestamps.answerEndedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
        groundingStatus: getChatGroundingStatus(result.scorecard),
        sourceRunId: String(result.requestId || ''),
      });
      writeSse('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          outputChars: 0,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
      writeSse('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      res.end();
    }
    return;
  }
}

class CreateChatPlanEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const repoRequest = parseChatRepoRequest(parsedBody);
    if (!repoRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const resolvedRepoRoot = resolveChatRepoRoot(repoRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const startedAt = Date.now();
      const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
      const content = repoRequest.content;
      const reader = new JsonRecordReader(parsedBody);
      const config = readConfig(configPath);
      const mockResponses = readRouteStringArray(reader, 'mockResponses');
      const mockTokenConfig = getMockTokenConfig(config, mockResponses);
      const presets = normalizePresets(config.Presets);
      const preset = resolveRepoSearchRoutePreset(
        presets,
        typeof activeSession.presetId === 'string' ? activeSession.presetId : undefined,
        'plan',
      );
      const autoAppend = resolveRepoSearchAutoAppendOverrides(config, preset, parsedBody);
      const result = await ctx.engineService.executeRepoSearch({
        taskKind: 'plan',
        prompt: buildPlanRequestPrompt(content),
        repoRoot: resolvedRepoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        promptPrefix: preset?.promptPrefix || '',
        allowedTools: withEffectiveWebTools(
          getEffectivePresetAllowedTools(config, preset),
          activeSession.webSearchEnabled === true,
        ),
        includeAgentsMd: autoAppend.includeAgentsMd,
        includeRepoFileListing: autoAppend.includeRepoFileListing,
        model: reader.optionalString('model'),
        maxTurns: readRouteNumber(reader, 'maxTurns'),
        logFile: reader.optionalString('logFile'),
        availableModels: readRouteStringArray(reader, 'availableModels'),
        mockResponses,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'tool_start') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'planner');
            if (logMessage) logLine(logMessage);
          }
        },
      });
      const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
      const inputTokenCount = await countPersistedInputTokens(mockTokenConfig, content);
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...activeSession, presetId: preset?.id || activeSession.presetId || 'plan', mode: 'plan', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        {
          turns: await countPersistTurnThinkingTokens(mockTokenConfig, buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
            thinkingText: turn.thinkingText,
            toolMessages: turn.toolMessages.map((message) => ({
              ...message,
              toolCallPromptTokenCount: getScorecardTotal(result?.scorecard, 'promptTokens'),
            })),
          }))),
          maintainPerStepThinking: shouldMaintainPerStepThinking(config, activeSession),
          inputTokens: inputTokenCount.tokenCount,
          inputTokensEstimated: inputTokenCount.estimated,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return getPromptTokensPerSecond(promptTokens, promptDurationMs);
          })(),
          generationTokensPerSecond: (() => {
            return getRepoSearchGenerationTokensPerSecond(result?.scorecard);
          })(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          outputTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'outputTokensEstimatedCount'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          thinkingTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'thinkingTokensEstimatedCount'),
          sourceRunId: String(result.requestId || ''),
        }
      );
      sendJson(res, 200, {
        ...buildChatSessionResponse(config, updatedSession),
        repoSearch: {
          requestId: result.requestId,
          transcriptPath: result.transcriptPath,
          artifactPath: result.artifactPath,
          scorecard: result.scorecard,
        },
      });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class StreamChatPlanEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const repoRequest = parseChatRepoRequest(parsedBody);
    if (!repoRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const resolvedRepoRoot = resolveChatRepoRoot(repoRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: JsonSerializable): void => {
      if (clientDisconnected) return;
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* client gone */ }
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    try {
      const startedAt = Date.now();
      const requestStartedAtUtc = new Date(startedAt).toISOString();
      const phaseTracker = createChatTurnPhaseTracker(requestStartedAtUtc);
      const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
      const content = repoRequest.content;
      const reader = new JsonRecordReader(parsedBody);
      const config = readConfig(configPath);
      const mockResponses = readRouteStringArray(reader, 'mockResponses');
      const mockTokenConfig = getMockTokenConfig(config, mockResponses);
      const presets = normalizePresets(config.Presets);
      const preset = resolveRepoSearchRoutePreset(
        presets,
        typeof activeSession.presetId === 'string' ? activeSession.presetId : undefined,
        'plan',
      );
      const autoAppend = resolveRepoSearchAutoAppendOverrides(config, preset, parsedBody);
      const result = await ctx.engineService.executeRepoSearch({
        taskKind: 'plan',
        prompt: buildPlanRequestPrompt(content),
        repoRoot: resolvedRepoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        promptPrefix: preset?.promptPrefix || '',
        allowedTools: withEffectiveWebTools(
          getEffectivePresetAllowedTools(config, preset),
          activeSession.webSearchEnabled === true,
        ),
        includeAgentsMd: autoAppend.includeAgentsMd,
        includeRepoFileListing: autoAppend.includeRepoFileListing,
        model: reader.optionalString('model'),
        maxTurns: readRouteNumber(reader, 'maxTurns'),
        logFile: reader.optionalString('logFile'),
        availableModels: readRouteStringArray(reader, 'availableModels'),
        mockResponses,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'thinking') {
            phaseTracker.observeThinking(event.thinkingText || '');
            writeSse('thinking', { thinking: event.thinkingText || '' });
            return;
          }
          forwardRepoSearchToolEvent(writeSse, event, 'planner', logLine);
        },
      });
      const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
      phaseTracker.observeAnswer(assistantContent);
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
      const inputTokenCount = await countPersistedInputTokens(mockTokenConfig, content);
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...activeSession, presetId: preset?.id || activeSession.presetId || 'plan', mode: 'plan', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        {
          turns: await countPersistTurnThinkingTokens(mockTokenConfig, buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
            thinkingText: turn.thinkingText,
            toolMessages: turn.toolMessages.map((message) => ({
              ...message,
              toolCallPromptTokenCount: getScorecardTotal(result?.scorecard, 'promptTokens'),
            })),
          }))),
          maintainPerStepThinking: shouldMaintainPerStepThinking(config, activeSession),
          inputTokens: inputTokenCount.tokenCount,
          inputTokensEstimated: inputTokenCount.estimated,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return getPromptTokensPerSecond(promptTokens, promptDurationMs);
          })(),
          generationTokensPerSecond: (() => {
            return getRepoSearchGenerationTokensPerSecond(result?.scorecard);
          })(),
          ...phaseTracker.snapshot(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          outputTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'outputTokensEstimatedCount'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          thinkingTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'thinkingTokensEstimatedCount'),
          sourceRunId: String(result.requestId || ''),
        }
      );
      writeSse('done', {
        ...buildChatSessionResponse(config, updatedSession),
        repoSearch: {
          requestId: result.requestId,
          transcriptPath: result.transcriptPath,
          artifactPath: result.artifactPath,
          scorecard: result.scorecard,
        },
      });
    } catch (error) {
      writeSse('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      res.end();
    }
    return;
  }
}

class PreviewRepoSearchAppendEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/append-preview$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const appendPreviewRequest = parseChatRepoAppendPreviewRequest(parsedBody);
    const resolvedRepoRoot = resolveChatRepoRoot(appendPreviewRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const config = readConfig(configPath);
    const presets = normalizePresets(config.Presets);
    const preset = resolveRepoSearchRoutePreset(
      presets,
      typeof session.presetId === 'string' ? session.presetId : undefined,
      'repo-search',
    );
    const defaults = resolveRepoSearchAutoAppendOverrides(config, preset, {});
    const agentsContent = readAgentsMd(resolvedRepoRoot);
    const fileListing = scanRepoFiles(resolvedRepoRoot, buildIgnorePolicy(resolvedRepoRoot));
    sendJson(res, 200, {
      agentsMd: await buildRepoSearchAutoAppendPreviewItem({
        key: 'agentsMd',
        label: 'AGENTS.md',
        enabledDefault: defaults.includeAgentsMd,
        content: agentsContent,
        config,
      }),
      repoFileListing: await buildRepoSearchAutoAppendPreviewItem({
        key: 'repoFileListing',
        label: 'Files',
        enabledDefault: defaults.includeRepoFileListing,
        content: fileListing,
        config,
      }),
    });
    return;
  }
}

class StreamRepoSearchEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const repoRequest = parseChatRepoRequest(parsedBody);
    if (!repoRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const resolvedRepoRoot = resolveChatRepoRoot(repoRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_repo_search_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: JsonSerializable): void => {
      if (clientDisconnected) return;
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* client gone */ }
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    try {
      const startedAt = Date.now();
      const requestStartedAtUtc = new Date(startedAt).toISOString();
      const phaseTracker = createChatTurnPhaseTracker(requestStartedAtUtc);
      const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
      const content = repoRequest.content;
      const reader = new JsonRecordReader(parsedBody);
      const config = readConfig(configPath);
      const mockResponses = readRouteStringArray(reader, 'mockResponses');
      const mockTokenConfig = getMockTokenConfig(config, mockResponses);
      const presets = normalizePresets(config.Presets);
      const preset = resolveRepoSearchRoutePreset(
        presets,
        typeof activeSession.presetId === 'string' ? activeSession.presetId : undefined,
        'repo-search',
      );
      const autoAppend = resolveRepoSearchAutoAppendOverrides(config, preset, parsedBody);
      const result = await ctx.engineService.executeRepoSearch({
        taskKind: 'repo-search',
        prompt: content,
        repoRoot: resolvedRepoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        promptPrefix: preset?.promptPrefix || '',
        allowedTools: withEffectiveWebTools(
          getEffectivePresetAllowedTools(config, preset),
          activeSession.webSearchEnabled === true,
        ),
        includeAgentsMd: autoAppend.includeAgentsMd,
        includeRepoFileListing: autoAppend.includeRepoFileListing,
        model: reader.optionalString('model'),
        maxTurns: readRouteNumber(reader, 'maxTurns'),
        logFile: reader.optionalString('logFile'),
        availableModels: readRouteStringArray(reader, 'availableModels'),
        mockResponses,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'thinking') {
            phaseTracker.observeThinking(event.thinkingText || '');
            writeSse('answer', { answer: event.thinkingText || '' });
            return;
          }
          forwardRepoSearchToolEvent(writeSse, event, 'repo_search', logLine);
        },
      });
      const assistantContent = buildRepoSearchMarkdown(content, resolvedRepoRoot, result);
      phaseTracker.observeAnswer(assistantContent);
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
      const inputTokenCount = await countPersistedInputTokens(mockTokenConfig, content);
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...activeSession, presetId: preset?.id || activeSession.presetId || 'repo-search', mode: 'repo-search', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        {
          turns: await countPersistTurnThinkingTokens(mockTokenConfig, buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
            thinkingText: turn.thinkingText,
            toolMessages: turn.toolMessages.map((message) => ({
              ...message,
              toolCallPromptTokenCount: getScorecardTotal(result?.scorecard, 'promptTokens'),
            })),
          }))),
          maintainPerStepThinking: shouldMaintainPerStepThinking(config, activeSession),
          inputTokens: inputTokenCount.tokenCount,
          inputTokensEstimated: inputTokenCount.estimated,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return getPromptTokensPerSecond(promptTokens, promptDurationMs);
          })(),
          generationTokensPerSecond: (() => {
            return getRepoSearchGenerationTokensPerSecond(result?.scorecard);
          })(),
          ...phaseTracker.snapshot(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          outputTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'outputTokensEstimatedCount'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          thinkingTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'thinkingTokensEstimatedCount'),
          sourceRunId: String(result.requestId || ''),
        }
      );
      writeSse('done', {
        ...buildChatSessionResponse(config, updatedSession),
        repoSearch: {
          requestId: result.requestId,
          transcriptPath: result.transcriptPath,
          artifactPath: result.artifactPath,
          scorecard: result.scorecard,
        },
      });
    } catch (error) {
      writeSse('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      res.end();
    }
    return;
  }
}

class CondenseChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/condense$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const updatedSession = condenseChatSession(runtimeRoot, session);
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), updatedSession));
    return;
  }
}
const CHAT_ROUTES = new RouteTable([
  { method: 'GET', path: '/dashboard/chat/sessions', endpoint: new ListChatSessionsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new GetChatSessionEndpoint() },
  { method: 'PUT', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new UpdateChatSessionEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new DeleteChatSessionEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/u, endpoint: new DeleteChatMessageEndpoint() },
  { method: 'POST', path: '/dashboard/chat/sessions', endpoint: new CreateChatSessionEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages$/u, endpoint: new CreateChatMessageEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/stream$/u, endpoint: new StreamChatMessageEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan$/u, endpoint: new CreateChatPlanEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan\/stream$/u, endpoint: new StreamChatPlanEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search\/append-preview$/u, endpoint: new PreviewRepoSearchAppendEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search\/stream$/u, endpoint: new StreamRepoSearchEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/condense$/u, endpoint: new CondenseChatSessionEndpoint() },
]);

export async function handleChatRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  return await CHAT_ROUTES.handle(ctx, req, res, pathname);
}
