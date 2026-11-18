import assert from 'node:assert/strict';
import test from 'node:test';

import { ProgressWriter } from '../src/lib/progress-writer.ts';
import { RepoSearchLifecycleWriter } from '../src/repo-search/execute.ts';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { listEngineEvents } from '../src/state/engine-events.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { withTempEnv } from './_runtime-helpers.ts';

class CaptureWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

test('a cache break becomes an engine event of its run and reaches the run as a context warning', async () => {
  await withTempEnv(async () => {
    const target = new CaptureWriter();
    new RepoSearchLifecycleWriter('run-7', target).write({
      kind: 'prompt_cache_break', taskId: 'task', turn: 3, maxTurns: 6, elapsedMs: 42,
      promptTokens: 9_100, previousPromptTokens: 9_000, promptEvalTokens: 9_050, promptCacheTokens: 50,
    });

    assert.deepEqual(target.events, [{
      kind: 'context_warning', warningText: 'Prompt cache broke on turn 3: re-prefilled 9,050 tokens where the prompt grew 100.', elapsedMs: 42,
    }]);
    const events = listEngineEvents(getRuntimeDatabase(), 10);
    assert.deepEqual(events.map((event) => [event.kind, event.runId, event.turn, event.summary]), [
      ['prompt_cache_break', 'run-7', 3, 'Turn 3 re-prefilled 9,050 tokens; the prompt grew 100'],
    ]);
  });
});
