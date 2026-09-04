import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { APPROVAL_REVIEW_REQUEST_MARKER } from '../src/repo-search/approval-review-policy.js';
import {
  CLIENT_ABORT_MESSAGE,
  buildApprovalTimeoutMessage,
  type ApprovalDecision,
  type ApprovalGate,
} from '../src/repo-search/engine/approval-gate.js';
import { LlmApprovalGate } from '../src/repo-search/engine/llm-approval-gate.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { CLEAN_STREAM_STOP } from '../src/llm-protocol/types.js';
import { asObject, asArray, getAddressInfo } from './helpers/dashboard-http.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { mockOfflineSiftConfig, mockSiftConfig } from './helpers/mock-config.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import type { ApprovalRequestProgressEvent, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { ApprovalGateHarness } from './helpers/approval-gate-harness.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';

const RUNTIME_PROFILE = new RepoSearchRuntimeProfile('repo-search');

const ESCALATION_DECISION_TIMEOUT_MS = 25;

/**
 * Every other gate in this file is either answered immediately or must never be reached at all,
 * so none of them may inherit the 10-minute production default. A regression that parks on the
 * gate then fails this file in a second instead of stalling the whole suite behind one test —
 * which is exactly how a mis-routed verdict request once wedged it.
 */
const UNREACHED_GATE_TIMEOUT_MS = 1_000;

/** Records everything and answers nothing — a caller that ignores approval frames. */
class UnansweringWriter extends CollectingProgressWriter<RepoSearchProgressEvent> {}

/**
 * Regression for the deadlock behind a 17-minute freeze: when the auto-reviewer cannot produce a
 * verdict it escalates to the human gate, and a caller that never answers left that escalation
 * parked forever while holding the model lock. It must terminate the run instead.
 */
test('an auto-review that reaches no verdict aborts when nobody answers the escalation', async () => {
  const writer = new UnansweringWriter();
  const harness = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: ESCALATION_DECISION_TIMEOUT_MS });
  const gate = new LlmApprovalGate({
    requestId: 'run-1',
    humanGate: harness.gate,
    verdictRequester: {
      // What the real reviewer returns when the model answers with anything but a verdict.
      requestApprovalVerdict: () => Promise.resolve({
        text: 'not a verdict',
        rawText: 'not a verdict',
        narrationText: 'not a verdict',
        classification: 'narration',
        thinkingText: '',
        toolCalls: [],
        mockExhausted: false,
        stop: CLEAN_STREAM_STOP,
      }),
    },
    progressWriter: writer,
    logger: null,
  });

  const decision = await gate.request({
    turn: 1,
    toolName: 'git',
    command: "git operation=\"grep\" path=\"src1\" pattern=\"x\"",
    reviewPayload: null,
    pendingMessages: [],
  });

  assert.deepEqual(decision, {
    kind: 'abort',
    reason: buildApprovalTimeoutMessage(ESCALATION_DECISION_TIMEOUT_MS),
  });
  assert.deepEqual(
    writer.events.map((event) => event.kind),
    ['approval_auto', 'approval_request'],
  );
});

/** Explicit decision-provider interface — no dynamic callbacks. */
interface DecisionProvider {
  decide(event: ApprovalRequestProgressEvent): ApprovalDecision;
}

class AlwaysAbortProvider implements DecisionProvider {
  decide(_event: ApprovalRequestProgressEvent): ApprovalDecision {
    return { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
  }
}

class AlwaysApproveProvider implements DecisionProvider {
  decide(_event: ApprovalRequestProgressEvent): ApprovalDecision {
    return { kind: 'approve' };
  }
}

class RecordingWriter extends CollectingProgressWriter<RepoSearchProgressEvent> {
  public gate: ApprovalGate | null = null;
  constructor(private readonly provider: DecisionProvider) {
    super();
  }
  override write(event: RepoSearchProgressEvent): void {
    super.write(event);
    if (event.kind !== 'approval_request') return;
    setImmediate(() => this.gate?.submit(event.approvalId, this.provider.decide(event)));
  }
  kinds(): string[] { return this.events.map((event) => event.kind); }
}

function makeTask(prompt: string) {
  return { id: 'task-1', question: prompt };
}

function makeRecordingLogger() {
  const events: Array<Record<string, JsonSerializable>> = [];
  return {
    events,
    logger: { path: 'memory', write: (event: Record<string, JsonSerializable>) => { events.push(event); } },
  };
}

function makeAutoLoopOptions(
  tempRoot: string,
  mockResponses: MockPlannerResponseInput[],
  writer: RecordingWriter,
  gate: ApprovalGate,
  logger?: { path: string; write: (event: Record<string, JsonSerializable>) => void },
) {
  return {
    repoRoot: tempRoot,
    model: 'mock-model',
    baseUrl: DEAD_BASE_URL,
    runtimeProfile: RUNTIME_PROFILE,
    systemContext: createEmptyPresetSystemContext(),
    config: mockOfflineSiftConfig(),
    maxTurns: 4,
    minToolCallsBeforeFinish: 0,
    mockResponses,
    mockCommandResults: {},
    progressWriter: writer,
    approvalGate: gate,
    logger: logger ?? null,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
  };
}

test('auto mode: reviewer approve executes the write with no human involvement', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-approve-');
  try {
    const writer = new RecordingWriter(new AlwaysAbortProvider());
    const gate = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
    writer.gate = gate;
    const { events: logEvents, logger } = makeRecordingLogger();
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: '{"verdict":"approve","reason":"task-scoped write"}' },
      { content: "wrote it" },
    ], writer, gate, logger));
    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
    assert.equal(writer.ofKind('approval_request').length, 0);
    const auto = writer.ofKind('approval_auto');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].verdict, 'approve');
    assert.equal(auto[0].toolName, 'write');
    assert.equal(auto[0].requestId, 'run-1');
    assert.equal(Object.hasOwn(auto[0], 'reviewPayload'), false);
    // Transcript purity: the reviewer question never enters the transcript.
    const transcriptEvents = logEvents.filter((event) => event.kind === 'turn_new_messages');
    assert.equal(
      JSON.stringify(transcriptEvents).includes(APPROVAL_REVIEW_REQUEST_MARKER),
      false,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: reviewer deny blocks the write and feeds the reason to the model', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-deny-');
  try {
    const writer = new RecordingWriter(new AlwaysAbortProvider());
    const gate = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: '{"verdict":"deny","reason":"not needed for the task"}' },
      { content: "gave up" },
    ], writer, gate));
    assert.equal(result.finalOutput, 'gave up');
    assert.equal(fs.existsSync(path.join(tempRoot, 'out.txt')), false);
    const denied = result.commands.find((command) => command.safe === false);
    assert.ok(denied);
    assert.match(String(denied.reason), /auto-reviewer: not needed for the task/u);
    assert.equal(String(denied.output).includes('"content": "hello"'), false);
    assert.equal(result.safetyRejects, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: unsure escalates to the human gate, which approves', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-unsure-');
  try {
    const writer = new RecordingWriter(new AlwaysApproveProvider());
    const gate = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: '{"verdict":"unsure","reason":"cannot judge scope"}' },
      { content: "wrote it" },
    ], writer, gate));
    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
    const kinds = writer.kinds();
    assert.ok(kinds.indexOf('approval_auto') !== -1);
    assert.ok(kinds.indexOf('approval_request') !== -1);
    assert.ok(kinds.indexOf('approval_auto') < kinds.indexOf('approval_request'));
    assert.equal(writer.ofKind('approval_auto')[0].verdict, 'unsure');
    assert.equal(Object.hasOwn(writer.ofKind('approval_auto')[0], 'reviewPayload'), false);
    assert.match(
      String(writer.ofKind('approval_request')[0].reviewPayload),
      /"content": "hello"/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

const AUTO_FAST_PATH_CASES: Array<{ toolName: string; args: JsonObject }> = [
  { toolName: 'read', args: { path: 'a.txt' } },
  { toolName: 'grep', args: { pattern: 'content-a', path: 'a.txt', literal: true } },
  { toolName: 'find', args: { pattern: 'a.txt', path: '.' } },
  { toolName: 'ls', args: { path: '.' } },
];

for (const testCase of AUTO_FAST_PATH_CASES) {
  test(`auto mode: ${testCase.toolName} fast-paths silently, spending neither a verdict call nor a log line`, async () => {
    const tempRoot = createManagedTempDir('siftkit-llm-auto-fastpath-');
    try {
      fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'content-a', 'utf8');
      const writer = new RecordingWriter(new AlwaysAbortProvider());
      const gate = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
      writer.gate = gate;
      const { events: logEvents, logger } = makeRecordingLogger();
      // No verdict mock present: if a verdict call were made it would consume the finish action and fail the run.
      const result = await runTaskLoop(makeTask('read a file'), makeAutoLoopOptions(tempRoot, [
        { toolCalls: [{ name: testCase.toolName, arguments: testCase.args }] },
        { content: "done" },
      ], writer, gate, logger));
      assert.equal(result.finalOutput, 'done');
      // The tool call itself still reports; the exemption is static policy and adds nothing to it.
      assert.equal(
        writer.ofKind('tool_start').filter((event) => String(event.command).startsWith(testCase.toolName)).length,
        1,
      );
      assert.equal(writer.ofKind('approval_auto').length, 0);
      assert.equal(writer.ofKind('approval_request').length, 0);
      assert.equal(logEvents.filter((event) => event.kind === 'approval_verdict').length, 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('auto mode: unparseable verdicts (after one retry) escalate to the human gate', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-badverdict-');
  try {
    const writer = new RecordingWriter(new AlwaysApproveProvider());
    const gate = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: 'not json at all' },
      { content: '{"verdict":"maybe","reason":"bad enum"}' },
      { content: "wrote it" },
    ], writer, gate));
    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
    const auto = writer.ofKind('approval_auto');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].verdict, 'unsure');
    assert.match(auto[0].reason, /^verdict call failed: /u);
    assert.equal(writer.ofKind('approval_request').length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: a tool-bearing verdict cannot auto-approve', async () => {
  const writer = new RecordingWriter(new AlwaysApproveProvider());
  const humanGate = new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
  writer.gate = humanGate;
  let verdictAttempts = 0;
  const gate = new LlmApprovalGate({
    requestId: 'run-1',
    humanGate,
    verdictRequester: {
      requestApprovalVerdict: () => {
        verdictAttempts += 1;
        return Promise.resolve(verdictAttempts === 1
          ? {
            text: '{"verdict":"approve","reason":"must not be accepted"}',
            rawText: '{"verdict":"approve","reason":"must not be accepted"}',
            narrationText: '{"verdict":"approve","reason":"must not be accepted"}',
            classification: 'tool_control',
            thinkingText: 'I should call a tool.',
            toolCalls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'run', arguments: '{"command":"Get-Content secret.txt"}' },
            }],
            mockExhausted: false,
            stop: CLEAN_STREAM_STOP,
          }
          : {
            text: '{"verdict":"approve","reason":"clean retry must not override the violation"}',
            rawText: '{"verdict":"approve","reason":"clean retry must not override the violation"}',
            narrationText: '{"verdict":"approve","reason":"clean retry must not override the violation"}',
            classification: 'narration',
            thinkingText: '',
            toolCalls: [],
            mockExhausted: false,
            stop: CLEAN_STREAM_STOP,
          });
      },
    },
    progressWriter: writer,
    logger: null,
  });

  const decision = await gate.request({
    turn: 1,
    toolName: 'run',
    command: 'run command="Get-Content file.txt"',
    reviewPayload: null,
    pendingMessages: [],
  });

  assert.deepEqual(decision, { kind: 'approve' });
  assert.equal(writer.ofKind('approval_auto')[0].verdict, 'unsure');
  assert.equal(
    writer.ofKind('approval_auto')[0].reason,
    'approval reviewer attempted a forbidden tool call',
  );
  assert.equal(writer.ofKind('approval_request').length, 1);
  assert.equal(verdictAttempts, 1);
});

test('auto mode over HTTP byte-preserves two approval overlays and an exempt read', async () => {
  const plannerBodies: ReturnType<typeof asObject>[] = [];
  const verdictBodies: ReturnType<typeof asObject>[] = [];
  let plannerCalls = 0;
  const largeToolContent = 'x'.repeat(2_048);

  function completionBody(content: string, reasoning: string | null): JsonObject {
    return {
      choices: [{
        message: {
          role: 'assistant',
          content,
          ...(reasoning === null ? {} : { reasoning_content: reasoning }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
  }

  function toolCompletionBody(name: string, args: JsonObject, reasoning: string): JsonObject {
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: reasoning,
          tool_calls: [{
            id: `provider-${plannerCalls}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/token/encode') {
        const parsed = asObject(parseJsonValueText(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(String(parsed.text || '').length / 4)) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const parsed = asObject(parseJsonValueText(body));
        const lastMessage = asObject(asArray(parsed.messages).at(-1));
        // The verdict question leads with the review policy and carries the marker as a block
        // header partway down, so routing must look for the marker anywhere in the message.
        // A planner request never contains it — the assertion at the end of this test proves it.
        if (String(lastMessage.content || '').includes(APPROVAL_REVIEW_REQUEST_MARKER)) {
          verdictBodies.push(parsed);
          sendChatCompletionSse(res, completionBody('{"verdict":"approve","reason":"scoped write"}', null));
          return;
        }
        plannerBodies.push(parsed);
        plannerCalls += 1;
        const response = plannerCalls === 1
          ? toolCompletionBody('write', { path: 'first.txt', content: largeToolContent }, 'thought-1')
          : plannerCalls === 2
            ? toolCompletionBody('write', { path: 'second.txt', content: 'follow-up' }, 'thought-2')
            : plannerCalls === 3
              ? toolCompletionBody('read', { path: 'first.txt' }, 'thought-3')
              : completionBody('completed cache chain', 'thought-4');
        sendChatCompletionSse(res, response);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  const tempRoot = createManagedTempDir('siftkit-llm-auto-http-');
  try {
    const gate = new ApprovalGateHarness(new SilentProgressWriter(), { mode: 'auto', decisionTimeoutMs: UNREACHED_GATE_TIMEOUT_MS }).gate;
    const result = await runTaskLoop(makeTask('execute the cache-chain test actions'), {
      repoRoot: tempRoot,
      model: 'mock-model',
      baseUrl,
      runtimeProfile: RUNTIME_PROFILE,
      systemContext: createEmptyPresetSystemContext(),
      config: mockSiftConfig({
        Server: {
          ModelPresets: {
            ActivePresetId: 'default',
            Presets: [{ id: 'default', BaseUrl: baseUrl, NumCtx: 32_000, Reasoning: 'on', ReasoningContent: true, PreserveThinking: true, MaintainPerStepThinking: true, IdleAction: 'unload' }],
          },
        },
      }),
      maxTurns: 6,
      minToolCallsBeforeFinish: 0,
      mockCommandResults: {},
      approvalGate: gate,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
    });

    assert.equal(result.finalOutput, 'completed cache chain');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'first.txt'), 'utf8'), largeToolContent);
    assert.equal(fs.readFileSync(path.join(tempRoot, 'second.txt'), 'utf8'), 'follow-up');
    assert.equal(plannerBodies.length, 4);
    assert.equal(verdictBodies.length, 2);

    const expectedApprovalArgs = [
      { path: 'first.txt', content: largeToolContent },
      { path: 'second.txt', content: 'follow-up' },
    ];
    for (let index = 0; index < verdictBodies.length; index += 1) {
      const executing = plannerBodies[index];
      const verdict = verdictBodies[index];
      const resumed = plannerBodies[index + 1];
      assert.ok(executing);
      assert.ok(verdict);
      assert.ok(resumed);
      const executingMessages = asArray(executing.messages);
      const verdictMessages = asArray(verdict.messages);

      assert.equal(verdictMessages.length, executingMessages.length + 2);
      assert.deepEqual(verdictMessages.slice(0, executingMessages.length), executingMessages);
      const pending = asObject(verdictMessages[executingMessages.length]);
      const pendingCall = asObject(asArray(pending.tool_calls)[0]);
      const pendingFunction = asObject(pendingCall.function);
      assert.deepEqual(
        asObject(parseJsonValueText(String(pendingFunction.arguments || ''))),
        expectedApprovalArgs[index],
      );
      assert.deepEqual(verdict.chat_template_kwargs, executing.chat_template_kwargs);
      assert.deepEqual(verdict.tools, executing.tools);
      assert.equal(verdict.tool_choice, 'none');

      const resumedMessages = asArray(resumed.messages);
      assert.deepEqual(resumedMessages.slice(0, executingMessages.length), executingMessages);
      assert.deepEqual(resumedMessages[executingMessages.length], pending);
      assert.equal(asObject(resumedMessages[executingMessages.length + 1]).role, 'tool');
      assert.equal(JSON.stringify(resumed).includes(APPROVAL_REVIEW_REQUEST_MARKER), false);
    }

    // The third tool is read-only: it bypasses approval while its call and result still
    // become the exact prefix of the fourth planner request.
    const readExecutingMessages = asArray(plannerBodies[2].messages);
    const afterReadMessages = asArray(plannerBodies[3].messages);
    assert.deepEqual(afterReadMessages.slice(0, readExecutingMessages.length), readExecutingMessages);
    const readPending = asObject(afterReadMessages[readExecutingMessages.length]);
    assert.equal(asObject(asArray(readPending.tool_calls)[0]).type, 'function');
    assert.equal(asObject(asObject(asArray(readPending.tool_calls)[0]).function).name, 'read');
    assert.equal(asObject(afterReadMessages[readExecutingMessages.length + 1]).role, 'tool');
    assert.deepEqual(plannerBodies.map((body) => body.tools), [
      plannerBodies[0].tools,
      plannerBodies[0].tools,
      plannerBodies[0].tools,
      plannerBodies[0].tools,
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
