import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTaskLoop } from '../src/repo-search/engine.js';
import {
  CLIENT_ABORT_MESSAGE,
  type ApprovalDecision,
  type ApprovalGate,
} from '../src/repo-search/engine/approval-gate.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import type { ApprovalRequestProgressEvent, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { ApprovalGateHarness } from './helpers/approval-gate-harness.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';

const RUNTIME_PROFILE = new RepoSearchRuntimeProfile('repo-search');

class AutoRespondingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly approvalEvents: ApprovalRequestProgressEvent[] = [];
  public gate: ApprovalGate | null = null;
  constructor(private readonly decide: (event: ApprovalRequestProgressEvent) => ApprovalDecision) {
    super();
  }
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void {
    if (event.kind !== 'approval_request') return;
    this.approvalEvents.push(event);
    // Resolve asynchronously, as the real endpoint would.
    setImmediate(() => this.gate?.submit(event.approvalId, this.decide(event)));
  }
}

function makeTask(prompt: string) {
  return { id: 'task-1', question: prompt, signals: [] };
}

function makeLoopOptions(tempRoot: string, mockResponses: MockPlannerResponseInput[], writer: AutoRespondingWriter, gate: ApprovalGate) {
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
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]),
  };
}

test('approve lets a write execute; the file exists afterwards', async () => {
  const tempRoot = createManagedTempDir('siftkit-approval-write-');
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: "wrote it" },
    ], writer, gate));
    assert.equal(result.finalOutput, 'wrote it');
    assert.equal(writer.approvalEvents.length, 1);
    assert.equal(writer.approvalEvents[0].toolName, 'write');
    assert.match(
      String(writer.approvalEvents[0].reviewPayload),
      /"content": "hello"/u,
    );
    assert.equal(fs.readFileSync(path.join(tempRoot, 'out.txt'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('edit approval receives every complete replacement before execution', async () => {
  const tempRoot = createManagedTempDir('siftkit-approval-edit-');
  try {
    fs.writeFileSync(path.join(tempRoot, 'cleanup.ts'), 'cleanCache();\n', 'utf8');
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('edit cleanup'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "edit", arguments: {"path":"cleanup.ts","edits":[{"oldText":"cleanCache();","newText":"fs.rmSync(repoRoot, { recursive: true, force: true });"}]} }] },
      { content: "edited it" },
    ], writer, gate));

    assert.equal(result.finalOutput, 'edited it');
    assert.equal(writer.approvalEvents.length, 1);
    assert.match(
      String(writer.approvalEvents[0].reviewPayload),
      /fs\.rmSync\(repoRoot, \{ recursive: true, force: true \}\);/u,
    );
    assert.match(
      fs.readFileSync(path.join(tempRoot, 'cleanup.ts'), 'utf8'),
      /fs\.rmSync/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a run records the files it mutated even when the finish output denies changing anything', async () => {
  const tempRoot = createManagedTempDir('siftkit-mutated-paths-');
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: "No changes made. No files were edited." },
    ], writer, gate));

    assert.equal(result.finalOutput, 'No changes made. No files were edited.');
    assert.deepEqual(result.mutatedPaths, ['out.txt']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a mutated path is recorded in its resolved form, not as the model spelled it', async () => {
  const tempRoot = createManagedTempDir('siftkit-resolved-paths-');
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":".\\nested\\Out.txt","content":"hello"} }] },
      { content: "done" },
    ], writer, gate));

    assert.deepEqual(result.mutatedPaths, ['nested/Out.txt']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a denied mutation is not recorded as a mutated path', async () => {
  const tempRoot = createManagedTempDir('siftkit-denied-paths-');
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'deny', reason: 'no' }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: "blocked" },
    ], writer, gate));

    assert.deepEqual(result.mutatedPaths, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('deny blocks execution, feeds the reason to the model, and the run continues', async () => {
  const tempRoot = createManagedTempDir('siftkit-approval-deny-');
  try {
    const writer = new AutoRespondingWriter((event) => (
      event.toolName === 'write' ? { kind: 'deny', reason: 'not that file' } : { kind: 'approve' }
    ));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('write a file'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
      { content: "gave up" },
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
  const tempRoot = createManagedTempDir('siftkit-approval-read-');
  try {
    fs.writeFileSync(path.join(tempRoot, 'secret.txt'), 'secret-content', 'utf8');
    const writer = new AutoRespondingWriter(() => ({ kind: 'deny', reason: '' }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    const result = await runTaskLoop(makeTask('read a file'), makeLoopOptions(tempRoot, [
      { toolCalls: [{ name: "read", arguments: {"path":"secret.txt"} }] },
      { content: "done" },
    ], writer, gate));
    const deniedCommand = result.commands.find((command) => command.safe === false);
    assert.ok(deniedCommand);
    assert.doesNotMatch(String(deniedCommand.output || ''), /secret-content/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('abort throws out of the run', async () => {
  const tempRoot = createManagedTempDir('siftkit-approval-abort-');
  try {
    const writer = new AutoRespondingWriter(() => ({
      kind: 'abort',
      reason: CLIENT_ABORT_MESSAGE,
    }));
    const gate = new ApprovalGateHarness(writer).gate;
    writer.gate = gate;
    await assert.rejects(
      runTaskLoop(makeTask('read'), makeLoopOptions(tempRoot, [
        { toolCalls: [{ name: "ls", arguments: {} }] },
        { content: "unreachable" },
      ], writer, gate)),
      /Aborted by user\./u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('without a gate, mutating tools stay invalid actions (non-interactive unchanged)', async () => {
  const tempRoot = createManagedTempDir('siftkit-approval-off-');
  try {
    const writer = new AutoRespondingWriter(() => ({ kind: 'approve' }));
    const result = await runTaskLoop(makeTask('write a file'), {
                                                                 plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
      repoRoot: tempRoot,
      systemContext: createEmptyPresetSystemContext(),
      config: mockOfflineSiftConfig(),
      model: 'mock-model',
      baseUrl: DEAD_BASE_URL,
      runtimeProfile: RUNTIME_PROFILE,
      maxTurns: 4,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "write", arguments: {"path":"out.txt","content":"hello"} }] },
        { content: "done" },
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
