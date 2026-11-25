import React from 'react';

import type { OrchestratorRunState } from '@siftkit/contracts';

import { usePaneFollow } from '../hooks/usePaneFollow.ts';
import { formatClock, runLine } from '../orchestrator-view.ts';

/** Past lines shown while folded; CSS fades them with age. */
const PAST_SHOWN = 3;

/** Where the whole run is, in the orchestrator's words: the current line, with the past ones above it. */
export function OrchestratorRunLine({ state }: { state: OrchestratorRunState }) {
  const { current, past } = runLine(state);
  const [expanded, setExpanded] = React.useState(false);
  const [cut, setCut] = React.useState(false);
  const { paneRef, onScroll } = usePaneFollow<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLOListElement>(null);
  React.useLayoutEffect(() => {
    const lines = [...listRef.current?.querySelectorAll('p') ?? []];
    if (!expanded) setCut(lines.some((line) => line.scrollWidth > line.clientWidth));
  });
  if (current === null) return null;
  const shown = expanded ? past : past.slice(-PAST_SHOWN);
  return (
    <section className="orch-now" aria-label="Where the run is">
      {past.length > PAST_SHOWN || cut || expanded ? (
        <button type="button" className="orch-now-all" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${past.length + 1} updates`}
        </button>
      ) : null}
      {past.length === 0 ? null : (
        <div className={expanded ? 'orch-now-past all' : 'orch-now-past'} ref={paneRef} onScroll={onScroll}
          {...(expanded ? { tabIndex: 0, role: 'region', 'aria-label': 'All updates' } : {})}>
          <ol ref={listRef}>
            {shown.map((line, index) => (
              <li key={`${past.length - shown.length + index}`}><p title={line.text}>{line.text}</p><time>{formatClock(line.atUtc)}</time></li>
            ))}
          </ol>
        </div>
      )}
      <div className="orch-now-current">
        <p>{current.text}</p>
        {current.atUtc === null ? null : <time>{formatClock(current.atUtc)}</time>}
      </div>
    </section>
  );
}
