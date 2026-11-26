# Audit Top Five Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix audit findings REM-1, AST-1, AST-4, SHM-2 and DSH-1.

**Architecture:** Four small fixes at their source, and one state move: a note's unsaved text moves from the editor component into its vault tab, so nothing that unmounts the editor can lose it.

**Tech Stack:** TypeScript, better-sqlite3, React, node:test, vitest, cmd.

---

### Task 1: REM-1, AST-1 and AST-4

**Files:**
- Modify: `src/web-search/url-safety.ts`, `src/assistant/storage/evidence-store.ts`, `src/assistant/storage/node-store.ts`, `src/assistant/graph/merge-service.ts`
- Test: `tests/web-search.test.ts`, `tests/assistant-evidence-store.test.ts`, `tests/assistant-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/web-search.test.ts`, inside `'assertPublicHttpUrl rejects loopback and private hosts'`:

```ts
  // 0.0.0.0/8 and every localhost name reach this machine's own listeners.
  for (const host of ['0.0.0.0:4765', '0', '0.1.2.3', 'localhost.', 'a.localhost', 'a.localhost.', 'printer.local.']) {
    assert.throws(() => assertPublicHttpUrl(`http://${host}/`), /private|internal|local/i, host);
  }
  assert.equal(assertPublicHttpUrl('https://example.com./a').hostname, 'example.com.');
```

`tests/assistant-evidence-store.test.ts`, at the end:

```ts
test('content recorded again after its blob was purged is stored again and readable', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const input = {
      ownerId: context.ownerId, deviceId: null, parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, sourceTimezone: 'UTC', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes: Buffer.from('seen twice', 'utf8'),
    } as const;
    const first = evidence.recordBlobEvidence({ ...input, sourceEventId: 'cap_1' });
    evidence.deleteEvidence(first.id);
    assert.equal(evidence.countBlobs(context.ownerId), 0);

    const second = evidence.recordBlobEvidence({ ...input, sourceEventId: 'cap_2' });

    assert.equal(evidence.hasReadableBlob(second), true);
    assert.deepEqual([...evidence.readBlobBytes(second.blob_id ?? '')], [...input.bytes]);
    assert.equal(evidence.countBlobs(context.ownerId), 1);
    assert.ok(fs.existsSync(blobPath(context, second.content_hash)));
    assert.equal(evidence.requireEvidence(first.id).status, 'deleted', 'the deleted record stays deleted');

    evidence.deleteEvidence(second.id);
    assert.equal(fs.existsSync(blobPath(context, second.content_hash)), false, 'and it can be purged again');
  });
});
```

`tests/assistant-merge.test.ts`, after `'a merge is reversible and restores every moved reference'`:

```ts
test('reversing a merge returns only the aliases it moved', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    const alias = (nodeId: string, text: string) => h.nodes.addAlias({
      ownerId: context.ownerId, nodeId, alias: text, aliasType: 'name', sourceEvidenceId: null,
    });
    alias(target, 'code');
    alias(source, 'vsc');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') return;
    alias(target, 'added while merged');

    h.merges.unmerge({ ownerId: context.ownerId, mergeId: outcome.mergeId, reason: 'reversed' });

    const names = (nodeId: string) => h.nodes.listAliases(nodeId).map((entry) => entry.normalized_alias).sort();
    assert.deepEqual(names(target), ['added while merged', 'code']);
    assert.deepEqual(names(source), ['vsc']);
    assert.deepEqual(h.nodes.findByAlias(context.ownerId, 'code').map((node) => node.id), [target]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node ./src/test-runner/run-tests.ts web-search`, `node ./src/test-runner/run-tests.ts assistant-evidence-store`, `node ./src/test-runner/run-tests.ts assistant-merge`
Expected: one failing test each.

- [ ] **Step 3: Implement**

`src/web-search/url-safety.ts`: `const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.localhost'] as const;`; `isPrivateIpv4` returns `a === 0 || a === 10 || ...` (first term added); in `isBlockedHostname`:

```ts
  // A trailing dot names the same host: "localhost." is localhost.
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '');
```

`src/assistant/storage/evidence-store.ts`, `persistBlob` becomes:

```ts
  private persistBlob(
    ownerId: string, contentHash: string, mimeType: string, bytes: Buffer,
  ): BlobRow {
    const row = this.database
      .prepare('SELECT * FROM evidence_blobs WHERE owner_id = ? AND content_hash = ?')
      .get(ownerId, contentHash);
    const existing = row === undefined || row === null ? null : BlobRowSchema.parse(row);
    if (existing !== null && existing.deleted_at_utc === null) return existing;

    const filePath = this.resolveBlobPath(contentHash);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const encrypted = this.cipher.encrypt(bytes);
    fs.writeFileSync(filePath, encrypted.envelope);

    // One row per content: content recorded again after its purge takes its old row back.
    if (existing !== null) {
      this.database.prepare(`
        UPDATE evidence_blobs SET mime_type = ?, encrypted = 1, key_id = ?, created_at_utc = ?, deleted_at_utc = NULL WHERE id = ?
      `).run(mimeType, encrypted.keyId, this.clock.nowUtc(), existing.id);
      return this.requireBlob(existing.id);
    }
```

followed by the existing insert, unchanged.

`src/assistant/storage/node-store.ts`: replace `reassignAliases` with:

```ts
  /** Re-points the listed aliases that `fromNodeId` still holds at `toNodeId`. */
  moveAliases(aliasIds: readonly string[], fromNodeId: string, toNodeId: string): void {
    this.database
      .prepare('UPDATE graph_node_aliases SET node_id = ? WHERE node_id = ? AND id IN (SELECT value FROM json_each(?))')
      .run(toNodeId, fromNodeId, JSON.stringify(aliasIds));
    this.refreshFts(fromNodeId);
    this.refreshFts(toNodeId);
  }
```

`src/assistant/graph/merge-service.ts`: in `merge`

```ts
      payload.movedAliasIds.push(...this.nodes.listAliases(request.sourceNodeId).map((alias) => alias.id));
      this.nodes.moveAliases(payload.movedAliasIds, request.sourceNodeId, request.targetNodeId);
```

and in `unmerge`

```ts
      this.nodes.moveAliases(payload.movedAliasIds, payload.targetNodeId, payload.sourceNodeId);
```

No `reassignAliases` may remain.

- [ ] **Step 4: Run to verify they pass**

Run: the three commands of Step 2, then `node ./src/test-runner/run-tests.ts assistant`, `npm run typecheck`
Expected: PASS. Do not commit.

### Task 2: SHM-2, the command shim returns the CLI's exit code

**Files:**
- Modify: `bin/siftkit.cmd`
- Test: `tests/process/install.test.ts`

- [ ] **Step 1: Write the failing test**, appended to `tests/process/install.test.ts`:

```ts
test('siftkit.cmd exits with the exit code of what it runs, through PowerShell and through node', async () => {
  const tempRoot = createManagedTempDir('siftkit-cmd-exit-');
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(tempRoot, 'src', 'cli'), { recursive: true });
    fs.copyFileSync(path.resolve('bin', 'siftkit.cmd'), path.join(bin, 'siftkit.cmd'));
    fs.writeFileSync(path.join(tempRoot, 'src', 'cli', 'main.ts'), 'process.exit(5);\n');
    const run = () => spawnProcess('cmd.exe', ['/d', '/c', 'siftkit.cmd', 'probe'], { cwd: bin, env: process.env });

    assert.equal((await run()).code, 5);
    fs.writeFileSync(path.join(bin, 'siftkit.ps1'), 'exit 7\r\n');
    assert.equal((await run()).code, 7);
    fs.writeFileSync(path.join(bin, 'siftkit.ps1'), 'exit 0\r\n');
    assert.equal((await run()).code, 0);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node ./src/test-runner/run-tests.ts --process install`
Expected: FAIL: 0 instead of 7.

- [ ] **Step 3: Implement**: `bin/siftkit.cmd` becomes

```bat
@echo off
if exist "%~dp0siftkit.ps1" (
  powershell -ExecutionPolicy Bypass -File "%~dp0siftkit.ps1" %*
) else (
  node "%~dp0..\src\cli\main.ts" %*
)
rem cmd expands %errorlevel% when it reads a block, so it is read only after the block has run.
exit /b %errorlevel%
```

The `rem` line must stay after the block. Do not touch `scripts/postinstall.cjs`: its shim already returns the last exit code.

- [ ] **Step 4: Run to verify it passes**

Run: `node ./src/test-runner/run-tests.ts --process install`, `node ./src/test-runner/run-tests.ts install`
Expected: PASS. Do not commit.

### Task 3: DSH-1, a note's unsaved text lives in its tab

**Files:**
- Modify: `dashboard/src/lib/vault-tabs.ts`, `dashboard/src/components/vault/NoteEditor.tsx`, `dashboard/src/components/vault/NoteView.tsx`, `dashboard/src/components/vault/vault-actions.ts`, `dashboard/src/tabs/VaultTab.tsx`, `dashboard/src/hooks/useVaultController.ts`
- Test: `dashboard/tests/vault-tabs.test.ts`, `dashboard/tests/vault-drafts.test.tsx` (create), fixtures and literals in `dashboard/tests/vault-fixture.ts`, `dashboard/tests/vault-components.test.tsx`

Behavior: the draft survives switching tabs, toggling Read/Edit, a save of another note, and a save conflict. `Cancel` discards it. Closing the tab discards it. A draft remembers the revision it was based on, so a note that changed elsewhere conflicts instead of being overwritten silently; after a conflict the draft is kept and a second save replaces the latest revision.

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/vault-tabs.test.ts`: add `draft: null` to every note-tab literal, extend the import, and append:

```ts
test('a draft belongs to its note: it survives other tabs and reading, keeps its tab from being replaced, and marks its label', () => {
  const draft = { body: 'typed', revision: 3 };
  const drafted = setNoteDraft(START, 'a', draft);
  assert.deepEqual(noteDraft(drafted, 'a'), draft);
  assert.equal(noteDraft(drafted, 'b'), null);
  assert.equal(noteDraft(openSpecialTab(drafted, { kind: 'graph' }), 'a'), draft);
  const opened = openNoteTab(drafted, 'b', { newTab: false, mode: 'read' });
  assert.equal(opened.tabs.length, 3, 'a tab holding a draft is not replaced');
  assert.equal(noteDraft(opened, 'a'), draft);
  assert.equal(tabLabel({ kind: 'note', noteId: 'a', mode: 'read', full: false, draft }, new Map([['a', 'Alpha']])), '✎ Alpha');
  assert.equal(noteDraft(setNoteDraft(drafted, 'a', null), 'a'), null);
});

test('a saved draft leaves its note reading, unless more was typed while it saved: that stays, based on the saved revision', () => {
  const editing = setNoteDraft(setActiveNoteTab(START, { mode: 'edit' }), 'a', { body: 'one', revision: 3 });
  const elsewhere = { ...editing, active: 0 };
  assert.deepEqual(settleNoteDraft(elsewhere, 'a', 'one', 4).tabs[1], { kind: 'note', noteId: 'a', mode: 'read', full: false, draft: null });
  const typedOn = setNoteDraft(editing, 'a', { body: 'one two', revision: 3 });
  assert.deepEqual(settleNoteDraft(typedOn, 'a', 'one', 4).tabs[1],
    { kind: 'note', noteId: 'a', mode: 'edit', full: false, draft: { body: 'one two', revision: 4 } });
});
```

`dashboard/tests/vault-drafts.test.tsx` (create). It drives the real controller and the real tab over a stubbed server:

```tsx
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
    if (path === '/graph' || path.startsWith('/graph/local/')) return reply({ nodes: [], edges: [] });
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
```

If a query above does not match the real markup, adjust the query only, never the asserted behavior.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --config ./dashboard/vitest.config.ts dashboard/tests/vault-tabs.test.ts dashboard/tests/vault-drafts.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`dashboard/src/lib/vault-tabs.ts`:

```ts
/** Unsaved text of one note, and the revision it was typed over. */
export interface VaultDraft {
  readonly body: string;
  readonly revision: number;
}
```

The note member of `VaultTab` gains `readonly draft: VaultDraft | null`. `openNoteTab`: `fresh` gains `draft: null`, and a tab is replaced only when `current.mode === 'read' && current.draft === null`. `tabLabel` uses `tab.mode === 'edit' || tab.draft !== null`. Add these three, with no shared helper that takes a callback:

```ts
export function noteDraft(state: VaultTabsState, noteId: string): VaultDraft | null {
  const tab = state.tabs.find((entry) => entry.kind === 'note' && entry.noteId === noteId);
  return tab?.kind === 'note' ? tab.draft : null;
}

export function setNoteDraft(state: VaultTabsState, noteId: string, draft: VaultDraft | null): VaultTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.kind === 'note' && tab.noteId === noteId ? { ...tab, draft } : tab)) };
}

/** After `body` was saved as `revision`: the note reads, unless more was typed meanwhile; that stays, based on the saved revision. */
export function settleNoteDraft(state: VaultTabsState, noteId: string, body: string, revision: number): VaultTabsState {
  const draft = noteDraft(state, noteId);
  if (draft !== null && draft.body !== body) return setNoteDraft(state, noteId, { ...draft, revision });
  return { ...state, tabs: state.tabs.map((tab) => (tab.kind === 'note' && tab.noteId === noteId ? { ...tab, mode: 'read', draft: null } : tab)) };
}
```

`dashboard/src/components/vault/vault-actions.ts`: replace `saveBody` with

```ts
  setDraft(noteId: string, draft: VaultDraft | null): void;
  /** Saves the note's draft; without one there is nothing to save and the note just reads. */
  saveDraft(noteId: string): void;
```

`NoteEditor.tsx`: props gain `draft: VaultDraft | null`; the `value` state goes away:

```tsx
  const value = draft?.body ?? note.body;
  const setValue = (next: string) => actions.setDraft(note.id, next === note.body ? null : { body: next, revision: draft?.revision ?? note.revision });
```

`save` becomes `() => actions.saveDraft(note.id)`; `Cancel` calls `actions.setDraft(note.id, null)` then `actions.setMode('read')`.

`NoteView.tsx`: `NoteViewProps` gains `readonly draft: VaultDraft | null`; the editor is rendered without a `key`, as `<NoteEditor note={note} draft={props.draft} entries={entries} actions={actions} />`. `VaultTab.tsx` passes `draft={tab.draft}`.

`useVaultController.ts`: the startup note tabs gain `draft: null`. `recoverConflict` returns the reloaded note's revision (`Promise<number>`). `writeBody` takes `note: Pick<VaultNote, 'id' | 'revision'>` and returns `Promise<{ saved: boolean; revision: number }>`: the saved note's revision, or the latest one after a conflict. Actions:

```ts
    setDraft: (noteId, draft) => setTabs((current) => setNoteDraft(current, noteId, draft)),
    saveDraft: (noteId) => authed(async (auth) => {
      const draft = noteDraft(tabs, noteId);
      if (draft === null) { setTabs((current) => setActiveNoteTab(current, { mode: 'read' })); return; }
      const written = await writeBody(auth, { id: noteId, revision: draft.revision }, draft.body, 'Saved as a new revision.');
      if (written.saved) { setTabs((current) => settleNoteDraft(current, noteId, draft.body, written.revision)); return; }
      setTabs((current) => {
        const kept = noteDraft(current, noteId);
        return kept === null ? current : setNoteDraft(current, noteId, { ...kept, revision: written.revision });
      });
      notify('This note changed elsewhere. Your text is kept; save again to replace the latest revision.', true);
    }),
```

Fixtures: `vault-fixture.ts` gets `setDraft: noop, saveDraft: noop` instead of `saveBody: noop`, and `draft: null` on its note tab; `vault-components.test.tsx` passes `draft={null}` to every `NoteView`. No `saveBody` may remain in `dashboard/`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --config ./dashboard/vitest.config.ts`, `npm run typecheck`
Expected: PASS. Do not commit.
