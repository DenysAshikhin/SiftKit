import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { ChatTurnInput } from '../src/assistant/ingestion/conversation-ingestor.js';
import type { RetrieveResult } from '../src/assistant/retrieval/memory-retriever.js';
import { getConfigPath } from '../src/config/index.js';
import { writeConfig, getDefaultConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { getAddressInfo, requestJson, requestSse } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const CHAT_OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

class RecordingAssistant {
  readonly enabled = true;
  readonly ownerId = 'own_test';
  readonly retrievedMessages: string[] = [];
  readonly ingestedTurns: ChatTurnInput[] = [];
  interactiveRequestCount = 0;

  async retrieveMemoryContext(userMessage: string): Promise<RetrieveResult> {
    this.retrievedMessages.push(userMessage);
    return {
      renderedBlock: '## Relevant personal context\n\n- Uses PowerShell. [M:ast_1]',
      assertionIds: ['ast_1'],
      projectionIds: [],
      tokenCount: 12,
    };
  }

  ingestChatTurn(input: ChatTurnInput): void {
    this.ingestedTurns.push(input);
  }

  onInteractiveRequest(): void {
    this.interactiveRequestCount += 1;
  }

  async drainJobs(): Promise<void> {}

  status() {
    return {
      available: true, enabled: true, ownerId: this.ownerId,
      pendingQuestionCount: 0, pendingValidationCount: 0,
    };
  }

  refreshConfig(): void {}
}

test('streaming dashboard chat retrieves and ingests opted-in assistant memory', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-stream-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  writeConfig(getConfigPath(), config);
  const assistant = new RecordingAssistant();
  const server = startStatusServer({ disableManagedLlamaStartup: true, assistant });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Assistant memory stream' }),
    });
    const session = created.body?.session;
    if (typeof session !== 'object' || session === null || Array.isArray(session)) {
      throw new Error('Expected a created chat session.');
    }
    const sessionId = typeof session.id === 'string' ? session.id : '';
    const response = await requestSse(
      `${baseUrl}/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/stream`,
      {
        method: 'POST',
        timeoutMs: 5_000,
        body: JSON.stringify({
          content: 'Which shell do I use?',
          operationId: CHAT_OPERATION_ID,
          webSearchOverride: 'off',
          availableModels: ['mock'],
          model: 'mock',
          mockResponses: [{ content: "PowerShell." }],
        }),
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.events.some((event) => event.event === 'error'), false);
    assert.deepEqual(assistant.retrievedMessages, ['Which shell do I use?']);
    assert.equal(assistant.interactiveRequestCount, 1);
    assert.equal(assistant.ingestedTurns.length, 1);
    assert.equal(assistant.ingestedTurns[0]?.userText, 'Which shell do I use?');
    assert.equal(assistant.ingestedTurns[0]?.assistantText, 'PowerShell.');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
