import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EngineEvent } from '@siftkit/contracts';
import { groupEngineEvents } from '../src/lib/engine-events.ts';

const event = (id: string, kind: EngineEvent['kind'], summary: string): EngineEvent => ({
  id, occurredAtUtc: `2026-11-18T10:00:0${id}Z`, kind, inferenceRunId: null, runId: null, turn: null, summary, detail: '',
});

test('engine events with the same kind and summary, digits aside, collapse into one group, newest first', () => {
  const groups = groupEngineEvents([
    event('3', 'engine_error', 'WARNING #2930 failed'),
    event('2', 'prompt_cache_break', 'Turn 4 re-prefilled 9 tokens'),
    event('1', 'engine_error', 'WARNING #2911 failed'),
  ]);
  assert.deepEqual(groups.map((group) => [group.kind, group.summary, group.events.map((item) => item.id)]), [
    ['engine_error', 'WARNING #2930 failed', ['3', '1']],
    ['prompt_cache_break', 'Turn 4 re-prefilled 9 tokens', ['2']],
  ]);
});
