import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { z } from 'zod';
import { VaultNoteSchema, type VaultNote } from '@siftkit/contracts';

import { useVaultController } from '../src/hooks/useVaultController.ts';
import { VaultTab } from '../src/tabs/VaultTab.tsx';
import { fireEvent, render, screen } from './react-test-environment.ts';
import { noteDetail, summaryOf, vaultNote } from './vault-fixture.ts';

const PutSchema = z.object({ body: z.string(), expectedRevision: z.number() });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Two starred notes on a server that checks revisions as the real one does. */
function stubVault(): { notes: Map<string, VaultNote>; puts: z.infer<typeof PutSchema>[] } {
  const notes = new Map([['a', vaultNote({ id: 'a', title: 'Alpha', body: 'alpha body' })], ['b', vaultNote({ id: 'b', title: 'Beta', body: 'beta body' })]]);
  const puts: z.infer<typeof PutSchema>[] = [];
  const note = (id: string): VaultNote => VaultNoteSchema.parse(notes.get(id));
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace('/assistant/vault', '');
    if (url.pathname === '/assistant/auth/bootstrap') return reply({ token: 'tok' });
    if (path === '/search') return reply({ total: 1, hits: [{ note: summaryOf(note('a')), score: 1, snippet: null }] });
    if (path === '/resolve') return reply({ id: 'b' });
    if (path === '/notes') return reply({ notes: [] });
    if (path === '/graph') {
      return reply({ nodes: [...notes.values()].map((entry) => ({ id: entry.id, title: entry.title, folder: entry.folder, topFolder: entry.folder, kind: entry.kind, degree: 0 })), edges: [] });
    }
    if (path.startsWith('/graph/local/')) return reply({ nodes: [], edges: [] });
    if (path === '/tree') return reply({ folders: [] });
    if (path === '/stats') {
      return reply({ notes: 2, links: 0, tags: 0, stubs: 0, notesWithUnverified: 0, byKind: { entity: 2, capture: 0, daily: 0, chat: 0, note: 0 },
        validation: { queueDepth: 0, oldestValidatedAtUtc: null } });
    }
    const id = path.replace('/notes/', '');
    if (init?.method !== 'PUT') return reply(noteDetail(note(id)));
    const put = PutSchema.parse(JSON.parse(String(init.body)));
    puts.push(put);
    if (put.expectedRevision !== note(id).revision) return reply({ error: { code: 'conflict', message: 'stale' } }, 409);
    const saved = { ...note(id), body: put.body, revision: put.expectedRevision + 1 };
    notes.set(id, saved);
    return reply(saved);
  };
  return { notes, puts };
}

function Vault() { return <VaultTab {...useVaultController(true)} />; }

const settle = async (step: () => void = () => undefined) => {
  await act(async () => { step(); await new Promise((resolve) => { setTimeout(resolve, 20); }); });
};
const editor = () => document.querySelector('textarea');
const openTab = (name: string) => settle(() => { fireEvent.click(screen.getByText((text, element) => element?.parentElement?.className.startsWith('v-tab') === true
  && element.tagName === 'SPAN' && text.endsWith(name))); });
const press = (name: string) => settle(() => { fireEvent.click(screen.getByRole('button', { name })); });
const type = (value: string) => settle(() => {
  const area = editor();
  assert.ok(area);
  fireEvent.change(area, { target: { value } });
});

async function editAlpha(): Promise<ReturnType<typeof stubVault>> {
  const server = stubVault();
  render(<Vault />);
  await settle();
  await openTab('Alpha');
  await press('Edit');
  return server;
}

test('unsaved text survives switching tabs, reading, and saving another note; Cancel discards it', async () => {
  const server = await editAlpha();
  await type('alpha draft');
  await openTab('Beta');
  await press('Edit');
  await type('beta saved');
  await press('Save · creates a revision');
  assert.deepEqual(server.puts, [{ body: 'beta saved', expectedRevision: 3 }]);
  await openTab('Alpha');
  assert.equal(editor()?.value, 'alpha draft');
  await press('Read');
  assert.equal(editor(), null);
  await press('Edit');
  assert.equal(editor()?.value, 'alpha draft');
  await press('Cancel');
  await press('Edit');
  assert.equal(editor()?.value, 'alpha body');
  assert.equal(server.puts.length, 1);
});

test('a save that conflicts keeps the draft, and saving again replaces the latest revision', async () => {
  const server = await editAlpha();
  await type('my text');
  server.notes.set('a', vaultNote({ id: 'a', title: 'Alpha', body: 'changed elsewhere', revision: 4 }));
  await press('Save · creates a revision');
  assert.equal(editor()?.value, 'my text');
  screen.getByText('This note changed elsewhere. Your text is kept; save again to replace the latest revision.');
  await press('Save · creates a revision');
  assert.equal(editor(), null);
  assert.deepEqual(server.puts, [{ body: 'my text', expectedRevision: 3 }, { body: 'my text', expectedRevision: 4 }]);
  assert.equal(server.notes.get('a')?.body, 'my text');
});
