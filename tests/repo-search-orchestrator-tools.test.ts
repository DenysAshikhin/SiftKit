import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject, JsonSerializable } from '../src/lib/json-types.ts';
import { ORCHESTRATOR_TOOL_NAMES } from '../src/planner-protocol/repo-search.ts';
import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import type { OrchestratorToolHost, OrchestratorToolOutcome } from '../src/repo-search/engine/orchestrator-tool-host.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import type { OrchestratorToolCall } from '../src/repo-search/repo-tool-arguments.ts';
import { resolveRunSystemPrompt } from '../src/repo-search/run-system-prompt.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';
import { parseLoggedEvent } from './helpers/logged-events.ts';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.ts';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.ts';
import { mockOfflineSiftConfig } from './helpers/mock-config.ts';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-orchestrator-tools-');
const TOOLS = resolveRepoSearchPlannerToolDefinitions(['read', ...ORCHESTRATOR_TOOL_NAMES]);
const DISPATCH = { children: [{ taskId: 'greeting', purpose: 'implementation', instruction: 'Create src/greeting.ts.' }] };

class RecordingHost implements OrchestratorToolHost {
  readonly calls: OrchestratorToolCall[] = [];
  private readonly answer: (call: OrchestratorToolCall) => OrchestratorToolOutcome;

  constructor(answer: (call: OrchestratorToolCall) => OrchestratorToolOutcome) {
    this.answer = answer;
  }

  execute(call: OrchestratorToolCall): Promise<OrchestratorToolOutcome> {
    this.calls.push(call);
    return Promise.resolve(this.answer(call));
  }

  contextDigest(): string {
    return `RUN STATE after ${this.calls.length} host calls`;
  }
}

function run(host: OrchestratorToolHost, mockResponses: Parameters<typeof runTaskLoop>[1]['mockResponses']) {
  return runTaskLoop({ id: 'orchestrator', question: 'Orchestrate.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS, plannerToolDefinitions: TOOLS,
    maxTurns: 4, minToolCallsBeforeFinish: 0, mockCommandResults: {}, orchestratorTools: host, mockResponses,
  });
}

test('an orchestrator tool call reaches the host parsed, and its answer is the tool result', async () => {
  const host = new RecordingHost(() => ({ ok: true, output: 'report: greeting done' }));
  const result = await run(host, [{ toolCalls: [{ name: 'dispatch', arguments: DISPATCH }] }, { content: 'done' }, { content: 'done' }]);
  assert.deepEqual(host.calls, [{ toolName: 'dispatch', args: DISPATCH }]);
  const command = result.commands.find((entry) => entry.command.startsWith('dispatch'));
  assert.equal(command?.exitCode, 0);
  assert.match(command?.output ?? '', /report: greeting done/u);
});

test('update_tasks reaches the host with omitted lists defaulted to empty', async () => {
  const host = new RecordingHost(() => ({ ok: true, output: 'Plan updated.' }));
  const update = [{ taskId: 'greeting', set: { writePaths: ['src/greeting.ts', 'tests/greeting.test.ts'] } }];
  await run(host, [{ toolCalls: [{ name: 'update_tasks', arguments: { update } }] }, { content: 'done' }, { content: 'done' }]);
  assert.deepEqual(host.calls, [{ toolName: 'update_tasks', args: { update, add: [], remove: [] } }]);
});

test('a host refusal is a failed tool result the model reads, and invalid arguments never reach the host', async () => {
  const host = new RecordingHost(() => ({ ok: false, output: 'Task greeting is not in the saved plan.' }));
  const result = await run(host, [
    { toolCalls: [{ name: 'dispatch', arguments: { children: [] } }] },
    { toolCalls: [{ name: 'dispatch', arguments: DISPATCH }] },
    { content: 'done' }, { content: 'done' },
  ]);
  assert.equal(host.calls.length, 1);
  const dispatched = result.commands.filter((entry) => entry.command.startsWith('dispatch'));
  assert.equal(dispatched.at(-1)?.exitCode, 1);
  assert.match(dispatched.at(-1)?.output ?? '', /not in the saved plan/u);
});

test('a repeated orchestrator call reaches the host each time, because its answer depends on the run state', async () => {
  const host = new RecordingHost(() => ({ ok: true, output: 'report: greeting done' }));
  const review = { taskId: 'greeting', verdict: 'pass', criteria: [], findings: [] };
  const twice = (name: string, args: JsonObject) => [{ toolCalls: [{ name, arguments: args }] }, { toolCalls: [{ name, arguments: args }] }];
  await run(host, [...twice('dispatch', DISPATCH), ...twice('record_review', review), { content: 'done' }, { content: 'done' }]);
  assert.deepEqual(host.calls.map((call) => call.toolName), ['dispatch', 'dispatch', 'record_review', 'record_review']);
});

test('a host failure ends the run instead of reaching the model', async () => {
  const host: OrchestratorToolHost = { execute: () => Promise.reject(new Error('repository gate lost')), contextDigest: () => '' };
  await assert.rejects(run(host, [{ toolCalls: [{ name: 'dispatch', arguments: DISPATCH }] }, { content: 'done' }]), /repository gate lost/u);
});

test('an overflowing orchestrator transcript is rebuilt from the host digest without a summary request', async () => {
  const host = new RecordingHost(() => ({ ok: true, output: 'report: greeting done' }));
  const loggedEvents: JsonObject[] = [];
  const result = await runTaskLoop({ id: 'orchestrator', question: 'Orchestrate the greeting.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, ...MOCK_LOOP_DEFAULTS, plannerToolDefinitions: TOOLS,
    runtimeProfile: new RepoSearchRuntimeProfile('orchestrator'), maxTurns: 4, minToolCallsBeforeFinish: 0,
    // A 100k-character history is 25000 tokens against a 17000-token prompt budget: turn 1 compacts.
    totalContextTokens: 32000, historyMessages: [{ role: 'assistant', content: 'H'.repeat(100_000) }],
    mockCommandResults: {}, orchestratorTools: host,
    // No response is spent on a summary: the first one is already the planner's turn.
    mockResponses: [{ toolCalls: [{ name: 'dispatch', arguments: DISPATCH }] }, { content: 'done' }, { content: 'done' }],
    logger: { path: 'memory', write(event: Record<string, JsonSerializable>) { loggedEvents.push(parseLoggedEvent(event)); } },
  });
  assert.equal(loggedEvents.filter((event) => event.kind === 'turn_preflight_compaction_applied').length, 1);
  assert.equal(host.calls.length, 1);
  assert.equal(result.compactionSummary, 'RUN STATE after 0 host calls');
  const requests = loggedEvents.filter((event) => event.kind === 'provider_request_start').map((event) => event.stage);
  assert.equal(requests.includes('context_compaction'), false);
  const firstRequest = JSON.stringify(loggedEvents.find((event) => event.kind === 'turn_new_messages'));
  assert.match(firstRequest, /RUN STATE after 0 host calls/u);
  assert.match(firstRequest, /Orchestrate the greeting\./u);
  assert.doesNotMatch(firstRequest, /HHHH/u);
});

test('only a run with a host is offered the orchestrator tools', () => {
  const base = {
    promptPrefix: '', systemContext: createEmptyPresetSystemContext(), webSearch: mockOfflineSiftConfig().WebSearch,
    webToolsEnabled: false, visionEnabled: false, webChatTools: false, allowedTools: ['read'], promptKind: 'orchestrator' as const,
  };
  const names = (orchestratorTools: boolean) => resolveRunSystemPrompt({ ...base, orchestratorTools }).toolDefinitions
    .map((definition) => definition.function.name);
  assert.deepEqual(names(true), ['read', ...ORCHESTRATOR_TOOL_NAMES]);
  assert.deepEqual(names(false), ['read']);
});
