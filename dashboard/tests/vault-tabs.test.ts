import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  closeTab, noteDraft, openNoteTab, openSpecialTab, setActiveNoteTab, setNoteDraft, settleNoteDraft, tabLabel, type VaultTabsState,
} from '../src/lib/vault-tabs.ts';
import { ago, fmtTime } from '../src/lib/vault-time.ts';

const START: VaultTabsState = { tabs: [{ kind: 'graph' }, { kind: 'note', noteId: 'a', mode: 'read', full: false, draft: null }], active: 1 };

test('opening a note replaces a read-mode active note tab, else pushes', () => {
  assert.deepEqual(openNoteTab(START, 'b', { newTab: false, mode: 'read' }).tabs[1], { kind: 'note', noteId: 'b', mode: 'read', full: false, draft: null });
  const pushed = openNoteTab(START, 'b', { newTab: true, mode: 'read' });
  assert.equal(pushed.tabs.length, 3);
  assert.equal(pushed.active, 2);
  const editing = setActiveNoteTab(START, { mode: 'edit' });
  assert.equal(openNoteTab(editing, 'b', { newTab: false, mode: 'read' }).tabs.length, 3);
  assert.equal(openNoteTab({ ...START, active: 0 }, 'b', { newTab: false, mode: 'read' }).tabs.length, 3);
});

test('opening an already-open note activates its tab and applies edit mode', () => {
  const state = openNoteTab({ ...START, active: 0 }, 'a', { newTab: true, mode: 'edit' });
  assert.equal(state.active, 1);
  assert.equal(state.tabs.length, 2);
  assert.deepEqual(state.tabs[1], { kind: 'note', noteId: 'a', mode: 'edit', full: false, draft: null });
});

test('special tabs are reused; diff tabs are keyed by note and revision', () => {
  assert.equal(openSpecialTab(START, { kind: 'graph' }).active, 0);
  const diff = openSpecialTab(START, { kind: 'diff', noteId: 'a', revision: 2 });
  assert.equal(diff.tabs.length, 3);
  assert.equal(openSpecialTab(diff, { kind: 'diff', noteId: 'a', revision: 2 }).tabs.length, 3);
  assert.equal(openSpecialTab(diff, { kind: 'diff', noteId: 'a', revision: 3 }).tabs.length, 4);
});

test('closeTab clamps the active index, and setActiveNoteTab ignores non-note tabs', () => {
  assert.deepEqual(closeTab(START, 1), { tabs: [{ kind: 'graph' }], active: 0 });
  assert.deepEqual(closeTab({ tabs: [{ kind: 'graph' }], active: 0 }, 0), { tabs: [], active: -1 });
  assert.deepEqual(setActiveNoteTab({ ...START, active: 0 }, { mode: 'edit' }), { ...START, active: 0 });
});

test('tabLabel names each tab kind', () => {
  const titles = new Map([['a', 'Alpha']]);
  assert.equal(tabLabel({ kind: 'graph' }, titles), '◎ Graph view');
  assert.equal(tabLabel({ kind: 'review' }, titles), '✓ Review');
  assert.equal(tabLabel({ kind: 'diff', noteId: 'a', revision: 3 }, titles), '⟲ Alpha · r3');
  assert.equal(tabLabel({ kind: 'note', noteId: 'a', mode: 'edit', full: false, draft: null }, titles), '✎ Alpha');
  assert.equal(tabLabel({ kind: 'note', noteId: 'zz', mode: 'read', full: false, draft: null }, titles), '…');
});

test('ago buckets minutes, hours and days; fmtTime trims to minutes', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  assert.equal(ago('2026-10-24T11:59:40.000Z', now), 'just now');
  assert.equal(ago('2026-10-24T11:30:00.000Z', now), '30m ago');
  assert.equal(ago('2026-10-23T12:00:00.000Z', now), '24h ago');
  assert.equal(ago('2026-10-20T12:00:00.000Z', now), '4d ago');
  assert.equal(fmtTime('2026-10-24T11:30:12.000Z'), '2026-10-24 11:30');
});

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
