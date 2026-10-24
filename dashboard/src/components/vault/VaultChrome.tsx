import { useState, type KeyboardEvent } from 'react';
import { vaultKey, type VaultGraphNode, type VaultNoteDetail, type VaultStats } from '@siftkit/contracts';

import { rankTitles } from '../../lib/vault-edits.ts';
import { ago } from '../../lib/vault-time.ts';
import { NoteMarkdown } from './NoteMarkdown.tsx';
import type { VaultActions } from './vault-actions.ts';

const SWITCHER_LIMIT = 40;
const HOVER_PREVIEW_LINES = 18;
const num = (value: number) => value.toLocaleString('en-US');

export interface QuickSwitcherProps {
  readonly entries: readonly VaultGraphNode[];
  readonly actions: VaultActions;
}

/** Ctrl+O palette: fuzzy title match; Enter opens, Shift+Enter creates. Mounted only while open. */
export function QuickSwitcher(props: QuickSwitcherProps) {
  const { entries, actions } = props;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const trimmed = query.trim();
  const items = rankTitles(entries, trimmed, 'fuzzy', SWITCHER_LIMIT);
  const canCreate = trimmed.length > 0 && !entries.some((entry) => vaultKey(entry.title) === vaultKey(trimmed));
  const total = items.length + (canCreate ? 1 : 0);
  const pick = (index: number) => {
    actions.closePalette();
    const item = items[index];
    if (item) actions.openNote(item.id, true);
    else if (canCreate) actions.createNote(trimmed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((selected + 1) % Math.max(1, total)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((selected - 1 + total) % Math.max(1, total)); }
    if (event.key === 'Enter') { event.preventDefault(); pick(event.shiftKey ? items.length : selected); }
    if (event.key === 'Escape') actions.closePalette();
  };
  return (
    <div className="v-palette-bg" onClick={(event) => { if (event.target === event.currentTarget) actions.closePalette(); }}>
      <div className="v-palette">
        <input autoFocus placeholder="Find or create a note…" value={query} onKeyDown={onKeyDown} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} />
        <div className="v-list">
          {items.map((item, index) => (
            <div key={item.id} className={`v-item${index === selected ? ' v-sel' : ''}`} onClick={() => pick(index)}>
              <span>{item.title}</span><small>{item.folder || '/'}</small>
            </div>
          ))}
          {canCreate && (
            <div className={`v-item${selected === items.length ? ' v-sel' : ''}`} onClick={() => pick(items.length)}>
              <span>＋ Create “{trimmed}”</span><small>Shift+Enter</small>
            </div>
          )}
        </div>
        <div className="v-palette-hint">↑↓ navigate · Enter open · Shift+Enter create · Esc close</div>
      </div>
    </div>
  );
}

export interface VaultHover {
  readonly detail: VaultNoteDetail;
  readonly left: number;
  readonly top: number;
}

export function HoverCard(props: { readonly hover: VaultHover; readonly degree: number; readonly colors: ReadonlyMap<string, string>; readonly nowMs: number; readonly actions: VaultActions }) {
  const { hover, degree, colors, nowMs, actions } = props;
  const { note } = hover.detail;
  return (
    <div className="v-hover-card" style={{ left: hover.left, top: hover.top }}>
      <h1>{note.title}</h1>
      <div className="v-hover-meta">{note.folder || '/'} · {num(degree)} links · updated {ago(note.updatedAtUtc, nowMs)}</div>
      <NoteMarkdown body={note.body} unresolved={new Set(hover.detail.outgoing.unresolved.map(vaultKey))} colors={colors} limit={HOVER_PREVIEW_LINES} full={false} noteId={null} actions={actions} />
    </div>
  );
}

export interface StatusBarProps {
  readonly stats: VaultStats | null;
  readonly activeBody: string | null;
  readonly activeDegree: number;
  readonly actions: VaultActions;
}

export function StatusBar(props: StatusBarProps) {
  const { stats, activeBody, activeDegree, actions } = props;
  return (
    <footer className="v-status">
      {stats !== null && <span><b>{num(stats.notes)}</b> notes · <b>{num(stats.notesWithUnverified)}</b> with unverified facts · <b>{num(stats.links)}</b> links</span>}
      <span className="v-grow" />
      {activeBody !== null && <span>{num(activeBody.split('\n').length)} lines · {num(activeDegree)} links</span>}
      <button type="button" onClick={() => actions.exportVault()}>Export as .md</button>
    </footer>
  );
}
