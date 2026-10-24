import { useState } from 'react';
import { vaultKey, type VaultBacklink, type VaultGraphNode, type VaultNoteDetail } from '@siftkit/contracts';

import { contextGroups } from '../../lib/vault-edits.ts';
import { MAX_RENDER_LINES } from '../../lib/vault-blocks.ts';
import type { VaultNoteMode } from '../../lib/vault-tabs.ts';
import { ago, fmtTime } from '../../lib/vault-time.ts';
import { NoteEditor } from './NoteEditor.tsx';
import { NoteMarkdown, PillList } from './NoteMarkdown.tsx';
import type { VaultActions } from './vault-actions.ts';

const ALIASES_SHOWN = 5;
const CONTEXT_NOTES_SHOWN = 12;
export const OWNER_TAG = 'me';

/** "Where it shows up": linking notes grouped by the fact row they link from. */
export function ContextCard(props: { readonly backlinks: readonly VaultBacklink[]; readonly colors: ReadonlyMap<string, string>; readonly actions: VaultActions }) {
  const groups = contextGroups(props.backlinks);
  if (groups.length === 0) return null;
  const ctx = { unresolved: new Set<string>(), colors: props.colors, noteId: null, actions: props.actions };
  return (
    <div className="v-ctx-card">
      <h4>Where it shows up</h4>
      <div className="v-facts v-bare">
        {groups.map((group) => (
          <div key={group.label} className="v-frow">
            <span className="v-flabel">{group.label} ←</span>
            <span className="v-fvals">
              <PillList values={group.notes.slice(0, CONTEXT_NOTES_SHOWN).map((note) => `[[${note.title}]]`)} ctx={ctx} />
              {group.notes.length > CONTEXT_NOTES_SHOWN && <small className="v-hint">+{group.notes.length - CONTEXT_NOTES_SHOWN}</small>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface NoteViewProps {
  readonly detail: VaultNoteDetail;
  readonly mode: VaultNoteMode;
  readonly full: boolean;
  readonly colors: ReadonlyMap<string, string>;
  readonly entries: readonly VaultGraphNode[];
  readonly nowMs: number;
  readonly actions: VaultActions;
}

export function NoteView(props: NoteViewProps) {
  const { detail, mode, full, colors, entries, nowMs, actions } = props;
  const { note } = detail;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(note.title);
  const finishRename = () => {
    setRenaming(false);
    if (draft.trim() !== note.title) actions.rename(note.id, draft.trim());
  };
  const showContext = note.kind !== 'capture' && note.kind !== 'daily' && !note.tags.includes(OWNER_TAG);
  const revisions = `${note.revision} revision${note.revision === 1 ? '' : 's'}`;

  return (
    <article className="v-note">
      <div className="v-crumbs">
        {(note.folder ? note.folder.split('/') : ['vault']).map((part, index) => <span key={index}>{part}<span className="v-sep"> /</span></span>)}
        <span>{note.title}</span>
      </div>
      <div className="v-note-head">
        {renaming ? (
          <input
            className="v-title-input" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') { setDraft(note.title); setRenaming(false); }
            }}
          />
        ) : <h1 title="Click to rename" onClick={() => { setDraft(note.title); setRenaming(true); }}>{note.title}</h1>}
        <div className="v-seg">
          <button type="button" className={mode === 'read' ? 'v-on' : undefined} onClick={() => actions.setMode('read')}>Read</button>
          <button type="button" className={mode === 'edit' ? 'v-on' : undefined} onClick={() => actions.setMode('edit')}>Edit</button>
        </div>
      </div>
      {note.aliases.length > 0 && (
        <div className="v-aka">
          also known as {note.aliases.slice(0, ALIASES_SHOWN).map((alias, index) => <span key={alias}>{index > 0 && ', '}<b>{alias}</b></span>)}
          {note.aliases.length > ALIASES_SHOWN && ` and ${note.aliases.length - ALIASES_SHOWN} more`}
        </div>
      )}
      {mode === 'edit' ? <NoteEditor key={note.revision} note={note} entries={entries} actions={actions} /> : (
        <>
          <NoteMarkdown
            body={note.body} unresolved={new Set(detail.outgoing.unresolved.map(vaultKey))} colors={colors}
            limit={MAX_RENDER_LINES} full={full} noteId={note.id} actions={actions}
          />
          {showContext && <ContextCard backlinks={detail.backlinks} colors={colors} actions={actions} />}
        </>
      )}
      <details className="v-props">
        <summary>Properties · {note.types[0] ?? note.kind} · {revisions} · updated {ago(note.updatedAtUtc, nowMs)}</summary>
        <table>
          <tbody>
            <tr><td>kind</td><td>{note.kind}</td></tr>
            {note.types.length > 0 && <tr><td>type</td><td>{note.types.map((type) => <span key={type} className="v-chip">{type}</span>)}</td></tr>}
            {note.aliases.length > 0 && <tr><td>aliases</td><td>{note.aliases.map((alias) => <span key={alias} className="v-chip">{alias}</span>)}</td></tr>}
            {note.tags.length > 0 && <tr><td>tags</td><td>{note.tags.map((tag) => <span key={tag} className="v-chip">#{tag}</span>)}</td></tr>}
            <tr><td>created</td><td>{fmtTime(note.createdAtUtc)}</td></tr>
            <tr><td>updated</td><td>{fmtTime(note.updatedAtUtc)} · {ago(note.updatedAtUtc, nowMs)}</td></tr>
            <tr><td>history</td><td>{revisions}</td></tr>
          </tbody>
        </table>
      </details>
    </article>
  );
}
