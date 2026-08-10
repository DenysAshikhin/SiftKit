import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatSystemContent } from '../src/status-server/chat.js';
import { ChatMemorySeam } from '../src/status-server/chat-memory-seam.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import type { ChatTurnInput } from '../src/assistant/ingestion/conversation-ingestor.js';
import type { RetrieveResult } from '../src/assistant/retrieval/memory-retriever.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';

const basePreset = PresetCatalog.createDefault().requireById('summary');
const optedIn = { ...basePreset, id: 'in', assistantMemory: true };
const optedOut = { ...basePreset, id: 'out', assistantMemory: false };
const SESSION: ChatSession = {
  id: 'chat_1',
  modelPresetId: 'default',
  modelPreset: mockModelPreset({ id: 'default' }),
};

class StubAssistant {
  enabled = true;
  readonly ownerId = 'own_local';
  readonly ingested: string[] = [];
  retrieveCount = 0;

  async retrieveMemoryContext(_userMessage: string): Promise<RetrieveResult> {
    this.retrieveCount += 1;
    return {
      renderedBlock: '## Relevant personal context\n\n- Uses PowerShell. [M:ast_1]',
      assertionIds: ['ast_1'],
      projectionIds: [],
      tokenCount: 12,
    };
  }

  ingestChatTurn(input: ChatTurnInput): void {
    this.ingested.push(input.userText);
  }
}

test('the system prompt is byte-identical when no memory context is supplied', () => {
  const config = mockSiftConfig({});
  assert.equal(
    buildChatSystemContent(config, SESSION),
    buildChatSystemContent(config, SESSION, {}),
  );
});

test('a supplied memory context is appended to the system prompt', () => {
  const config = mockSiftConfig({});
  const base = buildChatSystemContent(config, SESSION);
  const withMemory = buildChatSystemContent(config, SESSION, {
    memoryContext: '## Relevant personal context\n\n- Uses PowerShell. [M:ast_1]',
  });
  assert.ok(withMemory.startsWith(base));
  assert.ok(withMemory.includes('[M:ast_1]'));
});

test('an opted-out preset retrieves nothing and injects zero memory bytes', async () => {
  const assistant = new StubAssistant();
  const seam = new ChatMemorySeam(assistant);
  assert.equal(await seam.buildMemoryContext(optedOut, 'what shell do I use?'), '');
  assert.equal(assistant.retrieveCount, 0, 'the retriever must not even be called');
});

test('an opted-in preset injects the retrieved block', async () => {
  const assistant = new StubAssistant();
  const seam = new ChatMemorySeam(assistant);
  const block = await seam.buildMemoryContext(optedIn, 'what shell do I use?');
  assert.ok(block.includes('[M:ast_1]'));
  assert.equal(assistant.retrieveCount, 1);
});

test('no assistant means no retrieval and no ingestion, without throwing', async () => {
  const seam = new ChatMemorySeam(null);
  assert.equal(await seam.buildMemoryContext(optedIn, 'anything'), '');
  assert.doesNotThrow(() => {
    seam.ingestTurn(optedIn, {
      sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'hi', assistantMessageId: 'm2', assistantText: 'hello',
    });
  });
});

test('an opted-out preset is never ingested', () => {
  const assistant = new StubAssistant();
  const seam = new ChatMemorySeam(assistant);
  seam.ingestTurn(optedOut, {
    sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
    userMessageId: 'm1', userText: 'hi', assistantMessageId: 'm2', assistantText: 'hello',
  });
  assert.deepEqual(assistant.ingested, []);
});

test('a disabled assistant is never called even when the preset opted in', async () => {
  const assistant = new StubAssistant();
  assistant.enabled = false;
  const seam = new ChatMemorySeam(assistant);
  assert.equal(await seam.buildMemoryContext(optedIn, 'PowerShell'), '');
  seam.ingestTurn(optedIn, {
    sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
    userMessageId: 'm1', userText: 'hi', assistantMessageId: 'm2', assistantText: 'hello',
  });
  assert.equal(assistant.retrieveCount, 0);
  assert.deepEqual(assistant.ingested, []);
});

test('a retrieval failure degrades to an empty block', async () => {
  class ThrowingAssistant extends StubAssistant {
    async retrieveMemoryContext(): Promise<RetrieveResult> {
      throw new Error('graph exploded');
    }
  }
  const seam = new ChatMemorySeam(new ThrowingAssistant());
  assert.equal(await seam.buildMemoryContext(optedIn, 'anything'), '');
});
