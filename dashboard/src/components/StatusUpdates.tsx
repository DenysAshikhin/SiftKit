import React from 'react';

import type { StatusUpdate } from '../lib/chatTurns.ts';
import { plural } from '../lib/format.ts';

/** What the agent said it was doing: live, the newest update with the earlier ones folded; settled, the whole list folded. */
export function StatusUpdates({ updates, live }: { updates: readonly StatusUpdate[]; live: boolean }) {
  if (live) {
    const current = updates.at(-1);
    if (current === undefined) return null;
    const earlier = updates.slice(0, -1);
    return (
      <section className="status-updates" aria-label="Status updates">
        {earlier.length === 0 ? null : (
          <details>
            <summary>Earlier updates ({earlier.length})</summary>
            <UpdateList updates={earlier} />
          </details>
        )}
        <p className={current.callsSince === 0 ? 'status-update' : 'status-update past'}>{current.text}</p>
        {current.callsSince === 0 ? null : <small>{`${plural(current.callsSince, 'tool call')} ago`}</small>}
      </section>
    );
  }
  if (updates.length === 0) return null;
  return (
    <details className="status-updates">
      <summary>Updates ({updates.length})</summary>
      <UpdateList updates={updates} />
    </details>
  );
}

function UpdateList({ updates }: { updates: readonly StatusUpdate[] }) {
  return <ol>{updates.map((update) => <li key={update.updateId}>{update.text}</li>)}</ol>;
}
