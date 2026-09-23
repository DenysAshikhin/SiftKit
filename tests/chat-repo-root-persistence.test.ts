import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, requestSse, asObject } from './helpers/dashboard-http.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { ChatMessageQueueStore } from '../src/state/chat-message-queue.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';

async function createSession(baseUrl: string): Promise<string> {
  return String(asObject((await requestJson(`${baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'root' }) })).body.session).id);
}

for (const operation of ['repo-search', 'repo-agent'] as const) test(`a ${operation} run remembers the directory it ran in`, async (t) => {
  const harness = await startHarness(`siftkit-repo-root-${operation}-`, t);
  const repoRoot = createManagedTempDir('siftkit-repo-root-target-');
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const response = await requestSse(`${url}/${operation}/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'look around', repoRoot, ...(operation === 'repo-agent' ? { approval: 'off' } : {}), mockResponses: repoAgentFinishResponses('done'),
  }) });
  assert.equal(response.statusCode, 200);
  assert.equal(asObject((await requestJson(url)).body.session).planRepoRoot, path.resolve(repoRoot));
});

test('a rejected repo directory is not remembered', async (t) => {
  const harness = await startHarness('siftkit-repo-root-bad-', t);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const before = asObject((await requestJson(url)).body.session).planRepoRoot;
  const response = await requestSse(`${url}/repo-search/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'look', repoRoot: path.join(process.cwd(), 'no-such-dir-7f3a'), mockResponses: [{ content: 'x' }],
  }) });
  assert.equal(response.statusCode, 400);
  assert.equal(asObject((await requestJson(url)).body.session).planRepoRoot, before);
});

test('a repo run refused behind pending queued messages does not remember its directory', async (t) => {
  const harness = await startHarness('siftkit-repo-root-refused-', t);
  const repoRoot = createManagedTempDir('siftkit-repo-root-refused-target-');
  const sessionId = await createSession(harness.baseUrl);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const before = asObject((await requestJson(url)).body.session).planRepoRoot;
  new ChatMessageQueueStore(getRuntimeDatabase()).enqueue(sessionId, { id: randomUUID(), content: 'waiting', images: [], options: { operationKind: 'repo-search' } });
  const response = await requestJson(`${url}/repo-search/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'look', repoRoot, mockResponses: [{ content: 'x' }],
  }) });
  assert.equal(response.statusCode, 409);
  assert.equal(asObject((await requestJson(url)).body.session).planRepoRoot, before);
});
