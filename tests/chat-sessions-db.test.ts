import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveChatSession,
  readChatSessions,
  readChatSessionFromPath,
  getChatSessionPath,
  deleteChatSession,
} from '../src/state/chat-sessions.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';

function withTempRepo(fn: (repoRoot: string) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-db-'));
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

test('chat sessions are persisted in runtime sqlite instead of JSON files', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-db-test';
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'DB Session',
      modelPresetId: 'preset-a',
      model: 'model-a',
      contextWindowTokens: 4096,
      thinkingEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      condensedSummary: '',
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

test('chat sessions persist webSearchEnabled', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-web-search';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Web Session',
      modelPresetId: 'preset-a',
      model: 'model-a',
      contextWindowTokens: 4096,
      thinkingEnabled: true,
      webSearchEnabled: true,
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: repoRoot,
      condensedSummary: '',
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
      model: 'model-a',
      contextWindowTokens: 4096,
      thinkingEnabled: true,
      presetId: 'repo-search',
      mode: 'repo-search',
      planRepoRoot: repoRoot,
      condensedSummary: '',
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
      model: 'model-a',
      contextWindowTokens: 4096,
      thinkingEnabled: true,
      webSearchEnabled: false,
      presetId: 'repo-search',
      mode: 'repo-search',
      planRepoRoot: runtimeRoot,
      condensedSummary: '',
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
      model: null,
      contextWindowTokens: 1024,
      presetId: 'chat',
      condensedSummary: '',
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });

    assert.equal(deleteChatSession(runtimeRoot, sessionId), true);
    assert.equal(deleteChatSession(runtimeRoot, sessionId), false);
    assert.equal(readChatSessions(runtimeRoot).length, 0);
  });
});
