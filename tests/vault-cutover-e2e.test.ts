import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  PendingCapturesResponseSchema, VaultNoteDetailSchema, VaultNoteListResponseSchema, VaultResolveResponseSchema,
} from '@siftkit/contracts';
import type { AssistantService } from '../src/assistant/assistant-service.ts';
import type {
  AssistantInferenceClient, AssistantInferenceRequest, AssistantInferenceResult,
} from '../src/assistant/inference/client.ts';
import type { AssistantInferenceRole } from '../src/assistant/inference/roles.ts';
import { getConfigPath } from '../src/config/index.ts';
import { z } from '../src/lib/zod.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { startStatusServer } from '../src/status-server/index.ts';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.ts';
import { CHATS_FOLDER } from '../src/vault/vault-layout.ts';
import { buildAssistantService } from './helpers/assistant-fixture.ts';
import { closeHttpServer, getAddressInfo, requestJson, requestSse } from './helpers/dashboard-http.ts';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';
import { StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';

process.env.TZ = 'UTC';

const BootstrapResponseSchema = z.object({ token: z.string().min(1) });
const SessionResponseSchema = z.object({ session: z.object({ id: z.string() }) });

/** Answers each vault writer by role, so follow-up order cannot desynchronise the fixture. */
class RoleInference implements AssistantInferenceClient {
  readonly roles: AssistantInferenceRole[] = [];

  async complete(request: AssistantInferenceRequest): Promise<AssistantInferenceResult> {
    this.roles.push(request.role);
    const text = request.role === 'vault_capture_writer'
      ? JSON.stringify({ operations: [
        { op: 'create_note', title: 'Ripgrep', type: 'software', lead: 'Ripgrep is a fast code search tool.' },
        { op: 'add_facts', note: 'Ripgrep', label: 'Used for', values: ['code search'] },
        { op: 'learned', note: 'Ripgrep', label: 'Used for', value: 'code search' },
      ] })
      : request.role === 'vault_tidy'
        ? JSON.stringify({ lead: 'Ripgrep is the code search tool the user runs.' })
        : JSON.stringify({ operations: [] });
    return { text, backendId: 'fake', modelId: 'fake-model' };
  }
}

interface CutoverHarness {
  readonly service: AssistantService;
  readonly inference: RoleInference;
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
}

/** A real status server over a real vault-backed service whose only stub is the model. */
async function withCutoverServer(body: (harness: CutoverHarness) => Promise<void>): Promise<void> {
  const tempRoot = createManagedTempDir('siftkit-vault-cutover-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const envBackup = configureDashboardTestEnv(
    tempRoot, path.join(tempRoot, '.siftkit', 'status', 'inference.txt'), path.join(tempRoot, '.siftkit', 'config.json'),
  );
  writeConfig(getConfigPath(), getDefaultServerConfig());
  const inference = new RoleInference();
  const service = buildAssistantService({ inference, imageCapability: new StubImageCapability(true), screenshotsEnabled: true });
  const server = startStatusServer({ disableManagedEngineStartup: true, assistant: service });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const { token } = BootstrapResponseSchema.parse((await requestJson(`${baseUrl}/assistant/auth/bootstrap`)).body);
    await body({ service, inference, baseUrl, headers: { Authorization: `Bearer ${token}` } });
  } finally {
    await closeHttpServer(server);
    closeAllRuntimeDatabases();
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
}

/** Drains until follow-ups stop appearing; a bounded loop so a runaway follow-up fails the test. */
async function drainAll(service: AssistantService): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    if (service.graph.jobs.listByStatus(service.ownerId, 'queued').length === 0) return;
    await service.drainJobs();
  }
  assert.fail('background jobs never settled');
}

async function resolveId(harness: CutoverHarness, title: string): Promise<string | null> {
  const response = await requestJson(`${harness.baseUrl}/assistant/vault/resolve?title=${encodeURIComponent(title)}`, { headers: harness.headers });
  return VaultResolveResponseSchema.parse(response.body).id;
}

async function noteBody(harness: CutoverHarness, id: string): Promise<string> {
  const response = await requestJson(`${harness.baseUrl}/assistant/vault/notes/${id}`, { headers: harness.headers });
  return VaultNoteDetailSchema.parse(response.body).note.body;
}

const postCapture = (harness: CutoverHarness, body: object, headers = harness.headers) => requestJson(
  `${harness.baseUrl}/assistant/ingest/capture`, { method: 'POST', headers, body: JSON.stringify(body) },
);
const postSuppression = (harness: CutoverHarness) => requestJson(`${harness.baseUrl}/assistant/ingest/suppression`, {
  method: 'POST', headers: harness.headers,
  body: JSON.stringify({ schemaVersion: 1, occurredAtUtc: '2026-08-05T09:00:00.000Z', ruleId: 'private_mode' }),
});

test('a posted capture drains into its capture note, the entity it names and the daily note', async () => {
  await withCutoverServer(async (harness) => {
    const accepted = await postCapture(harness, vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:30.000Z' }));
    assert.equal(accepted.statusCode, 200);
    const pending = PendingCapturesResponseSchema.parse(
      (await requestJson(`${harness.baseUrl}/assistant/captures/pending`, { headers: harness.headers })).body,
    ).captures;
    assert.deepEqual(pending.map((capture) => capture.state), ['queued']);
    const captureNoteId = pending[0]?.noteId ?? '';

    await drainAll(harness.service);

    assert.deepEqual(harness.inference.roles, ['vault_capture_writer', 'vault_tidy']);
    assert.match(await noteBody(harness, captureNoteId), /\[\[Ripgrep\]\]/u, 'the capture note links what it taught');
    const ripgrepId = await resolveId(harness, 'Ripgrep');
    assert.ok(ripgrepId);
    assert.match(await noteBody(harness, ripgrepId), /^Ripgrep is the code search tool the user runs\.\n\n\*\*Used for\*\* code search/u);
    const dailyId = await resolveId(harness, '2026-08-05');
    assert.ok(dailyId);
    assert.match(await noteBody(harness, dailyId), /\[\[Ripgrep\]\]/u);
    const queue = PendingCapturesResponseSchema.parse(
      (await requestJson(`${harness.baseUrl}/assistant/captures/pending`, { headers: harness.headers })).body,
    );
    assert.deepEqual(queue.captures, []);

    const context = await harness.service.retrieveMemoryContext('Which tool do I use for Ripgrep searches?');
    assert.match(context.renderedBlock, /### Ripgrep\nRipgrep is the code search tool the user runs\./u);
    assert.ok(context.noteIds.includes(ripgrepId));
  });
});

test('a streamed dashboard chat turn drains into a chat note', async () => {
  await withCutoverServer(async (harness) => {
    const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, {
      method: 'POST', body: JSON.stringify({ title: 'Shell setup' }),
    });
    const sessionId = SessionResponseSchema.parse(created.body).session.id;
    const streamed = await requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
      method: 'POST',
      timeoutMs: 5_000,
      body: JSON.stringify({
        content: 'I switched to PowerShell 7.',
        operationId: '5a1c2b3d-0000-4000-8000-000000000000',
        submissionId: '5a1c2b3d-0000-4000-8000-000000000001',
        webSearchOverride: 'off',
        availableModels: ['mock'],
        mockResponses: [{ content: 'Noted.' }],
      }),
    });
    assert.equal(streamed.statusCode, 200);

    await drainAll(harness.service);

    const listed = await requestJson(`${harness.baseUrl}/assistant/vault/notes?folder=${CHATS_FOLDER}`, { headers: harness.headers });
    const chats = VaultNoteListResponseSchema.parse(listed.body).notes;
    assert.equal(chats.length, 1);
    assert.match(chats[0]?.title ?? '', /^Chat \d{4}-\d{2}-\d{2} · Shell setup$/u);
    const transcript = await noteBody(harness, chats[0]?.id ?? '');
    assert.match(transcript, /I switched to PowerShell 7\./u);
    assert.match(transcript, /Noted\./u);
  });
});

test('the capture and suppression routes guard auth, contract version and enablement', async () => {
  await withCutoverServer(async (harness) => {
    assert.equal((await postCapture(harness, vaultCaptureDto(), {})).statusCode, 401);
    assert.equal((await postCapture(harness, { ...vaultCaptureDto(), schemaVersion: 2 })).statusCode, 400);
    assert.equal((await postSuppression(harness)).statusCode, 200);

    harness.service.refreshConfig({ ...harness.service.config, Enabled: false });
    assert.equal((await postCapture(harness, vaultCaptureDto())).statusCode, 409);
    assert.equal((await postSuppression(harness)).statusCode, 409);
  });
});
