import type { VaultGraph } from '@siftkit/contracts';

export const FOLDER_PALETTE = ['#2fbfa0', '#3d8fd6', '#e6b566', '#ef7d7d', '#c9a0ff', '#9cd6ff', '#7fd35a', '#ff9f5a', '#e57bd1', '#6fc7c1', '#b8c46a', '#8f9cff'] as const;
const UNKNOWN_COLOR = '#3a4c61';
// Force constants from the mockup's d3-style step.
const CELL = 110;
const REPULSION = 60;
const MIN_DIST2 = 25;
const GRAVITY = 0.008;
const SPRING_LENGTH = 40;
const SPRING_STRENGTH = 0.5;
const MAX_VELOCITY = 30;
const DAMPING = 0.6;
const ALPHA_DECAY = 0.985;
const SEED_SPACING = 12;
const GOLDEN_ANGLE = 2.39996;
const FIT_PADDING = 80;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.2;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface SimNode {
  readonly id: string;
  readonly title: string;
  readonly color: string;
  readonly degree: number;
  readonly r: number;
  readonly current: boolean;
  readonly neighbors: SimNode[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

export interface SimEdge {
  readonly source: SimNode;
  readonly target: SimNode;
}

export interface GraphViewport {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

const clampVelocity = (value: number) => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, value * DAMPING));

/** Grid-bounded repulsion, gravity and degree-biased springs; hubs barely move, so layouts settle fast. */
export class ForceSimulation {
  readonly nodes: readonly SimNode[];
  readonly edges: readonly SimEdge[];
  alpha = 1;

  constructor(nodes: readonly SimNode[], edges: readonly SimEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
  }

  tick(): void {
    const alpha = this.alpha;
    const grid = new Map<string, SimNode[]>();
    const cellKey = (x: number, y: number) => `${x},${y}`;
    for (const node of this.nodes) {
      const key = cellKey(Math.floor(node.x / CELL), Math.floor(node.y / CELL));
      const bucket = grid.get(key);
      if (bucket) bucket.push(node); else grid.set(key, [node]);
    }
    for (const node of this.nodes) {
      const cx = Math.floor(node.x / CELL);
      const cy = Math.floor(node.y / CELL);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const other of grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
            if (other === node) continue;
            let x = node.x - other.x;
            let y = node.y - other.y;
            const d2 = x * x + y * y;
            if (d2 > CELL * CELL) continue;
            if (d2 === 0) { x = Math.random() - 0.5; y = Math.random() - 0.5; }
            const force = (REPULSION * alpha) / Math.max(d2, MIN_DIST2);
            node.vx += x * force;
            node.vy += y * force;
          }
        }
      }
      node.vx -= node.x * GRAVITY * alpha;
      node.vy -= node.y * GRAVITY * alpha;
    }
    for (const { source, target } of this.edges) {
      let x = target.x + target.vx - source.x - source.vx;
      let y = target.y + target.vy - source.y - source.vy;
      const distance = Math.sqrt(x * x + y * y) || 1;
      const strength = ((distance - SPRING_LENGTH) / distance) * alpha * (SPRING_STRENGTH / Math.max(1, Math.min(source.degree, target.degree)));
      x *= strength;
      y *= strength;
      const bias = source.degree / (source.degree + target.degree || 1);
      target.vx -= x * bias;
      target.vy -= y * bias;
      source.vx += x * (1 - bias);
      source.vy += y * (1 - bias);
    }
    for (const node of this.nodes) {
      if (node.fixed) { node.vx = 0; node.vy = 0; continue; }
      node.vx = clampVelocity(node.vx);
      node.vy = clampVelocity(node.vy);
      node.x += node.vx;
      node.y += node.vy;
    }
    this.alpha = Math.max(0, alpha * ALPHA_DECAY);
  }
}

export function folderColors(topFolders: readonly string[]): Map<string, string> {
  return new Map([...new Set(topFolders)].sort().map((folder, index) => [folder, FOLDER_PALETTE[index % FOLDER_PALETTE.length] ?? UNKNOWN_COLOR]));
}

export function filterGraph(graph: VaultGraph, hiddenTopFolders: ReadonlySet<string>, minDegree: number): VaultGraph {
  const nodes = graph.nodes.filter((node) => !hiddenTopFolders.has(node.topFolder) && node.degree >= minDegree);
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
}

/** Builds simulation nodes; known positions are kept, new nodes get phyllotaxis seeds with hubs in the middle. */
export function buildSimGraph(
  graph: VaultGraph, colors: ReadonlyMap<string, string>, currentId: string | null, positions: ReadonlyMap<string, Point>,
): ForceSimulation {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const seedOrder = new Map([...graph.nodes].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0)).map((node, index) => [node.id, index]));
  const nodes = graph.nodes.map((entry): SimNode => {
    const deg = degree.get(entry.id) ?? 0;
    const seedIndex = seedOrder.get(entry.id) ?? 0;
    const radius = SEED_SPACING * Math.sqrt(seedIndex + 0.5);
    const known = positions.get(entry.id);
    return {
      id: entry.id, title: entry.title, color: colors.get(entry.topFolder) ?? UNKNOWN_COLOR, degree: deg, r: 2.5 + Math.sqrt(deg) * 1.1,
      current: entry.id === currentId, neighbors: [], fixed: false, vx: 0, vy: 0,
      x: known?.x ?? radius * Math.cos(seedIndex * GOLDEN_ANGLE), y: known?.y ?? radius * Math.sin(seedIndex * GOLDEN_ANGLE),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: SimEdge[] = [];
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    source.neighbors.push(target);
    target.neighbors.push(source);
    edges.push({ source, target });
  }
  return new ForceSimulation(nodes, edges);
}

/** Fits the laid-out nodes into the canvas, leaving `reserveRight` pixels free for an overlay panel. */
export function fitView(nodes: readonly Point[], rect: { readonly width: number; readonly height: number }, reserveRight: number): GraphViewport | null {
  if (nodes.length === 0) return null;
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((rect.width - reserveRight) / (x1 - x0 + FIT_PADDING), rect.height / (y1 - y0 + FIT_PADDING))));
  return { x: -((x0 + x1) / 2) * k - reserveRight / 2, y: -((y0 + y1) / 2) * k, k };
}

export function pickNode(nodes: readonly SimNode[], point: Point, k: number): SimNode | null {
  let best: SimNode | null = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    const distance = (node.x - point.x) ** 2 + (node.y - point.y) ** 2;
    if (distance < Math.max(node.r + 3, 6 / k) ** 2 && distance < bestDistance) { best = node; bestDistance = distance; }
  }
  return best;
}
