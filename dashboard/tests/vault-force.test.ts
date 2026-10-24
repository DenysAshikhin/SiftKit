import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { VaultGraph, VaultGraphNode } from '@siftkit/contracts';
import { buildSimGraph, filterGraph, fitView, folderColors, pickNode, FOLDER_PALETTE } from '../src/lib/vault-force.ts';

const node = (id: string, topFolder: string, degree: number): VaultGraphNode => ({ id, title: id, folder: topFolder, topFolder, kind: 'entity', degree });

function hubGraph(): VaultGraph {
  const leaves = Array.from({ length: 300 }, (_, index) => node(`leaf${index}`, 'People', 1));
  const chain = Array.from({ length: 20 }, (_, index) => node(`chain${index}`, 'Topics', 2));
  return {
    nodes: [node('hub', 'Software', 301), ...leaves, ...chain],
    edges: [
      ...leaves.map((leaf) => ({ source: 'hub', target: leaf.id })),
      { source: 'hub', target: 'chain0' },
      ...chain.slice(1).map((link, index) => ({ source: `chain${index}`, target: link.id })),
    ],
  };
}

test('the simulation stays finite and settles with a 300-leaf hub', () => {
  const graph = hubGraph();
  const sim = buildSimGraph(graph, folderColors(graph.nodes.map((entry) => entry.topFolder)), null, new Map());
  for (let tick = 0; tick < 300; tick += 1) sim.tick();
  assert.ok(sim.nodes.every((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y)));
  assert.ok(sim.alpha < 0.02);
  const hub = sim.nodes.find((entry) => entry.id === 'hub');
  assert.ok(hub && Math.hypot(hub.x, hub.y) < 200);
});

test('buildSimGraph counts degree inside the subgraph, sizes radii from it and reuses known positions', () => {
  const graph: VaultGraph = { nodes: [node('a', 'X', 9), node('b', 'X', 9), node('c', 'Y', 9)], edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }] };
  const sim = buildSimGraph(graph, folderColors(['X', 'Y']), 'b', new Map([['a', { x: 5, y: 6 }]]));
  const [a, b, c] = sim.nodes;
  assert.equal(a?.degree, 2);
  assert.equal(c?.degree, 1);
  assert.equal(a?.r, 2.5 + Math.sqrt(2) * 1.1);
  assert.deepEqual([a?.x, a?.y], [5, 6]);
  assert.equal(b?.current, true);
  assert.deepEqual(a?.neighbors.map((entry) => entry.id), ['b', 'c']);
  assert.equal(sim.edges.length, 2);
});

test('fitView centres the bounds, clamps the zoom and leaves room on the right', () => {
  const nodes = [{ x: -100, y: -50 }, { x: 100, y: 50 }];
  assert.deepEqual(fitView(nodes, { width: 800, height: 600 }, 0), { x: -0, y: -0, k: 2.2 });
  const wide = [{ x: -1000, y: -10 }, { x: 3000, y: 10 }];
  const view = fitView(wide, { width: 800, height: 600 }, 280);
  assert.deepEqual(view, { x: -1000 * 0.15 - 140, y: -0, k: 0.15 });
  assert.equal(fitView([], { width: 800, height: 600 }, 0), null);
});

test('pickNode returns the nearest node within its hit radius', () => {
  const graph: VaultGraph = { nodes: [node('a', 'X', 0), node('b', 'X', 0)], edges: [] };
  const sim = buildSimGraph(graph, folderColors(['X']), null, new Map([['a', { x: 0, y: 0 }], ['b', { x: 50, y: 0 }]]));
  assert.equal(pickNode(sim.nodes, { x: 1, y: 1 }, 1)?.id, 'a');
  assert.equal(pickNode(sim.nodes, { x: 25, y: 0 }, 1), null);
});

test('folderColors assigns the palette in sorted folder order', () => {
  const colors = folderColors(['b', 'a', 'b']);
  assert.equal(colors.get('a'), FOLDER_PALETTE[0]);
  assert.equal(colors.get('b'), FOLDER_PALETTE[1]);
});

test('filterGraph drops hidden folders and low-degree notes along with their edges', () => {
  const graph: VaultGraph = {
    nodes: [node('a', 'Keep', 3), node('b', 'Daily', 3), node('c', 'Keep', 1)],
    edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
  };
  assert.deepEqual(filterGraph(graph, new Set(['Daily']), 2), { nodes: [node('a', 'Keep', 3)], edges: [] });
  assert.equal(filterGraph(graph, new Set(), 0).edges.length, 2);
});
