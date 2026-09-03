import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, resolve } from 'node:path';
import {
  ImageMetadataSchema,
  ModelRuntimePresetSchema,
  ChatRepoAgentApprovalMessageSchema,
  ChatTranscriptMessageKindSchema,
  ChatTranscriptRoleSchema,
  PersistedChatTranscriptMessageSchema,
  ToolCallStatusSchema,
  ToolActivityKindSchema,
  ToolActivitySubjectSchema,
} from '@siftkit/contracts';
import type { ImageMetadata, PersistedChatTranscriptMessage } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { ModelRuntimePreset } from '../config/types.js';
import { normalizeModelRuntimePresetRecord } from '../config/normalization.js';
import {
  toNullableNonNegativeInteger,
  toNullableNonNegativeNumber,
} from '../lib/telemetry-metrics.js';
import { getRuntimeDatabase } from './runtime-db.js';
import { parseImageDataUrls } from '../llm-protocol/image-attachments.js';
import { parseJsonValueText } from '../lib/json.js';
import type { ChatPromptContext } from '../status-server/chat-prompt-context.js';

export type ChatSessionMode = 'chat' | 'plan' | 'repo-search';
export type ChatMessageRole = PersistedChatTranscriptMessage['role'];
export type ChatMessageKind = PersistedChatTranscriptMessage['kind'];
export type ChatGroundingStatus = NonNullable<PersistedChatTranscriptMessage['groundingStatus']>;

export class ChatMessageImageNotFoundError extends Error {
  constructor() {
    super('Image not found.');
    this.name = 'ChatMessageImageNotFoundError';
  }
}

export type ChatMessage = PersistedChatTranscriptMessage;

export type ChatSession = {
  id: string;
  title?: string;
  modelPresetId: string;
  /** Full request-shaping preset captured when the session was created. */
  modelPreset: ModelRuntimePreset;
  thinkingEnabled?: boolean;
  webSearchEnabled?: boolean;
  presetId?: string;
  mode?: ChatSessionMode;
  planRepoRoot?: string;
  promptContext?: ChatPromptContext;
  createdAtUtc?: string;
  updatedAtUtc?: string;
  messages?: ChatMessage[];
};

const SessionIdRowSchema = z.object({ id: z.string().nullable() });

const SessionRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  model_preset_id: z.string().trim().min(1),
  model_preset_json: z.string().nullable(),
  thinking_enabled: z.number(),
  web_search_enabled: z.number(),
  preset_id: z.string().nullable(),
  mode: z.string(),
  plan_repo_root: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});

const MessageRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  kind: z.string(),
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
  tool_call_activity_kind: z.string().nullable(),
  tool_call_activity_subject_kind: z.string().nullable(),
  tool_call_activity_subject_value: z.string().nullable(),
  tool_call_turn: z.number().nullable(),
  tool_call_max_turns: z.number().nullable(),
  tool_call_exit_code: z.number().nullable(),
  tool_call_prompt_token_count: z.number().nullable(),
  tool_call_output_snippet: z.string().nullable(),
  tool_call_output: z.string().nullable(),
  tool_call_status: z.string().nullable(),
  approval_decision: z.string().nullable(),
  approval_tool_name: z.string().nullable(),
  approval_command: z.string().nullable(),
  approval_reason: z.string().nullable(),
  created_at_utc: z.string(),
  source_run_id: z.string().nullable(),
  compressed_into_summary: z.number(),
  grounding_status: z.string().nullable(),
  images: z.string().nullable(),
  image_meta: z.string().nullable(),
  removed_image_count: z.number().nullable(),
  position: z.number(),
});
type MessageRow = z.infer<typeof MessageRowSchema>;

const MessageImageRowSchema = z.object({
  id: z.string(),
  images: z.string().nullable(),
  image_meta: z.string().nullable(),
});
type MessageImageRow = z.infer<typeof MessageImageRowSchema>;

const MessageImageRemovalRowSchema = MessageImageRowSchema.extend({
  removed_image_count: z.number().nullable(),
});

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

function requirePresetId(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    throw new Error('Chat session presetId is required.');
  }
  return normalized;
}

function requireModelPresetId(value: string): string {
  const modelPresetId = value.trim();
  if (!modelPresetId) {
    throw new Error('Chat session modelPresetId is required.');
  }
  return modelPresetId;
}

/**
 * A snapshot is stored preset JSON, so it is read through the same normalization as the
 * config's preset list: a field added to the preset contract after the row was written
 * resolves to its current default, while a field this repo removed still fails loudly.
 */
function parseModelPresetSnapshot(sessionId: string, modelPresetId: string, raw: string | null): ModelRuntimePreset {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Chat session ${sessionId} has no model preset snapshot; re-create the session.`);
  }
  return normalizeModelRuntimePresetRecord(parseJsonValueText(raw), modelPresetId, modelPresetId);
}

function normalizeGroundingStatus(value: string | null | undefined): ChatGroundingStatus | null {
  if (value === 'ungrounded' || value === 'snippet_only' || value === 'fetched') {
    return value;
  }
  return null;
}

function mapMessageRow(row: MessageRow): ChatMessage {
  const kind = ChatTranscriptMessageKindSchema.parse(row.kind);
  return PersistedChatTranscriptMessageSchema.parse({
    id: row.id,
    role: ChatTranscriptRoleSchema.parse(row.role),
    kind,
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
    toolCallActivityKind: kind === 'assistant_tool_call'
      ? ToolActivityKindSchema.parse(row.tool_call_activity_kind)
      : undefined,
    toolCallActivitySubject: kind === 'assistant_tool_call'
      ? ToolActivitySubjectSchema.parse(
        row.tool_call_activity_subject_kind === 'none'
          ? { kind: row.tool_call_activity_subject_kind }
          : {
              kind: row.tool_call_activity_subject_kind,
              value: row.tool_call_activity_subject_value,
            },
      )
      : undefined,
    toolCallTurn: row.tool_call_turn,
    toolCallMaxTurns: row.tool_call_max_turns,
    toolCallExitCode: row.tool_call_exit_code,
    toolCallPromptTokenCount: row.tool_call_prompt_token_count,
    toolCallOutputSnippet: row.tool_call_output_snippet,
    toolCallOutput: row.tool_call_output,
    toolCallStatus: kind === 'assistant_tool_call'
      ? ToolCallStatusSchema.parse(row.tool_call_status)
      : undefined,
    approvalDecision: kind === 'repo_agent_approval'
      ? ChatRepoAgentApprovalMessageSchema.shape.approvalDecision.parse(row.approval_decision)
      : undefined,
    approvalToolName: kind === 'repo_agent_approval'
      ? ChatRepoAgentApprovalMessageSchema.shape.approvalToolName.parse(row.approval_tool_name)
      : undefined,
    approvalCommand: kind === 'repo_agent_approval'
      ? ChatRepoAgentApprovalMessageSchema.shape.approvalCommand.parse(row.approval_command)
      : undefined,
    approvalReason: kind === 'repo_agent_approval'
      ? ChatRepoAgentApprovalMessageSchema.shape.approvalReason.parse(row.approval_reason)
      : undefined,
    createdAtUtc: row.created_at_utc,
    sourceRunId: row.source_run_id,
    compressedIntoSummary: row.compressed_into_summary === 1,
    groundingStatus: normalizeGroundingStatus(row.grounding_status),
    images: row.images === null ? [] : parseImageDataUrls(parseJsonValueText(row.images)),
    imageMeta: row.image_meta === null
      ? []
      : z.array(ImageMetadataSchema).parse(parseJsonValueText(row.image_meta)),
    removedImageCount: row.removed_image_count ?? 0,
  });
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
      model_preset_id,
      model_preset_json,
      thinking_enabled,
      web_search_enabled,
      preset_id,
      mode,
      plan_repo_root,
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
      tool_call_activity_kind,
      tool_call_activity_subject_kind,
      tool_call_activity_subject_value,
      tool_call_turn,
      tool_call_max_turns,
      tool_call_exit_code,
      tool_call_prompt_token_count,
      tool_call_output_snippet,
      tool_call_output,
      tool_call_status,
      approval_decision,
      approval_tool_name,
      approval_command,
      approval_reason,
      created_at_utc,
      source_run_id,
      compressed_into_summary,
      grounding_status,
      images,
      image_meta,
      removed_image_count,
      position
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY position ASC
  `).all(sessionId);
  const messages = z.array(MessageRowSchema).parse(messageRows);

  return {
    id: session.id,
    title: session.title,
    modelPresetId: session.model_preset_id,
    modelPreset: parseModelPresetSnapshot(session.id, session.model_preset_id, session.model_preset_json),
    thinkingEnabled: session.thinking_enabled === 1,
    webSearchEnabled: session.web_search_enabled === 1,
    presetId: requirePresetId(session.preset_id),
    mode: normalizeMode(session.mode),
    planRepoRoot: session.plan_repo_root,
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

export function updateChatMessageImageCaption(
  runtimeRoot: string,
  sessionId: string,
  messageId: string,
  imageIndex: number,
  caption: string,
): void {
  const normalizedSessionId = sessionId.trim();
  const normalizedMessageId = messageId.trim();
  const normalizedCaption = caption.trim();
  if (!normalizedSessionId || !normalizedMessageId) {
    throw new Error('Session id and message id are required.');
  }
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    throw new Error('Image index must be a non-negative integer.');
  }
  if (!normalizedCaption) {
    throw new Error('Image caption is required.');
  }

  const database = getSessionDatabase(runtimeRoot);
  const rowValue = database.prepare(`
    SELECT id, images, image_meta
    FROM chat_messages
    WHERE session_id = ? AND id = ?
  `).get(normalizedSessionId, normalizedMessageId);
  if (rowValue === undefined || rowValue === null) {
    throw new ChatMessageImageNotFoundError();
  }
  const row: MessageImageRow = MessageImageRowSchema.parse(rowValue);
  const images = row.images === null ? [] : parseImageDataUrls(parseJsonValueText(row.images));
  if (!images[imageIndex]) {
    throw new ChatMessageImageNotFoundError();
  }
  if (row.image_meta === null) {
    throw new ChatMessageImageNotFoundError();
  }
  const imageMeta = z.array(ImageMetadataSchema).parse(parseJsonValueText(row.image_meta));
  const metadata = imageMeta[imageIndex];
  if (!metadata) {
    throw new ChatMessageImageNotFoundError();
  }
  const updatedImageMeta: ImageMetadata[] = imageMeta.map((entry, index) => (
    index === imageIndex ? { ...entry, caption: normalizedCaption } : entry
  ));
  const parsedUpdatedImageMeta = z.array(ImageMetadataSchema).parse(updatedImageMeta);
  const result = database.prepare(`
    UPDATE chat_messages
    SET image_meta = ?
    WHERE session_id = ? AND id = ?
  `).run(JSON.stringify(parsedUpdatedImageMeta), normalizedSessionId, normalizedMessageId);
  if (Number(result.changes || 0) !== 1) {
    throw new ChatMessageImageNotFoundError();
  }
}

function touchChatSession(runtimeRoot: string, sessionId: string): void {
  getSessionDatabase(runtimeRoot)
    .prepare('UPDATE chat_sessions SET updated_at_utc = ? WHERE id = ?')
    .run(new Date().toISOString(), sessionId);
}

/**
 * Drops one attachment from a persisted message so its tokens stop replaying into every
 * later request. The removal is recorded as a count rather than written into the text:
 * the user's words stay theirs, and the replay notice is composed from the count so a
 * message that referred to "this screenshot" does not dangle.
 */
export function deleteChatMessageImage(
  runtimeRoot: string,
  sessionId: string,
  messageId: string,
  imageIndex: number,
): void {
  const normalizedSessionId = sessionId.trim();
  const normalizedMessageId = messageId.trim();
  if (!normalizedSessionId || !normalizedMessageId) {
    throw new Error('Session id and message id are required.');
  }
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    throw new Error('Image index must be a non-negative integer.');
  }

  const database = getSessionDatabase(runtimeRoot);
  const rowValue = database.prepare(`
    SELECT id, images, image_meta, removed_image_count
    FROM chat_messages
    WHERE session_id = ? AND id = ?
  `).get(normalizedSessionId, normalizedMessageId);
  if (rowValue === undefined || rowValue === null) {
    throw new ChatMessageImageNotFoundError();
  }
  const row = MessageImageRemovalRowSchema.parse(rowValue);
  const images = row.images === null ? [] : parseImageDataUrls(parseJsonValueText(row.images));
  if (!images[imageIndex]) {
    throw new ChatMessageImageNotFoundError();
  }
  const imageMeta = row.image_meta === null
    ? []
    : z.array(ImageMetadataSchema).parse(parseJsonValueText(row.image_meta));
  const remainingImages = images.filter((_, index) => index !== imageIndex);
  const remainingImageMeta = imageMeta.filter((_, index) => index !== imageIndex);
  const result = database.prepare(`
    UPDATE chat_messages
    SET images = ?, image_meta = ?, removed_image_count = ?
    WHERE session_id = ? AND id = ?
  `).run(
    JSON.stringify(remainingImages),
    remainingImageMeta.length > 0 ? JSON.stringify(remainingImageMeta) : null,
    (row.removed_image_count ?? 0) + 1,
    normalizedSessionId,
    normalizedMessageId,
  );
  if (Number(result.changes || 0) !== 1) {
    throw new ChatMessageImageNotFoundError();
  }
  touchChatSession(runtimeRoot, normalizedSessionId);
}

export function saveChatSession(runtimeRoot: string, session: ChatSession): void {
  const sessionId = String(session.id || '').trim();
  if (!sessionId) {
    throw new Error('Session id is required.');
  }
  const now = new Date().toISOString();
  const modelPresetId = requireModelPresetId(session.modelPresetId);
  const modelPresetJson = JSON.stringify(ModelRuntimePresetSchema.parse(session.modelPreset));
  const mode = normalizeMode(session.mode);
  const presetId = requirePresetId(session.presetId);
  const messages = z.array(PersistedChatTranscriptMessageSchema).parse(session.messages ?? []);

  const database = getSessionDatabase(runtimeRoot);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO chat_sessions (
        id,
        title,
        model_preset_id,
        model_preset_json,
        thinking_enabled,
        web_search_enabled,
        preset_id,
        mode,
        plan_repo_root,
        created_at_utc,
        updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        model_preset_id = excluded.model_preset_id,
        model_preset_json = excluded.model_preset_json,
        thinking_enabled = excluded.thinking_enabled,
        web_search_enabled = excluded.web_search_enabled,
        preset_id = excluded.preset_id,
        mode = excluded.mode,
        plan_repo_root = excluded.plan_repo_root,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      sessionId,
      typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'New Session',
      modelPresetId,
      modelPresetJson,
      session.thinkingEnabled === false ? 0 : 1,
      session.webSearchEnabled === true ? 1 : 0,
      presetId,
      mode,
      typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
        ? resolve(session.planRepoRoot)
        : process.cwd(),
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
        tool_call_activity_kind,
        tool_call_activity_subject_kind,
        tool_call_activity_subject_value,
        tool_call_turn,
        tool_call_max_turns,
        tool_call_exit_code,
        tool_call_prompt_token_count,
        tool_call_output_snippet,
        tool_call_output,
        tool_call_status,
        approval_decision,
        approval_tool_name,
        approval_command,
        approval_reason,
        created_at_utc,
        source_run_id,
        compressed_into_summary,
        grounding_status,
        images,
        image_meta,
        removed_image_count,
        position
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const messageKind = ChatTranscriptMessageKindSchema.parse(message.kind);
      const activitySubject = messageKind === 'assistant_tool_call'
        ? ToolActivitySubjectSchema.parse(message.toolCallActivitySubject)
        : null;
      const approvalMessage = message.kind === 'repo_agent_approval' ? message : null;
      insertMessage.run(
        sessionId,
        typeof message.id === 'string' && message.id.trim() ? message.id.trim() : randomUUID(),
        ChatTranscriptRoleSchema.parse(message.role),
        messageKind,
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
        messageKind === 'assistant_tool_call'
          ? ToolActivityKindSchema.parse(message.toolCallActivityKind)
          : null,
        activitySubject?.kind ?? null,
        activitySubject?.kind === 'file' || activitySubject?.kind === 'host'
          ? activitySubject.value
          : null,
        toNullableNonNegativeInteger(message.toolCallTurn),
        toNullableNonNegativeInteger(message.toolCallMaxTurns),
        toNullableInteger(message.toolCallExitCode),
        toNullableNonNegativeInteger(message.toolCallPromptTokenCount),
        typeof message.toolCallOutputSnippet === 'string' ? message.toolCallOutputSnippet : null,
        typeof message.toolCallOutput === 'string' ? message.toolCallOutput : null,
        message.kind === 'assistant_tool_call' ? message.toolCallStatus : null,
        approvalMessage?.approvalDecision ?? null,
        approvalMessage?.approvalToolName ?? null,
        approvalMessage?.approvalCommand ?? null,
        approvalMessage?.approvalReason ?? null,
        typeof message.createdAtUtc === 'string' && message.createdAtUtc.trim() ? message.createdAtUtc : now,
        typeof message.sourceRunId === 'string' && message.sourceRunId.trim() ? message.sourceRunId : null,
        message.compressedIntoSummary === true ? 1 : 0,
        normalizeGroundingStatus(message.groundingStatus),
        JSON.stringify(message.images ?? []),
        message.imageMeta && message.imageMeta.length > 0 ? JSON.stringify(message.imageMeta) : null,
        toNullableNonNegativeInteger(message.removedImageCount) ?? 0,
        index,
      );
    }

  })();
}
