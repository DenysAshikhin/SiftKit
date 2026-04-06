/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Dict } from '../../lib/types.js';
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
  saveChatSession,
} from '../../state/chat-sessions.js';
import { logLine } from '../managed-llama.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
} from '../server-ops.js';
import type { ServerContext } from '../server-types.js';

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
    if (typeof parsedBody.mode === 'string' && (parsedBody.mode === 'chat' || parsedBody.mode === 'plan' || parsedBody.mode === 'repo-search')) {
      updated.mode = parsedBody.mode;
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
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    if (!fs.existsSync(sessionPath)) {
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    try {
      fs.rmSync(sessionPath, { force: true });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
    const runtimeCfg = (currentConfig.Runtime as Dict | undefined) ?? {};
    const runtimeLlamaCfg = (runtimeCfg.LlamaCpp as Dict | undefined) ?? {};
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: typeof parsedBody.title === 'string' && parsedBody.title.trim() ? parsedBody.title.trim() : 'New Session',
      model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim()
        ? (parsedBody.model as string).trim()
        : (runtimeCfg.Model as string) || null,
      contextWindowTokens: Number(runtimeLlamaCfg.NumCtx || 150000),
      thinkingEnabled: runtimeLlamaCfg.Reasoning !== 'off',
      mode: 'chat',
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
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat');
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    try {
      const userContent = (parsedBody.content as string).trim();
      let assistantContent: string;
      let usage: Partial<ChatUsage>;
      let thinkingContent = '';
      if (typeof parsedBody.assistantContent === 'string' && (parsedBody.assistantContent as string).trim()) {
        assistantContent = (parsedBody.assistantContent as string).trim();
        usage = {};
      } else {
        const config = readConfig(configPath);
        const generated = await generateChatAssistantMessage(config, session, userContent);
        assistantContent = generated.assistantContent;
        usage = generated.usage;
        thinkingContent = generated.thinkingContent || '';
      }
      const updatedSession = appendChatMessagesWithUsage(runtimeRoot, session, userContent, assistantContent, usage, thinkingContent);
      sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
    } catch (error) {
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
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream');
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected content.' });
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
      const userContent = (parsedBody.content as string).trim();
      const config = readConfig(configPath);
      const generated = await streamChatAssistantMessage(config, session, userContent, (progress) => {
        writeSse('thinking', { thinking: progress.thinkingContent });
        writeSse('answer', { answer: progress.assistantContent });
      });
      const updatedSession = appendChatMessagesWithUsage(runtimeRoot, session, userContent, generated.assistantContent, generated.usage, generated.thinkingContent);
      writeSse('done', { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
    } catch (error) {
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
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan');
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
      ? (parsedBody.repoRoot as string).trim()
      : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
    const resolvedRepoRoot = path.resolve(requestedRepoRoot);
    if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return true;
    }
    try {
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const content = (parsedBody.content as string).trim();
      const result = await executeRepoSearchRequest({
        prompt: buildPlanRequestPrompt(content),
        repoRoot: resolvedRepoRoot,
        config: readConfig(configPath),
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        requestMaxTokens: 10000,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
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
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...session, mode: 'plan', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        '',
        { toolContextContents }
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
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan_stream');
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
      ? (parsedBody.repoRoot as string).trim()
      : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
    const resolvedRepoRoot = path.resolve(requestedRepoRoot);
    if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
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
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const content = (parsedBody.content as string).trim();
      const result = await executeRepoSearchRequest({
        prompt: buildPlanRequestPrompt(content),
        repoRoot: resolvedRepoRoot,
        config: readConfig(configPath),
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        requestMaxTokens: 10000,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
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
            writeSse('thinking', { thinking: event.thinkingText || '' });
          } else if (event.kind === 'tool_start') {
            writeSse('tool_start', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
            writeSse('answer', { answer: `Planning step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...` });
          } else if (event.kind === 'tool_result') {
            writeSse('tool_result', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              exitCode: event.exitCode,
              outputSnippet: event.outputSnippet,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
            writeSse('answer', { answer: `Planning step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})` });
          }
        },
      });
      const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
      const toolContextContents = buildToolContextFromRepoSearchResult(result);
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...session, mode: 'plan', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        '',
        { toolContextContents }
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
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_repo_search_stream');
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return true;
    }
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected content.' });
      return true;
    }
    const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
      ? (parsedBody.repoRoot as string).trim()
      : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
    const resolvedRepoRoot = path.resolve(requestedRepoRoot);
    if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
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
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const content = (parsedBody.content as string).trim();
      const result = await executeRepoSearchRequest({
        prompt: content,
        repoRoot: resolvedRepoRoot,
        config: readConfig(configPath),
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        requestMaxTokens: 10000,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
        logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
        mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'tool_start') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'repo_search');
            if (logMessage) logLine(logMessage);
          }
          if (event.kind === 'thinking') {
            writeSse('thinking', { thinking: event.thinkingText || '' });
          } else if (event.kind === 'tool_start') {
            writeSse('tool_start', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
            writeSse('answer', { answer: `Search step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...` });
          } else if (event.kind === 'tool_result') {
            writeSse('tool_result', {
              turn: event.turn,
              maxTurns: event.maxTurns,
              command: event.command,
              exitCode: event.exitCode,
              outputSnippet: event.outputSnippet,
              promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
            });
            writeSse('answer', { answer: `Search step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})` });
          }
        },
      });
      const assistantContent = buildRepoSearchMarkdown(content, resolvedRepoRoot, result);
      const toolContextContents = buildToolContextFromRepoSearchResult(result);
      const updatedSession = appendChatMessagesWithUsage(
        runtimeRoot,
        { ...session, mode: 'repo-search', planRepoRoot: resolvedRepoRoot },
        content,
        assistantContent,
        {
          promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
          promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        },
        '',
        { toolContextContents }
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
