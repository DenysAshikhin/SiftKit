import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { VaultChatTurn } from '../src/vault/note-writer/chat-writer.ts';
import type { VaultRetrieveResult } from '../src/vault/vault-retriever.ts';
import { getConfigPath } from '../src/config/index.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { startStatusServer } from '../src/status-server/index.ts';
import { getAddressInfo, requestJson, requestSse } from './helpers/dashboard-http.ts';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';

const CHAT_OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const CHAT_SUBMISSION_ID = '4f9c1f9a-0000-4000-8000-000000000001';

class RecordingAssistant {
  readonly enabled = true;
  readonly ownerId = 'own_test';
  readonly retrievedMessages: string[] = [];
  readonly ingestedTurns: VaultChatTurn[] = [];
  interactiveRequestCount = 0;

  async retrieveMemoryContext(userMessage: string): Promise<VaultRetrieveResult> {
    this.retrievedMessages.push(userMessage);
    return { renderedBlock: '## Relevant personal context\n\n### PowerShell\nYour shell.', noteIds: ['note_1'], tokenCount: 12 };
  }

  ingestChatTurn(turn: VaultChatTurn): void {
    this.ingestedTurns.push(turn);
  }

  onInteractiveRequest(): void {
    this.interactiveRequestCount += 1;
  }

  async drainJobs(): Promise<void> {}

  status() {
    return { available: true, enabled: true, ownerId: this.ownerId };
  }

  refreshConfig(): void {}
}

test('streaming dashboard chat retrieves and ingests opted-in assistant memory', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-stream-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultServerConfig();
  writeConfig(getConfigPath(), config);
  const assistant = new RecordingAssistant();
  const server = startStatusServer({ disableManagedEngineStartup: true, assistant });
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
          submissionId: CHAT_SUBMISSION_ID,
          webSearchOverride: 'off',
          availableModels: ['mock'],
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
    assert.equal(assistant.ingestedTurns[0]?.sessionTitle, 'Assistant memory stream');
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
