import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { z } from '../lib/zod.js';
import { mapLegacyModeToPresetId } from '../presets.js';
import {
  toNullableNonNegativeInteger,
  toNullableNonNegativeNumber,
} from '../lib/telemetry-metrics.js';
import { getRuntimeDatabase } from './runtime-db.js';
import type { ChatPromptContext } from '../status-server/chat-prompt-context.js';

export type ChatSessionMode = 'chat' | 'plan' | 'repo-search';
export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageKind = 'user_text' | 'assistant_answer' | 'assistant_thinking' | 'assistant_tool_call';
export type ChatGroundingStatus = 'ungrounded' | 'snippet_only' | 'fetched';

export type ChatMessage = {
  id: string;
  role: ChatMessageRole;
  kind?: ChatMessageKind;
  content: string;
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  thinkingTokens: number;
  inputTokensEstimated?: boolean;
  outputTokensEstimated?: boolean;
  thinkingTokensEstimated?: boolean;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
  requestDurationMs?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  requestStartedAtUtc?: string | null;
  thinkingStartedAtUtc?: string | null;
  thinkingEndedAtUtc?: string | null;
  answerStartedAtUtc?: string | null;
  answerEndedAtUtc?: string | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  associatedToolTokens?: number | null;
  thinkingContent?: string | null;
  toolCallCommand?: string | null;
  toolCallTurn?: number | null;
  toolCallMaxTurns?: number | null;
  toolCallExitCode?: number | null;
  toolCallPromptTokenCount?: number | null;
  toolCallOutputSnippet?: string | null;
  toolCallOutput?: string | null;
  createdAtUtc: string;
  sourceRunId?: string | null;
  compressedIntoSummary?: boolean;
  groundingStatus?: ChatGroundingStatus | null;
};

export type ChatSession = {
  id: string;
  title?: string;
  model?: string | null;
  contextWindowTokens?: number;
  thinkingEnabled?: boolean;
  webSearchEnabled?: boolean;
  presetId?: string;
  mode?: ChatSessionMode;
  planRepoRoot?: string;
  condensedSummary?: string;
  promptContext?: ChatPromptContext;
  createdAtUtc?: string;
  updatedAtUtc?: string;
  messages?: ChatMessage[];
};

const SessionIdRowSchema = z.object({ id: z.string().nullable() });

const SessionRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: z.string().nullable(),
  context_window_tokens: z.number(),
  thinking_enabled: z.number(),
  web_search_enabled: z.number(),
  preset_id: z.string().nullable(),
  mode: z.string(),
  plan_repo_root: z.string(),
  condensed_summary: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});

const MessageRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  kind: z.string().nullable(),
  content: z.string(),
  input_tokens_estimate: z.number(),
  output_tokens_estimate: z.number(),
  thinking_tokens: z.number(),
  input_tokens_estimated: z.number(),
  output_tokens_estimated: z.number(),
  thinking_tokens_estimated: z.number(),
  prompt_cache_tokens: z.number().nullable(),
  prompt_eval_tokens: z.number().nullable(),
  prompt_tokens_per_second: z.number().nullable(),
  output_tokens_per_second: z.number().nullable(),
  request_duration_ms: z.number().nullable(),
  prompt_eval_duration_ms: z.number().nullable(),
  generation_duration_ms: z.number().nullable(),
  request_started_at_utc: z.string().nullable(),
  thinking_started_at_utc: z.string().nullable(),
  thinking_ended_at_utc: z.string().nullable(),
  answer_started_at_utc: z.string().nullable(),
  answer_ended_at_utc: z.string().nullable(),
  speculative_accepted_tokens: z.number().nullable(),
  speculative_generated_tokens: z.number().nullable(),
  associated_tool_tokens: z.number().nullable(),
  thinking_content: z.string().nullable(),
  tool_call_command: z.string().nullable(),
  tool_call_turn: z.number().nullable(),
  tool_call_max_turns: z.number().nullable(),
  tool_call_exit_code: z.number().nullable(),
  tool_call_prompt_token_count: z.number().nullable(),
  tool_call_output_snippet: z.string().nullable(),
  tool_call_output: z.string().nullable(),
  created_at_utc: z.string(),
  source_run_id: z.string().nullable(),
  compressed_into_summary: z.number(),
  grounding_status: z.string().nullable(),
  position: z.number(),
});
type MessageRow = z.infer<typeof MessageRowSchema>;

function getSessionDatabase(runtimeRoot: string): ReturnType<typeof getRuntimeDatabase> {
  return getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite'));
}

function parseSessionId(targetPath: string): string | null {
  const raw = String(targetPath || '').trim();
  if (!raw) {
    return null;
  }
  const base = basename(raw);
  const match = /^session_(.+)\.json$/iu.exec(base);
  if (match && match[1] && match[1].trim()) {
    return match[1].trim();
  }
  if (raw.startsWith('db://session/')) {
    return raw.replace('db://session/', '').trim() || null;
  }
  return null;
}

function normalizeMode(value: string | null | undefined): ChatSessionMode {
  return value === 'plan' || value === 'repo-search' ? value : 'chat';
}

function normalizePresetId(value: string | null | undefined, modeValue?: string | null): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || mapLegacyModeToPresetId(modeValue);
}

function normalizeRole(value: string | null | undefined): ChatMessageRole {
  return value === 'user' ? 'user' : 'assistant';
}

function normalizeMessageKind(value: string | null | undefined, roleValue: string | null | undefined): ChatMessageKind {
  if (
    value === 'user_text'
    || value === 'assistant_answer'
    || value === 'assistant_thinking'
    || value === 'assistant_tool_call'
  ) {
    return value;
  }
  return roleValue === 'user' ? 'user_text' : 'assistant_answer';
}

function normalizeGroundingStatus(value: string | null | undefined): ChatGroundingStatus | null {
  if (value === 'ungrounded' || value === 'snippet_only' || value === 'fetched') {
    return value;
  }
  return null;
}

function mapMessageRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: normalizeRole(row.role),
    kind: normalizeMessageKind(row.kind, row.role),
    content: row.content,
    inputTokensEstimate: row.input_tokens_estimate,
    outputTokensEstimate: row.output_tokens_estimate,
    thinkingTokens: row.thinking_tokens,
    inputTokensEstimated: row.input_tokens_estimated === 1,
    outputTokensEstimated: row.output_tokens_estimated === 1,
    thinkingTokensEstimated: row.thinking_tokens_estimated === 1,
    promptCacheTokens: row.prompt_cache_tokens,
    promptEvalTokens: row.prompt_eval_tokens,
    promptTokensPerSecond: row.prompt_tokens_per_second,
    generationTokensPerSecond: row.output_tokens_per_second,
    requestDurationMs: row.request_duration_ms,
    promptEvalDurationMs: row.prompt_eval_duration_ms,
    generationDurationMs: row.generation_duration_ms,
    requestStartedAtUtc: row.request_started_at_utc,
    thinkingStartedAtUtc: row.thinking_started_at_utc,
    thinkingEndedAtUtc: row.thinking_ended_at_utc,
    answerStartedAtUtc: row.answer_started_at_utc,
    answerEndedAtUtc: row.answer_ended_at_utc,
    speculativeAcceptedTokens: row.speculative_accepted_tokens,
    speculativeGeneratedTokens: row.speculative_generated_tokens,
    associatedToolTokens: row.associated_tool_tokens,
    thinkingContent: row.thinking_content,
    toolCallCommand: row.tool_call_command,
    toolCallTurn: row.tool_call_turn,
    toolCallMaxTurns: row.tool_call_max_turns,
    toolCallExitCode: row.tool_call_exit_code,
    toolCallPromptTokenCount: row.tool_call_prompt_token_count,
    toolCallOutputSnippet: row.tool_call_output_snippet,
    toolCallOutput: row.tool_call_output,
    createdAtUtc: row.created_at_utc,
    sourceRunId: row.source_run_id,
    compressedIntoSummary: row.compressed_into_summary === 1,
    groundingStatus: normalizeGroundingStatus(row.grounding_status),
  };
}

function toNullableInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function estimateTokenCount(value: string): number {
  if (!value.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(value.length / 4));
}

export function getChatSessionsRoot(runtimeRoot: string): string {
  return join(runtimeRoot, 'chat', 'sessions');
}

export function listChatSessionPaths(runtimeRoot: string): string[] {
  const database = getSessionDatabase(runtimeRoot);
  const rows = z.array(SessionIdRowSchema).parse(
    database.prepare('SELECT id FROM chat_sessions ORDER BY updated_at_utc DESC').all(),
  );
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
      web_search_enabled,
      preset_id,
      mode,
      plan_repo_root,
      condensed_summary,
      created_at_utc,
      updated_at_utc
    FROM chat_sessions
    WHERE id = ?
  `).get(sessionId);
  if (row === undefined || row === null) {
    return null;
  }
  const session = SessionRowSchema.parse(row);

  const messageRows = database.prepare(`
    SELECT
      id,
      role,
      kind,
      content,
      input_tokens_estimate,
      output_tokens_estimate,
      thinking_tokens,
      input_tokens_estimated,
      output_tokens_estimated,
      thinking_tokens_estimated,
      prompt_cache_tokens,
      prompt_eval_tokens,
      prompt_tokens_per_second,
      output_tokens_per_second,
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
      tool_call_command,
      tool_call_turn,
      tool_call_max_turns,
      tool_call_exit_code,
      tool_call_prompt_token_count,
      tool_call_output_snippet,
      tool_call_output,
      created_at_utc,
      source_run_id,
      compressed_into_summary,
      grounding_status,
      position
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY position ASC
  `).all(sessionId);
  const messages = z.array(MessageRowSchema).parse(messageRows);

  return {
    id: session.id,
    title: session.title,
    model: session.model,
    contextWindowTokens: session.context_window_tokens,
    thinkingEnabled: session.thinking_enabled === 1,
    webSearchEnabled: session.web_search_enabled === 1,
    presetId: normalizePresetId(session.preset_id, session.mode),
    mode: normalizeMode(session.mode),
    planRepoRoot: session.plan_repo_root,
    condensedSummary: session.condensed_summary,
    createdAtUtc: session.created_at_utc,
    updatedAtUtc: session.updated_at_utc,
    messages: messages.map((message) => mapMessageRow(message)),
  };
}

export function readChatSessionFromPath(targetPath: string): ChatSession | null {
  const sessionId = parseSessionId(targetPath);
  if (!sessionId) {
    return null;
  }
  const runtimeRoot = resolve(dirname(dirname(dirname(targetPath))));
  if (!runtimeRoot || runtimeRoot === parse(runtimeRoot).root) {
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
  return join(getChatSessionsRoot(runtimeRoot), `session_${sessionId}.json`);
}

export function deleteChatSession(runtimeRoot: string, sessionId: string): boolean {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) {
    return false;
  }
  const database = getSessionDatabase(runtimeRoot);
  database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(normalizedId);
  const result = database.prepare('DELETE FROM chat_sessions WHERE id = ?').run(normalizedId);
  return Number(result.changes || 0) > 0;
}

export function deleteChatMessage(runtimeRoot: string, sessionId: string, messageId: string): { session: ChatSession; deletedMessage: ChatMessage } | null {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedMessageId = String(messageId || '').trim();
  if (!normalizedSessionId || !normalizedMessageId) {
    return null;
  }
  const current = readSessionById(runtimeRoot, normalizedSessionId);
  if (!current || !Array.isArray(current.messages)) {
    return null;
  }
  const deletedMessage = current.messages.find((message) => String(message.id || '') === normalizedMessageId);
  if (!deletedMessage) {
    return null;
  }
  const updatedSession: ChatSession = {
    ...current,
    updatedAtUtc: new Date().toISOString(),
    messages: current.messages.filter((message) => String(message.id || '') !== normalizedMessageId),
  };
  saveChatSession(runtimeRoot, updatedSession);
  return { session: updatedSession, deletedMessage };
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

  const database = getSessionDatabase(runtimeRoot);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO chat_sessions (
        id,
        title,
        model,
        context_window_tokens,
        thinking_enabled,
        web_search_enabled,
        preset_id,
        mode,
        plan_repo_root,
        condensed_summary,
        created_at_utc,
        updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        model = excluded.model,
        context_window_tokens = excluded.context_window_tokens,
        thinking_enabled = excluded.thinking_enabled,
        web_search_enabled = excluded.web_search_enabled,
        preset_id = excluded.preset_id,
        mode = excluded.mode,
        plan_repo_root = excluded.plan_repo_root,
        condensed_summary = excluded.condensed_summary,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      sessionId,
      typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'New Session',
      typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null,
        toNullableNonNegativeInteger(session.contextWindowTokens) ?? 150000,
      session.thinkingEnabled === false ? 0 : 1,
      session.webSearchEnabled === true ? 1 : 0,
      presetId,
      mode,
      typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
        ? resolve(session.planRepoRoot)
        : process.cwd(),
      typeof session.condensedSummary === 'string' ? session.condensedSummary : '',
      typeof session.createdAtUtc === 'string' && session.createdAtUtc.trim() ? session.createdAtUtc : now,
      typeof session.updatedAtUtc === 'string' && session.updatedAtUtc.trim() ? session.updatedAtUtc : now,
    );

    database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);

    const insertMessage = database.prepare(`
      INSERT INTO chat_messages (
        session_id,
        id,
        role,
        kind,
        content,
        input_tokens_estimate,
        output_tokens_estimate,
        thinking_tokens,
        input_tokens_estimated,
        output_tokens_estimated,
        thinking_tokens_estimated,
        prompt_cache_tokens,
        prompt_eval_tokens,
        prompt_tokens_per_second,
        output_tokens_per_second,
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
        tool_call_command,
        tool_call_turn,
        tool_call_max_turns,
        tool_call_exit_code,
        tool_call_prompt_token_count,
        tool_call_output_snippet,
        tool_call_output,
        created_at_utc,
        source_run_id,
        compressed_into_summary,
        grounding_status,
        position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      insertMessage.run(
        sessionId,
        typeof message.id === 'string' && message.id.trim() ? message.id.trim() : randomUUID(),
        normalizeRole(message.role),
        normalizeMessageKind(message.kind, message.role),
        typeof message.content === 'string' ? message.content : '',
        toNullableNonNegativeInteger(message.inputTokensEstimate) ?? estimateTokenCount(message.content),
        toNullableNonNegativeInteger(message.outputTokensEstimate) ?? estimateTokenCount(message.content),
        toNullableNonNegativeInteger(message.thinkingTokens) ?? 0,
        message.inputTokensEstimated === false ? 0 : 1,
        message.outputTokensEstimated === false ? 0 : 1,
        message.thinkingTokensEstimated === false ? 0 : 1,
        toNullableNonNegativeInteger(message.promptCacheTokens),
        toNullableNonNegativeInteger(message.promptEvalTokens),
        toNullableNonNegativeNumber(message.promptTokensPerSecond),
        toNullableNonNegativeNumber(message.generationTokensPerSecond),
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
        typeof message.toolCallCommand === 'string' ? message.toolCallCommand : null,
        toNullableNonNegativeInteger(message.toolCallTurn),
        toNullableNonNegativeInteger(message.toolCallMaxTurns),
        toNullableInteger(message.toolCallExitCode),
        toNullableNonNegativeInteger(message.toolCallPromptTokenCount),
        typeof message.toolCallOutputSnippet === 'string' ? message.toolCallOutputSnippet : null,
        typeof message.toolCallOutput === 'string' ? message.toolCallOutput : null,
        typeof message.createdAtUtc === 'string' && message.createdAtUtc.trim() ? message.createdAtUtc : now,
        typeof message.sourceRunId === 'string' && message.sourceRunId.trim() ? message.sourceRunId : null,
        message.compressedIntoSummary === true ? 1 : 0,
        normalizeGroundingStatus(message.groundingStatus),
        index,
      );
    }

  })();
}
