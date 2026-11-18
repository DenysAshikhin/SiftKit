import type { EngineEvent, EngineEventKind } from '@siftkit/contracts';

export type EngineEventGroup = { key: string; kind: EngineEventKind; summary: string; events: EngineEvent[] };

export const ENGINE_EVENT_KIND_LABELS: Record<EngineEventKind, string> = {
  prompt_cache_break: 'Cache break',
  engine_error: 'Error',
  engine_exit: 'Exit',
};

/** Collapses events whose kind and summary match once digits are ignored; input and groups stay newest first. */
export function groupEngineEvents(events: readonly EngineEvent[]): EngineEventGroup[] {
  const groups = new Map<string, EngineEventGroup>();
  for (const event of events) {
    const key = `${event.kind}:${event.summary.replace(/\d+/gu, '#')}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, kind: event.kind, summary: event.summary, events: [event] });
    else group.events.push(event);
  }
  return [...groups.values()];
}
