import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveChatSession,
  readChatSessions,
  readChatSessionFromPath,
  getChatSessionPath,
  deleteChatSession,
} from '../dist/state/chat-sessions.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

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
      hiddenToolContexts: [{
        id: 'h1',
        content: 'context',
        tokenEstimate: 1,
        sourceMessageId: 'm1',
        createdAtUtc: new Date().toISOString(),
      }],
    });

    const sessions = readChatSessions(runtimeRoot);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, sessionId);
    assert.equal(sessions[0]?.presetId, 'chat');
    assert.equal(sessions[0]?.messages?.length, 1);
    assert.equal(sessions[0]?.hiddenToolContexts?.length, 1);
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
      hiddenToolContexts: [],
    });

    const loaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    assert.equal(loaded?.webSearchEnabled, true);

    saveChatSession(runtimeRoot, { ...loaded, webSearchEnabled: false } as Parameters<typeof saveChatSession>[1]);
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
      hiddenToolContexts: [{
        id: 'h-tool',
        content: 'Command: rg -n "timeline" .',
        tokenEstimate: 7,
        sourceMessageId: 'tool-1',
        createdAtUtc: new Date().toISOString(),
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
    assert.equal(loaded?.hiddenToolContexts?.[0]?.sourceMessageId, 'tool-1');
  });
});

test('deleteChatSession removes DB rows and reports existence correctly', () => {
  withTempRepo((repoRoot) => {
    const runtimeRoot = path.join(repoRoot, '.siftkit');
    const sessionId = 'session-delete-test';

    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Delete Me',
      model: null,
      contextWindowTokens: 1024,
      presetId: 'chat',
      condensedSummary: '',
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
      hiddenToolContexts: [],
    });

    assert.equal(deleteChatSession(runtimeRoot, sessionId), true);
    assert.equal(deleteChatSession(runtimeRoot, sessionId), false);
    assert.equal(readChatSessions(runtimeRoot).length, 0);
  });
});
