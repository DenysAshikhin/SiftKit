import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { ApprovalGate } from '../src/repo-search/engine/approval-gate.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import { INTERACTIVE_REPO_TOOL_NAMES, resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

type ScriptedDecision = { kind: 'approve' } | { kind: 'deny'; reason: string } | { kind: 'abort' };

class AutoRespondingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly approvalEvents: RepoSearchProgressEvent[] = [];
  public gate: ApprovalGate | null = null;
  constructor(private readonly decide: (event: RepoSearchProgressEvent) => ScriptedDecision) {
    super();
  }
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void {
    if (event.kind !== 'approval_request') return;
    this.approvalEvents.push(event);
    // Resolve asynchronously, as the real endpoint would.
    setImmediate(() => this.gate?.submit(String(event.approvalId), this.decide(event)));
  }
}

function makeTask(prompt: string) {
  return { id: 'task-1', question: prompt, signals: [] };
}

function makeLoopOptions(tempRoot: string, mockResponses: string[], writer: AutoRespondingWriter, gate: ApprovalGate) {
  return {
    repoRoot: tempRoot,
    model: 'mock-model',
    baseUrl: 'http://127.0.0.1:1',
    maxTurns: 4,
    minToolCallsBeforeFinish: 0,
    mockResponses,
    mockCommandResults: {},
    progressWriter: writer,
    approvalGate: gate,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
  };
}

test('approve lets a write execute; the file exists afterwards', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-approval-write-'));
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      '{"action":"write","path":"out.txt","content":"hello"}',
      '{"action":"finish","output":"wrote it"}',
    ], writer, gate));
    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(writer.approvalEvents.length, 1);
    assert.equal(writer.approvalEvents[0].toolName, 'write');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('deny blocks execution, feeds the reason to the model, and the run continues', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-approval-deny-'));
  try {
    const writer = new AutoRespondingWriter((event) => (
      event.toolName === 'write' ? { kind: 'deny', reason: 'not that file' } : { kind: 'approve' }
    ));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      '{"action":"write","path":"out.txt","content":"hello"}',
      '{"action":"finish","output":"gave up"}',
    ], writer, gate));
    assert.equal(result.finalOutput, 'gave up');
    assert.equal(fs.existsSync(path.join(tempRoot, 'out.txt')), false);
    const denied = result.commands.find((command) => command.safe === false);
    assert.ok(denied);
    assert.match(String(denied.reason), /user denied — not that file/u);
    assert.equal(result.safetyRejects, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('denied read never executes (no read output recorded)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-approval-read-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'secret.txt'), 'secret-content', 'utf8');
    const writer = new AutoRespondingWriter(() => ({ kind: 'deny', reason: '' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('read a file'), makeLoopOptions(tempRoot, [
      '{"action":"read","path":"secret.txt"}',
      '{"action":"finish","output":"done"}',
    ], writer, gate));
    const deniedCommand = result.commands.find((command) => command.safe === false);
    assert.ok(deniedCommand);
    assert.doesNotMatch(String(deniedCommand.output || ''), /secret-content/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('abort throws out of the run', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-approval-abort-'));
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'abort' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
    writer.gate = gate;
    await assert.rejects(
      runTaskLoop(makeTask('read'), makeLoopOptions(tempRoot, [
        '{"action":"ls"}',
        '{"action":"finish","output":"unreachable"}',
      ], writer, gate)),
      /Aborted by user\./u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('without a gate, mutating tools stay invalid actions (non-interactive unchanged)', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-approval-off-'));
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const result = await runTaskLoop(makeTask('write a file'), {
      repoRoot: tempRoot,
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 4,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"write","path":"out.txt","content":"hello"}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {},
      progressWriter: writer,
      // no approvalGate, default (exposed-only) tool definitions
    });
    assert.equal(fs.existsSync(path.join(tempRoot, 'out.txt')), false);
    assert.ok(result.invalidResponses >= 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
