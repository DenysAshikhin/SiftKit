import { useEffect, useMemo, useRef } from 'react';
import type { VaultGraph } from '@siftkit/contracts';

import {
  buildSimGraph, fitView, pickNode, type ForceSimulation, type GraphViewport, type Point, type SimNode,
} from '../../lib/vault-force.ts';

const HUB_HALO_DEGREE = 12;
const SETTLED_ALPHA = 0.01;
const PREWARM_SETTLED_ALPHA = 0.03;
const DRAG_REHEAT_ALPHA = 0.3;
const WHEEL_ZOOM_RATE = 0.0015;
const LABEL_MAX_CHARS = 40;
const SCATTER_SPAN = 800;

export interface GraphCanvasProps {
  readonly graph: VaultGraph;
  readonly colors: ReadonlyMap<string, string>;
  readonly currentId: string | null;
  readonly selectedId: string | null;
  readonly filterText: string;
  readonly labels: boolean;
  readonly reserveRight: number;
  readonly prewarmTicks: number;
  readonly ticksPerFrame: number;
  /** Layout cache shared across rebuilds, so filtering or reopening keeps nodes where they were. */
  readonly positions: Map<string, Point>;
  readonly layoutSeed: number;
  readonly onSelect: (id: string) => void;
  readonly onOpen: (id: string) => void;
}

interface CanvasState {
  view: GraphViewport;
  hover: SimNode | null;
  raf: number;
  width: number;
  height: number;
  redraw: (heat: boolean) => void;
}

function drawGraph(ctx: CanvasRenderingContext2D, state: CanvasState, sim: ForceSimulation, props: GraphCanvasProps): void {
  const { view, hover, width, height } = state;
  const ratio = window.devicePixelRatio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2 + view.x, height / 2 + view.y);
  ctx.scale(view.k, view.k);
  const lit = hover ? new Set([hover, ...hover.neighbors]) : null;
  const filter = props.filterText.trim().toLowerCase();
  const matches = (node: SimNode) => filter.length > 0 && node.title.toLowerCase().includes(filter);
  const thin = 0.6 / view.k;
  ctx.lineWidth = thin;
  for (const { source, target } of sim.edges) {
    const hot = lit !== null && (source === hover || target === hover);
    ctx.strokeStyle = hot ? 'rgba(156,214,255,.7)' : lit ? 'rgba(60,80,100,.12)' : 'rgba(90,115,140,.28)';
    ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(target.x, target.y); ctx.stroke();
  }
  for (const node of sim.nodes) {
    const dim = (lit !== null && !lit.has(node)) || (filter.length > 0 && !matches(node));
    if (node.degree > HUB_HALO_DEGREE && !dim) {
      ctx.globalAlpha = 0.14; ctx.fillStyle = node.color;
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r * 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = dim ? 0.18 : 1;
    ctx.fillStyle = node.color;
    ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2); ctx.fill();
    if (props.selectedId === node.id) {
      ctx.strokeStyle = '#2fbfa0'; ctx.lineWidth = 2.5 / view.k;
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r + 3 / view.k, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = thin;
    }
    if (node.current) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / view.k; ctx.stroke(); ctx.lineWidth = thin; }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#dfe9f3';
  ctx.font = `${11 / view.k}px Segoe UI`;
  ctx.textAlign = 'center';
  for (const node of sim.nodes) {
    const show = node === hover || (lit?.has(node) === true && view.k > 0.6) || node.current || props.selectedId === node.id
      || (props.labels && (node.r * view.k > 5 || view.k > 1.6)) || matches(node);
    if (show) ctx.fillText(node.title.slice(0, LABEL_MAX_CHARS), node.x, node.y + node.r + 12 / view.k);
  }
  ctx.restore();
}

/** Canvas force graph: drag a node, drag empty space to pan, wheel to zoom, click selects, double-click opens. */
export function GraphCanvas(props: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const { graph, colors, currentId, positions } = props;
  const sim = useMemo(() => buildSimGraph(graph, colors, currentId, positions), [graph, colors, currentId, positions]);
  const state = useRef<CanvasState>({ view: { x: 0, y: 0, k: 1 }, hover: null, raf: 0, width: 0, height: 0, redraw: () => undefined });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;
    if (!canvas || !ctx) return undefined;
    const current = state.current;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      current.width = rect.width;
      current.height = rect.height;
    };
    const draw = () => drawGraph(ctx, current, sim, latest.current);
    const loop = () => {
      for (let tick = 0; tick < latest.current.ticksPerFrame && sim.alpha > SETTLED_ALPHA; tick += 1) sim.tick();
      for (const node of sim.nodes) positions.set(node.id, { x: node.x, y: node.y });
      draw();
      current.raf = sim.alpha > SETTLED_ALPHA ? requestAnimationFrame(loop) : 0;
    };
    current.redraw = (heat) => {
      if (heat && current.raf === 0) current.raf = requestAnimationFrame(loop);
      else if (current.raf === 0) draw();
    };
    measure();
    if (sim.nodes.some((node) => !positions.has(node.id))) {
      for (let tick = 0; tick < latest.current.prewarmTicks && sim.alpha > PREWARM_SETTLED_ALPHA; tick += 1) sim.tick();
    }
    current.view = fitView(sim.nodes, current, latest.current.reserveRight) ?? current.view;
    current.hover = null;

    const toWorld = (event: MouseEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      const { view } = current;
      return { x: (event.clientX - rect.left - rect.width / 2 - view.x) / view.k, y: (event.clientY - rect.top - rect.height / 2 - view.y) / view.k };
    };
    let drag: { node: SimNode } | { panX: number; panY: number } | null = null;
    let moved = false;
    const onDown = (event: MouseEvent) => {
      const node = pickNode(sim.nodes, toWorld(event), current.view.k);
      moved = false;
      if (node) { node.fixed = true; drag = { node }; } else drag = { panX: event.clientX - current.view.x, panY: event.clientY - current.view.y };
    };
    const onMove = (event: MouseEvent) => {
      if (drag !== null && 'node' in drag) {
        const point = toWorld(event);
        drag.node.x = point.x; drag.node.y = point.y; moved = true;
        sim.alpha = Math.max(sim.alpha, DRAG_REHEAT_ALPHA);
        current.redraw(true);
        return;
      }
      if (drag !== null) {
        current.view = { ...current.view, x: event.clientX - drag.panX, y: event.clientY - drag.panY };
        moved = true; current.redraw(false);
        return;
      }
      if (event.target !== canvas) return;
      const node = pickNode(sim.nodes, toWorld(event), current.view.k);
      if (node !== current.hover) { current.hover = node; canvas.style.cursor = node ? 'pointer' : 'grab'; current.redraw(false); }
    };
    const onUp = () => {
      if (drag !== null && 'node' in drag) {
        drag.node.fixed = false;
        if (!moved) latest.current.onSelect(drag.node.id);
      }
      drag = null;
    };
    const onDouble = (event: MouseEvent) => {
      const node = pickNode(sim.nodes, toWorld(event), current.view.k);
      if (node) latest.current.onOpen(node.id);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE);
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left - rect.width / 2;
      const my = event.clientY - rect.top - rect.height / 2;
      const { view } = current;
      current.view = { x: mx - (mx - view.x) * factor, y: my - (my - view.y) * factor, k: view.k * factor };
      current.redraw(false);
    };
    const resize = new ResizeObserver(() => { measure(); current.redraw(false); });
    resize.observe(canvas);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    current.raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(current.raf);
      current.raf = 0;
      resize.disconnect();
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('dblclick', onDouble);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sim, positions]);

  const seenSeed = useRef(props.layoutSeed);
  useEffect(() => {
    if (seenSeed.current === props.layoutSeed) return;
    seenSeed.current = props.layoutSeed;
    for (const node of sim.nodes) { node.x = (Math.random() - 0.5) * SCATTER_SPAN; node.y = (Math.random() - 0.5) * SCATTER_SPAN; }
    sim.alpha = 1;
    state.current.redraw(true);
  }, [props.layoutSeed, sim]);

  useEffect(() => {
    state.current.redraw(false);
  }, [props.selectedId, props.filterText, props.labels]);

  return <canvas ref={canvasRef} />;
}
