import { createRef } from 'react';
import type { VaultNote, VaultNoteDetail, VaultNoteSummary } from '@siftkit/contracts';

import type { VaultActions } from '../src/components/vault/vault-actions.ts';
import type { VaultTabProps } from '../src/hooks/useVaultController.ts';

export const FIXTURE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const noop = () => undefined;

export const NOOP_ACTIONS: VaultActions = {
  openNote: noop, followLink: noop, searchTag: noop, toggleTask: noop, triage: noop, showFull: noop, jumpTo: noop, setMode: noop,
  saveBody: noop, rename: noop, linkMention: noop, openDiff: noop, restore: noop, activateTab: noop, closeTab: noop, openGraph: noop,
  openReview: noop, openDaily: noop, newNote: noop, createNote: noop, setSide: noop, setSearch: noop, toggleFolder: noop,
  collapseAll: noop, toggleStubs: noop, setRight: noop, setLocalDepth: noop, setGraphOptions: noop, selectGraphNode: noop,
  rerunLayout: noop, openPalette: noop, closePalette: noop, hoverLink: noop, clearHover: noop, exportVault: noop,
  attachment: () => new Promise<Blob>(() => {}),
};

export function vaultNote(overrides: Partial<VaultNote> = {}): VaultNote {
  return {
    id: 'vnote_vsc', title: 'Visual Studio Code', folder: 'Software', kind: 'entity', types: ['software'], aliases: [], tags: [],
    body: 'VS Code is your editor.', revision: 3, isStub: false,
    createdAtUtc: '2026-10-20T09:00:00.000Z', updatedAtUtc: '2026-10-24T11:00:00.000Z', ...overrides,
  };
}

export function summaryOf(note: VaultNote): VaultNoteSummary {
  return { id: note.id, title: note.title, folder: note.folder, kind: note.kind, isStub: note.isStub, updatedAtUtc: note.updatedAtUtc };
}

export function noteDetail(note: VaultNote, overrides: Partial<Omit<VaultNoteDetail, 'note'>> = {}): VaultNoteDetail {
  return { note, backlinks: [], outgoing: { resolved: [], unresolved: [] }, ...overrides };
}

export function vaultTabProps(overrides: Partial<VaultTabProps> = {}): VaultTabProps {
  const note = vaultNote();
  return {
    error: null,
    index: { nodes: [{ id: note.id, title: note.title, folder: 'Software', topFolder: 'Software', kind: 'entity', degree: 4 }], edges: [] },
    folderColorMap: new Map([['Software', '#2fbfa0']]),
    noteColors: new Map([['visual studio code', '#2fbfa0']]),
    degrees: new Map([[note.id, 4]]),
    titles: new Map([[note.id, note.title]]),
    folders: [{ path: 'Software', name: 'Software', depth: 0, count: 1 }],
    folderNotes: new Map(),
    expanded: new Set(),
    starred: [{ note: summaryOf(note), owner: false }],
    showStubs: false,
    stats: { notes: 12, links: 30, tags: 4, stubs: 5, notesWithUnverified: 2, byKind: { entity: 10, capture: 0, daily: 1, chat: 0, note: 1 } },
    side: 'files',
    search: '',
    searchResult: null,
    searchInput: createRef(),
    tabs: { tabs: [{ kind: 'graph' }, { kind: 'note', noteId: note.id, mode: 'read', full: false }], active: 0 },
    details: new Map([[note.id, noteDetail(note)]]),
    revisions: new Map(),
    diffs: new Map(),
    review: null,
    right: 'graph',
    localDepth: 1,
    localGraph: null,
    unlinked: null,
    graphOptions: { filterText: '', hidden: new Set(['Daily']), minDegree: 2, labels: true },
    graphSelection: null,
    positions: new Map(),
    layoutSeed: 0,
    paletteOpen: false,
    hover: null,
    toast: null,
    nowMs: FIXTURE_NOW,
    actions: NOOP_ACTIONS,
    ...overrides,
  };
}
