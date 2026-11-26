import { useState, type KeyboardEvent } from 'react';
import type { VaultGraphNode, VaultNote } from '@siftkit/contracts';

import { insertLink, linkQueryAt, rankTitles } from '../../lib/vault-edits.ts';
import type { VaultDraft } from '../../lib/vault-tabs.ts';
import type { VaultActions } from './vault-actions.ts';

const AUTOCOMPLETE_LIMIT = 12;

/** Plain-text body editor over the note's draft, kept in its tab; typing `[[` offers matching note titles, Ctrl+S saves. */
export function NoteEditor(props: {
  readonly note: VaultNote; readonly draft: VaultDraft | null; readonly entries: readonly VaultGraphNode[]; readonly actions: VaultActions;
}) {
  const { note, draft, entries, actions } = props;
  const value = draft?.body ?? note.body;
  const setValue = (next: string) => actions.setDraft(note.id, next === note.body ? null : { body: next, revision: draft?.revision ?? note.revision });
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [caret, setCaret] = useState(0);
  const matches = query === null ? [] : rankTitles(entries, query, 'contains', AUTOCOMPLETE_LIMIT);

  const track = (next: string, position: number) => {
    setValue(next);
    setCaret(position);
    setQuery(linkQueryAt(next, position));
    setSelected(0);
  };
  const pick = (title: string) => {
    const inserted = insertLink(value, caret, title);
    setValue(inserted.value);
    setCaret(inserted.caret);
    setQuery(null);
  };
  const save = () => actions.saveDraft(note.id);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
    if (matches.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((selected + 1) % matches.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((selected - 1 + matches.length) % matches.length); }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(matches[selected]?.title ?? ''); }
    if (event.key === 'Escape') setQuery(null);
  };

  return (
    <>
      <div className="v-editor-wrap">
        <textarea
          className="v-editor" spellCheck={false} autoFocus value={value} onKeyDown={onKeyDown}
          onChange={(event) => track(event.target.value, event.target.selectionStart)}
        />
        {query !== null && (
          <div className="v-ac">
            {matches.length === 0 ? <div>Create “{query}” by saving the link</div> : matches.map((entry, index) => (
              <div key={entry.id} className={index === selected ? 'v-sel' : undefined} onMouseDown={(event) => { event.preventDefault(); pick(entry.title); }}>
                {entry.title}<small>{entry.folder}</small>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="v-edit-bar">
        <button type="button" className="v-btn v-primary" onClick={save}>Save · creates a revision</button>
        <button type="button" className="v-btn" onClick={() => { actions.setDraft(note.id, null); actions.setMode('read'); }}>Cancel</button>
        <span>Type <code>[[</code> to link a note · Ctrl+S saves</span>
      </div>
    </>
  );
}
