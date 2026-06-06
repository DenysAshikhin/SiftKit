"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokenCount = estimateTokenCount;
exports.getChatSessionsRoot = getChatSessionsRoot;
exports.listChatSessionPaths = listChatSessionPaths;
exports.readChatSessionFromPath = readChatSessionFromPath;
exports.readChatSessions = readChatSessions;
exports.getChatSessionPath = getChatSessionPath;
exports.deleteChatSession = deleteChatSession;
exports.deleteChatMessage = deleteChatMessage;
exports.saveChatSession = saveChatSession;
const crypto = __importStar(require("node:crypto"));
const path = __importStar(require("node:path"));
const presets_js_1 = require("../presets.js");
const runtime_db_js_1 = require("./runtime-db.js");
function getSessionDatabase(runtimeRoot) {
    return (0, runtime_db_js_1.getRuntimeDatabase)(path.join(runtimeRoot, 'runtime.sqlite'));
}
function parseSessionId(targetPath) {
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
function normalizeMode(value) {
    return value === 'plan' || value === 'repo-search' ? value : 'chat';
}
function normalizePresetId(value, modeValue) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized || (0, presets_js_1.mapLegacyModeToPresetId)(modeValue);
}
function normalizeMessageKind(value, roleValue) {
    if (value === 'user_text'
        || value === 'assistant_answer'
        || value === 'assistant_thinking'
        || value === 'assistant_tool_call') {
        return value;
    }
    return roleValue === 'user' ? 'user_text' : 'assistant_answer';
}
function toNonNegativeInteger(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return Math.trunc(parsed);
}
function toNullableNonNegativeInteger(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }
    return Math.trunc(parsed);
}
function toNullableNonNegativeNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }
    return parsed;
}
function estimateTokenCount(value) {
    const text = String(value || '');
    if (!text.trim()) {
        return 0;
    }
    return Math.max(1, Math.ceil(text.length / 4));
}
function getChatSessionsRoot(runtimeRoot) {
    return path.join(runtimeRoot, 'chat', 'sessions');
}
function listChatSessionPaths(runtimeRoot) {
    const database = getSessionDatabase(runtimeRoot);
    const rows = database.prepare('SELECT id FROM chat_sessions ORDER BY updated_at_utc DESC').all();
    return rows
        .map((row) => (typeof row.id === 'string' ? row.id.trim() : ''))
        .filter((id) => id.length > 0)
        .map((id) => getChatSessionPath(runtimeRoot, id));
}
function readSessionById(runtimeRoot, sessionId) {
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
    if (!row) {
        return null;
    }
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
      position
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY position ASC
  `).all(sessionId);
    return {
        id: row.id,
        title: row.title,
        model: row.model,
        contextWindowTokens: row.context_window_tokens,
        thinkingEnabled: row.thinking_enabled === 1,
        webSearchEnabled: row.web_search_enabled === 1,
        presetId: normalizePresetId(row.preset_id, row.mode),
        mode: normalizeMode(row.mode),
        planRepoRoot: row.plan_repo_root,
        condensedSummary: row.condensed_summary,
        createdAtUtc: row.created_at_utc,
        updatedAtUtc: row.updated_at_utc,
        messages: messageRows.map((message) => ({
            id: message.id,
            role: message.role,
            kind: normalizeMessageKind(message.kind, message.role),
            content: message.content,
            inputTokensEstimate: message.input_tokens_estimate,
            outputTokensEstimate: message.output_tokens_estimate,
            thinkingTokens: message.thinking_tokens,
            inputTokensEstimated: message.input_tokens_estimated === 1,
            outputTokensEstimated: message.output_tokens_estimated === 1,
            thinkingTokensEstimated: message.thinking_tokens_estimated === 1,
            promptCacheTokens: message.prompt_cache_tokens,
            promptEvalTokens: message.prompt_eval_tokens,
            promptTokensPerSecond: message.prompt_tokens_per_second,
            generationTokensPerSecond: message.output_tokens_per_second,
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
            toolCallCommand: message.tool_call_command,
            toolCallTurn: message.tool_call_turn,
            toolCallMaxTurns: message.tool_call_max_turns,
            toolCallExitCode: message.tool_call_exit_code,
            toolCallPromptTokenCount: message.tool_call_prompt_token_count,
            toolCallOutputSnippet: message.tool_call_output_snippet,
            toolCallOutput: message.tool_call_output,
            createdAtUtc: message.created_at_utc,
            sourceRunId: message.source_run_id,
            compressedIntoSummary: message.compressed_into_summary === 1,
        })),
    };
}
function readChatSessionFromPath(targetPath) {
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
function readChatSessions(runtimeRoot) {
    const ids = listChatSessionPaths(runtimeRoot)
        .map((targetPath) => parseSessionId(targetPath))
        .filter((sessionId) => Boolean(sessionId));
    return ids
        .map((sessionId) => readSessionById(runtimeRoot, sessionId))
        .filter((entry) => entry !== null)
        .sort((left, right) => String(right.updatedAtUtc || '').localeCompare(String(left.updatedAtUtc || '')));
}
function getChatSessionPath(runtimeRoot, sessionId) {
    return path.join(getChatSessionsRoot(runtimeRoot), `session_${sessionId}.json`);
}
function deleteChatSession(runtimeRoot, sessionId) {
    const normalizedId = String(sessionId || '').trim();
    if (!normalizedId) {
        return false;
    }
    const database = getSessionDatabase(runtimeRoot);
    database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(normalizedId);
    const result = database.prepare('DELETE FROM chat_sessions WHERE id = ?').run(normalizedId);
    return Number(result.changes || 0) > 0;
}
function deleteChatMessage(runtimeRoot, sessionId, messageId) {
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
    const updatedSession = {
        ...current,
        updatedAtUtc: new Date().toISOString(),
        messages: current.messages.filter((message) => String(message.id || '') !== normalizedMessageId),
    };
    saveChatSession(runtimeRoot, updatedSession);
    return { session: updatedSession, deletedMessage };
}
function saveChatSession(runtimeRoot, session) {
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
    `).run(sessionId, typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'New Session', typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null, toNonNegativeInteger(session.contextWindowTokens, 150000), session.thinkingEnabled === false ? 0 : 1, session.webSearchEnabled === true ? 1 : 0, presetId, mode, typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
            ? path.resolve(session.planRepoRoot)
            : process.cwd(), typeof session.condensedSummary === 'string' ? session.condensedSummary : '', typeof session.createdAtUtc === 'string' && session.createdAtUtc.trim() ? session.createdAtUtc : now, typeof session.updatedAtUtc === 'string' && session.updatedAtUtc.trim() ? session.updatedAtUtc : now);
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
        position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            insertMessage.run(sessionId, typeof message.id === 'string' && message.id.trim() ? message.id.trim() : crypto.randomUUID(), typeof message.role === 'string' && message.role.trim() ? message.role.trim() : 'assistant', normalizeMessageKind(message.kind, message.role), typeof message.content === 'string' ? message.content : '', toNonNegativeInteger(message.inputTokensEstimate, estimateTokenCount(message.content)), toNonNegativeInteger(message.outputTokensEstimate, estimateTokenCount(message.content)), toNonNegativeInteger(message.thinkingTokens, 0), message.inputTokensEstimated === false ? 0 : 1, message.outputTokensEstimated === false ? 0 : 1, message.thinkingTokensEstimated === false ? 0 : 1, toNullableNonNegativeInteger(message.promptCacheTokens), toNullableNonNegativeInteger(message.promptEvalTokens), toNullableNonNegativeNumber(message.promptTokensPerSecond), toNullableNonNegativeNumber(message.generationTokensPerSecond), toNullableNonNegativeInteger(message.requestDurationMs), toNullableNonNegativeInteger(message.promptEvalDurationMs), toNullableNonNegativeInteger(message.generationDurationMs), typeof message.requestStartedAtUtc === 'string' && message.requestStartedAtUtc.trim() ? message.requestStartedAtUtc : null, typeof message.thinkingStartedAtUtc === 'string' && message.thinkingStartedAtUtc.trim() ? message.thinkingStartedAtUtc : null, typeof message.thinkingEndedAtUtc === 'string' && message.thinkingEndedAtUtc.trim() ? message.thinkingEndedAtUtc : null, typeof message.answerStartedAtUtc === 'string' && message.answerStartedAtUtc.trim() ? message.answerStartedAtUtc : null, typeof message.answerEndedAtUtc === 'string' && message.answerEndedAtUtc.trim() ? message.answerEndedAtUtc : null, toNullableNonNegativeInteger(message.speculativeAcceptedTokens), toNullableNonNegativeInteger(message.speculativeGeneratedTokens), toNullableNonNegativeInteger(message.associatedToolTokens), typeof message.thinkingContent === 'string' ? message.thinkingContent : null, typeof message.toolCallCommand === 'string' ? message.toolCallCommand : null, toNullableNonNegativeInteger(message.toolCallTurn), toNullableNonNegativeInteger(message.toolCallMaxTurns), toNullableNonNegativeInteger(message.toolCallExitCode), toNullableNonNegativeInteger(message.toolCallPromptTokenCount), typeof message.toolCallOutputSnippet === 'string' ? message.toolCallOutputSnippet : null, typeof message.toolCallOutput === 'string' ? message.toolCallOutput : null, typeof message.createdAtUtc === 'string' && message.createdAtUtc.trim() ? message.createdAtUtc : now, typeof message.sourceRunId === 'string' && message.sourceRunId.trim() ? message.sourceRunId : null, message.compressedIntoSummary === true ? 1 : 0, index);
        }
    })();
}
