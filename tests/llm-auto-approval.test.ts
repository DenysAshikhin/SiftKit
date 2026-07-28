import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskLoop } from '../src/repo-search/engine.js';
import {
  APPROVAL_REVIEW_PAYLOAD_LABEL,
  APPROVAL_REVIEW_REQUEST_MARKER,
} from '../src/repo-search/approval-review-policy.js';
import { ApprovalGate } from '../src/repo-search/engine/approval-gate.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import { INTERACTIVE_REPO_TOOL_NAMES, resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';

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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-approve-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-deny-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-unsure-'));
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-fastpath-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-badverdict-'));
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

test('auto mode without a human gate fails loudly at construction', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-nogate-'));
  try {
    const writer = new RecordingWriter(new AlwaysApproveProvider());
    await assert.rejects(
      runTaskLoop(makeTask('write a file'), {
        repoRoot: tempRoot,
        systemContext: createEmptyPresetSystemContext(),
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
