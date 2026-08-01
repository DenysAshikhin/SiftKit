import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runTaskLoop } from '../src/repo-search/engine.js';
import {
  APPROVAL_REVIEW_PAYLOAD_LABEL,
  APPROVAL_REVIEW_REQUEST_MARKER,
} from '../src/repo-search/approval-review-policy.js';
import { ApprovalGate } from '../src/repo-search/engine/approval-gate.js';
import { ProgressWriter, SilentProgressWriter } from '../src/lib/progress-writer.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject, asArray, getAddressInfo } from './helpers/dashboard-http.js';
import { mockOfflineSiftConfig, mockSiftConfig } from './helpers/mock-config.js';
import { INTERACTIVE_REPO_TOOL_NAMES, resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

type ScriptedDecision = { kind: 'approve' } | { kind: 'deny'; reason: string } | { kind: 'abort' };

/** Explicit decision-provider interface — no dynamic callbacks. */
interface DecisionProvider {
  decide(event: RepoSearchProgressEvent): ScriptedDecision;
}

class AlwaysAbortProvider implements DecisionProvider {
  decide(_event: RepoSearchProgressEvent): ScriptedDecision {
    return { kind: 'abort' };
  }
}

class AlwaysApproveProvider implements DecisionProvider {
  decide(_event: RepoSearchProgressEvent): ScriptedDecision {
    return { kind: 'approve' };
  }
}

class RecordingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly events: RepoSearchProgressEvent[] = [];
  public gate: ApprovalGate | null = null;
  constructor(private readonly provider: DecisionProvider) {
    super();
  }
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
    if (event.kind !== 'approval_request') return;
    setImmediate(() => this.gate?.submit(String(event.approvalId), this.provider.decide(event)));
  }
  kinds(): string[] { return this.events.map((event) => event.kind); }
  ofKind(kind: string): RepoSearchProgressEvent[] { return this.events.filter((event) => event.kind === kind); }
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
    baseUrl: 'http://127.0.0.1:1',
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
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000, bypassReadOnlyTools: false });
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
    assert.equal(
      JSON.stringify(transcriptEvents).includes(APPROVAL_REVIEW_PAYLOAD_LABEL),
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
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000, bypassReadOnlyTools: false });
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
    assert.equal(String(denied.output).includes(APPROVAL_REVIEW_PAYLOAD_LABEL), false);
    assert.equal(result.safetyRejects, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: unsure escalates to the human gate, which approves', async () => {
  const tempRoot = createManagedTempDir('siftkit-llm-auto-unsure-');
  try {
    const writer = new RecordingWriter(new AlwaysApproveProvider());
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000, bypassReadOnlyTools: false });
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
      const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000, bypassReadOnlyTools: false });
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
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000, bypassReadOnlyTools: false });
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

  function completionBody(content: string, reasoning: string | null): string {
    return JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content,
          ...(reasoning === null ? {} : { reasoning_content: reasoning }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (String(lastMessage.content || '').startsWith(APPROVAL_REVIEW_REQUEST_MARKER)) {
          verdictBodies.push(parsed);
          res.end(completionBody('{"verdict":"approve","reason":"scoped write"}', null));
          return;
        }
        plannerBodies.push(parsed);
        plannerCalls += 1;
        const content = plannerCalls === 1
          ? '{"action":"read","path":"a.txt"}'
          : plannerCalls === 2
            ? '{"action":"write","path":"out.txt","content":"hello"}'
            : '{"action":"finish","output":"wrote it"}';
        res.end(completionBody(content, `thought-${plannerCalls}`));
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
    const gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter: new SilentProgressWriter(),
      timeoutMs: 5000,
      bypassReadOnlyTools: false,
    });
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
            Presets: [{ id: 'default', Reasoning: 'on', ReasoningContent: true, PreserveThinking: true }],
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

    // The verdict prompt is exactly the executing planner prompt plus one question.
    assert.equal(verdictMessages.length, executingMessages.length + 1);
    assert.deepEqual(verdictMessages.slice(0, executingMessages.length), executingMessages);
    const question = asObject(verdictMessages.at(-1));
    assert.equal(question.role, 'user');
    assert.match(String(question.content), /tool: write/u);

    // Identical server-side template rendering: same chat_template_kwargs.
    assert.deepEqual(verdict.chat_template_kwargs, executing.chat_template_kwargs);

    // The question is popped: it never reaches a later planner request.
    assert.equal(JSON.stringify(plannerBodies[2]).includes(APPROVAL_REVIEW_REQUEST_MARKER), false);
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
        baseUrl: 'http://127.0.0.1:1',
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
