import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Dict } from '../lib/types.js';
import { mapLegacyModeToPresetId } from '../presets.js';
import { getRuntimeDatabase } from './runtime-db.js';

export type ChatMessage = Dict;
export type ChatSession = Dict & { id: string; messages?: ChatMessage[]; hiddenToolContexts?: Dict[] };

type SessionRow = {
  id: string;
  title: string;
  model: string | null;
  context_window_tokens: number;
  thinking_enabled: number;
  preset_id: string | null;
  mode: string;
  plan_repo_root: string;
  condensed_summary: string;
  created_at_utc: string;
  updated_at_utc: string;
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  input_tokens_estimate: number;
  output_tokens_estimate: number;
  thinking_tokens: number;
  input_tokens_estimated: number;
  output_tokens_estimated: number;
  thinking_tokens_estimated: number;
  prompt_cache_tokens: number | null;
  prompt_eval_tokens: number | null;
  request_duration_ms: number | null;
  prompt_eval_duration_ms: number | null;
  generation_duration_ms: number | null;
  request_started_at_utc: string | null;
  thinking_started_at_utc: string | null;
  thinking_ended_at_utc: string | null;
  answer_started_at_utc: string | null;
  answer_ended_at_utc: string | null;
  speculative_accepted_tokens: number | null;
  speculative_generated_tokens: number | null;
  associated_tool_tokens: number | null;
  thinking_content: string | null;
  created_at_utc: string;
  source_run_id: string | null;
  compressed_into_summary: number;
  position: number;
};

type HiddenContextRow = {
  id: string;
  content: string;
  token_estimate: number;
  source_message_id: string | null;
  created_at_utc: string;
  position: number;
};

function getSessionDatabase(runtimeRoot: string): ReturnType<typeof getRuntimeDatabase> {
  return getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
}

function parseSessionId(targetPath: string): string | null {
  const raw = String(targetPath || '').trim();
  if (!raw) {
    return null;
  }
  const base = path.basename(raw);
  const match = /^session_(.+)\.json$/iu.exec(base);
  if (match && match[1] && match[1].trim()) {
    return match[1].trim();
  }
  if (raw.startsWith('db://session/')) {
    return raw.replace('db://session/', '').trim() || null;
  }
  return null;
}

function normalizeMode(value: unknown): 'chat' | 'plan' | 'repo-search' {
  return value === 'plan' || value === 'repo-search' ? value : 'chat';
}

function normalizePresetId(value: unknown, modeValue?: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || mapLegacyModeToPresetId(modeValue);
}

function toNonNegativeInteger(value: unknown, fallback: number = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function toNullableNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

export function estimateTokenCount(value: unknown): number {
  const text = String(value || '');
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function getChatSessionsRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'chat', 'sessions');
}

export function listChatSessionPaths(runtimeRoot: string): string[] {
  const database = getSessionDatabase(runtimeRoot);
  const rows = database.prepare('SELECT id FROM chat_sessions ORDER BY updated_at_utc DESC').all() as Array<{ id?: unknown }>;
  return rows
    .map((row) => (typeof row.id === 'string' ? row.id.trim() : ''))
    .filter((id) => id.length > 0)
    .map((id) => getChatSessionPath(runtimeRoot, id));
}

function readSessionById(runtimeRoot: string, sessionId: string): ChatSession | null {
  const database = getSessionDatabase(runtimeRoot);
  const row = database.prepare(`
    SELECT
      id,
      title,
      model,
      context_window_tokens,
      thinking_enabled,
      preset_id,
      mode,
      plan_repo_root,
      condensed_summary,
      created_at_utc,
      updated_at_utc
    FROM chat_sessions
    WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;
  if (!row) {
    return null;
  }

  const messageRows = database.prepare(`
    SELECT
      id,
      role,
      content,
      input_tokens_estimate,
      output_tokens_estimate,
      thinking_tokens,
      input_tokens_estimated,
      output_tokens_estimated,
      thinking_tokens_estimated,
      prompt_cache_tokens,
      prompt_eval_tokens,
      request_duration_ms,
      prompt_eval_duration_ms,
      generation_duration_ms,
      request_started_at_utc,
      thinking_started_at_utc,
      thinking_ended_at_utc,
      answer_started_at_utc,
      answer_ended_at_utc,
      speculative_accepted_tokens,
      speculative_generated_tokens,
      associated_tool_tokens,
      thinking_content,
      created_at_utc,
      source_run_id,
      compressed_into_summary,
      position
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY position ASC
  `).all(sessionId) as MessageRow[];

  const hiddenContextRows = database.prepare(`
    SELECT
      id,
      content,
      token_estimate,
      source_message_id,
      created_at_utc,
      position
    FROM chat_hidden_tool_contexts
    WHERE session_id = ?
    ORDER BY position ASC
  `).all(sessionId) as HiddenContextRow[];

  return {
    id: row.id,
    title: row.title,
    model: row.model,
    contextWindowTokens: row.context_window_tokens,
    thinkingEnabled: row.thinking_enabled === 1,
    presetId: normalizePresetId(row.preset_id, row.mode),
    mode: normalizeMode(row.mode),
    planRepoRoot: row.plan_repo_root,
    condensedSummary: row.condensed_summary,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    messages: messageRows.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      inputTokensEstimate: message.input_tokens_estimate,
      outputTokensEstimate: message.output_tokens_estimate,
      thinkingTokens: message.thinking_tokens,
      inputTokensEstimated: message.input_tokens_estimated === 1,
      outputTokensEstimated: message.output_tokens_estimated === 1,
      thinkingTokensEstimated: message.thinking_tokens_estimated === 1,
      promptCacheTokens: message.prompt_cache_tokens,
      promptEvalTokens: message.prompt_eval_tokens,
      requestDurationMs: message.request_duration_ms,
      promptEvalDurationMs: message.prompt_eval_duration_ms,
      generationDurationMs: message.generation_duration_ms,
      requestStartedAtUtc: message.request_started_at_utc,
      thinkingStartedAtUtc: message.thinking_started_at_utc,
      thinkingEndedAtUtc: message.thinking_ended_at_utc,
      answerStartedAtUtc: message.answer_started_at_utc,
      answerEndedAtUtc: message.answer_ended_at_utc,
      speculativeAcceptedTokens: message.speculative_accepted_tokens,
      speculativeGeneratedTokens: message.speculative_generated_tokens,
      associatedToolTokens: message.associated_tool_tokens,
      thinkingContent: message.thinking_content,
      createdAtUtc: message.created_at_utc,
      sourceRunId: message.source_run_id,
      compressedIntoSummary: message.compressed_into_summary === 1,
    })),
    hiddenToolContexts: hiddenContextRows.map((entry) => ({
      id: entry.id,
      content: entry.content,
      tokenEstimate: entry.token_estimate,
      sourceMessageId: entry.source_message_id,
      createdAtUtc: entry.created_at_utc,
    })),
  };
}

export function readChatSessionFromPath(targetPath: string): ChatSession | null {
  const sessionId = parseSessionId(targetPath);
  if (!sessionId) {
    return null;
  }
  const runtimeRoot = path.resolve(path.dirname(path.dirname(path.dirname(targetPath))));
  if (!runtimeRoot || runtimeRoot === path.parse(runtimeRoot).root) {
    return null;
  }
  return readSessionById(runtimeRoot, sessionId);
}

export function readChatSessions(runtimeRoot: string): ChatSession[] {
  const ids = listChatSessionPaths(runtimeRoot)
    .map((targetPath) => parseSessionId(targetPath))
    .filter((sessionId): sessionId is string => Boolean(sessionId));
  return ids
    .map((sessionId) => readSessionById(runtimeRoot, sessionId))
    .filter((entry): entry is ChatSession => entry !== null)
    .sort((left, right) => String(right.updatedAtUtc || '').localeCompare(String(left.updatedAtUtc || '')));
}

export function getChatSessionPath(runtimeRoot: string, sessionId: string): string {
  return path.join(getChatSessionsRoot(runtimeRoot), `session_${sessionId}.json`);
}

export function deleteChatSession(runtimeRoot: string, sessionId: string): boolean {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) {
    return false;
  }
  const database = getSessionDatabase(runtimeRoot);
  database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(normalizedId);
  database.prepare('DELETE FROM chat_hidden_tool_contexts WHERE session_id = ?').run(normalizedId);
  const result = database.prepare('DELETE FROM chat_sessions WHERE id = ?').run(normalizedId) as { changes?: number };
  return Number(result.changes || 0) > 0;
}

export function saveChatSession(runtimeRoot: string, session: ChatSession): void {
  const sessionId = String(session.id || '').trim();
  if (!sessionId) {
    throw new Error('Session id is required.');
  }
  const now = new Date().toISOString();
  const mode = normalizeMode(session.mode);
  const presetId = normalizePresetId(session.presetId, mode);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const hiddenToolContexts = Array.isArray(session.hiddenToolContexts)
    ? session.hiddenToolContexts
    : [];

  const database = getSessionDatabase(runtimeRoot);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO chat_sessions (
        id,
        title,
        model,
        context_window_tokens,
        thinking_enabled,
        preset_id,
        mode,
        plan_repo_root,
        condensed_summary,
        created_at_utc,
        updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        model = excluded.model,
        context_window_tokens = excluded.context_window_tokens,
        thinking_enabled = excluded.thinking_enabled,
        preset_id = excluded.preset_id,
        mode = excluded.mode,
        plan_repo_root = excluded.plan_repo_root,
        condensed_summary = excluded.condensed_summary,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      sessionId,
      typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'New Session',
      typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null,
      toNonNegativeInteger(session.contextWindowTokens, 150000),
      session.thinkingEnabled === false ? 0 : 1,
      presetId,
      mode,
      typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
        ? path.resolve(session.planRepoRoot)
        : process.cwd(),
      typeof session.condensedSummary === 'string' ? session.condensedSummary : '',
      typeof session.createdAtUtc === 'string' && session.createdAtUtc.trim() ? session.createdAtUtc : now,
      typeof session.updatedAtUtc === 'string' && session.updatedAtUtc.trim() ? session.updatedAtUtc : now,
    );

    database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
    database.prepare('DELETE FROM chat_hidden_tool_contexts WHERE session_id = ?').run(sessionId);

    const insertMessage = database.prepare(`
      INSERT INTO chat_messages (
        session_id,
        id,
        role,
        content,
        input_tokens_estimate,
        output_tokens_estimate,
        thinking_tokens,
        input_tokens_estimated,
        output_tokens_estimated,
        thinking_tokens_estimated,
        prompt_cache_tokens,
        prompt_eval_tokens,
        request_duration_ms,
        prompt_eval_duration_ms,
        generation_duration_ms,
        request_started_at_utc,
        thinking_started_at_utc,
        thinking_ended_at_utc,
        answer_started_at_utc,
        answer_ended_at_utc,
        speculative_accepted_tokens,
        speculative_generated_tokens,
        associated_tool_tokens,
        thinking_content,
        created_at_utc,
        source_run_id,
        compressed_into_summary,
        position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index] as Dict;
      insertMessage.run(
        sessionId,
        typeof message.id === 'string' && message.id.trim() ? message.id.trim() : crypto.randomUUID(),
        typeof message.role === 'string' && message.role.trim() ? message.role.trim() : 'assistant',
        typeof message.content === 'string' ? message.content : '',
        toNonNegativeInteger(message.inputTokensEstimate, estimateTokenCount(message.content)),
        toNonNegativeInteger(message.outputTokensEstimate, estimateTokenCount(message.content)),
        toNonNegativeInteger(message.thinkingTokens, 0),
        message.inputTokensEstimated === false ? 0 : 1,
        message.outputTokensEstimated === false ? 0 : 1,
        message.thinkingTokensEstimated === false ? 0 : 1,
        toNullableNonNegativeInteger(message.promptCacheTokens),
        toNullableNonNegativeInteger(message.promptEvalTokens),
        toNullableNonNegativeInteger(message.requestDurationMs),
        toNullableNonNegativeInteger(message.promptEvalDurationMs),
        toNullableNonNegativeInteger(message.generationDurationMs),
        typeof message.requestStartedAtUtc === 'string' && message.requestStartedAtUtc.trim() ? message.requestStartedAtUtc : null,
        typeof message.thinkingStartedAtUtc === 'string' && message.thinkingStartedAtUtc.trim() ? message.thinkingStartedAtUtc : null,
        typeof message.thinkingEndedAtUtc === 'string' && message.thinkingEndedAtUtc.trim() ? message.thinkingEndedAtUtc : null,
        typeof message.answerStartedAtUtc === 'string' && message.answerStartedAtUtc.trim() ? message.answerStartedAtUtc : null,
        typeof message.answerEndedAtUtc === 'string' && message.answerEndedAtUtc.trim() ? message.answerEndedAtUtc : null,
        toNullableNonNegativeInteger(message.speculativeAcceptedTokens),
        toNullableNonNegativeInteger(message.speculativeGeneratedTokens),
        toNullableNonNegativeInteger(message.associatedToolTokens),
        typeof message.thinkingContent === 'string' ? message.thinkingContent : null,
        typeof message.createdAtUtc === 'string' && message.createdAtUtc.trim() ? message.createdAtUtc : now,
        typeof message.sourceRunId === 'string' && message.sourceRunId.trim() ? message.sourceRunId : null,
        message.compressedIntoSummary === true ? 1 : 0,
        index,
      );
    }

    const insertHiddenToolContext = database.prepare(`
      INSERT INTO chat_hidden_tool_contexts (
        session_id,
        id,
        content,
        token_estimate,
        source_message_id,
        created_at_utc,
        position
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (let index = 0; index < hiddenToolContexts.length; index += 1) {
      const entry = hiddenToolContexts[index] as Dict;
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!content) {
        continue;
      }
      insertHiddenToolContext.run(
        sessionId,
        typeof entry.id === 'string' && entry.id.trim() ? entry.id : crypto.randomUUID(),
        content,
        toNonNegativeInteger(entry.tokenEstimate, estimateTokenCount(content)),
        typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim()
          ? entry.sourceMessageId
          : null,
        typeof entry.createdAtUtc === 'string' && entry.createdAtUtc.trim()
          ? entry.createdAtUtc
          : now,
        index,
      );
    }
  })();
}
