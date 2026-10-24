import { useMemo } from 'react';
import { VAULT_LOCAL_GRAPH_CAP, type VaultGraph, type VaultLocalGraphDepth } from '@siftkit/contracts';

import { filterGraph, type Point } from '../../lib/vault-force.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import type { VaultActions, VaultGraphOptions } from './vault-actions.ts';

const GLOBAL_PREWARM_TICKS = 230;
const LOCAL_PREWARM_TICKS = 200;
const CONTROL_PANEL_RESERVE_PX = 280;
const MAX_MIN_DEGREE = 10;
const folderLabel = (topFolder: string): string => topFolder || '(root)';
const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

export interface GraphViewProps {
  readonly graph: VaultGraph;
  readonly colors: ReadonlyMap<string, string>;
  readonly options: VaultGraphOptions;
  readonly selectedId: string | null;
  readonly positions: Map<string, Point>;
  readonly layoutSeed: number;
  readonly actions: VaultActions;
}

export function GraphView(props: GraphViewProps) {
  const { graph, colors, options, selectedId, positions, layoutSeed, actions } = props;
  const visible = useMemo(() => filterGraph(graph, options.hidden, options.minDegree), [graph, options.hidden, options.minDegree]);
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) counts.set(node.topFolder, (counts.get(node.topFolder) ?? 0) + 1);
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [graph]);
  const toggleFolder = (folder: string, shown: boolean) => {
    const hidden = new Set(options.hidden);
    if (shown) hidden.delete(folder); else hidden.add(folder);
    actions.setGraphOptions({ hidden });
  };

  return (
    <div className="v-graph-wrap">
      <GraphCanvas
        graph={visible} colors={colors} currentId={null} selectedId={selectedId} filterText={options.filterText} labels={options.labels}
        reserveRight={CONTROL_PANEL_RESERVE_PX} prewarmTicks={GLOBAL_PREWARM_TICKS} ticksPerFrame={2} positions={positions} layoutSeed={layoutSeed}
        onSelect={(id) => actions.selectGraphNode(id)} onOpen={(id) => actions.openNote(id, true)}
      />
      <div className="v-graph-ctl">
        <input type="text" placeholder="Highlight notes…" value={options.filterText} onChange={(event) => actions.setGraphOptions({ filterText: event.target.value })} />
        <h4>Folders</h4>
        <div>
          {folderCounts.map(([folder, count]) => (
            <label key={folder}>
              <input type="checkbox" checked={!options.hidden.has(folder)} onChange={(event) => toggleFolder(folder, event.target.checked)} />
              <span className="v-dot" style={{ background: colors.get(folder) }} />{folderLabel(folder)}<small>{count.toLocaleString('en-US')}</small>
            </label>
          ))}
        </div>
        <h4>Minimum links: {options.minDegree}</h4>
        <input type="range" min={0} max={MAX_MIN_DEGREE} value={options.minDegree} onChange={(event) => actions.setGraphOptions({ minDegree: Number(event.target.value) })} />
        <label><input type="checkbox" checked={options.labels} onChange={(event) => actions.setGraphOptions({ labels: event.target.checked })} /> Labels</label>
        <button type="button" className="v-btn v-wide" onClick={() => actions.rerunLayout()}>Re-run layout</button>
      </div>
      <div className="v-graph-info">
        {plural(visible.nodes.length, 'note')} · {plural(visible.edges.length, 'link')} · click to preview · double-click to open · scroll to zoom · drag to pan
      </div>
    </div>
  );
}

export interface LocalGraphProps {
  readonly graph: VaultGraph | null;
  readonly colors: ReadonlyMap<string, string>;
  readonly centerId: string;
  readonly depth: VaultLocalGraphDepth;
  readonly actions: VaultActions;
}

export function LocalGraph(props: LocalGraphProps) {
  const { graph, colors, centerId, depth, actions } = props;
  const positions = useMemo(() => new Map<string, Point>(), [graph]);
  return (
    <>
      <div className="v-lg-ctl">
        Depth
        <select value={depth} onChange={(event) => actions.setLocalDepth(event.target.value === '2' ? 2 : 1)}>
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
        <span className="v-push">click a node to open</span>
      </div>
      <div className="v-local-graph">
        {graph !== null && (
          <GraphCanvas
            graph={graph} colors={colors} currentId={centerId} selectedId={null} filterText="" labels
            reserveRight={0} prewarmTicks={LOCAL_PREWARM_TICKS} ticksPerFrame={3} positions={positions} layoutSeed={0}
            onSelect={(id) => actions.openNote(id, false)} onOpen={(id) => actions.openNote(id, true)}
          />
        )}
      </div>
      <div className="v-lg-ctl">
        {graph === null ? 'Loading…' : `${plural(graph.nodes.length, 'note')} within ${depth} hop${depth > 1 ? 's' : ''}${graph.nodes.length >= VAULT_LOCAL_GRAPH_CAP ? ` (capped at ${VAULT_LOCAL_GRAPH_CAP})` : ''}`}
      </div>
    </>
  );
}
