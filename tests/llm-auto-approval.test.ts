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
import { asObject, asArray, getAddressInfo } from './helpers/dashboard-http.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { mockOfflineSiftConfig, mockSiftConfig } from './helpers/mock-config.js';
import { INTERACTIVE_REPO_TOOL_NAMES, resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import type { ApprovalRequestProgressEvent, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { ApprovalGateHarness } from './helpers/approval-gate-harness.js';

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
  const harness = new ApprovalGateHarness(writer, false, ESCALATION_DECISION_TIMEOUT_MS);
  const gate = new LlmApprovalGate({
    requestId: 'run-1',
    humanGate: harness.gate,
    verdictRequester: {
      // What the real reviewer returns when the model answers with anything but a verdict.
      requestApprovalVerdict: () => Promise.resolve({
        text: '{"action":"git","command":"git grep -n \\"x\\" src2"}',
        thinkingText: '',
        mockExhausted: false,
      }),
    },
    progressWriter: writer,
    logger: null,
  });

  const decision = await gate.request({
    turn: 1,
    toolName: 'git',
    command: 'git grep -n "x" src1',
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
  return { id: 'task-1', question: prompt, signals: [] };
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
  mockResponses: string[],
  writer: RecordingWriter,
  gate: ApprovalGate,
  logger?: { path: string; write: (event: Record<string, JsonSerializable>) => void },
) {
  return {
    repoRoot: tempRoot,
    model: 'mock-model',
    baseUrl: DEAD_BASE_URL,
    systemContext: createEmptyPresetSystemContext(),
    config: mockOfflineSiftConfig(),
    maxTurns: 4,
    minToolCallsBeforeFinish: 0,
    mockResponses,
    mockCommandResults: {},
    progressWriter: writer,
    approvalGate: gate,
    approvalMode: 'auto' as const,
    logger: logger ?? null,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
  };
}

test('auto mode: reviewer approve executes the write with no human involvement', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-approve-');
  try {
    const writer = new RecordingWriter(new AlwaysAbortProvider());
    const gate = new ApprovalGateHarness(writer, false, UNREACHED_GATE_TIMEOUT_MS).gate;
    writer.gate = gate;
    const { events: logEvents, logger } = makeRecordingLogger();
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      '{"action":"write","path":"out.txt","content":"hello"}',
      '{"verdict":"approve","reason":"task-scoped write"}',
      '{"action":"finish","output":"wrote it"}',
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
    const gate = new ApprovalGateHarness(writer, false, UNREACHED_GATE_TIMEOUT_MS).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      '{"action":"write","path":"out.txt","content":"hello"}',
      '{"verdict":"deny","reason":"not needed for the task"}',
      '{"action":"finish","output":"gave up"}',
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
    const gate = new ApprovalGateHarness(writer, false, UNREACHED_GATE_TIMEOUT_MS).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      '{"action":"write","path":"out.txt","content":"hello"}',
      '{"verdict":"unsure","reason":"cannot judge scope"}',
      '{"action":"finish","output":"wrote it"}',
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

for (const testCase of [
  { toolName: 'read', action: '{"action":"read","path":"a.txt"}' },
  { toolName: 'grep', action: '{"action":"grep","pattern":"content-a","path":"a.txt","literal":true}' },
  { toolName: 'find', action: '{"action":"find","pattern":"a.txt","path":"."}' },
  { toolName: 'ls', action: '{"action":"ls","path":"."}' },
]) {
  test(`auto mode: ${testCase.toolName} fast-paths without spending a verdict call`, async () => {
    const tempRoot = createManagedTempDir('siftkit-llm-auto-fastpath-');
    try {
      fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'content-a', 'utf8');
      const writer = new RecordingWriter(new AlwaysAbortProvider());
      const gate = new ApprovalGateHarness(writer, false, UNREACHED_GATE_TIMEOUT_MS).gate;
      writer.gate = gate;
      // No verdict mock present: if a verdict call were made it would consume the finish action and fail the run.
      const result = await runTaskLoop(makeTask('read a file'), makeAutoLoopOptions(tempRoot, [
        testCase.action,
        '{"action":"finish","output":"done"}',
      ], writer, gate));
      assert.equal(result.finalOutput, 'done');
      const auto = writer.ofKind('approval_auto');
      assert.equal(auto.length, 1);
      assert.equal(auto[0].toolName, testCase.toolName);
      assert.equal(auto[0].verdict, 'approve');
      assert.equal(auto[0].reason, 'read-only tool');
      assert.equal(writer.ofKind('approval_request').length, 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('auto mode: unparseable verdicts (after one retry) escalate to the human gate', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-badverdict-');
  try {
    const writer = new RecordingWriter(new AlwaysApproveProvider());
    const gate = new ApprovalGateHarness(writer, false, UNREACHED_GATE_TIMEOUT_MS).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeAutoLoopOptions(tempRoot, [
      '{"action":"write","path":"out.txt","content":"hello"}',
      'not json at all',
      '{"verdict":"maybe","reason":"bad enum"}',
      '{"action":"finish","output":"wrote it"}',
    ], writer, gate));
    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
    const auto = writer.ofKind('approval_auto');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].verdict, 'unsure');
    assert.equal(auto[0].reason, 'verdict call failed');
    assert.equal(writer.ofKind('approval_request').length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode over HTTP: the verdict request byte-extends the executing planner request', async () => {
  const plannerBodies: ReturnType<typeof asObject>[] = [];
  const verdictBodies: ReturnType<typeof asObject>[] = [];
  let plannerCalls = 0;

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

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/tokenize') {
        const parsed = asObject(parseJsonValueText(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(String(parsed.content || '').length / 4)) }));
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
        const content = plannerCalls === 1
          ? '{"action":"read","path":"a.txt"}'
          : plannerCalls === 2
            ? '{"action":"write","path":"out.txt","content":"hello"}'
            : '{"action":"finish","output":"wrote it"}';
        sendChatCompletionSse(res, completionBody(content, `thought-${plannerCalls}`));
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
    fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'content-a', 'utf8');
    const gate = new ApprovalGateHarness(new SilentProgressWriter(), false, UNREACHED_GATE_TIMEOUT_MS).gate;
    const result = await runTaskLoop(makeTask('read a file then write a file'), {
      repoRoot: tempRoot,
      model: 'mock-model',
      baseUrl,
      systemContext: createEmptyPresetSystemContext(),
      config: mockSiftConfig({
        Runtime: { LlamaCpp: { BaseUrl: baseUrl, NumCtx: 32000 } },
        Server: {
          ModelPresets: {
            ActivePresetId: 'default',
            Presets: [{ id: 'default', Reasoning: 'on', ReasoningContent: true, PreserveThinking: true, IdleAction: 'unload' }],
          },
        },
      }),
      maxTurns: 4,
      minToolCallsBeforeFinish: 0,
      mockCommandResults: {},
      approvalGate: gate,
      approvalMode: 'auto' as const,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
    });

    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
    assert.equal(plannerBodies.length, 3);
    assert.equal(verdictBodies.length, 1);

    const executing = plannerBodies[1];
    const verdict = verdictBodies[0];
    const executingMessages = asArray(executing.messages);
    const verdictMessages = asArray(verdict.messages);

    // Scenario sanity: the executing request really carries earlier-turn reasoning,
    // so the prefix equality below proves the verdict preserved it.
    assert.equal(JSON.stringify(executingMessages).includes('thought-1'), true);

    // The verdict prompt is the executing planner prompt, pending assistant call, then question.
    assert.equal(verdictMessages.length, executingMessages.length + 2);
    assert.deepEqual(verdictMessages.slice(0, executingMessages.length), executingMessages);
    const pending = asObject(verdictMessages[executingMessages.length]);
    assert.equal(pending.role, 'assistant');
    const pendingCall = asObject(asArray(pending.tool_calls)[0]);
    const pendingFunction = asObject(pendingCall.function);
    assert.deepEqual(
      asObject(parseJsonValueText(String(pendingFunction.arguments))),
      { path: 'out.txt', content: 'hello' },
    );
    const question = asObject(verdictMessages.at(-1));
    assert.equal(question.role, 'user');
    assert.match(String(question.content), /tool: write/u);
    assert.equal(String(question.content).includes('"content": "hello"'), false);

    // Identical server-side template rendering: same chat_template_kwargs.
    assert.deepEqual(verdict.chat_template_kwargs, executing.chat_template_kwargs);

    // The question is popped: it never reaches a later planner request.
    assert.equal(JSON.stringify(plannerBodies[2]).includes(APPROVAL_REVIEW_REQUEST_MARKER), false);
    assert.deepEqual(asArray(plannerBodies[2].messages)[executingMessages.length], pending);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('auto mode without a human gate fails loudly at construction', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-nogate-');
  try {
    const writer = new RecordingWriter(new AlwaysApproveProvider());
    await assert.rejects(
      runTaskLoop(makeTask('write a file'), {
        repoRoot: tempRoot,
        systemContext: createEmptyPresetSystemContext(),
        config: mockOfflineSiftConfig(),
        model: 'mock-model',
        baseUrl: DEAD_BASE_URL,
        maxTurns: 4,
        minToolCallsBeforeFinish: 0,
        mockResponses: ['{"action":"finish","output":"unreachable"}'],
        mockCommandResults: {},
        progressWriter: writer,
        approvalMode: 'auto' as const,
        plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
      }),
      /approvalMode "auto" requires an approvalGate/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
