# F17: Split SummaryPlannerLoopRuntime.requestProviderAction + Fix & Extend the God-Function Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tests/god-function-regression.test.ts` measure real function bodies (it currently can be bypassed by inline object parameters), register `SummaryPlannerLoopRuntime.requestProviderAction` in the guard, and split that 116-line method below the 90-line limit by extracting its two status-notify blocks.

**Architecture:** Two coupled changes. (1) The guard's body locator uses `searchText.indexOf('{', startMatch.index)` at [tests/god-function-regression.test.ts:66](../../../tests/god-function-regression.test.ts#L66), which locks onto the **first `{` after the method name** — for a signature with an inline object parameter (`fn(x?: { … })`) that is the parameter object, not the body, so the method's real size is never measured. Replace the three brace-matching heuristics with a TypeScript-AST body locator that resolves a function/method by name and measures its `body` node. (2) `requestProviderAction` ([src/summary/planner/mode.ts:477-595](../../../src/summary/planner/mode.ts#L477-L595)) does three things — notify-running, call-the-LLM, notify-failed — and has its own inline object parameter. Extract the two notify blocks into private helpers, dropping the body to 73 lines.

**Tech Stack:** TypeScript (strict, zero-cast per repo rules; `typescript@^5.9.2` is already a direct dependency), `node:test` via `tsx --test`. Behavior-preserving refactor; no production runtime dependencies added.

---

## Verified Facts (measured during planning)

- The AST body locator counts the **body block** (`{` line through `}` line, inclusive), matching the old heuristic's semantics for every currently-guarded method (none of which has an inline object parameter — verified by scan), so existing limits do not shift.
- `requestProviderAction` real body = **116 lines** (> 90 → red once added to the guard).
- Extracting *only* the running-notify block lands at ~89 lines — already under 90. The guard is therefore a **single red→green cycle** across the whole refactor, not a per-helper ratchet. Both helpers are extracted together in one task; the second extraction is justified by margin (73 vs a fragile 89), and correctness is verified by the planner behavioral suite.
- Fully-split `requestProviderAction` body = **73 lines** (≤ 90 → green). Measured with the exact post-refactor source.
- AST counter validated under `tsx`: inline-param fixture body measures 5 (the heuristic measured 4); arrow-function-with-inline-param body measures 4. Named imports from `'typescript'` resolve under the test runtime.

## File Structure

- Modify: [tests/god-function-regression.test.ts](../../../tests/god-function-regression.test.ts) — replace heuristic locator with AST locator; add a regression test for the inline-param bypass; add the `requestProviderAction` limit entry.
- Modify: [src/summary/planner/mode.ts](../../../src/summary/planner/mode.ts) — extract `notifyPlannerRunning` and `notifyPlannerRequestFailed`; `requestProviderAction` signature is unchanged (its inline object param is now correctly measured).
- Modify: [ARCHITECTURE-REVIEW.md](../../../ARCHITECTURE-REVIEW.md) — remove the resolved F17 finding.

No new files. The helpers live in `SummaryPlannerLoopRuntime` (their only caller; they read `this.options`/`this.prompt`).

## Verification Commands (used throughout)

- Guard test only: `npx tsx --test tests/god-function-regression.test.ts`
- Planner behavioral safety net: `npx tsx --test --test-timeout=60000 tests/runtime-planner-mode.test.ts tests/runtime-planner-mode.integration.test.ts tests/runtime-planner-mode.fallbacks.test.ts tests/summary-planner-runtime.test.ts tests/planner-streaming-timings.test.ts`
- Type safety: `npm run typecheck:test`

---

### Task 1: Replace the guard's brace-matching locator with an AST locator (fixes the bypass)

This is the blocker fix. The current locator can undercount any function whose signature contains a `{` before the body (inline object params, object return types). Replace `findClassBody`, `findFunctionBodyStart`, and the heuristic `countFunctionLines` with an AST-based locator, and add a regression test proving the bypass is closed. Per repo policy this is a complete replacement — the old heuristics are deleted, not left as a fallback.

**Files:**
- Modify: [tests/god-function-regression.test.ts](../../../tests/god-function-regression.test.ts) (full rewrite of the locator section + new test)

- [ ] **Step 1: Write the failing regression test (red)**

First add **only** the new test to the existing file (above the existing `test(...)` block) so it fails against the current heuristic locator:

```ts
test('line counter measures the body, not an inline object parameter', () => {
  const fixture = [
    'class Fixture {',
    '  method(override?: {',
    '    a: string;',
    '    b: number;',
    '  }): void {',
    '    const x = 1;',
    '    const y = 2;',
    '    return;',
    '  }',
    '}',
  ].join('\n');
  // Body spans the `{` on the `}): void {` line through its closing `}` = 5 lines.
  // The brace-matching heuristic locked onto the parameter object `{` and reported 4,
  // letting arbitrarily long bodies bypass the guard.
  assert.equal(countFunctionLines(fixture, 'Fixture.method'), 5);
});
```

- [ ] **Step 2: Run it to confirm the bypass exists (red)**

Run: `npx tsx --test tests/god-function-regression.test.ts`
Expected: FAIL — the heuristic returns 4 (the parameter object), asserted against 5.

- [ ] **Step 3: Replace the locator with the AST implementation**

Replace the entire imports-plus-helpers region — lines [tests/god-function-regression.test.ts:1-85](../../../tests/god-function-regression.test.ts#L1-L85), i.e. everything from the `import` block through the end of the old `countFunctionLines` (just before the first `test(...)`) — with:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isClassDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isVariableStatement,
  ScriptTarget,
  type Node,
  type SourceFile,
} from 'typescript';

type FunctionLimit = {
  filePath: string;
  symbol: string;
  maxLines: number;
};

const limits: FunctionLimit[] = [
  { filePath: 'src/summary/planner/mode.ts', symbol: 'invokePlannerMode', maxLines: 180 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.executeTools', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.handleForcedFinishAttempt', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.handleToolCallLimit', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.handleDuplicateToolAction', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.executeSingleToolAction', maxLines: 90 },
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.executeToolBatch', maxLines: 90 },
  { filePath: 'src/status-server/routes/chat.ts', symbol: 'handleChatRoute', maxLines: 60 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'handleCoreRoute', maxLines: 60 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'StatusPostEndpoint.handle', maxLines: 90 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'StatusPostRequestHandler.handle', maxLines: 90 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'StatusPostRequestHandler.updateStatusMetrics', maxLines: 90 },
  { filePath: 'src/status-server/routes/dashboard.ts', symbol: 'handleDashboardRoute', maxLines: 70 },
  { filePath: 'src/status-server/routes/llama-passthrough.ts', symbol: 'handleLlamaPassthroughRoute', maxLines: 60 },
  { filePath: 'src/summary/core.ts', symbol: 'summarizeRequest', maxLines: 10 },
  { filePath: 'src/summary/core-runner.ts', symbol: 'invokeSummaryCore', maxLines: 10 },
  { filePath: 'src/summary/core-runner.ts', symbol: 'SummaryCoreRunner.run', maxLines: 35 },
  { filePath: 'src/summary/request-runner.ts', symbol: 'SummaryRequestRunner.run', maxLines: 35 },
];

function findFunctionBody(source: SourceFile, symbol: string): Node | null {
  const [ownerName, methodName] = symbol.split('.');
  let body: Node | null = null;
  const visit = (node: Node): void => {
    if (body) return;
    if (methodName) {
      if (isClassDeclaration(node) && node.name?.text === ownerName) {
        for (const member of node.members) {
          if (isMethodDeclaration(member) && member.name.getText(source) === methodName && member.body) {
            body = member.body;
          }
        }
      }
    } else {
      if (isFunctionDeclaration(node) && node.name?.text === ownerName && node.body) {
        body = node.body;
      }
      if (isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (
            declaration.name.getText(source) === ownerName
            && declaration.initializer
            && (isArrowFunction(declaration.initializer) || isFunctionExpression(declaration.initializer))
          ) {
            body = declaration.initializer.body;
          }
        }
      }
    }
    if (!body) forEachChild(node, visit);
  };
  forEachChild(source, visit);
  return body;
}

function countFunctionLines(sourceText: string, symbol: string): number {
  const source = createSourceFile(symbol, sourceText, ScriptTarget.Latest, true);
  const body = findFunctionBody(source, symbol);
  assert.ok(body, `Expected ${symbol} to exist`);
  const startLine = source.getLineAndCharacterOfPosition(body.getStart(source)).line;
  const endLine = source.getLineAndCharacterOfPosition(body.getEnd()).line;
  return endLine - startLine + 1;
}
```

Leave the existing `test('touched planner and route entrypoints stay below god-function limits', ...)` block (currently [tests/god-function-regression.test.ts:87-96](../../../tests/god-function-regression.test.ts#L87-L96)) unchanged — it already calls `countFunctionLines`. The new regression test from Step 1 stays.

- [ ] **Step 4: Run the full guard to confirm green + no existing entry shifted**

Run: `npx tsx --test tests/god-function-regression.test.ts`
Expected: PASS — the regression test now returns 5, and every existing limit entry still passes (AST counts match the old heuristic for non-inline-param signatures). If any *existing* entry now reports a larger count and fails, that is a previously-hidden undercount; STOP and report it rather than relaxing the limit — it is out of scope for F17.

- [ ] **Step 5: Commit**

```bash
git add tests/god-function-regression.test.ts
git commit -m "test(god-function): measure bodies via TS AST, close inline-param bypass"
```

---

### Task 2: Register requestProviderAction in the guard (red)

The guard now measures real bodies, so adding the entry fails against the 116-line method.

**Files:**
- Modify: [tests/god-function-regression.test.ts](../../../tests/god-function-regression.test.ts) (`limits` array)

- [ ] **Step 1: Add the guard entry**

In the `limits` array, after the `executeToolBatch` entry, add:

```ts
  { filePath: 'src/summary/planner/mode.ts', symbol: 'SummaryPlannerLoopRuntime.requestProviderAction', maxLines: 90 },
```

- [ ] **Step 2: Run the guard to verify it fails**

Run: `npx tsx --test tests/god-function-regression.test.ts`
Expected: FAIL with `SummaryPlannerLoopRuntime.requestProviderAction in src/summary/planner/mode.ts has 116 lines; limit is 90`.

- [ ] **Step 3: Commit the red entry**

```bash
git add tests/god-function-regression.test.ts
git commit -m "test(god-function): guard requestProviderAction at 90 lines (red)"
```

---

### Task 3: Extract the two notify blocks (green)

Extract the running-notify block (current [src/summary/planner/mode.ts:483-512](../../../src/summary/planner/mode.ts#L483-L512)) into `notifyPlannerRunning`, and the failure-notify block (current [src/summary/planner/mode.ts:569-592](../../../src/summary/planner/mode.ts#L569-L592)) into `notifyPlannerRequestFailed`. The `requestProviderAction` signature is unchanged — its inline object parameter is now correctly measured by the AST guard, so no type hoist is needed.

**Files:**
- Modify: [src/summary/planner/mode.ts](../../../src/summary/planner/mode.ts)

- [ ] **Step 1: Add `notifyPlannerRunning` before `requestProviderAction`**

Insert this method into `SummaryPlannerLoopRuntime` immediately before `requestProviderAction` ([src/summary/planner/mode.ts:477](../../../src/summary/planner/mode.ts#L477)):

```ts
  private async notifyPlannerRunning(promptText: string, promptTokenCount: number): Promise<number> {
    traceSummary(
      `notify running=true phase=planner chunk=none raw_chars=${this.options.inputText.length} `
      + `chunk_chars=${this.options.inputText.length} prompt_chars=${promptText.length}`
    );
    const statusRunningStartedAt = Date.now();
    const notifyRunningSpan = this.options.timingRecorder?.start('summary.planner.status.notify_running', {
      promptChars: promptText.length,
    });
    try {
      await notifyStatusBackend({
        running: true,
        taskKind: 'summary',
        statusBackendUrl: this.options.statusBackendUrl,
        requestId: this.options.requestId,
        promptCharacterCount: promptText.length,
        promptTokenCount,
        rawInputCharacterCount: this.options.inputText.length,
        chunkInputCharacterCount: this.options.inputText.length,
        budgetSource: this.options.config.Effective?.BudgetSource ?? null,
        inputCharactersPerContextToken: this.options.config.Effective?.InputCharactersPerContextToken ?? null,
        chunkThresholdCharacters: this.options.config.Effective?.ChunkThresholdCharacters ?? null,
        phase: 'planner',
      });
      notifyRunningSpan?.end({ ok: true });
    } catch {
      notifyRunningSpan?.end({ ok: false });
      traceSummary(`notify running=true failed phase=planner chunk=none request_id=${this.options.requestId}`);
    }
    return Date.now() - statusRunningStartedAt;
  }
```

- [ ] **Step 2: Add `notifyPlannerRequestFailed` after `requestProviderAction`**

Insert this method into `SummaryPlannerLoopRuntime` immediately after `requestProviderAction`'s closing brace ([src/summary/planner/mode.ts:595](../../../src/summary/planner/mode.ts#L595)). The failure path captures whatever usage values were assigned before the throw (all `null` if the LLM call itself threw). The original code calls `Date.now()` twice on this path (trace line + `requestDurationMs`); both are preserved as separate calls.

```ts
  private async notifyPlannerRequestFailed(args: {
    promptText: string;
    startedAt: number;
    inputTokens: number | null;
    outputCharacterCount: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
  }): Promise<void> {
    traceSummary(`notify running=false phase=planner chunk=none duration_ms=${Date.now() - args.startedAt}`);
    const notifyFailedSpan = this.options.timingRecorder?.start('summary.planner.status.notify_terminal', {
      terminalState: 'failed',
    });
    try {
      await notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        requestId: this.options.requestId,
        statusBackendUrl: this.options.statusBackendUrl,
        promptCharacterCount: args.promptText.length,
        inputTokens: args.inputTokens,
        outputCharacterCount: args.outputCharacterCount,
        outputTokens: args.outputTokens,
        thinkingTokens: args.thinkingTokens,
        promptCacheTokens: args.promptCacheTokens,
        promptEvalTokens: args.promptEvalTokens,
        requestDurationMs: Date.now() - args.startedAt,
      });
      notifyFailedSpan?.end({ ok: true });
    } catch {
      notifyFailedSpan?.end({ ok: false });
      traceSummary(`notify running=false failed phase=planner chunk=none request_id=${this.options.requestId}`);
    }
  }
```

- [ ] **Step 3: Rewrite `requestProviderAction` to call the helpers**

Replace the body of `requestProviderAction` ([src/summary/planner/mode.ts:481-595](../../../src/summary/planner/mode.ts#L481-L595) — everything between the signature's opening `{` and its closing `}`) so the full method reads:

```ts
  private async requestProviderAction(override?: {
    promptText: string;
    promptTokenCount: number;
  }): Promise<SummaryPlannerProviderResponse> {
    const promptText = override?.promptText ?? this.prompt;
    const promptTokenCount = override?.promptTokenCount ?? this.promptTokenCount;
    const statusRunningMs = await this.notifyPlannerRunning(promptText, promptTokenCount);
    const startedAt = Date.now();
    let inputTokens: number | null = null;
    let outputCharacterCount: number | null = null;
    let outputTokens: number | null = null;
    let thinkingTokens: number | null = null;
    let promptCacheTokens: number | null = null;
    let promptEvalTokens: number | null = null;
    try {
      const llamaSpan = this.options.timingRecorder?.start('summary.planner.llama.request', {
        promptTokenCount,
        toolDefinitionCount: this.toolDefinitions.length,
      });
      let response: LlamaCppGenerateResult;
      try {
        response = await generateLlamaCppChatResponse({
          config: this.options.config,
          model: this.options.model,
          messages: this.messages,
          timeoutSeconds: this.options.requestTimeoutSeconds ?? 600,
          slotId: this.options.slotId ?? undefined,
          cachePrompt: true,
          tools: this.toolDefinitions,
          structuredOutput: {
            kind: 'siftkit-planner-action-json',
            tools: this.toolDefinitions,
          },
          overrides: this.options.llamaCppOverrides,
        });
      } finally {
        llamaSpan?.end();
      }
      inputTokens = getProcessedPromptTokens(
        response.usage?.promptTokens ?? null,
        response.usage?.promptCacheTokens ?? null,
        response.usage?.promptEvalTokens ?? null,
      );
      outputCharacterCount = response.text.length;
      outputTokens = response.usage?.completionTokens ?? null;
      thinkingTokens = response.usage?.thinkingTokens ?? null;
      promptCacheTokens = response.usage?.promptCacheTokens ?? null;
      promptEvalTokens = response.usage?.promptEvalTokens ?? null;
      const providerDurationMs = Date.now() - startedAt;
      return {
        text: response.text,
        reasoningText: response.reasoningText,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
        requestDurationMs: providerDurationMs,
        providerDurationMs,
        statusRunningMs,
      };
    } catch (error) {
      await this.notifyPlannerRequestFailed({
        promptText,
        startedAt,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
      });
      throw error;
    }
  }
```

- [ ] **Step 4: Confirm the guard is green**

Run: `npx tsx --test tests/god-function-regression.test.ts`
Expected: PASS — `requestProviderAction` now measures 73 lines (≤ 90); the two new helpers are each well under 90.

- [ ] **Step 5: Type-check and run the planner behavioral suite**

Run: `npm run typecheck:test`
Expected: PASS.

Run: `npx tsx --test --test-timeout=60000 tests/runtime-planner-mode.test.ts tests/runtime-planner-mode.integration.test.ts tests/runtime-planner-mode.fallbacks.test.ts tests/summary-planner-runtime.test.ts tests/planner-streaming-timings.test.ts`
Expected: PASS — pure extraction, no behavioral change.

- [ ] **Step 6: Commit**

```bash
git add src/summary/planner/mode.ts
git commit -m "refactor(summary-planner): extract planner notify helpers; requestProviderAction under god-function guard (F17)"
```

---

### Task 4: Mark F17 resolved and run the full gate

**Files:**
- Modify: [ARCHITECTURE-REVIEW.md:24-28](../../../ARCHITECTURE-REVIEW.md#L24-L28) and [ARCHITECTURE-REVIEW.md:102-107](../../../ARCHITECTURE-REVIEW.md#L102-L107)

- [ ] **Step 1: Remove the F17 finding and renumber priorities**

Delete the `### F17. Split the remaining summary planner god method` section ([ARCHITECTURE-REVIEW.md:24-28](../../../ARCHITECTURE-REVIEW.md#L24-L28)) and priority-order line 1 referencing F17 ([ARCHITECTURE-REVIEW.md:104](../../../ARCHITECTURE-REVIEW.md#L104)); renumber the remaining priority list (F11 → 1, F15 → 2, then the L-items line). Per repo policy the resolved finding is deleted, not struck through.

- [ ] **Step 2: Run the full test suite as the final gate**

Run: `npm test`
Expected: PASS (typecheck:test + build:test + full `node ./dist/scripts/run-tests.js` all green).

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE-REVIEW.md
git commit -m "docs(architecture-review): mark F17 resolved"
```

---

## Self-Review

**Spec coverage (F17 = "split `requestProviderAction` below the 90-line guard threshold and add it to the regression guard"):**
- Add to regression guard → Task 2 (entry at 90, driven red against the now-accurate counter).
- Split below 90 → Task 3 (two helper extractions → 73 lines, guard green).
- Guard must actually be capable of measuring it → Task 1 (AST locator + regression test). Without this the guard would measure `requestProviderAction`'s inline param object and pass vacuously — the original blocker.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step is complete and paste-ready. The full `limits` array is reproduced in Task 1 so the engineer never reconstructs it from memory.

**Type consistency:** `findFunctionBody(source: SourceFile, symbol: string): Node | null` and `countFunctionLines(sourceText, symbol): number` are used exactly as defined by the unchanged `test(...)` block and the new regression test. Helper names `notifyPlannerRunning`/`notifyPlannerRequestFailed` match between definition and call site. `notifyPlannerRunning` returns `number` → assigned to `statusRunningMs`. `notifyPlannerRequestFailed`'s `args` shape matches the `let` variables in `requestProviderAction` (`number | null` usage fields + `promptText: string`, `startedAt: number`). Guard symbol string `SummaryPlannerLoopRuntime.requestProviderAction` matches the `ClassName.method` convention the AST locator splits on `.`.

**Honesty of the red/green narrative (reviewer High):** The guard is a single red→green cycle: 116 lines red (Task 2) → 73 green (Task 3). The plan does **not** claim each helper extraction independently toggles the guard — extracting one block alone would already pass at ~89, so both land together in Task 3 for durable margin, verified by the behavioral suite.

**Behavior preservation:** Pure extraction, no control-flow change. The only difference is the failure-path `Date.now()` calls execute inside `notifyPlannerRequestFailed`; both calls are retained, so timing semantics are unchanged.
