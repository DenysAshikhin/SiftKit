export type VaultNoteMode = 'read' | 'edit';

/** Unsaved text of one note, and the revision it was typed over. */
export interface VaultDraft {
  readonly body: string;
  readonly revision: number;
}

export type VaultTab =
  | { readonly kind: 'graph' }
  | { readonly kind: 'review' }
  | { readonly kind: 'note'; readonly noteId: string; readonly mode: VaultNoteMode; readonly full: boolean; readonly draft: VaultDraft | null }
  | { readonly kind: 'diff'; readonly noteId: string; readonly revision: number };

export type VaultSpecialTab = Exclude<VaultTab, { kind: 'note' }>;

export interface VaultTabsState {
  readonly tabs: readonly VaultTab[];
  readonly active: number;
}

const replaceAt = (tabs: readonly VaultTab[], index: number, tab: VaultTab) => tabs.map((current, at) => (at === index ? tab : current));

/** Mirrors the mockup: reuse an open tab, else replace a read-mode note tab without a draft, else push a new one. */
export function openNoteTab(state: VaultTabsState, noteId: string, options: { readonly newTab: boolean; readonly mode: VaultNoteMode }): VaultTabsState {
  const existing = state.tabs.findIndex((tab) => tab.kind === 'note' && tab.noteId === noteId);
  const fresh: VaultTab = { kind: 'note', noteId, mode: options.mode, full: false, draft: null };
  if (existing >= 0) {
    const opened = { ...state, active: existing };
    return options.mode === 'edit' ? setActiveNoteTab(opened, { mode: 'edit' }) : opened;
  }
  const current = state.tabs[state.active];
  if (!options.newTab && current?.kind === 'note' && current.mode === 'read' && current.draft === null) return { ...state, tabs: replaceAt(state.tabs, state.active, fresh) };
  return { tabs: [...state.tabs, fresh], active: state.tabs.length };
}

export function openSpecialTab(state: VaultTabsState, tab: VaultSpecialTab): VaultTabsState {
  const existing = state.tabs.findIndex((current) => current.kind === tab.kind
    && (current.kind !== 'diff' || tab.kind !== 'diff' || (current.noteId === tab.noteId && current.revision === tab.revision)));
  return existing >= 0 ? { ...state, active: existing } : { tabs: [...state.tabs, tab], active: state.tabs.length };
}

export function closeTab(state: VaultTabsState, index: number): VaultTabsState {
  const tabs = state.tabs.filter((_tab, at) => at !== index);
  return { tabs, active: Math.min(state.active, tabs.length - 1) };
}

export function setActiveNoteTab(state: VaultTabsState, patch: { readonly mode?: VaultNoteMode; readonly full?: boolean }): VaultTabsState {
  const current = state.tabs[state.active];
  if (current?.kind !== 'note') return state;
  return { ...state, tabs: replaceAt(state.tabs, state.active, { ...current, ...patch }) };
}

export function tabLabel(tab: VaultTab, titles: ReadonlyMap<string, string>): string {
  if (tab.kind === 'graph') return '◎ Graph view';
  if (tab.kind === 'review') return '✓ Review';
  const title = titles.get(tab.noteId) ?? '…';
  if (tab.kind === 'diff') return `⟲ ${title} · r${tab.revision}`;
  return tab.mode === 'edit' || tab.draft !== null ? `✎ ${title}` : title;
}

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
