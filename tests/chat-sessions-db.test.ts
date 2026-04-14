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
        createdAtUtc: new Date().toISOString(),
        sourceRunId: null,
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

    const loadedFromPath = readChatSessionFromPath(sessionPath);
    assert.equal(loadedFromPath?.id, sessionId);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'runtime.sqlite')), true);
    assert.equal(fs.existsSync(sessionPath), false);
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
