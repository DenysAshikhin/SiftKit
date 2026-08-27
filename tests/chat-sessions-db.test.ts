import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  saveChatSession,
  readChatSessions,
  readChatSessionFromPath,
  getChatSessionPath,
  deleteChatSession,
} from '../src/state/chat-sessions.js';
import type { ChatMessage, ChatSession } from '../src/state/chat-sessions.js';
import {
  appendChatMessagesWithUsage,
  buildChatHistoryMessages,
  buildCompactionSummaryRow,
  condenseChatSession,
} from '../src/status-server/chat.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { buildCompactionSummaryMessage } from '../src/repo-search/engine/transcript-compactor.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { JsonValueSchema } from '../src/lib/json-types.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset, mockOfflineSiftConfig } from './helpers/mock-config.js';

const SnapshotRowSchema = z.object({ model_preset_json: z.string() });

const COMPACTION_FIXTURE_TIMESTAMP = '2026-08-20T00:00:00.000Z';

function compactionMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: COMPACTION_FIXTURE_TIMESTAMP,
    sourceRunId: null,
    ...overrides,
  };
}

function saveCompactionSession(runtimeRoot: string, messages: ChatMessage[]): ChatSession {
  const session: ChatSession = {
    id: 'compaction-session',
    title: 'Compaction session',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }),
    thinkingEnabled: true,
    presetId: 'chat',
    mode: 'chat',
    planRepoRoot: runtimeRoot,
    createdAtUtc: COMPACTION_FIXTURE_TIMESTAMP,
    updatedAtUtc: COMPACTION_FIXTURE_TIMESTAMP,
    messages,
  };
  saveChatSession(runtimeRoot, session);
  return session;
}

function withTempRepo(fn: (repoRoot: string) => void): void {
  const tempRoot = createManagedTempDir('siftkit-chat-db-');
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);
    fn(tempRoot);
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function withTempRepoAsync(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = createManagedTempDir('siftkit-chat-db-');
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);
    await fn(tempRoot);
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('chat sessions are persisted in runtime sqlite instead of JSON files', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-db-test';
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'DB Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      thinkingEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [{
        id: 'm1',
        role: 'user',
        content: 'hello',
        inputTokensEstimate: 1,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        promptCacheTokens: null,
        promptEvalTokens: null,
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
        requestDurationMs: null,
        promptEvalDurationMs: null,
        generationDurationMs: null,
        speculativeAcceptedTokens: null,
        speculativeGeneratedTokens: null,
        createdAtUtc: new Date().toISOString(),
        sourceRunId: 'run-1',
        groundingStatus: 'fetched',
      }],
    });

    const sessions = readChatSessions(runtimeRoot);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, sessionId);
    assert.equal(sessions[0]?.modelPresetId, 'preset-a');
    assert.equal(sessions[0]?.presetId, 'chat');
    assert.equal(sessions[0]?.messages?.length, 1);
    assert.equal(sessions[0]?.messages?.[0]?.promptCacheTokens, null);
    assert.equal(sessions[0]?.messages?.[0]?.promptEvalTokens, null);
    assert.equal(sessions[0]?.messages?.[0]?.promptTokensPerSecond, null);
    assert.equal(sessions[0]?.messages?.[0]?.generationTokensPerSecond, null);
    assert.equal(sessions[0]?.messages?.[0]?.requestDurationMs, null);
    assert.equal(sessions[0]?.messages?.[0]?.promptEvalDurationMs, null);
    assert.equal(sessions[0]?.messages?.[0]?.generationDurationMs, null);
    assert.equal(sessions[0]?.messages?.[0]?.speculativeAcceptedTokens, null);
    assert.equal(sessions[0]?.messages?.[0]?.speculativeGeneratedTokens, null);
    assert.equal(sessions[0]?.messages?.[0]?.sourceRunId, 'run-1');
    assert.equal(sessions[0]?.messages?.[0]?.groundingStatus, 'fetched');

    const loadedFromPath = readChatSessionFromPath(sessionPath);
    assert.equal(loadedFromPath?.id, sessionId);
    assert.equal(loadedFromPath?.messages?.[0]?.promptEvalDurationMs, null);
    assert.equal(loadedFromPath?.messages?.[0]?.generationDurationMs, null);
    assert.equal(loadedFromPath?.messages?.[0]?.groundingStatus, 'fetched');
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'runtime.sqlite')), true);
    assert.equal(fs.existsSync(sessionPath), false);
  });
});

test('v49 normalizes persisted image-only user token metadata', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
    saveChatSession(runtimeRoot, {
      id: 'image-only-session',
      title: 'Image only',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ id: 'preset-a' }),
      thinkingEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: '2026-08-20T00:00:00.000Z',
      updatedAtUtc: '2026-08-20T00:00:00.000Z',
      messages: [{
        id: 'image-message',
        role: 'user',
        kind: 'user_text',
        content: '',
        inputTokensEstimate: 1,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        inputTokensEstimated: true,
        outputTokensEstimated: false,
        thinkingTokensEstimated: false,
        createdAtUtc: '2026-08-20T00:00:00.000Z',
        images: ['data:image/png;base64,AA=='],
        imageMeta: [{
          width: 32,
          height: 32,
          originalWidth: 32,
          originalHeight: 32,
          mime: 'image/png',
          byteLength: 64,
          tokenEstimate: 1,
          resized: false,
          caption: null,
        }],
      }],
    });
    getRuntimeDatabase(databasePath)
      .prepare('UPDATE runtime_schema SET version = 48 WHERE id = 1')
      .run();
    closeRuntimeDatabase();

    const migratedMessage = readChatSessions(runtimeRoot)[0]?.messages?.[0];

    assert.equal(migratedMessage?.inputTokensEstimate, 0);
    assert.equal(migratedMessage?.inputTokensEstimated, false);
    const row = z.object({
      input_tokens_estimate: z.number(),
      input_tokens_estimated: z.number(),
    }).parse(getRuntimeDatabase(databasePath).prepare(
      "SELECT input_tokens_estimate, input_tokens_estimated FROM chat_messages WHERE id = 'image-message'",
    ).get());
    assert.deepEqual(row, { input_tokens_estimate: 0, input_tokens_estimated: 0 });
  });
});

test('chat sessions round-trip the full model preset snapshot', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-preset-snapshot';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Snapshot Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({
        id: 'preset-a',
        Model: 'snap-model',
        NumCtx: 12_345,
        Temperature: 0.5,
        MaxTokens: 777,
        Reasoning: 'on',
      }),
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.equal(loaded?.modelPreset.id, 'preset-a');
    assert.equal(loaded?.modelPreset.Model, 'snap-model');
    assert.equal(loaded?.modelPreset.NumCtx, 12_345);
    assert.equal(loaded?.modelPreset.Temperature, 0.5);
    assert.equal(loaded?.modelPreset.MaxTokens, 777);
    assert.equal(loaded?.modelPreset.Reasoning, 'on');
  });
});

test('reading a chat session row without a preset snapshot fails loudly', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-no-snapshot';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Legacy Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });
    getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'))
      .prepare('UPDATE chat_sessions SET model_preset_json = NULL WHERE id = ?')
      .run(sessionId);

    assert.throws(
      () => readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId)),
      /session-no-snapshot has no model preset snapshot/u,
    );
  });
});

/**
 * A session snapshot is stored preset JSON, exactly like the config's preset list, so it
 * must go through the same normalization: a field added to the preset contract after the
 * row was written resolves to the current default instead of failing the whole read.
 */
test('a preset snapshot written before a field existed loads with that field defaulted', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-pre-field-snapshot';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Pre-field Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ id: 'preset-a', Model: 'model-a', NumCtx: 4096 }),
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });
    const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
    const stored = SnapshotRowSchema.parse(
      database.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(sessionId),
    );
    const snapshot = z.record(z.string(), JsonValueSchema).parse(JSON.parse(stored.model_preset_json));
    delete snapshot.SpeculativeDynamic;
    database
      .prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), sessionId);

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.equal(loaded?.modelPreset.SpeculativeDynamic, mockModelPreset().SpeculativeDynamic);
    assert.equal(loaded?.modelPreset.id, 'preset-a');
    assert.equal(loaded?.modelPreset.Model, 'model-a');
    assert.equal(readChatSessions(runtimeRoot).length, 1);
  });
});

test('a preset snapshot carrying a field this repo removed still fails loudly', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-unsupported-field';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Unsupported Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ id: 'preset-a', Model: 'model-a', NumCtx: 4096 }),
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });
    const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
    const stored = SnapshotRowSchema.parse(
      database.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(sessionId),
    );
    const snapshot = z.record(z.string(), JsonValueSchema).parse(JSON.parse(stored.model_preset_json));
    snapshot.PenaltyRange = 4096;
    database
      .prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), sessionId);

    assert.throws(
      () => readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId)),
      /Unsupported model preset field PenaltyRange/u,
    );
  });
});

test('chat sessions persist webSearchEnabled', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-web-search';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Web Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      thinkingEnabled: true,
      webSearchEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.ok(loaded);
    assert.equal(loaded.webSearchEnabled, true);

    saveChatSession(runtimeRoot, { ...loaded, webSearchEnabled: false });
    const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.equal(reloaded?.webSearchEnabled, false);
  });
});

test('chat timeline bubbles persist typed tool payload fields', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-timeline-bubbles';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Timeline Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      thinkingEnabled: true,
      presetId: 'repo-search',
      mode: 'repo-search',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [{
        id: 'tool-1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'rg -n "timeline" .',
        inputTokensEstimate: 0,
        outputTokensEstimate: 9,
        thinkingTokens: 0,
        promptCacheTokens: null,
        promptEvalTokens: 44,
        toolCallCommand: 'rg -n "timeline" .',
        toolCallActivityKind: 'search',
        toolCallTurn: 2,
        toolCallMaxTurns: 5,
        toolCallExitCode: 0,
        toolCallPromptTokenCount: 44,
        toolCallOutputSnippet: 'src/chat.ts:1:timeline',
        toolCallOutput: 'src/chat.ts:1:timeline\nsrc/ui.tsx:2:bubble',
        createdAtUtc: new Date().toISOString(),
        sourceRunId: 'run-tool',
      }],
    });

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    const message = loaded?.messages?.[0];
    assert.equal(message?.kind, 'assistant_tool_call');
    assert.equal(message?.toolCallCommand, 'rg -n "timeline" .');
    assert.equal(message?.toolCallActivityKind, 'search');
    assert.equal(message?.toolCallTurn, 2);
    assert.equal(message?.toolCallMaxTurns, 5);
    assert.equal(message?.toolCallExitCode, 0);
    assert.equal(message?.toolCallPromptTokenCount, 44);
    assert.equal(message?.toolCallOutputSnippet, 'src/chat.ts:1:timeline');
    assert.equal(message?.toolCallOutput, 'src/chat.ts:1:timeline\nsrc/ui.tsx:2:bubble');
  });
});

test('chat session persistence keeps typed tool and timing fields', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session: ChatSession = {
      id: 'typed-session',
      title: 'Typed Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      thinkingEnabled: true,
      webSearchEnabled: false,
      presetId: 'repo-search',
      mode: 'repo-search',
      planRepoRoot: runtimeRoot,
      createdAtUtc: '2026-01-01T00:00:00.000Z',
      updatedAtUtc: '2026-01-01T00:00:00.000Z',
      messages: [{
        id: 'm1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'rg -n Dict src',
        inputTokensEstimate: 3,
        outputTokensEstimate: 5,
        thinkingTokens: 7,
        inputTokensEstimated: false,
        outputTokensEstimated: false,
        thinkingTokensEstimated: false,
        promptCacheTokens: 1,
        promptEvalTokens: 2,
        promptTokensPerSecond: 10,
        generationTokensPerSecond: 20,
        requestDurationMs: 30,
        promptEvalDurationMs: 40,
        generationDurationMs: 50,
        requestStartedAtUtc: '2026-01-01T00:00:01.000Z',
        thinkingStartedAtUtc: '2026-01-01T00:00:02.000Z',
        thinkingEndedAtUtc: '2026-01-01T00:00:03.000Z',
        answerStartedAtUtc: '2026-01-01T00:00:04.000Z',
        answerEndedAtUtc: '2026-01-01T00:00:05.000Z',
        speculativeAcceptedTokens: 6,
        speculativeGeneratedTokens: 8,
        associatedToolTokens: 9,
        thinkingContent: 'thinking',
        toolCallCommand: 'rg -n Dict src',
        toolCallActivityKind: 'search',
        toolCallTurn: 1,
        toolCallMaxTurns: 2,
        toolCallExitCode: 0,
        toolCallPromptTokenCount: 11,
        toolCallOutputSnippet: 'snippet',
        toolCallOutput: 'full output',
        createdAtUtc: '2026-01-01T00:00:06.000Z',
        sourceRunId: 'run-1',
        compressedIntoSummary: false,
        groundingStatus: 'fetched',
      }],
    };

    saveChatSession(runtimeRoot, session);

    const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, 'typed-session'));
    assert.equal(reloaded?.messages?.[0]?.kind, 'assistant_tool_call');
    assert.equal(reloaded?.messages?.[0]?.toolCallCommand, 'rg -n Dict src');
    assert.equal(reloaded?.messages?.[0]?.toolCallActivityKind, 'search');
    assert.equal(reloaded?.messages?.[0]?.groundingStatus, 'fetched');
    assert.equal(reloaded?.messages?.[0]?.promptEvalDurationMs, 40);
    assert.equal(reloaded?.messages?.[0]?.generationTokensPerSecond, 20);
  });
});

test('deleteChatSession removes DB rows and reports existence correctly', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-delete-test';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Delete Me',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: null, NumCtx: 1024 }),
      presetId: 'chat',
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });

    assert.equal(deleteChatSession(runtimeRoot, sessionId), true);
    assert.equal(deleteChatSession(runtimeRoot, sessionId), false);
    assert.equal(readChatSessions(runtimeRoot).length, 0);
  });
});

test('saveChatSession rejects a missing preset id instead of deriving it from mode', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');

    assert.throws(
      () => saveChatSession(runtimeRoot, {
        id: 'missing-preset',
        title: 'Missing preset',
        modelPresetId: 'preset-a',
        modelPreset: mockModelPreset({ Model: null, NumCtx: 1024 }),
        mode: 'plan',
        createdAtUtc: new Date().toISOString(),
        updatedAtUtc: new Date().toISOString(),
        messages: [],
      }),
      /Chat session presetId is required\./u,
    );
  });
});

test('chat messages round-trip their image data URIs', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-images';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Image Session',
      modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
      thinkingEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [{
        id: 'user-1',
        role: 'user',
        kind: 'user_text',
        content: 'what is this?',
        images: ['data:image/png;base64,AAAA'],
        inputTokensEstimate: 4,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        promptCacheTokens: null,
        promptEvalTokens: null,
        createdAtUtc: new Date().toISOString(),
        sourceRunId: null,
      }],
    });

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.deepEqual(loaded?.messages?.[0]?.images, ['data:image/png;base64,AAAA']);
  });
});

test('a compacted turn persists a summary row and flags everything before it', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'first question' }),
      compactionMessage({ id: 'a0', kind: 'assistant_answer', content: 'first answer' }),
    ]);

    const updated = appendChatMessagesWithUsage(
      runtimeRoot,
      session,
      'second question',
      'second answer',
      {},
      { turns: [], compactionSummary: 'SUMMARY OF THE FIRST EXCHANGE' },
    );

    const kinds = updated.messages.map((message) => message.kind);
    assert.deepEqual(kinds, ['user_text', 'assistant_answer', 'compaction_summary', 'user_text', 'assistant_answer']);
    const flags = updated.messages.map((message) => message.compressedIntoSummary === true);
    assert.deepEqual(flags, [true, true, false, false, false]);
    const summaryRow = updated.messages[2];
    assert.equal(summaryRow.role, 'assistant');
    assert.equal(summaryRow.content, 'SUMMARY OF THE FIRST EXCHANGE');

    const reread = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
    assert.deepEqual((reread?.messages ?? []).map((message) => message.kind), kinds);
    assert.deepEqual((reread?.messages ?? []).map((message) => message.compressedIntoSummary === true), flags);
  });
});

test('a turn without compaction leaves the earlier messages in context', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'first question' }),
      compactionMessage({ id: 'a0', kind: 'assistant_answer', content: 'first answer' }),
    ]);

    const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'second question', 'second answer', {}, { turns: [] });

    assert.equal(updated.messages.some((message) => message.kind === 'compaction_summary'), false);
    assert.equal(updated.messages.every((message) => message.compressedIntoSummary !== true), true);
  });
});

test('a second compaction supersedes the first summary row', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'first question' }),
      compactionMessage({ id: 's0', kind: 'compaction_summary', content: 'FIRST SUMMARY' }),
      compactionMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'second question' }),
    ]);

    const updated = appendChatMessagesWithUsage(
      runtimeRoot,
      session,
      'third question',
      'third answer',
      {},
      { turns: [], compactionSummary: 'SECOND SUMMARY' },
    );

    const summaryRows = updated.messages.filter((message) => message.kind === 'compaction_summary');
    assert.deepEqual(summaryRows.map((message) => message.content), ['FIRST SUMMARY', 'SECOND SUMMARY']);
    assert.equal(summaryRows[0].compressedIntoSummary, true);
    assert.equal(summaryRows[1].compressedIntoSummary, false);
    const activeSummaries = updated.messages.filter(
      (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
    );
    assert.equal(activeSummaries.length, 1);
    assert.equal(activeSummaries[0]?.content, 'SECOND SUMMARY');
    const latestSummaryIndex = updated.messages.findLastIndex(
      (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
    );
    assert.ok(latestSummaryIndex >= 0);
    assert.equal(
      updated.messages.slice(0, latestSummaryIndex).every((message) => message.compressedIntoSummary === true),
      true,
    );
  });
});

test('buildChatHistoryMessages replays the compacted shape without the dropped turns', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'first question', compressedIntoSummary: true }),
      compactionMessage({ id: 'a0', kind: 'assistant_answer', content: 'first answer', compressedIntoSummary: true }),
      compactionMessage({ id: 's0', kind: 'compaction_summary', content: 'SUMMARY OF THE FIRST EXCHANGE' }),
      compactionMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'second question' }),
      compactionMessage({ id: 'a1', kind: 'assistant_answer', content: 'second answer' }),
    ]);

    const history = buildChatHistoryMessages(mockOfflineSiftConfig(), session);

    assert.deepEqual(history.map((message) => message.role), ['assistant', 'user', 'assistant']);
    assert.match(String(history[0].content), /^\[CONTEXT COMPACTED/u);
    assert.match(String(history[0].content), /SUMMARY OF THE FIRST EXCHANGE/u);
    assert.equal(history.some((message) => String(message.content).includes('first answer')), false);
  });
});

test('chat replay reuses the engine compaction message, so both paths frame the summary identically', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'dropped question', compressedIntoSummary: true }),
      compactionMessage({ id: 's0', kind: 'compaction_summary', content: 'SUMMARY TEXT' }),
      compactionMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'live question' }),
    ]);

    const history = buildChatHistoryMessages(mockOfflineSiftConfig(), session);

    assert.deepEqual(history[0], buildCompactionSummaryMessage('SUMMARY TEXT'));
  });
});

test('manual condense reports the summarizer retry through the logger it is given', async () => {
  await withTempRepoAsync(async (repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'a question' }),
      compactionMessage({ id: 'a0', kind: 'assistant_answer', content: 'an answer' }),
    ]);
    const logged: Array<Record<string, JsonSerializable>> = [];

    const updated = await condenseChatSession(
      runtimeRoot,
      mockOfflineSiftConfig(),
      session,
      [{ content: '' }, { content: 'RECOVERED SUMMARY' }],
      { path: 'memory', write: (event) => { logged.push(event); } },
    );

    const summaryRow = updated.messages.find((message) => message.kind === 'compaction_summary');
    assert.equal(summaryRow?.content, 'RECOVERED SUMMARY');
    const retry = logged.find((event) => event.kind === 'turn_compaction_summary_retry');
    assert.ok(retry);
    // Condense is not a loop turn, so it must not claim one.
    assert.equal(retry.turn, null);
  });
});

test('both persistence paths write the same compaction summary row shape', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const session = saveCompactionSession(runtimeRoot, [
      compactionMessage({ id: 'u0', role: 'user', kind: 'user_text', content: 'a question' }),
    ]);

    const updated = appendChatMessagesWithUsage(
      runtimeRoot,
      session,
      'next question',
      'next answer',
      {},
      { turns: [], compactionSummary: 'SUMMARY TEXT' },
    );

    const summaryRow = updated.messages.find((message) => message.kind === 'compaction_summary');
    assert.ok(summaryRow);
    const canonical = buildCompactionSummaryRow('SUMMARY TEXT', summaryRow.createdAtUtc);
    assert.deepEqual({ ...summaryRow, id: '' }, { ...canonical, id: '' });
  });
});
