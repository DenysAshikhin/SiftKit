import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AssistantErrorResponseSchema, VaultDeleteResponseSchema, VaultGraphSchema, VaultNoteDetailSchema, VaultNoteListResponseSchema, VaultNoteSchema,
  VaultRenameResultSchema, VaultResolveResponseSchema, VaultReviewSchema, VaultRevisionListResponseSchema,
  VaultRevisionSchema, VaultSearchResultSchema, VaultStatsSchema, VaultTreeResponseSchema,
} from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { readArchiveEntriesFromBytes } from './helpers/archive-bytes.ts';
import { withAssistantServer, type AssistantServerHarness } from './helpers/assistant-server-harness.ts';
import { requestBinary, requestJson } from './helpers/dashboard-http.ts';

const ENABLED = { ...getDefaultConfig().Assistant, Enabled: true };

function vaultClient({ baseUrl, headers }: AssistantServerHarness) {
  const call = async (method: string, path: string, payload?: object) => requestJson(`${baseUrl}/assistant/vault${path}`, {
    method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    call,
    async ok<T>(method: string, path: string, schema: z.ZodType<T>, payload?: object): Promise<T> {
      const response = await call(method, path, payload);
      assert.equal(response.statusCode, 200, JSON.stringify(response.body));
      return schema.parse(response.body);
    },
    async error(method: string, path: string, status: number, payload?: object) {
      const response = await call(method, path, payload);
      assert.equal(response.statusCode, status, JSON.stringify(response.body));
      return AssistantErrorResponseSchema.parse(response.body).error;
    },
  };
}

test('vault routes create, read, link, search, review and graph notes', async () => {
  await withAssistantServer('siftkit-vault-routes-read-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    const git = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'Git', folder: 'Software', body: 'Git is a tool.' });
    assert.deepEqual([git.kind, git.revision, git.folder], ['note', 1, 'Software']);
    const siftkit = await vault.ok('POST', '/notes', VaultNoteSchema, {
      title: 'SiftKit', folder: 'Projects',
      body: 'SiftKit is a project.\n\n**Uses** [[Git]] · [[Node.js]]\n\n> [!unverified]- 1 unverified fact\n> - **Runs on** [[Windows]] #unverified',
    });

    assert.deepEqual((await vault.ok('GET', '/tree?stubs=true', VaultTreeResponseSchema)).folders.map((folder) => [folder.path, folder.count]),
      [['Projects', 1], ['Software', 1]]);
    assert.deepEqual((await vault.ok('GET', '/notes?folder=Software', VaultNoteListResponseSchema)).notes.map((note) => note.title), ['Git']);

    const gitDetail = await vault.ok('GET', `/notes/${git.id}`, VaultNoteDetailSchema);
    assert.deepEqual(gitDetail.backlinks.map((link) => [link.note.title, link.labels]), [['SiftKit', ['Uses']]]);
    const siftkitDetail = await vault.ok('GET', `/notes/${siftkit.id}`, VaultNoteDetailSchema);
    assert.deepEqual(siftkitDetail.outgoing.resolved.map((note) => note.title), ['Git']);
    assert.deepEqual(siftkitDetail.outgoing.unresolved, ['node.js', 'windows']);

    assert.deepEqual(await vault.ok('GET', '/resolve?title=GIT', VaultResolveResponseSchema), { id: git.id });
    assert.deepEqual(await vault.ok('GET', '/resolve?title=nope', VaultResolveResponseSchema), { id: null });
    assert.equal((await vault.ok('GET', '/search?q=git', VaultSearchResultSchema)).hits[0]?.note.title, 'Git');
    assert.deepEqual((await vault.ok('GET', '/review', VaultReviewSchema)).items.map((item) => [item.label, item.value]), [['Runs on', '[[Windows]]']]);

    const graph = await vault.ok('GET', '/graph', VaultGraphSchema);
    assert.deepEqual([graph.nodes.length, graph.edges.length], [2, 1]);
    assert.deepEqual((await vault.ok('GET', '/graph?minLinks=1&hide=Projects', VaultGraphSchema)).nodes.map((node) => node.title), ['Git']);
    assert.equal((await vault.ok('GET', `/graph/local/${git.id}?depth=1`, VaultGraphSchema)).nodes.length, 2);

    const stats = await vault.ok('GET', '/stats', VaultStatsSchema);
    assert.deepEqual([stats.notes, stats.links, stats.notesWithUnverified], [2, 3, 1]);
  });
});

test('vault routes update, rename, restore and delete under revision checks', async () => {
  await withAssistantServer('siftkit-vault-routes-write-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    const editor = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'VS Code', folder: 'Software', body: 'Editor.' });
    const project = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'SiftKit', body: '**Uses** [[VS Code]]' });

    const updated = await vault.ok('PUT', `/notes/${editor.id}`, VaultNoteSchema, { body: 'Editor by Microsoft.', tags: ['editor'], expectedRevision: 1 });
    assert.deepEqual([updated.revision, updated.tags], [2, ['editor']]);
    const stale = await vault.error('PUT', `/notes/${editor.id}`, 409, { body: 'Stale.', expectedRevision: 1 });
    assert.deepEqual([stale.code, stale.currentRevision], ['conflict', 2]);

    const renamed = await vault.ok('POST', `/notes/${editor.id}/rename`, VaultRenameResultSchema, { title: 'Visual Studio Code', expectedRevision: 2 });
    assert.deepEqual([renamed.rewrittenNotes, renamed.rewrittenLinks, renamed.note.aliases], [1, 1, ['VS Code']]);
    assert.equal((await vault.ok('GET', `/notes/${project.id}`, VaultNoteDetailSchema)).note.body, '**Uses** [[Visual Studio Code]]');

    assert.deepEqual((await vault.ok('GET', `/notes/${editor.id}/revisions`, VaultRevisionListResponseSchema)).revisions.map((revision) => revision.revision), [3, 2, 1]);
    const first = await vault.ok('GET', `/notes/${editor.id}/revisions/1`, VaultRevisionSchema);
    assert.deepEqual([first.title, first.body, first.actor], ['VS Code', 'Editor.', 'you']);

    const restored = await vault.ok('POST', `/notes/${editor.id}/restore`, VaultNoteSchema, { revision: 1, expectedRevision: 3 });
    assert.deepEqual([restored.revision, restored.title, restored.body], [4, 'Visual Studio Code', 'Editor.']);

    assert.deepEqual(await vault.ok('DELETE', `/notes/${editor.id}`, VaultDeleteResponseSchema, { expectedRevision: 4 }), { ok: true });
    assert.equal((await vault.error('GET', `/notes/${editor.id}`, 404)).code, 'not_found');
    assert.deepEqual((await vault.ok('GET', `/notes/${project.id}`, VaultNoteDetailSchema)).outgoing.unresolved, ['visual studio code']);
  });
});

test('vault routes reject bad requests with typed errors', async () => {
  await withAssistantServer('siftkit-vault-routes-errors-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    const git = await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'Git', body: 'x' });
    assert.equal((await vault.error('POST', '/notes', 409, { title: 'git' })).code, 'title_taken');
    assert.equal((await vault.error('POST', '/notes', 400, { title: 'a|b' })).code, 'invalid_request');
    assert.equal((await vault.error('POST', '/notes', 400, { title: 'Ok', extra: true })).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/notes/vnote_missing', 404)).code, 'not_found');
    assert.equal((await vault.error('GET', `/notes/${git.id}/revisions/9`, 404)).code, 'not_found');
    assert.equal((await vault.error('GET', `/graph/local/${git.id}?depth=3`, 400)).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/tree?stubs=maybe', 400)).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/notes?limit=100000', 400)).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/search?q=git&limit=0', 400)).code, 'invalid_request');
    assert.equal((await vault.error('GET', '/graph?minLinks=-1', 400)).code, 'invalid_request');
  });
});

test('vault export zips every note as markdown and keeps working while the assistant is disabled', async () => {
  await withAssistantServer('siftkit-vault-routes-export-', ENABLED, async (harness) => {
    const vault = vaultClient(harness);
    await vault.ok('POST', '/notes', VaultNoteSchema, { title: 'Git', folder: 'Software', body: 'Git is a tool.' });
    const patched = await requestJson(`${harness.baseUrl}/assistant/config`, {
      method: 'PATCH', headers: harness.headers, body: JSON.stringify({ assistant: { ...ENABLED, Enabled: false } }),
    });
    assert.equal(patched.statusCode, 200, JSON.stringify(patched.body));
    assert.equal((await vault.error('GET', '/tree', 409)).code, 'assistant_disabled');

    const exported = await requestBinary(`${harness.baseUrl}/assistant/vault/export`, { method: 'POST', headers: harness.headers });
    assert.equal(exported.statusCode, 200, exported.body.toString('utf8'));
    assert.equal(exported.contentType, 'application/zip');
    const entries = await readArchiveEntriesFromBytes(exported.body);
    assert.deepEqual([...entries.keys()], ['Software/Git.md']);
    assert.match(entries.get('Software/Git.md')?.toString('utf8') ?? '', /^---\nkind: note\n[\s\S]*---\n\nGit is a tool\.\n$/);
  });
});
