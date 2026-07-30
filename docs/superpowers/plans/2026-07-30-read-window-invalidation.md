# Read-Window Rejection + Mutation Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fully-covered `read` a rejected repeat in both `ExpandReads` modes, and make `edit`/`write`/`run`/`git` clear the read-window bookkeeping so an agent can re-read what it just changed.

**Architecture:** `planRead` gets one unified window calculation — both modes skip already-returned lines, and `ExpandReads` only decides whether the window may run past the requested `limit` to EOF. A read with nothing left to return is surfaced as `readFile.hasUnread: false` and routed by `ToolActionProcessor` into the existing `DuplicateTracker` rejection path (extracted into a shared `rejectAsDuplicate` helper) rather than returning a soft exit-0 message. `ReadWindowGovernor` gains `invalidatePath` / `invalidateAll`, called from `ToolActionProcessor` after a mutating tool completes.

**Tech Stack:** TypeScript (strict, no casts / `any` / non-null `!` / namespace imports), `node:test` + `node:assert/strict`, zod for IO boundaries.

**Spec:** [docs/superpowers/specs/2026-07-30-read-window-invalidation-design.md](../specs/2026-07-30-read-window-invalidation-design.md)

---

## File Structure

**Modified:**

- `src/repo-search/engine/read-window-governor.ts` — owns read-window bookkeeping. Gains `invalidatePath(pathKey)` and `invalidateAll()`.
- `src/repo-search/engine/duplicate-tracker.ts` — owns duplicate identity. Gains an exported `buildDuplicateFingerprint` so the fingerprint expression has one home.
- `src/repo-search/engine/repo-tools.ts` — owns tool execution. `planRead` window arithmetic; `readFile.hasUnread` and `mutatedPathKey` on `RepoToolExecution`.
- `src/repo-search/engine/tool-action-processor.ts` — owns per-tool-call policy. Extracts `rejectAsDuplicate`; adds `screenExhaustedRead` and `invalidateReadWindows`.
- `src/repo-search/planner-protocol.ts` — the `read` tool description the model actually reads.

**Tests modified:**

- `tests/engine-read-window-governor.test.ts` — invalidation unit tests.
- `tests/repo-tools.test.ts` — window arithmetic table, `hasUnread`, `mutatedPathKey`.
- `tests/mock-repo-search-loop.test.ts` — E2E through the real loop. Three existing tests change behaviour and are rewritten in place.

No new files. Every change lands in the module that already owns that responsibility.

---

## Task 1: Read-window invalidation API

**Files:**
- Modify: `src/repo-search/engine/read-window-governor.ts:17-52`
- Test: `tests/engine-read-window-governor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine-read-window-governor.test.ts`:

```typescript
test('invalidatePath clears returned ranges for one file and leaves other files alone', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 51);
  recordRead(governor, 1, 21, { pathKey: 'src/b.ts' });
  governor.invalidatePath('src/a.ts');
  assert.deepEqual(governor.stateMap.get('src/a.ts')?.mergedReturnedRanges, []);
  assert.deepEqual(governor.stateMap.get('src/b.ts')?.mergedReturnedRanges, [{ start: 1, end: 21 }]);
});

test('invalidatePath is a no-op for a file that was never read', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 51);
  governor.invalidatePath('src/never-read.ts');
  assert.equal(governor.stateMap.has('src/never-read.ts'), false);
  assert.deepEqual(governor.stateMap.get('src/a.ts')?.mergedReturnedRanges, [{ start: 1, end: 51 }]);
});

test('invalidateAll clears returned ranges for every file', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 51);
  recordRead(governor, 1, 21, { pathKey: 'src/b.ts' });
  governor.invalidateAll();
  assert.deepEqual(governor.stateMap.get('src/a.ts')?.mergedReturnedRanges, []);
  assert.deepEqual(governor.stateMap.get('src/b.ts')?.mergedReturnedRanges, []);
});

test('invalidation keeps cumulative counters and re-read lines count as unique, not overlap', () => {
  const governor = new ReadWindowGovernor();
  recordRead(governor, 1, 51);
  governor.invalidatePath('src/a.ts');
  const metrics = recordRead(governor, 1, 51);
  assert.equal(metrics.overlapLines, 0);
  assert.equal(metrics.newLinesCovered, 50);
  assert.equal(metrics.cumulativeUniqueLines, 100);
  const summary = governor.summary();
  assert.equal(summary.totalLinesRead, 100);
  assert.equal(summary.totalUniqueLinesRead, 100);
  assert.equal(summary.overlapRatePct, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js engine-read-window-governor
```

Expected: FAIL — `governor.invalidatePath is not a function`. The build step may also fail first with `Property 'invalidatePath' does not exist on type 'ReadWindowGovernor'`, which is the same signal.

- [ ] **Step 3: Add the two methods**

In `src/repo-search/engine/read-window-governor.ts`, insert after `recordNativeRead` (before `summary`):

```typescript
  /**
   * Drops the returned-range bookkeeping for one file after a mutation. Cumulative counters are
   * kept: lines re-read after a mutation are different content, so they count as unique, not
   * overlap. This clears only the re-read block — the transcript keeps the earlier read result.
   */
  invalidatePath(pathKey: string): void {
    const fileReadState = this.fileReadStateByPath.get(pathKey);
    if (!fileReadState) {
      return;
    }
    fileReadState.mergedReturnedRanges = [];
  }

  /** Same as invalidatePath, for tools that mutate without reporting which paths they touched. */
  invalidateAll(): void {
    for (const fileReadState of this.fileReadStateByPath.values()) {
      fileReadState.mergedReturnedRanges = [];
    }
  }
```

Then update the class doc comment so it stops claiming overlap can only come from a bypass. Replace lines 17-23:

```typescript
/**
 * Tracks which line ranges of which files have already been returned to the model, so `read` can
 * skip them (see planRead) and so the run can report a read-overlap rate.
 *
 * Overlap is expected to be near zero: planRead advances past already-returned ranges before the
 * read executes. A non-zero rate means ranges were returned by some path that bypassed that
 * check. Ranges returned before an invalidatePath/invalidateAll do not count toward overlap —
 * after a mutation the same line numbers hold different content.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js engine-read-window-governor
```

Expected: PASS — all tests in the file, including the 7 pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/read-window-governor.ts tests/engine-read-window-governor.test.ts
git commit -m "feat(repo-search): add read-window invalidation to ReadWindowGovernor"
```

---

## Task 2: Report the mutated path from `write` and `edit`

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:25-50` (type), `:586-606` (`executeWrite`), `:639-674` (`executeEdit`)
- Test: `tests/repo-tools.test.ts`

`resolveRepoScopedPath` returns `relativePath` already normalized through `toPosixPath`, and `planRead` builds its `pathKey` as `displayPath.toLowerCase()`. Use exactly that expression so both sides agree on the map key.

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`:

```typescript
test('write reports the mutated path key so read windows can be invalidated', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('write', { path: 'src/New.ts', content: 'alpha\n' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.mutatedPathKey, 'src/new.ts');
});

test('edit reports the mutated path key so read windows can be invalidated', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'edit',
    { path: 'src/a.ts', edits: [{ oldText: 'line3', newText: 'line3-edited' }] },
    makeContext(root),
  );
  assert.ok(result.ok);
  assert.equal(result.mutatedPathKey, 'src/a.ts');
});

test('a failed edit reports no mutated path key because nothing was written', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'edit',
    { path: 'src/a.ts', edits: [{ oldText: 'not-in-the-file', newText: 'x' }] },
    makeContext(root),
  );
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js repo-tools
```

Expected: FAIL — build error `Property 'mutatedPathKey' does not exist on type`.

- [ ] **Step 3: Add the field and populate it**

In `src/repo-search/engine/repo-tools.ts`, add to the `ok: true` variant of `RepoToolExecution`, immediately after `readFile?: {...},` (i.e. before `outputUnit?:`):

```typescript
    /** Set by mutating tools so the caller can drop stale read windows for that file. */
    mutatedPathKey?: string;
```

In `executeWrite`, replace the return statement:

```typescript
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${resolvedPath.relativePath}.`,
    toolType: 'write', outputUnit: 'lines',
    mutatedPathKey: resolvedPath.relativePath.toLowerCase(),
  };
```

In `executeEdit`, replace the return statement:

```typescript
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Applied ${resolved.length} edit(s) to ${resolvedPath.relativePath}.`,
    toolType: 'edit', outputUnit: 'lines',
    mutatedPathKey: resolvedPath.relativePath.toLowerCase(),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js repo-tools
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "feat(repo-search): report mutatedPathKey from write and edit"
```

---

## Task 3: Unified read-window arithmetic

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:33-40` (`readFile` type), `:374-395` (`planRead`), `:402-409` (`buildReadExecution`)
- Test: `tests/repo-tools.test.ts:153-165` (rewritten), plus new tests

The rule, for requested `[S, E)` and merged returned ranges `R`:

```
start' = advance S past any range in R covering it        (both modes)
end'   = min(next range start, ExpandReads ? EOF : E)     (mode-dependent)
hasUnread = start' < (ExpandReads ? EOF : E)
```

The existing `expandReads && hasReturnedRanges` guard on `totalEnd` stays, so a *first* read still honours its `limit` in both modes.

- [ ] **Step 1: Write the failing tests**

In `tests/repo-tools.test.ts`, **replace** the test named `planRead with expandReads=false runs the requested window unchanged despite prior ranges` (lines 153-165) with the following block. `makeRepo()` writes `src/a.ts` as `'line1\nalpha\nline3\nalpha\nline5\n'`, so `lines.length` is 6 and `totalEndLineExclusive` is 7.

```typescript
function stateWithReturnedRange(pathKey: string, start: number, end: number): Map<string, FileReadState> {
  return new Map<string, FileReadState>([
    [pathKey, { mergedReturnedRanges: [{ start, end }], totalLinesRead: end - start, uniqueLinesRead: end - start, overlapLines: 0 }],
  ]);
}

test('planRead with expandReads=false skips returned lines but stops at the requested end', () => {
  const root = makeRepo();
  const stateByPath = stateWithReturnedRange('src/a.ts', 1, 3);
  const plan = planRead({ path: 'src/a.ts', offset: 1, limit: 4 }, root, buildIgnorePolicy(root), stateByPath, false);
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.hasUnread, true);
  assert.equal(plan.effectiveStartLine, 3);
  assert.equal(plan.effectiveEndLineExclusive, 5);
});

test('planRead with expandReads=true skips returned lines and runs to end of file', () => {
  const root = makeRepo();
  const stateByPath = stateWithReturnedRange('src/a.ts', 1, 3);
  const plan = planRead({ path: 'src/a.ts', offset: 1, limit: 4 }, root, buildIgnorePolicy(root), stateByPath, true);
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.hasUnread, true);
  assert.equal(plan.effectiveStartLine, 3);
  assert.equal(plan.effectiveEndLineExclusive, 7);
});

test('planRead honours limit on a first read in both modes', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const expanded = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, new Map<string, FileReadState>(), true);
  assert.ok(!isFailedReadPlan(expanded));
  assert.equal(expanded.effectiveEndLineExclusive, 3);
  const clamped = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, new Map<string, FileReadState>(), false);
  assert.ok(!isFailedReadPlan(clamped));
  assert.equal(clamped.effectiveEndLineExclusive, 3);
});

test('planRead reports a fully covered window as exhausted in both modes', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const clamped = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, stateWithReturnedRange('src/a.ts', 1, 3), false);
  assert.ok(!isFailedReadPlan(clamped));
  assert.equal(clamped.hasUnread, false);
  assert.match(String(clamped.noUnreadOutput), /Lines 1-2 of src\/a\.ts were already returned in this run/u);
  const expanded = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, stateWithReturnedRange('src/a.ts', 1, 7), true);
  assert.ok(!isFailedReadPlan(expanded));
  assert.equal(expanded.hasUnread, false);
  assert.match(String(expanded.noUnreadOutput), /Lines 1-2 of src\/a\.ts were already returned in this run/u);
});

test('buildReadExecution reports hasUnread on both branches', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const fresh = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, new Map<string, FileReadState>(), false);
  assert.ok(!isFailedReadPlan(fresh));
  const freshExecution = buildReadExecution('read', fresh);
  assert.ok(freshExecution.ok);
  assert.equal(freshExecution.readFile?.hasUnread, true);
  const covered = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, stateWithReturnedRange('src/a.ts', 1, 3), false);
  assert.ok(!isFailedReadPlan(covered));
  const coveredExecution = buildReadExecution('read', covered);
  assert.ok(coveredExecution.ok);
  assert.equal(coveredExecution.readFile?.hasUnread, false);
  assert.match(coveredExecution.output, /already returned in this run/u);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js repo-tools
```

Expected: FAIL — build error `Property 'hasUnread' does not exist` on the `readFile` type, and the expandReads=false skip assertions fail because `planRead` still passes `returnedRanges: []` in that mode.

- [ ] **Step 3: Implement the unified arithmetic**

In `src/repo-search/engine/repo-tools.ts`, add `hasUnread` to the `readFile` shape on the `ok: true` variant of `RepoToolExecution`:

```typescript
    readFile?: {
      commandPath: string;
      pathKey: string;
      displayPath: string;
      startLine: number;
      endLineExclusive: number;
      totalEndLineExclusive: number;
      hasUnread: boolean;
    };
```

Replace `planRead` lines 374-380 with:

```typescript
  const state = fileReadStateByPath ? getOrCreateFileReadState(fileReadStateByPath, pathKey) : null;
  // Both modes skip lines already returned. expandReads decides only whether the window may run
  // past the requested limit to end of file.
  const returnedRanges = state?.mergedReturnedRanges ?? [];
  const hasReturnedRanges = returnedRanges.length > 0;
  const unreadRange = findContiguousUnreadRange({
    requestedStart: clampedStart,
    totalEnd: expandReads && hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive,
    returnedRanges,
  });
```

Replace the `noUnreadOutput` line in the returned object with:

```typescript
    noUnreadOutput: unreadRange.hasUnread
      ? null
      : `Lines ${clampedStart}-${requestedEndExclusive - 1} of ${displayPath} were already returned in this run. Read a different range, or edit/write the file to re-read it.`,
```

In `buildReadExecution`, add `hasUnread` to the `readFile` literal:

```typescript
  const readFile = {
    commandPath: plan.commandPath,
    pathKey: plan.pathKey,
    displayPath: plan.displayPath,
    startLine: plan.effectiveStartLine,
    endLineExclusive: plan.hasUnread ? plan.effectiveEndLineExclusive : plan.effectiveStartLine,
    totalEndLineExclusive: plan.totalEndLineExclusive,
    hasUnread: plan.hasUnread,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js repo-tools
```

Expected: PASS, including the pre-existing `read skips already-returned ranges instead of re-reading them` test.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "feat(repo-search): skip returned lines in both ExpandReads modes"
```

---

## Task 4: Reject an exhausted read as a repeat

**Files:**
- Modify: `src/repo-search/engine/duplicate-tracker.ts:21-42`
- Modify: `src/repo-search/engine/tool-action-processor.ts:261-277` (wiring), `:386-466` (extraction)
- Test: `tests/mock-repo-search-loop.test.ts:605-641` (rewritten), plus a new test

- [ ] **Step 1: Write the failing tests**

In `tests/mock-repo-search-loop.test.ts`, **replace** the test named `runTaskLoop reports when read has no unread lines left` (lines 605-641) with:

```typescript
test('runTaskLoop rejects a read whose whole range was already returned', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-native-read-exhausted',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  // The first read executes and logs a result; the rejected second read never does.
  assert.equal(commandEvents.length, 1);
  assert.equal(result.commandFailures, 1);
  const rejected = result.commands.filter((command) => command.safe === false);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'exhausted read');
  assert.match(String(rejected[0].output), /Lines 1-3 of target\.ts were already returned in this run/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop forces finish after repeated exhausted reads', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const readAction = '{"action":"read","path":"target.ts","offset":1,"limit":3}';
  await runTaskLoop(
    {
      id: 'task-native-read-exhausted-stagnation',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 8,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        readAction,
        readAction,
        readAction,
        readAction,
        readAction,
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const forcedFinish = events.find((event) => event.kind === 'turn_forced_finish_mode_started');
  assert.equal(String(forcedFinish?.trigger), 'exhausted_read');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js mock-repo-search-loop
```

Expected: FAIL — `commandEvents.length` is 2, not 1, because the exhausted read still returns exit-0 content; `result.commandFailures` is 0; no `turn_forced_finish_mode_started` event.

- [ ] **Step 3: Give the fingerprint expression one home**

In `src/repo-search/engine/duplicate-tracker.ts`, add above the class:

```typescript
export function buildDuplicateFingerprint(toolName: string, normalizedKey: string, fingerprint: string): string {
  return fingerprint || `${toolName}|${normalizedKey}`;
}
```

and use it inside `classify`, replacing the `duplicateFingerprint` line of the returned object:

```typescript
      duplicateFingerprint: buildDuplicateFingerprint(options.toolName, options.normalizedKey, options.fingerprint),
```

- [ ] **Step 4: Extract the rejection block**

In `src/repo-search/engine/tool-action-processor.ts`, update the duplicate-tracker import:

```typescript
import { buildDuplicateFingerprint, DuplicateTracker } from './duplicate-tracker.js';
```

Add this private method immediately after `screenWebAndDuplicates`:

```typescript
  /**
   * Records a repeat rejection: a safe:false command entry, a transcript message that collapses
   * onto the previous replay when one is active, and the stagnation pressure that eventually
   * forces a finish. Shared by string-level duplicates and reads with nothing left to return.
   */
  private rejectAsDuplicate(
    turn: number,
    context: AcceptedToolContext,
    state: TurnBatchState,
    options: {
      duplicateFingerprint: string;
      reason: string;
      trigger: string;
      prospectiveToolType: string;
      isSemantic: boolean;
      bodyText: string | null;
    },
  ): void {
    const { toolAction, normalizedToolName, isNativeTool, command, fingerprint } = context;
    const { commands, counters, duplicates, forcedFinish, toolStats, transcript } = this.deps;
    const registration = duplicates.registerDuplicate(options.duplicateFingerprint, transcript.length);
    const repeatSummary = buildRepeatedToolCallSummary(normalizedToolName, registration.count);
    const duplicateMessage = options.bodyText ? `${options.bodyText}\n${repeatSummary}` : repeatSummary;
    counters.commandFailures += 1;
    commands.push({
      command, turn, safe: false, reason: options.reason, exitCode: null,
      output: `Rejected: ${duplicateMessage}`,
    });
    if (registration.activeReplayMessageIndex !== null) {
      transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage);
    } else {
      state.batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `duplicate_call_${commands.length}`,
        toolContent: duplicateMessage,
      });
      state.batchDuplicateAnchorIndex = state.batchOutcomes.length - 1;
    }
    if (options.isSemantic) {
      toolStats.recordSemanticRepeatReject(options.prospectiveToolType);
      this.deps.logger?.write({
        kind: 'turn_semantic_repeat_rejected',
        taskId: this.deps.task.id,
        turn,
        command,
        fingerprint,
        repeats: registration.count,
      });
    }
    if (duplicates.shouldForceFinish() && !forcedFinish.isActive()) {
      state.pendingModeChangeUserMessages.push(forcedFinish.activateFromStagnation());
      toolStats.recordForcedFinishFromStagnation(options.prospectiveToolType);
      this.deps.logger?.write({
        kind: 'turn_forced_finish_mode_started',
        taskId: this.deps.task.id,
        turn,
        attemptsRemaining: FORCED_FINISH_MAX_ATTEMPTS,
        trigger: options.trigger,
      });
    }
  }
```

Now replace the body of the `if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) { ... }` block in `screenWebAndDuplicates` (lines 419-464) with a call to it:

```typescript
    if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) {
      this.rejectAsDuplicate(turn, context, state, {
        duplicateFingerprint,
        reason: isExactDuplicate ? 'duplicate command' : 'semantic duplicate command',
        trigger: isSemanticDuplicate ? 'semantic_repetition' : 'consecutive_duplicates',
        prospectiveToolType,
        isSemantic: isSemanticDuplicate,
        bodyText: null,
      });
      return 'next';
    }
    return null;
```

The local `const { commands, counters, duplicates, forcedFinish, toolStats, transcript } = this.deps;` at the top of `screenWebAndDuplicates` now only needs `counters` and `duplicates`; narrow it to `const { counters, duplicates } = this.deps;` so the build does not warn on unused bindings.

- [ ] **Step 5: Add the exhausted-read screen and wire it in**

Add this private method immediately after `screenRejection`:

```typescript
  /**
   * A read whose whole requested window was already returned has nothing to add. Route it through
   * the same repeat machinery as a duplicate command so it costs a rejection, not a full result.
   */
  private screenExhaustedRead(
    turn: number,
    context: AcceptedToolContext,
    prospectiveToolType: string,
    state: TurnBatchState,
  ): ToolActionOutcome | null {
    const { nativeExecution, normalizedToolName, normalizedKey, fingerprint } = context;
    if (!nativeExecution || !nativeExecution.ok || !nativeExecution.readFile || nativeExecution.readFile.hasUnread) {
      return null;
    }
    this.rejectAsDuplicate(turn, context, state, {
      duplicateFingerprint: buildDuplicateFingerprint(normalizedToolName, normalizedKey, fingerprint),
      reason: 'exhausted read',
      trigger: 'exhausted_read',
      prospectiveToolType,
      isSemantic: false,
      bodyText: nativeExecution.output,
    });
    return 'next';
  }
```

In `processToolAction`, replace the block from `const rejection = this.screenRejection(...)` through its `if` with:

```typescript
    const rejection = this.screenRejection(turn, context, state);
    if (rejection !== null) {
      return rejection;
    }
    const exhausted = this.screenExhaustedRead(turn, context, prospectiveToolType, state);
    if (exhausted !== null) {
      return exhausted;
    }
```

`prospectiveToolType` is already in scope — it is computed above the `screenWebAndDuplicates` call.

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js mock-repo-search-loop
```

Expected: PASS. The pre-existing `runTaskLoop advances overlapping read calls to the next unread span` test still passes — its second read advances to line 6 rather than being exhausted.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/duplicate-tracker.ts src/repo-search/engine/tool-action-processor.ts tests/mock-repo-search-loop.test.ts
git commit -m "feat(repo-search): reject reads with no unread lines as repeats"
```

---

## Task 5: Invalidate read windows on mutating tools

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts:699-796` (`recordToolOutcome`)
- Test: `tests/mock-repo-search-loop.test.ts`

`write`, `edit` and `run` carry a typed path or none at all; `git` is the only command-string tool. `run` and `git` cannot report which files they touched and both can rewrite the tree, so any completion clears everything — including a non-zero exit, because a partially-applied command still mutates.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mock-repo-search-loop.test.ts`:

```typescript
test('runTaskLoop lets a read repeat after an edit invalidates the file window', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-read-after-edit',
      question: 'Read and edit target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'edit']),
      mockResponses: [
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"edit","path":"target.ts","edits":[{"oldText":"line-2","newText":"line-2-EDITED"}]}',
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  // read, edit, read — the third call executed instead of being rejected.
  assert.equal(commandEvents.length, 3);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^1: line-1/mu);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^2: line-2-EDITED/mu);
});

test('runTaskLoop lets a read repeat after a git command invalidates every window', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-read-after-git',
      question: 'Read target file around a git call.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'git']),
      mockResponses: [
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"git","command":"git status --short"}',
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: ' M target.ts', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(commandEvents.length, 3);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^1: line-1/mu);
});
```

```typescript
test('runTaskLoop lets a read repeat after run invalidates every window with ExpandReads off', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  // `run` is native, so the mock key is the synthetic command string, not a shell line.
  const runCommandKey = buildRepoToolRequestedCommand('run', { command: 'npm run lint' });
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-read-after-run',
      question: 'Read target file around a run call.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      config: mockLoopConfig({ ...modelPresetReasoning('off'), ExpandReads: false }),
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'run']),
      mockResponses: [
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"run","command":"npm run lint"}',
        '{"action":"read","path":"target.ts","offset":1,"limit":3}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        [runCommandKey]: { exitCode: 0, stdout: 'lint clean', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(commandEvents.length, 3);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^1: line-1/mu);
});
```

That test needs one added import at the top of `tests/mock-repo-search-loop.test.ts`:

```typescript
import { buildRepoToolRequestedCommand } from '../src/repo-search/engine/repo-tools.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js mock-repo-search-loop
```

Expected: FAIL — in all three tests the final call is rejected as an exhausted read, so `commandEvents.length` is 2 and `result.commandFailures` is 1.

- [ ] **Step 3: Add the invalidation hook**

In `src/repo-search/engine/tool-action-processor.ts`, add this private method immediately after `recordToolOutcome`:

```typescript
  /**
   * A mutation makes prior read windows stale — the same line numbers now hold different content.
   * Clearing them restores the model's ability to re-read what changed. This touches bookkeeping
   * only; the transcript keeps every earlier read result.
   *
   * `run` and `git` do not report which paths they touched and both can rewrite the tree, so any
   * completion clears everything — a non-zero exit can still have mutated.
   */
  private invalidateReadWindows(context: ExecutedToolContext, commandSucceeded: boolean): void {
    const { normalizedToolName, nativeExecution } = context;
    if (normalizedToolName === 'run' || normalizedToolName === 'git') {
      this.deps.readWindows.invalidateAll();
      return;
    }
    if (commandSucceeded && nativeExecution && nativeExecution.ok && nativeExecution.mutatedPathKey) {
      this.deps.readWindows.invalidatePath(nativeExecution.mutatedPathKey);
    }
  }
```

In `recordToolOutcome`, call it right after `commandSucceeded` is computed:

```typescript
    const commandSucceeded = Number(executed.exitCode) === 0;
    this.invalidateReadWindows(context, commandSucceeded);
    if (commandSucceeded) {
      duplicates.recordSuccess(normalizedKey, fingerprint || null);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js mock-repo-search-loop
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/tool-action-processor.ts tests/mock-repo-search-loop.test.ts
git commit -m "feat(repo-search): invalidate read windows after write, edit, run and git"
```

---

## Task 6: Update the remaining behaviour-dependent test and the tool description

**Files:**
- Modify: `tests/mock-repo-search-loop.test.ts:1674-1708`
- Modify: `src/repo-search/planner-protocol.ts:86`

The test named `runTaskLoop re-reads overlapping windows when ExpandReads is disabled` asserts the old semantics: `read(100..119)` then `read(110..129)` produced 10 overlapping lines. Under the new rule the second read advances to 120 and stops at the requested end 129, so overlap is 0 and 10 new lines are returned.

- [ ] **Step 1: Rewrite the test to the new semantics**

Replace the test at lines 1674-1708 with:

```typescript
test('runTaskLoop with ExpandReads disabled skips returned lines but stops at the requested end', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, 'a.ts'),
    Array.from({ length: 200 }, (_, index) => `a.ts-line-${index + 1}`).join('\n'),
    'utf8',
  );
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-expand-reads-disabled',
      question: 'Read a file twice.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      config: mockLoopConfig({ ...modelPresetReasoning('off'), ExpandReads: false }),
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        '{"action":"read","path":"a.ts","offset":100,"limit":20}',
        '{"action":"read","path":"a.ts","offset":110,"limit":20}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(Number(result.readOverlapSummary?.totalOverlapLines), 0);
  // Second read starts after the returned range and stops at the requested end, not at EOF.
  assert.match(String(commandEvents[1]?.executedCommand || ''), /offset=120 limit=10/u);
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /^120: a\.ts-line-120/mu);
  assert.doesNotMatch(String(commandEvents[1]?.insertedResultText || ''), /^130: a\.ts-line-130/mu);
});
```

- [ ] **Step 2: Update the `read` tool description the model sees**

In `src/repo-search/planner-protocol.ts`, replace the `read` description string (line 86):

```typescript
      description: 'Read the contents of a repository file. Lines are returned numbered. Use offset/limit for large files; when you need the full file, continue with offset until complete. Lines already returned in this task are skipped automatically, and a read whose whole range was already returned is rejected. Editing or writing a file clears that history, so you can read it again to see your change.',
```

- [ ] **Step 3: Run the affected suites**

```powershell
npm run build:test
node .\dist\scripts\run-tests.js mock-repo-search-loop
node .\dist\scripts\run-tests.js repo-search-planner-protocol
```

Expected: PASS both.

- [ ] **Step 4: Run the full suite, typecheck and lint**

```powershell
npm test
npm run typecheck
```

Expected: PASS. `npm run typecheck` includes `npm run lint`. If any other suite asserts the old `No unread lines remain for` string or the old overlap behaviour, fix it to the new semantics — do not reintroduce the old path.

- [ ] **Step 5: Commit**

```bash
git add tests/mock-repo-search-loop.test.ts src/repo-search/planner-protocol.ts
git commit -m "test(repo-search): align ExpandReads-disabled expectations with skip-and-clamp semantics"
```

---

## Verification Checklist

Run after Task 6 and confirm each item against real output, not expectation:

- [ ] `npm test` passes with no skipped suites.
- [ ] `npm run typecheck` passes, including lint.
- [ ] `git grep -n "No unread lines remain"` returns only `src/summary/planner/mode.ts` (a separate planner with its own read logic, out of scope) and the design doc.
- [ ] `git grep -n "canAdvanceRepeatedRead"` still shows the bypass intact — it is deliberate, not dead code. Range coverage, not the command string, is what rejects a read.
