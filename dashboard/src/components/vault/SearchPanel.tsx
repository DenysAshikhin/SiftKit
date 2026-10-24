import type { ReactNode } from 'react';
import type { VaultSearchResult } from '@siftkit/contracts';

import type { VaultActions } from './vault-actions.ts';

const FILTER_PATTERN = /\b(tag|path|type):\S*/g;

/** Wraps every case-insensitive occurrence of `term` in `<mark>`. */
function Highlighted(props: { readonly text: string; readonly term: string }): ReactNode {
  const { text, term } = props;
  if (term.length === 0) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, cursor)) {
    parts.push(text.slice(cursor, at), <mark key={at}>{text.slice(at, at + term.length)}</mark>);
    cursor = at + term.length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

export function SearchPanel(props: { readonly query: string; readonly result: VaultSearchResult | null; readonly actions: VaultActions }) {
  const { query, result, actions } = props;
  if (query.trim().length === 0) {
    return (
      <div className="v-empty">
        Type to search titles, aliases and note text.<br /><br />
        Filters: <code>tag:#unverified</code> <code>path:Software</code> <code>type:device</code>
      </div>
    );
  }
  if (result === null) return <div className="v-empty">Searching…</div>;
  const term = query.replace(FILTER_PATTERN, '').trim().toLowerCase();
  return (
    <div className="v-results">
      <div className="v-summary">
        {result.total.toLocaleString('en-US')} notes{result.total > result.hits.length && ` · showing ${result.hits.length}`}
      </div>
      {result.hits.map((hit) => (
        <div key={hit.note.id} className="v-hit" onClick={(event) => actions.openNote(hit.note.id, event.ctrlKey || event.metaKey)}>
          <div className="v-hit-title"><Highlighted text={hit.note.title} term={term} /></div>
          <div className="v-hit-path">{hit.note.folder || '/'}</div>
          {hit.snippet !== null && <div className="v-hit-snippet"><Highlighted text={hit.snippet} term={term} /></div>}
        </div>
      ))}
    </div>
  );
}
