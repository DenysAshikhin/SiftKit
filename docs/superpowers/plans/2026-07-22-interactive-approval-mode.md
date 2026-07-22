# Interactive Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `siftkit repo-search --interactive` prompts the user to Approve / Deny+reason / Abort every planner tool call before it executes, and unlocks the withheld `write`/`edit`/`run` tools for interactive runs only.

**Architecture:** An `ApprovalGate` class parks `ToolActionProcessor` before any execution and emits `approval_request` frames through the run's existing `ProgressWriter` → SSE stream. Decisions arrive via a new plain-JSON `POST /repo-search/approval` endpoint that resolves the parked promise through a `ServerContext`-held registry. The CLI answers prompts with a readline-based `CliApprovalPrompter` driven from the SSE frame loop.

**Tech Stack:** TypeScript, existing SSE transport (`SseResponseWriter` / `HttpClient.streamSse`), zod, `node:readline`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-22-interactive-approval-mode-design.md`

**Test command pattern:** `npm run build:test; node .\dist\scripts\run-tests.js <file-name-filter>`. Full gate: `npm test`.

**Repo rules that bind every task:** no `as` casts, no `any`, no `!`, no namespace imports, no function-valued request/service fields (reporter/gate objects with explicit methods only), IO-boundary types via `z.infer`.

**Load-bearing placement fact:** for native tools, `ToolActionProcessor.runNativeExecution` *executes* the tool (`tool-action-processor.ts:231`). The gate MUST run after `screenWebAndDuplicates` and before `runNativeExecution`, or `write`/`edit`/`run` would execute before the human answers.

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/repo-search/engine/approval-gate.ts` | `ApprovalGate` + `ApprovalDecision` + wire schemas |
| Modify `src/repo-search/types.ts` | `RepoSearchProgressEvent` gains `requestId`/`approvalId`/`toolName`; `RepoSearchExecutionRequest` gains `approvalGate` |
| Modify `src/repo-search/planner-protocol.ts` | `INTERACTIVE_REPO_TOOL_NAMES`, registry-wide native check, non-interactive sanitizer |
| Modify `src/repo-search/engine/tool-action-processor.ts` | Gate call in `processToolAction`; allowed-list validation |
| Modify `src/repo-search/engine/task-loop-support.ts`, `task-loop.ts`, `engine.ts`, `execute.ts` | Thread `approvalGate` engine-deep |
| Modify `src/status-server/server-types.ts` (+ context construction site) | `approvalGates: Map<string, ApprovalGate>` |
| Modify `src/status-server/routes/core.ts` | `interactive` flag on `/repo-search`; new `RepoSearchApprovalEndpoint` + route row |
| Create `src/cli/approval-prompter.ts` | `CliApprovalPrompter` (readline) |
| Modify `src/cli/args.ts`, `run-repo-search.ts`, `dispatch.ts`, `help.ts` | `--interactive` flag, TTY check, stdin threading |
| Modify `src/cli/status-server-api-client.ts` | Approval frame handling + `submitRepoSearchApproval` |

---

### Task 1: ApprovalGate

**Files:**
- Create: `src/repo-search/engine/approval-gate.ts`
- Modify: `src/repo-search/types.ts` (progress event fields)
- Test: `tests/approval-gate.test.ts`

- [ ] **Step 1: Add event fields**

In `src/repo-search/types.ts`, add to `RepoSearchProgressEvent`:

```ts
  requestId?: string;
  approvalId?: string;
  toolName?: string;
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/approval-gate.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../src/repo-search/engine/approval-gate.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

class CollectingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

test('request emits approval_request and resolves with the submitted decision', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
  const pending = gate.request({ turn: 2, toolName: 'write', command: 'write path=src/x.ts' });
  assert.equal(writer.events.length, 1);
  const event = writer.events[0];
  assert.equal(event.kind, 'approval_request');
  assert.equal(event.requestId, 'run-1');
  assert.equal(event.toolName, 'write');
  assert.equal(event.command, 'write path=src/x.ts');
  assert.equal(typeof event.approvalId, 'string');
  const submitted = gate.submit(String(event.approvalId), { kind: 'approve' });
  assert.equal(submitted, true);
  assert.deepEqual(await pending, { kind: 'approve' });
});

test('deny decision carries its reason', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
  const pending = gate.request({ turn: 1, toolName: 'git', command: 'git log' });
  gate.submit(String(writer.events[0].approvalId), { kind: 'deny', reason: 'wrong branch' });
  assert.deepEqual(await pending, { kind: 'deny', reason: 'wrong branch' });
});

test('unknown or already-resolved approvalId returns false', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 5000 });
  assert.equal(gate.submit('nope', { kind: 'approve' }), false);
  const pending = gate.request({ turn: 1, toolName: 'ls', command: 'ls' });
  const approvalId = String(writer.events[0].approvalId);
  assert.equal(gate.submit(approvalId, { kind: 'approve' }), true);
  await pending;
  assert.equal(gate.submit(approvalId, { kind: 'approve' }), false);
});

test('timeout rejects with a distinct error', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGate({ requestId: 'run-1', progressWriter: writer, timeoutMs: 30 });
  await assert.rejects(
    gate.request({ turn: 1, toolName: 'read', command: 'read path=a.ts' }),
    /Approval request timed out after 30 ms\./u,
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js approval-gate`
Expected: FAIL — cannot find module

- [ ] **Step 4: Write the implementation**

```ts
// src/repo-search/engine/approval-gate.ts
import { randomUUID } from 'node:crypto';
import { z } from '../../lib/zod.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../types.js';

export const ApprovalDecisionKindSchema = z.enum(['approve', 'deny', 'abort']);

export const RepoSearchApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: ApprovalDecisionKindSchema,
  reason: z.string().optional(),
});
export type RepoSearchApprovalRequest = z.infer<typeof RepoSearchApprovalRequestSchema>;

export const RepoSearchApprovalResultSchema = z.object({ accepted: z.literal(true) });
export type RepoSearchApprovalResult = z.infer<typeof RepoSearchApprovalResultSchema>;

export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'deny'; reason: string }
  | { kind: 'abort' };

export function toApprovalDecision(request: RepoSearchApprovalRequest): ApprovalDecision {
  if (request.decision === 'deny') {
    return { kind: 'deny', reason: (request.reason ?? '').trim() };
  }
  return { kind: request.decision };
}

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  timeoutHandle: NodeJS.Timeout;
};

/**
 * Parks tool execution until a human decision arrives. Emits approval_request
 * through the run's progress writer (which the SSE layer forwards); submit()
 * is called by the /repo-search/approval endpoint via the server registry.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly requestId: string;
  private readonly progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  private readonly timeoutMs: number;

  constructor(options: {
    requestId: string;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    timeoutMs: number;
  }) {
    this.requestId = options.requestId;
    this.progressWriter = options.progressWriter;
    this.timeoutMs = options.timeoutMs;
  }

  request(input: { turn: number; toolName: string; command: string }): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(approvalId);
        reject(new Error(`Approval request timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      timeoutHandle.unref?.();
      this.pending.set(approvalId, { resolve, timeoutHandle });
      this.progressWriter.write({
        kind: 'approval_request',
        requestId: this.requestId,
        approvalId,
        turn: input.turn,
        toolName: input.toolName,
        command: input.command,
      });
    });
  }

  submit(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return false;
    }
    this.pending.delete(approvalId);
    clearTimeout(entry.timeoutHandle);
    entry.resolve(decision);
    return true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js approval-gate`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/approval-gate.ts src/repo-search/types.ts tests/approval-gate.test.ts
git commit -m "feat: add ApprovalGate with approval_request progress events"
```

---

### Task 2: Tool surface — interactive names, registry-wide validation, sanitizer

**Files:**
- Modify: `src/repo-search/planner-protocol.ts`
- Test: `tests/repo-search-planner-protocol.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (append to the existing file)

```ts
// append to tests/repo-search-planner-protocol.test.ts
import {
  INTERACTIVE_REPO_TOOL_NAMES,
  isRepoSearchNativeToolName,
  resolveRepoSearchPlannerToolDefinitions,
  sanitizeNonInteractiveAllowedTools,
} from '../src/repo-search/planner-protocol.js';

test('interactive tool names extend the exposed surface with write, edit, run', () => {
  assert.deepEqual(
    [...INTERACTIVE_REPO_TOOL_NAMES],
    ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run'],
  );
});

test('native tool name check covers the full registry', () => {
  assert.equal(isRepoSearchNativeToolName('write'), true);
  assert.equal(isRepoSearchNativeToolName('edit'), true);
  assert.equal(isRepoSearchNativeToolName('run'), true);
  assert.equal(isRepoSearchNativeToolName('git'), false); // still the command tool
  assert.equal(isRepoSearchNativeToolName('nonsense'), false);
});

test('resolver returns definitions for interactive names', () => {
  const names = resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES])
    .map((definition) => definition.function.name);
  assert.ok(names.includes('write') && names.includes('edit') && names.includes('run'));
});

test('sanitizer strips mutating tools from non-interactive allowed lists', () => {
  assert.deepEqual(sanitizeNonInteractiveAllowedTools(['read', 'write', 'run', 'git']), ['read', 'git']);
  assert.equal(sanitizeNonInteractiveAllowedTools(undefined), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js repo-search-planner-protocol`
Expected: FAIL — missing exports

- [ ] **Step 3: Implement in `planner-protocol.ts`**

Replace the exposure block (`planner-protocol.ts:247-254`) with:

```ts
/** Tools a non-interactive model may be offered. `write`, `edit` and `run` need the approval gate. */
export const EXPOSED_REPO_TOOL_NAMES = ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch'] as const;

/** Full surface for interactive (human-approved) runs. */
export const INTERACTIVE_REPO_TOOL_NAMES = [...EXPOSED_REPO_TOOL_NAMES, 'write', 'edit', 'run'] as const;

/** `git` is the only tool whose args carry a raw command string; everything else is native. */
export const REPO_COMMAND_TOOL_NAME = 'git';

const EXPOSED_REPO_TOOL_NAME_SET = new Set<string>(EXPOSED_REPO_TOOL_NAMES);
const REGISTERED_REPO_TOOL_NAME_SET = new Set<string>(Object.keys(REPO_TOOL_REGISTRY));
const WEB_TOOL_NAMES = new Set<string>(['web_search', 'web_fetch']);
```

Update the two membership functions:

```ts
export function isRepoSearchNativeToolName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return REGISTERED_REPO_TOOL_NAME_SET.has(normalized) && normalized !== REPO_COMMAND_TOOL_NAME;
}

export function sanitizeNonInteractiveAllowedTools(allowedToolNames: string[] | undefined): string[] | undefined {
  if (!Array.isArray(allowedToolNames)) {
    return undefined;
  }
  return allowedToolNames.filter((toolName) => EXPOSED_REPO_TOOL_NAME_SET.has(normalizeToolName(toolName)));
}
```

In `resolveRepoSearchPlannerToolDefinitions` (line ~296), change the membership
check from `EXPOSED_REPO_TOOL_NAME_SET` to `REGISTERED_REPO_TOOL_NAME_SET` —
exposure control now belongs to callers, and Task 5 fences every server entry
point with the sanitizer.

- [ ] **Step 4: Run the planner-protocol + repo-search regressions**

Run: `npm run build:test; node .\dist\scripts\run-tests.js repo-search-planner-protocol; node .\dist\scripts\run-tests.js repo-search`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/planner-protocol.ts tests/repo-search-planner-protocol.test.ts
git commit -m "feat: add interactive tool surface and non-interactive sanitizer"
```

---

### Task 3: Gate + allowed-list enforcement in ToolActionProcessor

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/task-loop-support.ts` (`RunTaskLoopOptions.approvalGate`)
- Modify: `src/repo-search/engine/task-loop.ts:259` (deps)
- Modify: `src/repo-search/engine.ts` (options type ~line 167 + pass-through at the `runTaskLoop` call)
- Modify: `src/repo-search/execute.ts:318` area (`approvalGate: request.approvalGate`)
- Modify: `src/repo-search/types.ts` (`RepoSearchExecutionRequest.approvalGate?: ApprovalGate`)
- Test: `tests/tool-action-approval.test.ts`

- [ ] **Step 1: Write the failing test**

Model the harness on `tests/mock-repo-search-loop.test.ts` (mock responses drive
`runTaskLoop`; mirror its option boilerplate — model, baseUrl, mock config).

```ts
// tests/tool-action-approval.test.ts
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

class AutoRespondingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly approvalEvents: RepoSearchProgressEvent[] = [];
  public gate: ApprovalGate | null = null;
  constructor(private readonly decide: (event: RepoSearchProgressEvent) =>
    { kind: 'approve' } | { kind: 'deny'; reason: string } | { kind: 'abort' }) {
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
```

Adjust `makeTask` / option boilerplate to whatever `tests/mock-repo-search-loop.test.ts`
actually passes (task shape and required option fields) — mirror it exactly; the
assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tool-action-approval`
Expected: FAIL — `approvalGate` unknown option; write executes without prompting for the interactive definitions case

- [ ] **Step 3: Thread the gate**

1. `src/repo-search/types.ts` — `RepoSearchExecutionRequest` gains:

```ts
  approvalGate?: ApprovalGate;
```

   (`import type { ApprovalGate } from './engine/approval-gate.js';`)

2. `task-loop-support.ts:143` — `RunTaskLoopOptions` gains `approvalGate?: ApprovalGate;`
3. `task-loop.ts:259` (`buildToolActionProcessor`) — add `approvalGate: options.approvalGate ?? null,` to the deps object.
4. `engine.ts` — the run options type (~line 167) gains `approvalGate?: ApprovalGate;` and the internal `runTaskLoop` invocation passes it through.
5. `execute.ts` (~line 318, where `allowedTools` is forwarded) — add `approvalGate: request.approvalGate,`.

- [ ] **Step 4: Gate + allowed-list check in `tool-action-processor.ts`**

1. Deps type gains `approvalGate: ApprovalGate | null;`
2. In `validateToolAction`, after the registry-membership check (the
   `if (!isCommandTool && !isNativeTool)` block), add an allowed-list check with
   the same invalid-action bookkeeping:

```ts
    if (!this.deps.allowedPlannerToolNames.includes(normalizedToolName)) {
      counters.invalidResponses += 1;
      const disallowedToolMessage = `Invalid action: tool "${normalizedToolName}" is not enabled for this run. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      state.batchOutcomes.push({
        action: { tool_name: normalizedToolName, args: toolAction.args },
        toolCallId: `invalid_call_${counters.invalidResponses}`,
        toolContent: disallowedToolMessage,
      });
      return this.logInvalidAction(turn, toolAction, disallowedToolMessage);
    }
```

3. In `processToolAction`, between the `screenWebAndDuplicates` return and the
   `runNativeExecution` call (currently `const nativeExecution = isNativeTool ? ...`),
   insert:

```ts
    if (this.deps.approvalGate) {
      const decision = await this.deps.approvalGate.request({
        turn,
        toolName: normalizedToolName,
        command,
      });
      if (decision.kind === 'abort') {
        throw new Error('Aborted by user.');
      }
      if (decision.kind === 'deny') {
        const { commands: taskCommands } = this.deps;
        counters.safetyRejects += 1;
        const reason = decision.reason ? `user denied — ${decision.reason}` : 'user denied this command';
        const rejection = `Rejected command: ${reason}`;
        taskCommands.push({ command, turn, safe: false, reason, exitCode: null, output: rejection });
        state.batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: `denied_call_${taskCommands.length}`,
          toolContent: rejection,
        });
        return 'next';
      }
    }
```

   (Destructure names to match the method's existing locals — `commands`,
   `counters`, `forcedFinish` are already destructured at the top of
   `processToolAction`; reuse them instead of re-destructuring.)

- [ ] **Step 5: Run test + engine regressions**

Run: `npm run build:test; node .\dist\scripts\run-tests.js tool-action-approval; node .\dist\scripts\run-tests.js mock-repo-search-loop; node .\dist\scripts\run-tests.js repo-search-loop`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/repo-search tests/tool-action-approval.test.ts
git commit -m "feat: gate tool execution on ApprovalGate decisions in the engine"
```

---

### Task 4: Server — registry, interactive flag, approval endpoint

**Files:**
- Modify: `src/status-server/server-types.ts:82` (`ServerContext` gains `approvalGates`)
- Modify: the `ServerContext` construction site (grep `activeRunsByRequestId: new Map` — add `approvalGates: new Map()` beside it)
- Modify: `src/status-server/routes/core.ts` (`RepoSearchEndpoint.execute` + new endpoint + route row at line 1683)
- Test: `tests/streamed-repo-search-interactive.test.ts`

- [ ] **Step 1: Write the failing E2E test**

```ts
// tests/streamed-repo-search-interactive.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';

function postJson(url: string, body: JsonSerializable): Promise<{ statusCode: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text, 'utf8') },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { raw += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: asObject(parseJsonValueText(raw || '{}')) }));
    });
    request.on('error', reject);
    request.write(text);
    request.end();
  });
}

test('interactive write run: approval_request precedes execution; approve completes it', async () => {
  const harness = await startHarness('siftkit-interactive-approve-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        interactive: true,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"interactive-out.txt","content":"approved"}',
          '{"action":"finish","output":"wrote it"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
      onProgress: async (event) => {
        if (event.kind !== 'approval_request') return;
        const submitted = await postJson(`${harness.baseUrl}/repo-search/approval`, {
          requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'approve',
        });
        assert.equal(submitted.statusCode, 200);
        assert.equal(submitted.body.accepted, true);
      },
    });
    assert.ok(response.result, response.rawBody);
    const written = path.join(process.cwd(), 'interactive-out.txt');
    assert.equal(fs.readFileSync(written, 'utf8'), 'approved');
    fs.rmSync(written, { force: true });
    const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
    assert.equal(approvalFrames.length, 1);
    assert.equal(approvalFrames[0].toolName, 'write');
  } finally {
    await harness.close();
  }
});

test('interactive deny: reason reaches the transcript; abort ends with error frame', async () => {
  const harness = await startHarness('siftkit-interactive-deny-');
  try {
    const denyResponse = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'write then stop', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        interactive: true,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"never.txt","content":"never"}',
          '{"action":"finish","output":"gave up"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
      onProgress: async (event) => {
        if (event.kind !== 'approval_request') return;
        await postJson(`${harness.baseUrl}/repo-search/approval`, {
          requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'deny', reason: 'wrong path',
        });
      },
    });
    assert.ok(denyResponse.result);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'never.txt')), false);

    const abortResponse = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'abort me', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        interactive: true,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"ls"}', '{"action":"finish","output":"unreachable"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
      onProgress: async (event) => {
        if (event.kind !== 'approval_request') return;
        await postJson(`${harness.baseUrl}/repo-search/approval`, {
          requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'abort',
        });
      },
    });
    assert.equal(abortResponse.result, null);
    assert.match(String(abortResponse.errorMessage), /Aborted by user\./u);
  } finally {
    await harness.close();
  }
});

test('approval endpoint: 404 unknown requestId, 409 stale approvalId; timeout aborts the run', async () => {
  const harness = await startHarness('siftkit-interactive-edge-');
  try {
    const notFound = await postJson(`${harness.baseUrl}/repo-search/approval`, {
      requestId: 'missing', approvalId: 'x', decision: 'approve',
    });
    assert.equal(notFound.statusCode, 404);

    process.env.SIFTKIT_APPROVAL_TIMEOUT_MS = '150';
    try {
      let staleCheck: Promise<void> | null = null;
      const timedOut = await requestSse(`${harness.baseUrl}/repo-search`, {
        body: {
          prompt: 'time out', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
          interactive: true,
          availableModels: ['mock-model'],
          mockResponses: ['{"action":"ls"}', '{"action":"finish","output":"unreachable"}'],
          mockCommandResults: {},
        },
        timeoutMs: 20_000,
        onProgress: async (event) => {
          if (event.kind !== 'approval_request') return;
          // Answer AFTER the timeout to exercise the stale path.
          staleCheck = new Promise<void>((resolve) => {
            setTimeout(async () => {
              const stale = await postJson(`${harness.baseUrl}/repo-search/approval`, {
                requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'approve',
              });
              // Run may already be unregistered (404) or gate resolved (409); both are stale outcomes.
              assert.ok(stale.statusCode === 409 || stale.statusCode === 404, String(stale.statusCode));
              resolve();
            }, 400);
          });
        },
      });
      assert.equal(timedOut.result, null);
      assert.match(String(timedOut.errorMessage), /Approval request timed out/u);
      if (staleCheck) await staleCheck;
    } finally {
      delete process.env.SIFTKIT_APPROVAL_TIMEOUT_MS;
    }
  } finally {
    await harness.close();
  }
});

test('non-interactive body cannot smuggle mutating tools via allowedTools', async () => {
  const harness = await startHarness('siftkit-interactive-guard-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        allowedTools: ['read', 'write', 'run'],
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"smuggled.txt","content":"nope"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(response.result);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'smuggled.txt')), false);
  } finally {
    await harness.close();
  }
});
```

Interactive tests must answer approvals *during* the stream, which is why
`requestSse` gains the `onProgress` hook in Step 2.

- [ ] **Step 2: Extend `tests/helpers/sse-http.ts` with a live progress hook**

`requestSse` options gain `onProgress?: (event: JsonObject) => void | Promise<void>`;
invoke it (fire-and-forget with `void ... .catch(reject)`) for each progress frame
as it is parsed, before pushing to `collected.progress`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-repo-search-interactive`
Expected: FAIL — no approval endpoint (404 route), no gate

- [ ] **Step 4: Server implementation**

1. `server-types.ts` — inside `ServerContext` (near `activeRunsByRequestId`):

```ts
  approvalGates: Map<string, ApprovalGate>;
```

   (`import type { ApprovalGate } from '../repo-search/engine/approval-gate.js';`)
   Initialize `approvalGates: new Map(),` at the construction site.

2. `core.ts` `RepoSearchEndpoint.execute` — replace the `allowedTools` line and
   wire the gate:

```ts
    const interactive = parsedBody.interactive === true;
    const requestedAllowedTools = Array.isArray(parsedBody.allowedTools)
      ? parsedBody.allowedTools.map((value) => String(value))
      : undefined;
    const allowedTools = interactive
      ? [...INTERACTIVE_REPO_TOOL_NAMES]
      : sanitizeNonInteractiveAllowedTools(requestedAllowedTools);
    const progressWriter = new LoggedRepoSearchSseProgressWriter(stream, admission.requestId);
    const approvalGate = interactive
      ? new ApprovalGate({
        requestId: admission.requestId,
        progressWriter,
        timeoutMs: readApprovalTimeoutMs(),
      })
      : undefined;
    if (approvalGate) {
      ctx.approvalGates.set(admission.requestId, approvalGate);
    }
    try {
      const result = await ctx.engineService.executeRepoSearch({
        // ...existing fields unchanged...
        allowedTools,
        abortSignal: stream.abortSignal,
        progressWriter,
        approvalGate,
      });
      RepoSearchResponseSanityChecker.assertSafeToSend(result);
      return result;
    } finally {
      if (approvalGate) {
        ctx.approvalGates.delete(admission.requestId);
      }
    }
```

   with a module-level helper:

```ts
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function readApprovalTimeoutMs(): number {
  const raw = Number(process.env.SIFTKIT_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_APPROVAL_TIMEOUT_MS;
}
```

3. New endpoint class in `core.ts` + route row after `/repo-search` (line 1683):

```ts
class RepoSearchApprovalEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const parsedRequest = RepoSearchApprovalRequestSchema.safeParse(parsedBody);
    if (!parsedRequest.success) {
      sendJson(res, 400, { error: 'Expected requestId, approvalId, and decision (approve|deny|abort).' });
      return;
    }
    const gate = ctx.approvalGates.get(parsedRequest.data.requestId);
    if (!gate) {
      sendJson(res, 404, { error: `No interactive run with requestId ${parsedRequest.data.requestId}.` });
      return;
    }
    if (!gate.submit(parsedRequest.data.approvalId, toApprovalDecision(parsedRequest.data))) {
      sendJson(res, 409, { error: 'Approval already resolved or unknown approvalId.' });
      return;
    }
    sendJson(res, 200, { accepted: true });
  }
}
```

```ts
  { method: 'POST', path: '/repo-search/approval', endpoint: new RepoSearchApprovalEndpoint() },
```

   Route-order note: the row must precede any prefix pattern that could swallow
   `/repo-search/approval` — place it directly ABOVE the `/repo-search` row.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js streamed-repo-search-interactive; node .\dist\scripts\run-tests.js streamed-repo-search-endpoint; node .\dist\scripts\run-tests.js status-route-table`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/status-server tests/streamed-repo-search-interactive.test.ts tests/helpers/sse-http.ts
git commit -m "feat: interactive repo-search runs with approval endpoint and gate registry"
```

---

### Task 5: CliApprovalPrompter

**Files:**
- Create: `src/cli/approval-prompter.ts`
- Test: `tests/cli-approval-prompter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli-approval-prompter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliApprovalPrompter } from '../src/cli/approval-prompter.js';
import { makeCaptureStream } from './_test-helpers.js';

function makePrompter(): { prompter: CliApprovalPrompter; input: PassThrough; output: ReturnType<typeof makeCaptureStream> } {
  const input = new PassThrough();
  const output = makeCaptureStream();
  return { prompter: new CliApprovalPrompter({ input, output: output.stream }), input, output };
}

const EVENT = { kind: 'approval_request', requestId: 'r1', approvalId: 'a1', turn: 3, maxTurns: 24, toolName: 'write', command: 'write path=src/x.ts' };

test('a approves', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('a\n');
  assert.deepEqual(await pending, { kind: 'approve' });
  assert.match(output.read(), /t3\/24 wants to run: write path=src\/x\.ts/u);
});

test('d asks for a reason and denies with it', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('d\n');
  input.write('wrong file\n');
  assert.deepEqual(await pending, { kind: 'deny', reason: 'wrong file' });
  assert.match(output.read(), /reason \(enter to skip\)/u);
});

test('b aborts; unrecognized keys re-prompt', async () => {
  const { prompter, input, output } = makePrompter();
  const pending = prompter.promptDecision(EVENT);
  input.write('x\n');
  input.write('b\n');
  assert.deepEqual(await pending, { kind: 'abort' });
  const promptCount = (output.read().match(/\[a\]pprove {2}\[d\]eny {2}a\[b\]ort/gu) || []).length;
  assert.equal(promptCount, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js cli-approval-prompter`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```ts
// src/cli/approval-prompter.ts
import { createInterface } from 'node:readline';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import type { ApprovalDecision } from '../repo-search/engine/approval-gate.js';

/** Interactive terminal prompt for repo-search approval_request frames. */
export class CliApprovalPrompter {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  constructor(options: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) {
    this.input = options.input;
    this.output = options.output;
  }

  async promptDecision(event: JsonObject): Promise<ApprovalDecision> {
    const reader = new JsonRecordReader(event);
    const turn = reader.number('turn');
    const maxTurns = reader.number('maxTurns');
    const turnLabel = turn !== null && maxTurns !== null ? `t${turn}/${maxTurns} ` : '';
    const command = reader.optionalString('command') || reader.optionalString('toolName') || '<unknown>';
    this.output.write(`repo-search ${turnLabel}wants to run: ${command}\n`);
    const rl = createInterface({ input: this.input, output: this.output });
    try {
      for (;;) {
        const answer = (await this.question(rl, '  [a]pprove  [d]eny  a[b]ort > ')).trim().toLowerCase();
        if (answer === 'a') {
          return { kind: 'approve' };
        }
        if (answer === 'b') {
          return { kind: 'abort' };
        }
        if (answer === 'd') {
          const reason = (await this.question(rl, '  reason (enter to skip) > ')).trim();
          return { kind: 'deny', reason };
        }
      }
    } finally {
      rl.close();
    }
  }

  private question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
    return new Promise((resolve) => rl.question(prompt, resolve));
  }
}
```

(If `JsonRecordReader`'s numeric accessor has a different name, mirror the actual
API in `src/lib/json-record-reader.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test; node .\dist\scripts\run-tests.js cli-approval-prompter`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/approval-prompter.ts tests/cli-approval-prompter.test.ts
git commit -m "feat: add CliApprovalPrompter"
```

---

### Task 6: CLI wiring — flag, TTY check, api-client approval loop

**Files:**
- Modify: `src/cli/args.ts` (`--interactive`), `src/cli/help.ts` (usage line)
- Modify: `src/cli/run-repo-search.ts`, `src/cli/dispatch.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Test: `tests/repo-search-cli-interactive.test.ts`

- [ ] **Step 1: Write the failing E2E test**

Mock server pattern from `tests/repo-search-cli.test.ts` (env-pointed base URL,
`runCli`), extended with an SSE handler that emits an `approval_request` frame,
waits for the decision POST, then emits the result:

```ts
// tests/repo-search-cli-interactive.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { runCli } from '../src/cli/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { buildMockScorecard, makeCaptureStream } from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';

function makeTtyInput(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: true });
}

test('interactive CLI prompts on approval_request and POSTs the decision', async () => {
  const decisions: JsonObject[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/repo-search') {
        const parsed = asObject(parseJsonValueText(body || '{}'));
        assert.equal(parsed.interactive, true);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('\n');
        res.write(`event: progress\ndata: ${JSON.stringify({
          kind: 'approval_request', requestId: 'req-1', approvalId: 'ap-1',
          turn: 1, maxTurns: 4, toolName: 'write', command: 'write path=out.txt',
        })}\n\n`);
        const finish = setInterval(() => {
          if (decisions.length === 0) return;
          clearInterval(finish);
          const result: RepoSearchExecutionResult = {
            requestId: 'req-1',
            transcriptPath: 'C:\\tmp\\t.jsonl',
            artifactPath: 'C:\\tmp\\a.json',
            scorecard: buildMockScorecard('interactive done'),
          };
          res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
          res.end();
        }, 20);
        return;
      }
      if (req.url === '/repo-search/approval') {
        decisions.push(asObject(parseJsonValueText(body || '{}')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = getAddressInfo(server).port;
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const stdin = makeTtyInput();
    setTimeout(() => stdin.write('a\n'), 150);
    const code = await runCli({
      argv: ['repo-search', '--prompt', 'write something', '--interactive'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin,
    });
    assert.equal(code, 0);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], { requestId: 'req-1', approvalId: 'ap-1', decision: 'approve' });
    assert.match(stderr.read(), /wants to run: write path=out\.txt/u);
    assert.equal(stdout.read(), 'interactive done\n');
  } finally {
    if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('--interactive without a TTY fails fast', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '--prompt', 'x', '--interactive'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: new PassThrough(), // no isTTY
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /--interactive requires a TTY/u);
});
```

Match `runCli`'s actual options type: `CliRunOptions` gains
`stdin?: NodeJS.ReadableStream & { isTTY?: boolean }` (Step 3). If `runCli`
callers construct options elsewhere (`src/cli/index.ts` bin entry), default
`stdin` to `process.stdin` there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; node .\dist\scripts\run-tests.js repo-search-cli-interactive`
Expected: FAIL — unknown `--interactive` token (validateRepoSearchTokens throws)

- [ ] **Step 3: Implement CLI wiring**

1. `args.ts`:
   - `CliParsedArguments` gains `interactive?: boolean;`
   - `parseArguments` handles the token: `case '--interactive': parsed.interactive = true; break;` (match the file's existing switch/if style).
   - `validateRepoSearchTokens` (line 125): add a boolean-flag set —
     `const booleanFlags = new Set(['--interactive']);` — and accept its members
     without consuming a value.
2. `help.ts` + the usage string in `run-repo-search.ts:14`: append
   `[--interactive]` to the repo-search usage line.
3. `CliRunOptions` (args.ts) gains `stdin?: NodeJS.ReadableStream & { isTTY?: boolean };`
   `dispatch.ts` forwards it to `runRepoSearchCli`; the bin entry
   (`src/cli/index.ts` or wherever `runCli` is invoked with `process.argv`)
   passes `stdin: process.stdin`.
4. `run-repo-search.ts`:

```ts
  const stdin = options.stdin;
  if (parsed.interactive && stdin?.isTTY !== true) {
    throw new Error('--interactive requires a TTY (stdin is not interactive).');
  }
  const approvalPrompter = parsed.interactive && stdin
    ? new CliApprovalPrompter({ input: stdin, output: options.stderr })
    : undefined;
  const response = await new StatusServerApiClient().requestRepoSearch({
    prompt,
    repoRoot: process.cwd(),
    model: parsed.model,
    logFile: parsed.logFile,
    interactive: parsed.interactive === true,
  }, new CliProgressRenderer(options.stderr, 'repo-search'), approvalPrompter);
```

5. `status-server-api-client.ts`:
   - `requestRepoSearch(request, renderer, approvalPrompter?: CliApprovalPrompter)`
     forwards the prompter to `requestStreamedOperation`.
   - `requestStreamedOperation` gains an optional last parameter
     `approvalPrompter?: CliApprovalPrompter`; inside the progress branch:

```ts
        if (frame.event === OPERATION_STREAM_EVENTS.progress) {
          const progressEvent = parseJsonObjectText(frame.data);
          const kind = String(progressEvent.kind || '');
          if (kind === 'approval_request') {
            if (!approvalPrompter) {
              throw new Error('Received approval_request on a non-interactive run.');
            }
            const decision = await approvalPrompter.promptDecision(progressEvent);
            await this.submitRepoSearchApproval(progressEvent, decision);
            continue;
          }
          renderer.render(progressEvent);
          continue;
        }
```

   - New method (409 = already resolved elsewhere → continue silently):

```ts
  private async submitRepoSearchApproval(event: JsonObject, decision: ApprovalDecision): Promise<void> {
    const reader = new JsonRecordReader(event);
    const body: RepoSearchApprovalRequest = {
      requestId: reader.optionalString('requestId') || '',
      approvalId: reader.optionalString('approvalId') || '',
      decision: decision.kind,
      ...(decision.kind === 'deny' && decision.reason ? { reason: decision.reason } : {}),
    };
    try {
      await this.client.requestJson({
        url: this.getServiceUrl('/repo-search/approval'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(body),
      }, RepoSearchApprovalResultSchema);
    } catch (error) {
      if (/^HTTP 409:/u.test(toError(error).message)) {
        return;
      }
      throw this.normalizeError(toError(error));
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npm run build:test; node .\dist\scripts\run-tests.js repo-search-cli-interactive; node .\dist\scripts\run-tests.js repo-search-cli; node .\dist\scripts\run-tests.js cli-help`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli tests/repo-search-cli-interactive.test.ts
git commit -m "feat: wire --interactive through CLI with approval prompting"
```

---

### Task 7: Full gate

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS. Likely stragglers: tests asserting the exact repo-search usage/help text, and any test enumerating planner tool names.

- [ ] **Step 2: Typecheck + lint everything**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke (optional but recommended)**

With the status server running (`npm run start:status:stable`), in a real terminal:

```
siftkit repo-search --prompt "list the files in src/cli and tell me what each does" --interactive
```

Expected: each tool call prompts; `a` continues; `b` ends the run with `Aborted by user.`

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: interactive approval mode cleanup"
```
