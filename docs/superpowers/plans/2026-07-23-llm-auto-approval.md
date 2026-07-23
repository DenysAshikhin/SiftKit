# LLM Auto-Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--approval auto` to repo-agent: the LLM reviews each pending command in-context (approve/deny/unsure), `unsure` and verdict failures escalate to the existing human approval flow, and the verdict call never touches the transcript so llama-cpp prompt caching stays intact.

**Architecture:** A new `LlmApprovalGate` decorator implements the same `request()` contract as `ApprovalGate` and wraps it; `ToolActionProcessor` is unchanged. The verdict is a one-off constrained request (`requestApprovalVerdict`, modeled on `requestFinishValidation`) built from `transcript.getMessages()` + one ephemeral user message, sent on the agent's llama-cpp slot. Approval mode is a three-state enum (`interactive|auto|off`) threaded CLI → API body → server route → engine → task-loop; `--no-approval` and the boolean `approval` API field are removed outright.

**Tech Stack:** TypeScript, zod (`src/lib/zod.js`), node:test, llama-cpp `json_schema` response format, mockResponses test plumbing.

**Spec:** `docs/superpowers/specs/2026-07-23-llm-auto-approval-design.md`

**Test invocation** (from repo root; bash): full pretest typecheck is slow, so during TDD use the filtered runner and pipe through siftkit:

```bash
npm run build:test 2>&1 | siftkit summary --question "did the test build succeed? if not list errors with file:line"
node ./dist/scripts/run-tests.js <filename-substring> 2>&1 | siftkit summary --question "pass/fail verdict; list failing test names with assertion messages"
```

**Key existing facts** (verified against the code; do not re-derive):
- `ApprovalGate.request()` / decision types: `src/repo-search/engine/approval-gate.ts:19-87`.
- The gate is consumed in `src/repo-search/engine/tool-action-processor.ts:232-256`; deny feeds a rejected tool call back to the model; abort throws.
- The assistant tool-call batch is appended to the transcript only **after** execution (`TranscriptManager.appendBatchExchange`), so at approval time the transcript ends with the previous turn — the verdict suffix is just one user message.
- `requestFinishValidation` (`src/repo-search/planner-protocol.ts:649-681`) is the template for a secondary constrained call; `PlannerRequestOptions` already supports `slotId`, `responseSchema`, `mockResponses`/`mockResponseIndex`.
- Mock responses are a single shared, ordered array: planner turns and verdict calls consume from the same list; `TaskLoop.mockResponseIndex` advances via `response.nextMockResponseIndex`.
- `RepoSearchProgressEvent` (`src/repo-search/types.ts:17-44`) is a flat optional-field bag with `kind: string`.
- Server route: `src/status-server/routes/core.ts:856-918` (gate creation at 878, `approvalOn` at 873); CLI: `src/cli/args.ts` (synopsis 15, `validateRepoAgentTokens` 164, parse case 299), `src/cli/dispatch.ts:51-58`, `src/cli/run-repo-search.ts:45-60`.

---

### Task 1: Approval-mode enum, verdict JSON schema, `requestApprovalVerdict`

**Files:**
- Modify: `src/repo-search/engine/approval-gate.ts`
- Modify: `src/providers/structured-output-schema.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Test: `tests/approval-verdict-request.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestApprovalVerdict } from '../src/repo-search/planner-protocol.js';
import { buildApprovalVerdictJsonSchema } from '../src/providers/structured-output-schema.js';
import { ApprovalModeSchema } from '../src/repo-search/engine/approval-gate.js';

test('ApprovalModeSchema accepts the three modes and rejects booleans', () => {
  assert.equal(ApprovalModeSchema.parse('interactive'), 'interactive');
  assert.equal(ApprovalModeSchema.parse('auto'), 'auto');
  assert.equal(ApprovalModeSchema.parse('off'), 'off');
  assert.equal(ApprovalModeSchema.safeParse(false).success, false);
  assert.equal(ApprovalModeSchema.safeParse(true).success, false);
});

test('buildApprovalVerdictJsonSchema constrains verdict to approve|deny|unsure', () => {
  assert.deepEqual(buildApprovalVerdictJsonSchema(), {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'deny', 'unsure'] },
      reason: { type: 'string' },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
  });
});

test('requestApprovalVerdict consumes one mock response and advances the index', async () => {
  const response = await requestApprovalVerdict({
    baseUrl: 'http://127.0.0.1:1',
    model: 'mock-model',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
    ],
    timeoutMs: 5000,
    mockResponses: ['{"verdict":"approve","reason":"ok"}'],
    mockResponseIndex: 0,
  });
  assert.equal(response.text, '{"verdict":"approve","reason":"ok"}');
  assert.equal(response.nextMockResponseIndex, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test 2>&1 | siftkit summary --question "did compilation fail on missing exports requestApprovalVerdict / buildApprovalVerdictJsonSchema / ApprovalModeSchema?"`
Expected: build FAILS on the three missing exports (compile error is the red state here).

- [ ] **Step 3: Implement**

In `src/repo-search/engine/approval-gate.ts`, after the existing `ApprovalDecisionKindSchema` block, add (and refactor `ApprovalGate.request` to use the named input type — same shape, no behavior change):

```ts
export const ApprovalModeSchema = z.enum(['interactive', 'auto', 'off']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export type ApprovalRequestInput = { turn: number; toolName: string; command: string };

/** Anything that can answer an approval request: the human gate or the LLM decorator. */
export type ApprovalRequester = {
  request(input: ApprovalRequestInput): Promise<ApprovalDecision>;
};
```

Change `ApprovalGate.request(input: { turn: number; toolName: string; command: string })` to `request(input: ApprovalRequestInput)`.

In `src/providers/structured-output-schema.ts`, next to `buildFinishValidationJsonSchema`:

```ts
export function buildApprovalVerdictJsonSchema(): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'deny', 'unsure'] },
      reason: { type: 'string' },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
  };
}
```

In `src/repo-search/planner-protocol.ts`, add `buildApprovalVerdictJsonSchema` to the existing import from `../providers/structured-output-schema.js`, and add next to `requestFinishValidation`:

```ts
export async function requestApprovalVerdict(options: {
  backend?: InferenceBackendId;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  slotId?: number;
  timeoutMs: number;
  mockResponses?: string[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    backend: options.backend,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: options.messages,
    slotId: options.slotId,
    timeoutMs: options.timeoutMs,
    maxTokens: 512,
    thinkingEnabled: false,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    abortSignal: options.abortSignal,
    logger: options.logger,
    stage: 'approval_verdict',
    responseSchema: buildApprovalVerdictJsonSchema(),
    responseSchemaName: 'siftkit_approval_verdict',
    toolDefinitions: [],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test 2>&1 | siftkit summary --question "build ok?"` then `node ./dist/scripts/run-tests.js approval-verdict-request 2>&1 | siftkit summary --question "pass/fail; failing test names"`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/approval-gate.ts src/providers/structured-output-schema.ts src/repo-search/planner-protocol.ts tests/approval-verdict-request.test.ts
git commit -m "feat(engine): approval-mode enum and constrained approval-verdict request"
```

---

### Task 2: `LlmApprovalGate` + task-loop wiring, engine E2E

**Files:**
- Create: `src/repo-search/engine/llm-approval-gate.ts`
- Modify: `src/repo-search/engine/task-loop-support.ts:168` (add `approvalMode`)
- Modify: `src/repo-search/engine/task-loop.ts` (verdict method + gate wrap)
- Modify: `src/repo-search/engine/tool-action-processor.ts:107` (deps type)
- Modify: `src/repo-search/types.ts:17-44` (progress event fields)
- Test: `tests/llm-auto-approval.test.ts` (create)

- [ ] **Step 1: Write the failing E2E test**

```ts
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
import type { JsonSerializable } from '../src/lib/json-types.js';

type ScriptedDecision = { kind: 'approve' } | { kind: 'deny'; reason: string } | { kind: 'abort' };

class RecordingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly events: RepoSearchProgressEvent[] = [];
  public gate: ApprovalGate | null = null;
  constructor(private readonly decide: (event: RepoSearchProgressEvent) => ScriptedDecision) {
    super();
  }
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
    if (event.kind !== 'approval_request') return;
    setImmediate(() => this.gate?.submit(String(event.approvalId), this.decide(event)));
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
    const writer = new RecordingWriter(() => ({ kind: 'abort' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
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
    // Transcript purity: the reviewer question never enters the transcript.
    const transcriptEvents = logEvents.filter((event) => event.kind === 'turn_new_messages');
    assert.equal(JSON.stringify(transcriptEvents).includes('independent command reviewer'), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: reviewer deny blocks the write and feeds the reason to the model', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-deny-'));
  try {
    const writer = new RecordingWriter(() => ({ kind: 'abort' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
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
    assert.equal(result.safetyRejects, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: unsure escalates to the human gate, which approves', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-unsure-'));
  try {
    const writer = new RecordingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
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
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: read-only tools fast-path without spending a verdict call', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-fastpath-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'content-a', 'utf8');
    const writer = new RecordingWriter(() => ({ kind: 'abort' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
    writer.gate = gate;
    // No verdict mock present: if a verdict call were made it would consume the finish action and fail the run.
    const result = await runTaskLoop(makeTask('read a file'), makeAutoLoopOptions(tempRoot, [
      '{"action":"read","path":"a.txt"}',
      '{"action":"finish","output":"done"}',
    ], writer, gate));
    assert.equal(result.finalOutput, 'done');
    const auto = writer.ofKind('approval_auto');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].verdict, 'approve');
    assert.equal(auto[0].reason, 'read-only tool');
    assert.equal(writer.ofKind('approval_request').length, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auto mode: unparseable verdicts (after one retry) escalate to the human gate', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llm-auto-badverdict-'));
  try {
    const writer = new RecordingWriter(() => ({ kind: 'approve' }));
    const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
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
    const writer = new RecordingWriter(() => ({ kind: 'approve' }));
    await assert.rejects(
      runTaskLoop(makeTask('write a file'), {
        repoRoot: tempRoot,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test 2>&1 | siftkit summary --question "list compile errors with file:line"`
Expected: FAILS — `approvalMode` not in `RunTaskLoopOptions`, `llm-approval-gate.ts` missing.

- [ ] **Step 3: Implement**

Create `src/repo-search/engine/llm-approval-gate.ts`:

```ts
import { z } from '../../lib/zod.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../types.js';
import type { PlannerActionResponse } from '../planner-protocol.js';
import type { ApprovalDecision, ApprovalRequester, ApprovalRequestInput } from './approval-gate.js';

const ApprovalVerdictSchema = z.object({
  verdict: z.enum(['approve', 'deny', 'unsure']),
  reason: z.string(),
});
type ApprovalVerdict = z.infer<typeof ApprovalVerdictSchema>;

/** Tools that cannot mutate state or reach the network; approved without a verdict call. */
export const AUTO_APPROVED_TOOL_NAMES = new Set(['read', 'grep', 'find', 'ls']);

/** Narrow view of TaskLoop: issues one ephemeral, schema-constrained verdict request. */
export type ApprovalVerdictRequester = {
  requestApprovalVerdict(question: string): Promise<PlannerActionResponse>;
};

export function buildApprovalVerdictQuestion(input: { toolName: string; command: string }): string {
  return [
    'You are now acting as an independent command reviewer, not the agent that proposed the action.',
    `Proposed action: tool "${input.toolName}" — ${input.command}`,
    '',
    'Decide whether this action should run:',
    '- approve: read-only, or clearly required by the task with effects confined to the repository working area.',
    '- deny: destructive or dangerous (recursive deletes, force-push, credential or secret access, sending data to external services), or unrelated to the task.',
    '- unsure: anything ambiguous — writes outside obvious task scope, package installs, long-running processes, or effects you cannot determine.',
    'When in doubt, prefer "unsure" over "approve".',
    'Respond with JSON: {"verdict":"approve"|"deny"|"unsure","reason":"<one sentence>"}',
  ].join('\n');
}

/**
 * Decorator over the human ApprovalGate: asks the model itself for an
 * approve/deny/unsure verdict via an ephemeral request (the transcript is never
 * mutated, preserving the llama-cpp prompt-cache prefix). `unsure` and verdict
 * failures fall through to the wrapped human gate.
 */
export class LlmApprovalGate {
  constructor(private readonly deps: {
    humanGate: ApprovalRequester;
    verdictRequester: ApprovalVerdictRequester;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  }) {}

  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    if (AUTO_APPROVED_TOOL_NAMES.has(input.toolName)) {
      this.emitVerdict(input, 'approve', 'read-only tool');
      return { kind: 'approve' };
    }
    const verdict = await this.requestVerdictWithRetry(buildApprovalVerdictQuestion(input));
    if (verdict === null) {
      this.emitVerdict(input, 'unsure', 'verdict call failed');
      return this.deps.humanGate.request(input);
    }
    this.emitVerdict(input, verdict.verdict, verdict.reason);
    if (verdict.verdict === 'approve') {
      return { kind: 'approve' };
    }
    if (verdict.verdict === 'deny') {
      return { kind: 'deny', reason: `auto-reviewer: ${verdict.reason}` };
    }
    return this.deps.humanGate.request(input);
  }

  private async requestVerdictWithRetry(question: string): Promise<ApprovalVerdict | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.deps.verdictRequester.requestApprovalVerdict(question);
        return ApprovalVerdictSchema.parse(JSON.parse(String(response.text || '')));
      } catch {
        // Inference failure or schema mismatch: retry once, then escalate to the human gate.
      }
    }
    return null;
  }

  private emitVerdict(input: ApprovalRequestInput, verdict: string, reason: string): void {
    this.deps.progressWriter.write({
      kind: 'approval_auto',
      turn: input.turn,
      toolName: input.toolName,
      command: input.command,
      verdict,
      reason,
    });
  }
}
```

In `src/repo-search/types.ts`, add to `RepoSearchProgressEvent`:

```ts
  verdict?: string;
  reason?: string;
```

In `src/repo-search/engine/task-loop-support.ts`, add to `RunTaskLoopOptions` (import `ApprovalMode` type from `./approval-gate.js`):

```ts
  approvalMode?: ApprovalMode;
```

In `src/repo-search/engine/task-loop.ts`:

1. Imports: add `LlmApprovalGate` from `./llm-approval-gate.js`; add `requestApprovalVerdict as requestApprovalVerdictRequest` to the existing `./planner-protocol.js` import (rename avoids colliding with the new method); add `ApprovalRequester` type to the `./approval-gate.js` type import.
2. In `buildToolActionProcessor`, replace `approvalGate: options.approvalGate ?? null,` with `approvalGate: this.buildApprovalRequester(options),`.
3. Add methods:

```ts
  private buildApprovalRequester(options: RunTaskLoopOptions): ApprovalRequester | null {
    if (options.approvalMode !== 'auto') {
      return options.approvalGate ?? null;
    }
    if (!options.approvalGate) {
      throw new Error('approvalMode "auto" requires an approvalGate for escalation.');
    }
    return new LlmApprovalGate({
      humanGate: options.approvalGate,
      verdictRequester: this,
      progressWriter: options.progressWriter ?? new SilentProgressWriter(),
    });
  }

  /** Ephemeral verdict call: transcript prefix + one user question; never appended to the transcript. */
  async requestApprovalVerdict(question: string): Promise<PlannerActionResponse> {
    const response = await requestApprovalVerdictRequest({
      backend: this.options.config ? getActiveInferenceBackend(this.options.config) : undefined,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      messages: [...this.transcript.getMessages(), { role: 'user', content: question }],
      slotId: this.slotId,
      timeoutMs: this.options.timeoutMs || DEFAULT_TIMEOUT_MS,
      mockResponses: this.options.mockResponses,
      mockResponseIndex: this.mockResponseIndex,
      abortSignal: this.options.abortSignal,
      logger: this.options.logger || null,
    });
    if (typeof response.nextMockResponseIndex === 'number') {
      this.mockResponseIndex = response.nextMockResponseIndex;
    }
    return response;
  }
```

In `src/repo-search/engine/tool-action-processor.ts`, change the deps field type from `approvalGate: ApprovalGate | null;` to `approvalGate: ApprovalRequester | null;` and update the import from `./approval-gate.js` accordingly (drop the now-unused `ApprovalGate` type import if nothing else uses it).

- [ ] **Step 4: Run tests**

Run: `npm run build:test 2>&1 | siftkit summary --question "build ok?"` then `node ./dist/scripts/run-tests.js llm-auto-approval 2>&1 | siftkit summary --question "pass/fail; failing test names with messages"` and `node ./dist/scripts/run-tests.js tool-action-approval 2>&1 | siftkit summary --question "pass/fail"`
Expected: all 6 new tests PASS; existing `tool-action-approval` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/llm-approval-gate.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/task-loop-support.ts src/repo-search/engine/tool-action-processor.ts src/repo-search/types.ts tests/llm-auto-approval.test.ts
git commit -m "feat(engine): LlmApprovalGate decorator with fast path, retry, and human escalation"
```

---

### Task 3: Thread `approvalMode` through engine → execute → server route

**Files:**
- Modify: `src/repo-search/engine.ts:189,256` (options + threading)
- Modify: `src/repo-search/types.ts:53-78` (`RepoSearchExecutionRequest`)
- Modify: `src/repo-search/execute.ts:344` (threading)
- Modify: `src/status-server/routes/core.ts:856-918` (enum parsing, gate creation)
- Test: `tests/streamed-repo-agent-endpoint.test.ts` (modify)

- [ ] **Step 1: Write the failing tests**

In `tests/streamed-repo-agent-endpoint.test.ts`:

1. In the existing `'POST /repo-agent with approval:false runs autonomously'` test, rename it to `'POST /repo-agent with approval:"off" runs autonomously with no approval frames'` and change `approval: false,` to `approval: 'off',`.
2. Append two tests:

```ts
test('POST /repo-agent with approval:"auto": reviewer approves; no approval_request frames', async () => {
  const harness = await startHarness('siftkit-repo-agent-llm-auto-');
  try {
    const written = path.join(process.cwd(), 'agent-endpoint-llm-auto.txt');
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        approval: 'auto',
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"agent-endpoint-llm-auto.txt","content":"auto"}',
          '{"verdict":"approve","reason":"task-scoped write"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(response.result, response.rawBody);
    assert.equal(fs.readFileSync(written, 'utf8'), 'auto');
    fs.rmSync(written, { force: true });
    assert.equal(response.progress.filter((event) => event.kind === 'approval_request').length, 0);
    const autoFrames = response.progress.filter((event) => event.kind === 'approval_auto');
    assert.equal(autoFrames.length, 1);
    assert.equal(autoFrames[0].verdict, 'approve');
  } finally {
    await harness.close();
  }
});

test('POST /repo-agent with a boolean approval value fails loudly', async () => {
  const harness = await startHarness('siftkit-repo-agent-bool-approval-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        approval: false,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"finish","output":"unreachable"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.equal(response.result, null);
    assert.match(String(response.errorMessage), /approval must be one of: interactive, auto, off/u);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npm run build:test 2>&1 | siftkit summary --question "build ok?"` then `node ./dist/scripts/run-tests.js streamed-repo-agent-endpoint 2>&1 | siftkit summary --question "which tests failed and why"`
Expected: `approval:"off"` test FAILS (server still treats non-false as approval-on, so an unanswered approval_request stalls/times out); boolean test FAILS (no rejection yet).

- [ ] **Step 3: Implement**

`src/repo-search/types.ts` — add to `RepoSearchExecutionRequest` (extend the existing `./engine/approval-gate.js` type import with `ApprovalMode`):

```ts
  approvalMode?: ApprovalMode;
```

`src/repo-search/engine.ts` — add `approvalMode?: ApprovalMode;` to the `runRepoSearch` options type (next to `approvalGate?: ApprovalGate;`, importing the type from `./engine/approval-gate.js`), and inside the `runTaskLoop` call add `approvalMode: options.approvalMode,` next to `approvalGate: options.approvalGate,`.

`src/repo-search/execute.ts` — in the `runRepoSearch` call, add `approvalMode: request.approvalMode,` next to `approvalGate: request.approvalGate,`.

`src/status-server/routes/core.ts` — in `RepoTaskEndpoint`:

1. Import `ApprovalModeSchema` and type `ApprovalMode` from the approval-gate module (same import path style as the existing `ApprovalGate` import).
2. Replace `const approvalOn = this.mode === 'agent' ? parsedBody.approval !== false : interactive;` with:

```ts
    const approvalMode = this.resolveApprovalMode(parsedBody, interactive);
    const approvalOn = approvalMode !== 'off';
```

3. Add the method:

```ts
  private resolveApprovalMode(parsedBody: JsonObject, interactive: boolean): ApprovalMode {
    if (this.mode !== 'agent') {
      return interactive ? 'interactive' : 'off';
    }
    const parsed = ApprovalModeSchema.safeParse(parsedBody.approval ?? 'interactive');
    if (!parsed.success) {
      throw new Error('approval must be one of: interactive, auto, off.');
    }
    return parsed.data;
  }
```

4. In the `ctx.engineService.executeRepoSearch({...})` call, add `approvalMode,` next to `approvalGate,`.

Also update the stale comment above the old line ("approval is on unless approval===false") to: `// Agent always gets the full surface; approval mode is interactive|auto|off (default interactive).`

- [ ] **Step 4: Run tests**

Run: `npm run build:test 2>&1 | siftkit summary --question "build ok?"` then `node ./dist/scripts/run-tests.js streamed-repo-agent-endpoint 2>&1 | siftkit summary --question "pass/fail; failing test names"` and `node ./dist/scripts/run-tests.js streamed-repo-search-interactive 2>&1 | siftkit summary --question "pass/fail"`
Expected: all PASS (search-mode interactive behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/types.ts src/repo-search/engine.ts src/repo-search/execute.ts src/status-server/routes/core.ts tests/streamed-repo-agent-endpoint.test.ts
git commit -m "feat(server): three-state approval mode on /repo-agent; boolean approval rejected"
```

---

### Task 4: CLI `--approval <mode>` flag, TTY gating, renderer line

**Files:**
- Modify: `src/cli/args.ts:15-16,63-67,164-187,296-308`
- Modify: `src/cli/dispatch.ts:51-58`
- Modify: `src/cli/run-repo-search.ts`
- Modify: `src/cli/progress-renderer.ts:37-58`
- Test: `tests/repo-agent-cli.test.ts`, `tests/cli-command-surface.test.ts` (modify)

- [ ] **Step 1: Write the failing tests**

In `tests/cli-command-surface.test.ts`, replace the two `--no-approval` tests:

```ts
test('validateRepoAgentTokens accepts value + boolean flags and rejects unknown', () => {
  assert.doesNotThrow(() => validateRepoAgentTokens(['--prompt', 'x', '--model', 'm', '--log-file', 'l', '--progress', '--approval', 'auto']));
  assert.throws(() => validateRepoAgentTokens(['--prompt']), /Missing value for repo-agent option/u);
  assert.throws(() => validateRepoAgentTokens(['--approval']), /Missing value for repo-agent option/u);
  assert.throws(() => validateRepoAgentTokens(['--no-approval']), /Unknown option for repo-agent/u);
  assert.throws(() => validateRepoAgentTokens(['--interactive']), /Unknown option for repo-agent/u);
});

test('parseArguments maps --approval to approvalMode and rejects invalid values', () => {
  assert.equal(parseArguments(['--prompt', 'x', '--approval', 'auto']).approvalMode, 'auto');
  assert.equal(parseArguments(['--prompt', 'x', '--approval', 'off']).approvalMode, 'off');
  assert.equal(parseArguments(['--prompt', 'x']).approvalMode, undefined);
  assert.throws(() => parseArguments(['--approval', 'bogus']), /Invalid --approval value: bogus/u);
});
```

In `tests/repo-agent-cli.test.ts`:

1. First test: rename to `'repo-agent --approval off runs autonomously (non-TTY) and applies a mutation'`; change argv to `['repo-agent', '--prompt', 'make x', '--approval', 'off']`; change the body assertion to `assert.equal(received[0].approval, 'off');`.
2. Second test: rename to `'repo-agent default (interactive) on a non-TTY stdin fails fast with an approval-TTY error'` — argv and assertions unchanged.
3. Append (reusing the second test's server/env scaffold verbatim, only argv and assertions differ):

```ts
test('repo-agent --approval auto on a non-TTY stdin fails fast (escalations need a terminal)', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = getAddressInfo(server).port;
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['repo-agent', '--prompt', 'make x', '--approval', 'auto'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: new PassThrough(), // non-TTY
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /repo-agent approval mode requires a TTY/u);
    assert.deepEqual(hits, []);
  } finally {
    if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    if (oldConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    else process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('repo-agent --approval bogus fails with a validation error before any network call', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', '--prompt', 'make x', '--approval', 'bogus'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: new PassThrough(),
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Invalid --approval value: bogus/u);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npm run build:test 2>&1 | siftkit summary --question "list compile errors"` — expected FAIL (`approvalMode` missing from ParsedArgs). After stubbing nothing, proceed to implement; the red state is the compile failure.

- [ ] **Step 3: Implement**

`src/cli/args.ts`:

1. Import at top: `import { ApprovalModeSchema, type ApprovalMode } from '../repo-search/engine/approval-gate.js';`
2. Synopsis (line 15-16):

```ts
export const REPO_AGENT_SYNOPSIS =
  'siftkit repo-agent --prompt "make change x" [--model <model>] [--log-file <path>] [--approval <interactive|auto|off>] [--progress]';
```

3. `ParsedArgs`: replace `noApproval?: boolean;` with `approvalMode?: ApprovalMode;`.
4. `validateRepoAgentTokens`: `flagsWithValues` becomes `new Set(['--prompt', '-prompt', '--model', '--log-file', '--approval'])`; `booleanFlags` becomes `new Set(['--progress'])`.
5. Add a parse helper and use it from both `parseArguments` and `readRepoAgentApprovalMode`:

```ts
function parseApprovalModeValue(raw: string | undefined): ApprovalMode {
  const parsed = ApprovalModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid --approval value: ${raw ?? '(missing)'}. Expected interactive, auto, or off.`);
  }
  return parsed.data;
}

/** Pre-parse peek used by dispatch's fail-fast TTY gate. Defaults to interactive. */
export function readRepoAgentApprovalMode(tokens: string[]): ApprovalMode {
  const index = tokens.indexOf('--approval');
  return index === -1 ? 'interactive' : parseApprovalModeValue(tokens[index + 1]);
}
```

6. In `parseArguments`, replace the `--no-approval` case:

```ts
      case '--approval':
        parsed.approvalMode = parseApprovalModeValue(tokens[++index]);
        break;
```

`src/cli/dispatch.ts` — in the repo-agent block, replace the `assertStdinIsTty` line (and its comment) with:

```ts
      // Interactive and auto modes both prompt on escalation; only --approval off
      // skips the TTY requirement. Fail before the server preflight; --help stays usable.
      if (!commandHelpRequested) {
        assertStdinIsTty(readRepoAgentApprovalMode(commandArgs) !== 'off', options.stdin, 'repo-agent approval mode');
      }
```

Add `readRepoAgentApprovalMode` to the existing `./args.js` import.

`src/cli/run-repo-search.ts`:

1. Help text for agent mode:

```ts
        ? `Usage: ${REPO_AGENT_SYNOPSIS}\n`
          + 'Approval is interactive by default; every write/edit/run awaits your decision.\n'
          + '--approval auto lets the model self-review each command and escalate unsure ones to you; --approval off runs autonomously.\n'
          + '--progress streams per-turn telemetry to stderr.\n'
```

2. Replace the approval wiring:

```ts
  const approvalMode = parsed.approvalMode ?? 'interactive';
  const approvalOn = options.mode === 'agent' ? approvalMode !== 'off' : parsed.interactive === true;
```

3. In the `requestRepoAgent` body, replace `approval: parsed.noApproval !== true,` with `approval: approvalMode,`.

`src/cli/progress-renderer.ts` — in `describe`, before the final fallback return:

```ts
    if (kind === 'approval_auto') {
      const verdict = reader.optionalString('verdict') || '';
      const reason = reader.optionalString('reason') || '';
      return `${turnPrefix}auto-approval ${verdict}: ${reader.optionalString('toolName') || ''} — ${reason}`.trim();
    }
```

- [ ] **Step 4: Run tests**

Run: `npm run build:test 2>&1 | siftkit summary --question "build ok?"` then `node ./dist/scripts/run-tests.js repo-agent-cli 2>&1 | siftkit summary --question "pass/fail; failing names"` and `node ./dist/scripts/run-tests.js cli-command-surface 2>&1 | siftkit summary --question "pass/fail"` and `node ./dist/scripts/run-tests.js repo-search-cli-interactive 2>&1 | siftkit summary --question "pass/fail"`
Expected: all PASS. Also grep for stragglers: `grep -rn "no-approval\|noApproval" src tests dashboard packages` must return nothing (any hit is a missed call site — fix it, do not shim).

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/dispatch.ts src/cli/run-repo-search.ts src/cli/progress-renderer.ts tests/repo-agent-cli.test.ts tests/cli-command-surface.test.ts
git commit -m "feat(cli): replace --no-approval with three-state --approval flag"
```

---

### Task 5: Full verification

**Files:** none new.

- [ ] **Step 1: Full typecheck + test suite**

Run: `npm test 2>&1 | siftkit summary --question "overall pass/fail; list every failing test file and assertion; list typecheck errors with file:line"`
Expected: PASS. Fix anything surfaced (likely candidates: other tests or dashboard/contracts code still sending boolean `approval` or `--no-approval` — update them to the enum, no compatibility shims).

- [ ] **Step 2: Commit any fixups**

```bash
git add -A
git commit -m "test: align remaining call sites with three-state approval mode"
```

(Skip the commit if Step 1 needed no changes.)
