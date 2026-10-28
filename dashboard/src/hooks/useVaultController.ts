import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  VAULT_OWNER_TAG, vaultKey,
  type VaultFolder, type VaultGraph, type VaultLocalGraphDepth, type VaultNote, type VaultNoteDetail, type VaultNoteSummary,
  type VaultReview, type VaultRevision, type VaultRevisionSummary, type VaultSearchResult, type VaultStats,
} from '@siftkit/contracts';

import { bootstrapAssistantToken } from '../api.ts';
import {
  createVaultNote, exportVaultArchive, fetchVaultAttachment, getVaultGraph, getVaultLocalGraph, getVaultNote, getVaultReview, getVaultRevision,
  getVaultStats, getVaultTree, listVaultNotes, listVaultRevisions, renameVaultNote, resolveVaultTitle, restoreVaultRevision,
  searchVault, triageVaultFact, updateVaultNote, VaultRequestError,
} from '../vault-api.ts';
import type { StarredNote } from '../components/vault/FileTree.tsx';
import { FOLDER_LIMIT } from '../components/vault/FileTree.tsx';
import type { VaultHover } from '../components/vault/VaultChrome.tsx';
import type {
  VaultActions, VaultAnchorRect, VaultGraphOptions, VaultRightTab, VaultSide,
} from '../components/vault/vault-actions.ts';
import { linkFirstMention, toggleTask } from '../lib/vault-edits.ts';
import { folderColors, type Point } from '../lib/vault-force.ts';
import {
  closeTab, openNoteTab, openSpecialTab, setActiveNoteTab, type VaultTab, type VaultTabsState,
} from '../lib/vault-tabs.ts';

const SEARCH_LIMIT = 150;
const SEARCH_DEBOUNCE_MS = 150;
const HOVER_DELAY_MS = 350;
const TOAST_MS = 4200;
const REVIEW_LIMIT = 1000;
const UNLINKED_SEARCH_LIMIT = 60;
const UNLINKED_SHOWN = 12;
const UNLINKED_MIN_TITLE = 4;
const HOVER_CARD_WIDTH = 440;
const HOVER_CARD_HEIGHT = 360;
const STARRED_PROJECT_TITLE = 'SiftKit';
const DAILY_FOLDER = 'Daily';
const DEFAULT_HIDDEN_FOLDERS = ['Captures', 'Daily', 'Chats'];
const EMPTY_GRAPH: VaultGraph = { nodes: [], edges: [] };

export interface VaultToast {
  readonly text: string;
  readonly error: boolean;
}

export interface VaultDiff {
  readonly revision: VaultRevision;
  readonly before: string | null;
}

export interface VaultTabProps {
  readonly error: string | null;
  readonly index: VaultGraph;
  readonly folderColorMap: ReadonlyMap<string, string>;
  readonly noteColors: ReadonlyMap<string, string>;
  readonly degrees: ReadonlyMap<string, number>;
  readonly titles: ReadonlyMap<string, string>;
  readonly folders: readonly VaultFolder[];
  readonly folderNotes: ReadonlyMap<string, readonly VaultNoteSummary[]>;
  readonly expanded: ReadonlySet<string>;
  readonly starred: readonly StarredNote[];
  readonly showStubs: boolean;
  readonly stats: VaultStats | null;
  readonly side: VaultSide;
  readonly search: string;
  readonly searchResult: VaultSearchResult | null;
  readonly searchInput: RefObject<HTMLInputElement | null>;
  readonly tabs: VaultTabsState;
  readonly details: ReadonlyMap<string, VaultNoteDetail>;
  readonly revisions: ReadonlyMap<string, readonly VaultRevisionSummary[]>;
  readonly diffs: ReadonlyMap<string, VaultDiff>;
  readonly review: VaultReview | null;
  readonly right: VaultRightTab;
  readonly localDepth: VaultLocalGraphDepth;
  readonly localGraph: VaultGraph | null;
  readonly unlinked: readonly VaultNoteSummary[] | null;
  readonly graphOptions: VaultGraphOptions;
  readonly graphSelection: string | null;
  readonly positions: Map<string, Point>;
  readonly layoutSeed: number;
  readonly paletteOpen: boolean;
  readonly hover: VaultHover | null;
  readonly toast: VaultToast | null;
  readonly nowMs: number;
  readonly actions: VaultActions;
}

export const diffKey = (noteId: string, revision: number): string => `${noteId}:${revision}`;
const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V) => new Map(map).set(key, value);

/** All vault UI state and server traffic; loads lazily the first time the tab becomes visible. */
export function useVaultController(visible: boolean): VaultTabProps {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState<VaultGraph>(EMPTY_GRAPH);
  const [folders, setFolders] = useState<readonly VaultFolder[]>([]);
  const [folderNotes, setFolderNotes] = useState<ReadonlyMap<string, readonly VaultNoteSummary[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [starred, setStarred] = useState<readonly StarredNote[]>([]);
  const [showStubs, setShowStubs] = useState(false);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [side, setSide] = useState<VaultSide>('files');
  const [search, setSearch] = useState('');
  const [searchResult, setSearchResult] = useState<VaultSearchResult | null>(null);
  const [tabs, setTabs] = useState<VaultTabsState>({ tabs: [], active: -1 });
  const [details, setDetails] = useState<ReadonlyMap<string, VaultNoteDetail>>(new Map());
  const [revisions, setRevisions] = useState<ReadonlyMap<string, readonly VaultRevisionSummary[]>>(new Map());
  const [diffs, setDiffs] = useState<ReadonlyMap<string, VaultDiff>>(new Map());
  const [review, setReview] = useState<VaultReview | null>(null);
  const [right, setRight] = useState<VaultRightTab>('graph');
  const [localDepth, setLocalDepth] = useState<VaultLocalGraphDepth>(1);
  const [localGraph, setLocalGraph] = useState<VaultGraph | null>(null);
  const [unlinked, setUnlinked] = useState<readonly VaultNoteSummary[] | null>(null);
  const [graphOptions, setGraphOptions] = useState<VaultGraphOptions>({ filterText: '', hidden: new Set(DEFAULT_HIDDEN_FOLDERS), minDegree: 2, labels: true });
  const [graphSelection, setGraphSelection] = useState<string | null>(null);
  const [layoutSeed, setLayoutSeed] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hover, setHover] = useState<VaultHover | null>(null);
  const [toast, setToast] = useState<VaultToast | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const positions = useRef(new Map<string, Point>()).current;
  const hoverTimer = useRef(0);
  const toastTimer = useRef(0);

  const folderColorMap = useMemo(() => folderColors(index.nodes.map((node) => node.topFolder)), [index]);
  const noteColors = useMemo(() => new Map(index.nodes.map((node) => [vaultKey(node.title), folderColorMap.get(node.topFolder) ?? ''])), [index, folderColorMap]);
  const degrees = useMemo(() => new Map(index.nodes.map((node) => [node.id, node.degree])), [index]);
  const titles = useMemo(() => {
    const map = new Map(index.nodes.map((node) => [node.id, node.title]));
    for (const [id, detail] of details) map.set(id, detail.note.title);
    return map;
  }, [index, details]);
  const activeTab: VaultTab | null = tabs.tabs[tabs.active] ?? null;
  const activeNoteId = activeTab?.kind === 'note' ? activeTab.noteId : null;
  const activeDetail = activeNoteId === null ? null : details.get(activeNoteId) ?? null;

  const notify = (text: string, isError = false) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, error: isError });
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  };
  const report = (caught: Error) => notify(caught.message, true);

  async function loadDetail(auth: string, id: string): Promise<VaultNoteDetail> {
    const detail = await getVaultNote(auth, id);
    setDetails((current) => withEntry(current, id, detail));
    return detail;
  }

  async function refreshVault(auth: string, stubs: boolean): Promise<void> {
    const [graph, tree, nextStats, rootNotes] = await Promise.all([
      getVaultGraph(auth), getVaultTree(auth, stubs), getVaultStats(auth), listVaultNotes(auth, '', stubs, FOLDER_LIMIT),
    ]);
    setIndex(graph);
    setFolders(tree);
    setStats(nextStats);
    setFolderNotes(new Map([['', rootNotes]]));
  }

  /** After a write the written note is refetched and every other cached detail dropped, since renames touch linking notes. */
  async function afterWrite(auth: string, note: VaultNote): Promise<void> {
    const detail = await getVaultNote(auth, note.id);
    setDetails(new Map([[note.id, detail]]));
    setRevisions(new Map());
    setUnlinked(null);
    setLocalGraph(null);
    await refreshVault(auth, showStubs);
  }

  async function recoverConflict(auth: string, noteId: string): Promise<void> {
    await loadDetail(auth, noteId);
    notify('This note changed elsewhere; the latest revision is loaded.', true);
  }

  async function writeBody(auth: string, note: VaultNote, body: string, message: string): Promise<void> {
    try {
      await afterWrite(auth, await updateVaultNote(auth, note.id, { body }, note.revision));
      notify(message);
    } catch (caught) {
      if (!(caught instanceof VaultRequestError && caught.code === 'conflict')) throw caught;
      await recoverConflict(auth, note.id);
    }
  }

  async function openCreated(auth: string, title: string): Promise<void> {
    const note = await createVaultNote(auth, title);
    await afterWrite(auth, note);
    setTabs((current) => openNoteTab(current, note.id, { newTab: true, mode: 'edit' }));
  }

  // First load: index, tree, stats, starred notes, and the startup tabs (graph first).
  useEffect(() => {
    if (!visible || token !== null) return undefined;
    let live = true;
    void (async () => {
      try {
        const auth = await bootstrapAssistantToken();
        const [owner, projectId, daily] = await Promise.all([
          searchVault(auth, `tag:#${VAULT_OWNER_TAG}`, 1), resolveVaultTitle(auth, STARRED_PROJECT_TITLE), listVaultNotes(auth, DAILY_FOLDER, false, 1),
        ]);
        await refreshVault(auth, false);
        const project = projectId === null ? null : (await getVaultNote(auth, projectId)).note;
        if (!live) return;
        const ownerNote = owner.hits[0]?.note ?? null;
        const pinned: StarredNote[] = [
          ...(ownerNote ? [{ note: ownerNote, owner: true }] : []),
          ...(project && project.id !== ownerNote?.id ? [{ note: project, owner: false }] : []),
          ...(daily[0] ? [{ note: daily[0], owner: false }] : []),
        ];
        setStarred(pinned);
        setTabs({ tabs: [{ kind: 'graph' }, ...pinned.map(({ note }): VaultTab => ({ kind: 'note', noteId: note.id, mode: 'read', full: false }))], active: 0 });
        setToken(auth);
      } catch (caught) {
        if (live) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => { live = false; };
  }, [visible, token]);

  // Lazily fetch whatever the active tab or the graph selection needs.
  useEffect(() => {
    if (token === null || activeTab === null) return;
    if ((activeTab.kind === 'note' || activeTab.kind === 'diff') && !details.has(activeTab.noteId)) void loadDetail(token, activeTab.noteId).catch(report);
    if (activeTab.kind === 'diff' && !diffs.has(diffKey(activeTab.noteId, activeTab.revision))) {
      const { noteId, revision } = activeTab;
      void Promise.all([getVaultRevision(token, noteId, revision), revision > 1 ? getVaultRevision(token, noteId, revision - 1) : null])
        .then(([after, previous]) => setDiffs((current) => withEntry(current, diffKey(noteId, revision), { revision: after, before: previous?.body ?? null })), report);
    }
  }, [token, activeTab, details, diffs]);

  const activeKind = activeTab?.kind ?? null;
  useEffect(() => {
    if (token !== null && activeKind === 'review') void getVaultReview(token, REVIEW_LIMIT).then(setReview, report);
  }, [token, activeKind]);

  useEffect(() => {
    if (token !== null && graphSelection !== null && !details.has(graphSelection)) void loadDetail(token, graphSelection).catch(report);
  }, [token, graphSelection, details]);

  const activeRevision = activeDetail?.note.revision ?? null;
  useEffect(() => {
    if (token === null || activeNoteId === null || activeRevision === null) return;
    if (right !== 'history' || revisions.has(activeNoteId)) return;
    void listVaultRevisions(token, activeNoteId).then((list) => setRevisions((current) => withEntry(current, activeNoteId, list)), report);
  }, [token, activeNoteId, activeRevision, right, revisions]);

  useEffect(() => {
    if (token === null || activeNoteId === null || activeRevision === null || right !== 'graph') return;
    setLocalGraph(null);
    void getVaultLocalGraph(token, activeNoteId, localDepth).then(setLocalGraph, report);
  }, [token, activeNoteId, activeRevision, right, localDepth]);

  useEffect(() => {
    if (token === null || right !== 'links' || activeDetail === null) return;
    const { note, backlinks } = activeDetail;
    if (note.title.length < UNLINKED_MIN_TITLE) { setUnlinked([]); return; }
    const linked = new Set(backlinks.map((backlink) => backlink.note.id));
    void searchVault(token, note.title, UNLINKED_SEARCH_LIMIT).then((result) => setUnlinked(result.hits
      .map((hit) => hit.note).filter((hit) => hit.id !== note.id && !linked.has(hit.id)).slice(0, UNLINKED_SHOWN)), report);
  }, [token, right, activeDetail]);

  useEffect(() => {
    if (token === null) return;
    const missing = [...expanded].filter((folder) => !folderNotes.has(folder));
    for (const folder of missing) {
      void listVaultNotes(token, folder, showStubs, FOLDER_LIMIT).then((notes) => setFolderNotes((current) => withEntry(current, folder, notes)), report);
    }
  }, [token, expanded, folderNotes, showStubs]);

  useEffect(() => {
    const query = search.trim();
    setSearchResult(null);
    if (token === null || query.length === 0) return undefined;
    const timer = window.setTimeout(() => { void searchVault(token, query, SEARCH_LIMIT).then(setSearchResult, report); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [token, search]);

  const authed = (task: (auth: string) => Promise<void>) => {
    if (token !== null) void task(token).catch(report);
  };

  const actions: VaultActions = {
    openNote: (id, newTab) => setTabs((current) => openNoteTab(current, id, { newTab, mode: 'read' })),
    followLink: (target, newTab) => authed(async (auth) => {
      const id = await resolveVaultTitle(auth, target);
      if (id !== null) { setTabs((current) => openNoteTab(current, id, { newTab, mode: 'read' })); return; }
      await openCreated(auth, target);
      notify(`Created “${target}” from an unresolved link.`);
    }),
    searchTag: (tag) => setSearch(`tag:#${tag}`),
    toggleTask: (noteId, line) => authed(async (auth) => {
      const { note } = await loadDetail(auth, noteId);
      await writeBody(auth, note, toggleTask(note.body, line), 'Task updated.');
    }),
    triage: (noteId, line, action) => authed(async (auth) => {
      const { note } = await loadDetail(auth, noteId);
      try {
        await afterWrite(auth, await triageVaultFact(auth, note.id, { line, action, expectedRevision: note.revision }));
        notify(action === 'confirm' ? 'Kept.' : 'Dropped.');
      } catch (caught) {
        if (!(caught instanceof VaultRequestError && caught.code === 'conflict')) throw caught;
        await recoverConflict(auth, note.id);
      }
      if (activeTab?.kind === 'review') setReview(await getVaultReview(auth, REVIEW_LIMIT));
    }),
    showFull: () => setTabs((current) => setActiveNoteTab(current, { full: true })),
    jumpTo: (line) => {
      setTabs((current) => setActiveNoteTab(current, { full: true, mode: 'read' }));
      window.requestAnimationFrame(() => document.getElementById(`v-h-${line}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    },
    setMode: (mode) => setTabs((current) => setActiveNoteTab(current, { mode })),
    saveBody: (noteId, body) => authed(async (auth) => {
      const detail = details.get(noteId) ?? await loadDetail(auth, noteId);
      if (body !== detail.note.body) await writeBody(auth, detail.note, body, 'Saved as a new revision.');
      setTabs((current) => setActiveNoteTab(current, { mode: 'read' }));
    }),
    rename: (noteId, title) => authed(async (auth) => {
      const { note } = details.get(noteId) ?? await loadDetail(auth, noteId);
      const result = await renameVaultNote(auth, noteId, title, note.revision);
      await afterWrite(auth, result.note);
      notify(`Renamed. ${result.rewrittenLinks} links in ${result.rewrittenNotes} notes rewritten.`);
    }),
    linkMention: (sourceId, title) => authed(async (auth) => {
      const { note } = await loadDetail(auth, sourceId);
      const body = linkFirstMention(note.body, title);
      if (body === null) { notify(`No bare mention of “${title}” left in “${note.title}”.`, true); return; }
      await writeBody(auth, note, body, `Linked the mention in “${note.title}”.`);
    }),
    openDiff: (noteId, revision) => setTabs((current) => openSpecialTab(current, { kind: 'diff', noteId, revision })),
    restore: (noteId, revision) => authed(async (auth) => {
      const { note } = await loadDetail(auth, noteId);
      await afterWrite(auth, await restoreVaultRevision(auth, noteId, revision, note.revision));
      setTabs((current) => openNoteTab(current, noteId, { newTab: false, mode: 'read' }));
      notify(`Restored r${revision} as a new revision; nothing was deleted from history.`);
    }),
    activateTab: (tabIndex) => setTabs((current) => ({ ...current, active: tabIndex })),
    closeTab: (tabIndex) => setTabs((current) => closeTab(current, tabIndex)),
    openGraph: () => setTabs((current) => openSpecialTab(current, { kind: 'graph' })),
    openReview: () => setTabs((current) => openSpecialTab(current, { kind: 'review' })),
    openDaily: () => authed(async (auth) => {
      const [latest] = await listVaultNotes(auth, DAILY_FOLDER, false, 1);
      if (latest) setTabs((current) => openNoteTab(current, latest.id, { newTab: true, mode: 'read' }));
    }),
    newNote: () => authed(async (auth) => {
      const taken = new Set(index.nodes.map((node) => vaultKey(node.title)));
      let number = 1;
      while (taken.has(`untitled ${number}`)) number += 1;
      await openCreated(auth, `Untitled ${number}`);
    }),
    createNote: (title) => authed((auth) => openCreated(auth, title)),
    setSide: (next) => {
      setSide(next);
      if (next === 'search') searchInput.current?.focus(); else setSearch('');
    },
    setSearch,
    toggleFolder: (path) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    }),
    collapseAll: () => setExpanded(new Set()),
    toggleStubs: () => authed(async (auth) => {
      const next = !showStubs;
      setShowStubs(next);
      await refreshVault(auth, next);
    }),
    setRight,
    setLocalDepth,
    setGraphOptions: (patch) => setGraphOptions((current) => ({ ...current, ...patch })),
    selectGraphNode: setGraphSelection,
    rerunLayout: () => setLayoutSeed((seed) => seed + 1),
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
    hoverLink: (target: string, rect: VaultAnchorRect) => {
      window.clearTimeout(hoverTimer.current);
      const timer = window.setTimeout(() => authed(async (auth) => {
        const id = await resolveVaultTitle(auth, target);
        if (id === null) return;
        const detail = details.get(id) ?? await loadDetail(auth, id);
        const left = Math.min(window.innerWidth - HOVER_CARD_WIDTH, rect.left);
        const top = rect.bottom + HOVER_CARD_HEIGHT > window.innerHeight ? rect.top - HOVER_CARD_HEIGHT + 10 : rect.bottom + 6;
        // The pointer may have left while the note loaded; only the latest hover may show.
        if (hoverTimer.current === timer) setHover({ detail, left, top });
      }), HOVER_DELAY_MS);
      hoverTimer.current = timer;
    },
    clearHover: () => {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = 0;
      setHover(null);
    },
    exportVault: () => authed(async (auth) => {
      const url = URL.createObjectURL(await exportVaultArchive(auth));
      const link = document.createElement('a');
      link.href = url;
      link.download = `siftkit-vault-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    }),
    attachment: (target) => (token === null ? Promise.reject(new Error('The vault is not connected yet.')) : fetchVaultAttachment(token, target)),
  };

  // Vault shortcuts apply only while the tab is visible.
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const activeMode = activeTab?.kind === 'note' ? activeTab.mode : null;
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      const act = latestActions.current;
      if (key === 'o' || key === 'k') { event.preventDefault(); act.openPalette(); }
      else if (event.shiftKey && key === 'f') { event.preventDefault(); act.setSide('search'); }
      else if (key === 'e' && activeKind === 'note') { event.preventDefault(); act.setMode(activeMode === 'edit' ? 'read' : 'edit'); }
      else if (key === 'g') { event.preventDefault(); act.openGraph(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, activeKind, activeMode]);

  return {
    error, index, folderColorMap, noteColors, degrees, titles, folders, folderNotes, expanded, starred, showStubs, stats,
    side, search, searchResult, searchInput, tabs, details, revisions, diffs, review, right, localDepth, localGraph, unlinked,
    graphOptions, graphSelection, positions, layoutSeed, paletteOpen, hover, toast, nowMs: Date.now(), actions,
  };
}
