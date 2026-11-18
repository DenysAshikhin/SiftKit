import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject, JsonSerializable } from '../src/lib/json-types.ts';
import { ProgressWriter } from '../src/lib/progress-writer.ts';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.ts';
import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { parseLoggedEvent } from './helpers/logged-events.ts';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';

const VERDICT = { content: '{"verdict":"pass","reason":"supported"}' };
const PATTERNS = ['planner', 'engine', 'config'];
const grepKey = (pattern: string) => `git operation="grep" path="src" pattern="${pattern}"`;

function grepCall(pattern: string, promptEvalTokens: number | null): MockPlannerResponseInput {
  return { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern, path: 'src' } }], promptEvalTokens };
}

class CaptureWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

async function runWithPrefills(id: string, prefills: readonly (number | null)[]) {
  const events: JsonObject[] = [];
  const progress = new CaptureWriter();
  await runTaskLoop({ id, question: 'Do the task.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
    ...createMockLoopDefaults('siftkit-cache-break-'),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'),
    minToolCallsBeforeFinish: 0,
    maxTurns: 8,
    mockResponses: [...PATTERNS.map((pattern, index) => grepCall(pattern, prefills[index] ?? null)), { content: 'complete answer' }, VERDICT],
    mockCommandResults: Object.fromEntries(PATTERNS.map((pattern) => [grepKey(pattern), { exitCode: 0, stdout: `src/a.ts:1:${pattern}`, stderr: '' }])),
    progressWriter: progress,
    logger: { path: 'memory', write(event: Record<string, JsonSerializable>) { events.push(parseLoggedEvent(event)); } },
  });
  return {
    transcriptBreaks: events.filter((event) => event.kind === 'prompt_cache_break'),
    progressBreaks: progress.events.filter((event) => event.kind === 'prompt_cache_break'),
  };
}

test('a turn that re-prefills far more than the prompt grew is logged and reported as a cache break', async () => {
  const { transcriptBreaks, progressBreaks } = await runWithPrefills('cache-break', [null, 10, 1_000_000]);

  assert.deepEqual(transcriptBreaks.map((event) => [event.turn, event.promptEvalTokens]), [[3, 1_000_000]]);
  assert.deepEqual(progressBreaks.map((event) => event.turn), [3]);
});

test('a run whose turns re-prefill only what the prompt grew reports no cache break', async () => {
  const { transcriptBreaks, progressBreaks } = await runWithPrefills('cache-intact', [null, 10, 10]);

  assert.deepEqual(transcriptBreaks, []);
  assert.deepEqual(progressBreaks, []);
});
