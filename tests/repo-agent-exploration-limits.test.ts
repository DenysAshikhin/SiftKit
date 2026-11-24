import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject, JsonSerializable } from '../src/lib/json-types.ts';
import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';
import { parseLoggedEvent } from './helpers/logged-events.ts';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.ts';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.ts';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-exploration-limits-');

function memoryLogger(events: JsonObject[]) {
  return { path: 'memory', write(event: Record<string, JsonSerializable>) { events.push(parseLoggedEvent(event)); } };
}

test('a worker run that only reads is refused before approval and names the read tools', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop({ id: 'worker', question: 'Check the readme.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['run']),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), maxTurns: 4, minToolCallsBeforeFinish: 0, mockCommandResults: {},
    mockResponses: [{ toolCalls: [{ name: 'run', arguments: { command: 'Get-Content README.md | Select-String install' } }] },
      ...repoAgentFinishResponses('done')],
    logger: memoryLogger(events),
  });
  const run = events.find((event) => event.kind === 'turn_command_result' && event.toolName === 'run');
  assert.equal(run?.rejectionKind, 'safety');
  assert.match(String(run?.rejectionReason), /^`Get-Content` only reads: use your read, grep, find, ls, or git tool instead\./u);
});

const read = (file: string) => ({ toolCalls: [{ name: 'read', arguments: { path: file } }] });
// 312k characters is about 78k tokens: past the 75k deadline of a 100k window, short of its compaction point.
const LATE_HISTORY = [{ role: 'assistant' as const, content: 'H'.repeat(312_000) }];

// Real case (run e85529c8): agent-endpoints read for 93 turns and two context windows and wrote nothing.
test('a worker past three quarters of its context with nothing written may only write, then reads again', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop({ id: 'worker', question: 'Add notes.txt.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'write']),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), maxTurns: 6, minToolCallsBeforeFinish: 0, mockCommandResults: {},
    totalContextTokens: 100_000, historyMessages: LATE_HISTORY,
    mockResponses: [read('README.md'), { toolCalls: [{ name: 'write', arguments: { path: 'notes.txt', content: 'notes\n' } }] },
      read('notes.txt'), ...repoAgentFinishResponses('done')],
    logger: memoryLogger(events),
  });
  const results = events.filter((event) => event.kind === 'turn_command_result');
  // Only a rejected result carries its tool name, so the three results are read in call order: read, write, read.
  assert.equal(results.length, 3);
  assert.equal(results[0]?.toolName, 'read');
  assert.equal(results[0]?.rejectionKind, 'budget');
  assert.match(String(results[0]?.rejectionReason),
    /^Edit deadline: the prompt is [\d,]+ of 100,000 context tokens and nothing has been written yet\./u);
  assert.equal(results[1]?.exitCode, 0, 'the write runs');
  assert.equal(results[2]?.exitCode, 0, 'after the first write, reading is allowed again');
});

test('a worker without edit or write tools is never held to the edit deadline', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop({ id: 'worker', question: 'Read the readme.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), maxTurns: 4, minToolCallsBeforeFinish: 0, mockCommandResults: {},
    totalContextTokens: 100_000, historyMessages: LATE_HISTORY,
    mockResponses: [read('README.md'), ...repoAgentFinishResponses('done')],
    logger: memoryLogger(events),
  });
  const reads = events.filter((event) => event.kind === 'turn_command_result' && event.toolName === 'read');
  assert.doesNotMatch(String(reads[0]?.rejectionReason), /Edit deadline/u);
});
