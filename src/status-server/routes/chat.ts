/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Dict } from '../../lib/types.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import { getRuntimeRoot } from '../paths.js';
import {
  readBody,
  parseJsonBody,
  sendJson,
} from '../http-utils.js';
import { readConfig } from '../config-store.js';
import {
  type RepoSearchProgressEvent,
  buildRepoSearchProgressLogMessage,
} from '../dashboard-runs.js';
import {
  buildContextUsage,
  type ChatUsage,
  generateChatAssistantMessage,
  appendChatMessagesWithUsage,
  streamChatAssistantMessage,
  condenseChatSession,
  buildPlanRequestPrompt,
  buildPlanMarkdownFromRepoSearch,
  getScorecardTotal,
  buildToolContextFromRepoSearchResult,
  buildRepoSearchMarkdown,
  loadRepoSearchExecutor,
} from '../chat.js';
import {
  type ChatSession,
  readChatSessionFromPath,
  readChatSessions,
  getChatSessionPath,
  deleteChatSession,
  saveChatSession,
} from '../../state/chat-sessions.js';
import {
  findPresetById,
  mapLegacyModeToPresetId,
  mapPresetIdToLegacyMode,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  resolvePresetAllowedTools,
  type SiftPreset,
} from '../../presets.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaSpeculativeMetricsDelta,
  logLine,
} from '../managed-llama.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
  ensureManagedLlamaReadyForModelRequest,
} from '../server-ops.js';
import { notifyStatusBackend } from '../../config/index.js';
import type { ServerContext } from '../server-types.js';

function getEffectivePresetAllowedTools(config: Dict, preset: SiftPreset | null): SiftPreset['allowedTools'] | undefined {
  if (!preset) {
    return undefined;
  }
  return resolvePresetAllowedTools(
    preset,
    normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
  );
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

export function getRepoSearchOutputTokensPerSecond(scorecard: unknown): number | null {
  const outputTokens = getScorecardTotal(scorecard, 'outputTokens');
  const thinkingTokens = getScorecardTotal(scorecard, 'thinkingTokens');
  const generationDurationMs = getScorecardTotal(scorecard, 'generationDurationMs');
  const generatedTokens = (outputTokens ?? 0) + (thinkingTokens ?? 0);
  return generatedTokens > 0 && generationDurationMs !== null && generationDurationMs > 0
    ? (generatedTokens / (generationDurationMs / 1000))
    : null;
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

export async function handleChatRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const runtimeRoot = getRuntimeRoot();
  const { configPath } = ctx;

  // -------------------------------------------------------------------------
  // List sessions
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && pathname === '/dashboard/chat/sessions') {
    sendJson(res, 200, { sessions: readChatSessions(runtimeRoot) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Get single session
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    sendJson(res, 200, { session, contextUsage: buildContextUsage(session) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Update session
  // -------------------------------------------------------------------------

  if (req.method === 'PUT' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const updated: ChatSession = { ...session, updatedAtUtc: new Date().toISOString() };
    if (typeof parsedBody.title === 'string' && parsedBody.title.trim()) {
      updated.title = parsedBody.title.trim();
    }
    if (typeof parsedBody.thinkingEnabled === 'boolean') {
      updated.thinkingEnabled = parsedBody.thinkingEnabled;
    }
    const currentConfig = readConfig(configPath);
    const presets = normalizePresets(currentConfig.Presets);
    if (typeof parsedBody.presetId === 'string' && (parsedBody.presetId as string).trim()) {
      const presetId = (parsedBody.presetId as string).trim();
      updated.presetId = findPresetById(presets, presetId)?.id || presetId;
      updated.mode = mapPresetIdToLegacyMode(updated.presetId, presets);
    }
    if (typeof parsedBody.mode === 'string' && (parsedBody.mode === 'chat' || parsedBody.mode === 'plan' || parsedBody.mode === 'repo-search')) {
      updated.mode = parsedBody.mode;
      updated.presetId = mapLegacyModeToPresetId(parsedBody.mode);
    }
    if (typeof parsedBody.planRepoRoot === 'string' && (parsedBody.planRepoRoot as string).trim()) {
      updated.planRepoRoot = path.resolve((parsedBody.planRepoRoot as string).trim());
    }
    saveChatSession(runtimeRoot, updated);
    sendJson(res, 200, { session: updated, contextUsage: buildContextUsage(updated) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Delete session
  // -------------------------------------------------------------------------

  if (req.method === 'DELETE' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const deleted = deleteChatSession(runtimeRoot, sessionId);
    if (!deleted) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    sendJson(res, 200, { ok: true, deleted: true, id: sessionId });
    return true;
  }

  // -------------------------------------------------------------------------
  // Create session
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && pathname === '/dashboard/chat/sessions') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const now = new Date().toISOString();
    const currentConfig = readConfig(configPath);
    const presets = normalizePresets(currentConfig.Presets);
    const runtimeCfg = (currentConfig.Runtime as Dict | undefined) ?? {};
    const runtimeLlamaCfg = (runtimeCfg.LlamaCpp as Dict | undefined) ?? {};
    const requestedPresetId = typeof parsedBody.presetId === 'string' && (parsedBody.presetId as string).trim()
      ? (parsedBody.presetId as string).trim()
      : 'chat';
    const presetId = findPresetById(presets, requestedPresetId)?.id || 'chat';
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: typeof parsedBody.title === 'string' && parsedBody.title.trim() ? parsedBody.title.trim() : 'New Session',
      model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim()
        ? (parsedBody.model as string).trim()
        : (runtimeCfg.Model as string) || null,
      contextWindowTokens: Number(runtimeLlamaCfg.NumCtx || 150000),
      thinkingEnabled: runtimeLlamaCfg.Reasoning !== 'off',
      presetId,
      mode: mapPresetIdToLegacyMode(presetId, presets),
      planRepoRoot: process.cwd(),
      condensedSummary: '',
      createdAtUtc: now,
      updatedAtUtc: now,
      messages: [],
      hiddenToolContexts: [],
    };
    saveChatSession(runtimeRoot, session);
    sendJson(res, 200, { session, contextUsage: buildContextUsage(session) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Post message (non-streaming)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat', req, res);
    if (!modelRequestLock) {
      return true;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    const userContent = (parsedBody.content as string).trim();
    const requestId = crypto.randomUUID();
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
      let thinkingContent = '';
      if (typeof parsedBody.assistantContent === 'string' && (parsedBody.assistantContent as string).trim()) {
        assistantContent = (parsedBody.assistantContent as string).trim();
        usage = {};
      } else {
        await ensureManagedLlamaReadyForModelRequest(ctx);
        const config = readConfig(configPath);
        const presets = normalizePresets(config.Presets);
        const preset = findPresetById(presets, activeSession.presetId);
        const generated = await generateChatAssistantMessage(config, activeSession, userContent, {
          promptPrefix: preset?.promptPrefix || undefined,
        });
        assistantContent = generated.assistantContent;
        usage = generated.usage;
        thinkingContent = generated.thinkingContent || '';
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
      const sessionWithTelemetry = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, assistantContent, usage, thinkingContent, {
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
      });
      sendJson(res, 200, { session: sessionWithTelemetry, contextUsage: buildContextUsage(sessionWithTelemetry) });
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Post message (streaming)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages\/stream$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', req, res);
    if (!modelRequestLock) {
      return true;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: unknown): void => {
      if (clientDisconnected) return;
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch { /* client gone */ }
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    const userContent = (parsedBody.content as string).trim();
    const requestId = crypto.randomUUID();
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
      await ensureManagedLlamaReadyForModelRequest(ctx);
      const config = readConfig(configPath);
      const presets = normalizePresets(config.Presets);
      const preset = findPresetById(presets, activeSession.presetId);
      const generated = await streamChatAssistantMessage(config, activeSession, userContent, (progress) => {
        phaseTracker.observeThinking(progress.thinkingContent);
        phaseTracker.observeAnswer(progress.assistantContent);
        writeSse('thinking', { thinking: progress.thinkingContent });
        writeSse('answer', { answer: progress.assistantContent });
      }, {
        promptPrefix: preset?.promptPrefix || undefined,
      });
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'completed',
          inputTokens: getProcessedPromptTokens(
            generated.usage.promptTokens,
            generated.usage.promptCacheTokens,
            generated.usage.promptEvalTokens,
          ),
          outputChars: generated.assistantContent.length,
          outputTokens: generated.usage.completionTokens,
          thinkingTokens: generated.usage.thinkingTokens,
          promptCacheTokens: generated.usage.promptCacheTokens,
          promptEvalTokens: generated.usage.promptEvalTokens,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
      phaseTracker.observeThinking(generated.thinkingContent);
      phaseTracker.observeAnswer(generated.assistantContent);
      const phaseTimestamps = phaseTracker.snapshot();
      const updatedSession = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, generated.assistantContent, generated.usage, generated.thinkingContent, {
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc: phaseTimestamps.requestStartedAtUtc,
        thinkingStartedAtUtc: phaseTimestamps.thinkingStartedAtUtc,
        thinkingEndedAtUtc: phaseTimestamps.thinkingEndedAtUtc,
        answerStartedAtUtc: phaseTimestamps.answerStartedAtUtc,
        answerEndedAtUtc: phaseTimestamps.answerEndedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
      });
      writeSse('done', { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Plan (non-streaming)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
      ? (parsedBody.repoRoot as string).trim()
      : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
    const resolvedRepoRoot = path.resolve(requestedRepoRoot);
    if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan', req, res);
    if (!modelRequestLock) {
      return true;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    try {
      const startedAt = Date.now();
      const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
      await ensureManagedLlamaReadyForModelRequest(ctx);
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const content = (parsedBody.content as string).trim();
      const config = readConfig(configPath);
      const presets = normalizePresets(config.Presets);
      const preset = resolveRepoSearchRoutePreset(
        presets,
        typeof activeSession.presetId === 'string' ? activeSession.presetId : undefined,
        'plan',
      );
      const result = await executeRepoSearchRequest({
        taskKind: 'plan',
        prompt: buildPlanRequestPrompt(content),
        repoRoot: resolvedRepoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        promptPrefix: preset?.promptPrefix || '',
        allowedTools: getEffectivePresetAllowedTools(config, preset),
        includeAgentsMd: preset?.includeAgentsMd !== false,
        includeRepoFileListing: preset?.includeRepoFileListing !== false,
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        requestMaxTokens: 10000,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
        mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'tool_start') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'planner');
            if (logMessage) logLine(logMessage);
          }
        },
      });
      const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
      const toolContextContents = buildToolContextFromRepoSearchResult(result);
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
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
        '',
        {
          toolContextContents,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return promptTokens !== null && promptDurationMs !== null && promptDurationMs > 0
              ? (promptTokens / (promptDurationMs / 1000))
              : null;
          })(),
          outputTokensPerSecond: (() => {
            return getRepoSearchOutputTokensPerSecond(result?.scorecard);
          })(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          sourceRunId: String(result.requestId || ''),
        }
      );
      sendJson(res, 200, {
        session: updatedSession,
        contextUsage: buildContextUsage(updatedSession),
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Plan (streaming)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan\/stream$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
      ? (parsedBody.repoRoot as string).trim()
      : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
    const resolvedRepoRoot = path.resolve(requestedRepoRoot);
    if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan_stream', req, res);
    if (!modelRequestLock) {
      return true;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: unknown): void => {
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
      await ensureManagedLlamaReadyForModelRequest(ctx);
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const content = (parsedBody.content as string).trim();
      const config = readConfig(configPath);
      const presets = normalizePresets(config.Presets);
      const preset = resolveRepoSearchRoutePreset(
        presets,
        typeof activeSession.presetId === 'string' ? activeSession.presetId : undefined,
        'plan',
      );
      const result = await executeRepoSearchRequest({
        taskKind: 'plan',
        prompt: buildPlanRequestPrompt(content),
        repoRoot: resolvedRepoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        promptPrefix: preset?.promptPrefix || '',
        allowedTools: getEffectivePresetAllowedTools(config, preset),
        includeAgentsMd: preset?.includeAgentsMd !== false,
        includeRepoFileListing: preset?.includeRepoFileListing !== false,
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        requestMaxTokens: 10000,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
        mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'tool_start') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'planner');
            if (logMessage) logLine(logMessage);
          }
          if (event.kind === 'thinking') {
            phaseTracker.observeThinking(event.thinkingText || '');
            writeSse('thinking', { thinking: event.thinkingText || '' });
          } else if (event.kind === 'tool_start') {
            const answer = `Planning step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...`;
            writeSse('tool_start', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
            phaseTracker.observeAnswer(answer);
            writeSse('answer', { answer });
          } else if (event.kind === 'tool_result') {
            const answer = `Planning step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})`;
            writeSse('tool_result', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              exitCode: event.exitCode,
              outputSnippet: event.outputSnippet,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
            phaseTracker.observeAnswer(answer);
            writeSse('answer', { answer });
          }
        },
      });
      const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
      phaseTracker.observeAnswer(assistantContent);
      const toolContextContents = buildToolContextFromRepoSearchResult(result);
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
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
        '',
        {
          toolContextContents,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return promptTokens !== null && promptDurationMs !== null && promptDurationMs > 0
              ? (promptTokens / (promptDurationMs / 1000))
              : null;
          })(),
          outputTokensPerSecond: (() => {
            return getRepoSearchOutputTokensPerSecond(result?.scorecard);
          })(),
          ...phaseTracker.snapshot(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          sourceRunId: String(result.requestId || ''),
        }
      );
      writeSse('done', {
        session: updatedSession,
        contextUsage: buildContextUsage(updatedSession),
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Repo-search (streaming, session-scoped)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/repo-search\/stream$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
      ? (parsedBody.repoRoot as string).trim()
      : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
    const resolvedRepoRoot = path.resolve(requestedRepoRoot);
    if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_repo_search_stream', req, res);
    if (!modelRequestLock) {
      return true;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });
    const writeSse = (eventName: string, payload: unknown): void => {
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
      await ensureManagedLlamaReadyForModelRequest(ctx);
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const content = (parsedBody.content as string).trim();
      const config = readConfig(configPath);
      const presets = normalizePresets(config.Presets);
      const preset = resolveRepoSearchRoutePreset(
        presets,
        typeof activeSession.presetId === 'string' ? activeSession.presetId : undefined,
        'repo-search',
      );
      const result = await executeRepoSearchRequest({
        taskKind: 'repo-search',
        prompt: content,
        repoRoot: resolvedRepoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        promptPrefix: preset?.promptPrefix || '',
        allowedTools: getEffectivePresetAllowedTools(config, preset),
        includeAgentsMd: preset?.includeAgentsMd !== false,
        includeRepoFileListing: preset?.includeRepoFileListing !== false,
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        requestMaxTokens: 10000,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
        mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'thinking') {
            phaseTracker.observeThinking(event.thinkingText || '');
            writeSse('answer', { answer: event.thinkingText || '' });
          } else if (event.kind === 'tool_start') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'repo_search');
            if (logMessage) logLine(logMessage);
            writeSse('tool_start', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
          } else if (event.kind === 'tool_result') {
            writeSse('tool_result', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              exitCode: event.exitCode,
              outputSnippet: event.outputSnippet,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
          }
        },
      });
      const assistantContent = buildRepoSearchMarkdown(content, resolvedRepoRoot, result);
      phaseTracker.observeAnswer(assistantContent);
      const toolContextContents = buildToolContextFromRepoSearchResult(result);
      const speculativeMetrics = readManagedLlamaSessionSpeculativeMetrics(ctx, managedLlamaCursor);
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
        '',
        {
          toolContextContents,
          requestDurationMs: Date.now() - startedAt,
          promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
          generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
          promptTokensPerSecond: (() => {
            const promptTokens = getScorecardTotal(result?.scorecard, 'promptEvalTokens');
            const promptDurationMs = getScorecardTotal(result?.scorecard, 'promptEvalDurationMs');
            return promptTokens !== null && promptDurationMs !== null && promptDurationMs > 0
              ? (promptTokens / (promptDurationMs / 1000))
              : null;
          })(),
          outputTokensPerSecond: (() => {
            return getRepoSearchOutputTokensPerSecond(result?.scorecard);
          })(),
          ...phaseTracker.snapshot(),
          speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
          outputTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
          thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
          sourceRunId: String(result.requestId || ''),
        }
      );
      writeSse('done', {
        session: updatedSession,
        contextUsage: buildContextUsage(updatedSession),
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Clear tool context
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/tool-context\/clear$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/tool-context\/clear$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    const updatedSession: ChatSession = {
      ...session,
      updatedAtUtc: new Date().toISOString(),
      hiddenToolContexts: [],
    };
    saveChatSession(runtimeRoot, updatedSession);
    sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Condense session
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/condense$/u.test(pathname)) {
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/condense$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    const updatedSession = condenseChatSession(runtimeRoot, session);
    sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
    return true;
  }

  return false;
}
