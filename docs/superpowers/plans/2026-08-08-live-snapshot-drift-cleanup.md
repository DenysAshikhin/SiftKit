# Live Snapshot Drift Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The primary agent must dispatch each task sequentially through `siftkit repo-agent` exactly once, review its JSON status and diff, and finish a failed or partial task directly without redispatching it.

**Goal:** Complete the live snapshot sync-write refactor by removing test-only interval configurability, obsolete async queue bookkeeping, duplicate filesystem coverage, and stale async test naming.

**Architecture:** `LiveRunSnapshotWriter` keeps one fixed 200 ms event-coalescing delay and one promise queue for deterministic write ordering. Queue state is represented only by the queue promise; snapshot serialization and filesystem writes remain synchronous inside `writeOnce()`. Filesystem helper tests retain only behavior not already covered by `tests/config.test.ts`.

**Tech Stack:** TypeScript 5.9, Node.js 24 filesystem and test APIs, `node:test`, SiftKit repository tooling

## Global Constraints

- Keep implementations succinct, explicit, and straightforward; prefer the smallest complete solution.
- Refactors are complete replacements: do not leave compatibility paths, deprecated options, parallel implementations, or stale async naming.
- Do not introduce `any`, type assertions, non-null assertions, namespace imports, schema-duplicating types, unvalidated IO, or dynamically passed functions outside required external APIs.
- Preserve the user's parallel changes, including `tests/repo-agent-sessions.test.ts` and `.scratch/` if present; never modify, delete, stage, or restore them as part of this plan.
- Do not use worktrees. Do not commit unless the user separately requests it.
- Use SiftKit-first discovery. Give `repo-search`, `summary`, and `repo-agent` commands a 15-minute timeout.
- Use TDD for behavior protection. For deletion-only refactors with no new behavior, establish a green characterization baseline and mutation-check the existing regression tests; do not add source-shape or change-detector tests merely to manufacture a failure.
- Route broad test, typecheck, lint, and diff output through `siftkit summary`.

## File Structure

- Modify `src/repo-search/live-snapshot/writer.ts`: own fixed scheduling, queue serialization, stopped-state enforcement, synchronous atomic writes, and removal.
- Modify `tests/live-run-snapshot-writer.test.ts`: describe only observable writer behavior and protect teardown ordering.
- Modify `tests/fs-helpers.test.ts`: retain overwrite/temp-cleanup coverage that is not present elsewhere.
- Read only `tests/config.test.ts`: confirm its existing write and parent-directory tests remain the canonical coverage; do not edit it.

---

### Task 1: Remove test-only interval configurability

**Files:**
- Modify: `src/repo-search/live-snapshot/writer.ts:6,19-47`
- Modify: `tests/live-run-snapshot-writer.test.ts:41-62`

**Interfaces:**
- Consumes: `new LiveRunSnapshotWriter({ filePath: string, collector: LiveRunSnapshotCollector })`
- Produces: the same constructor shape with no `minIntervalMs` option; `schedule(): void` always uses the module-private `DEFAULT_MIN_INTERVAL_MS = 200`

- [ ] **Step 1: Recheck overlap and establish the characterization baseline**

Run:

```powershell
git status --short
npm test -- live-run-snapshot-writer
```

Expected: the status may include the user's parallel files, which must remain untouched. The focused writer target passes, including `writer coalesces scheduled writes and keeps the latest state` and both teardown regression tests.

- [ ] **Step 2: Make the scheduled-update test state only what it observes**

Replace the test heading and constructor setup with:

```ts
test('writer flushes the latest state after scheduled updates', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-scheduled-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-2', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });
```

Keep the existing 25-event loop, `await writer.flushNow()`, `turnsRecorded` assertion, single-target-file assertion, and `finally { writer.stop(); }`. The test must not claim to count physical writes because it has no write-count observation.

- [ ] **Step 3: Remove the constructor option and instance field completely**

Reduce the writer state and constructor to:

```ts
const DEFAULT_MIN_INTERVAL_MS = 200;

export class LiveRunSnapshotWriter {
  private readonly filePath: string;
  private readonly collector: LiveRunSnapshotCollector;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private stopped = false;

  constructor(options: {
    filePath: string;
    collector: LiveRunSnapshotCollector;
  }) {
    this.filePath = options.filePath;
    this.collector = options.collector;
  }
```

Change the timer delay in `schedule()` to the fixed constant:

```ts
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, DEFAULT_MIN_INTERVAL_MS);
```

Do not add another option, environment variable, setter, test hook, or compatibility overload.

- [ ] **Step 4: Verify the focused behavior and complete option removal**

Run:

```powershell
npm test -- live-run-snapshot-writer
siftkit repo-search 'Search executable code in src/ and tests/ for minIntervalMs. Return every remaining definition, constructor property, or call-site argument with exact file:line anchors and a zero-match verdict. Ignore historical implementation plans. Do not propose changes.'
```

Expected: the focused writer target passes and `minIntervalMs` has zero remaining matches in executable source and tests. Historical implementation plans may continue to describe the state they originally implemented.

---

### Task 2: Complete the synchronous queue refactor

**Files:**
- Modify: `src/repo-search/live-snapshot/writer.ts:24-96`
- Test: `tests/live-run-snapshot-writer.test.ts:64-118`

**Interfaces:**
- Consumes: `schedule(): void`, `flushNow(): Promise<void>`, `stop(): void`, `remove(): Promise<void>`
- Produces: unchanged public lifecycle signatures; private `writeOnce(): void`; a single `Promise<void>` queue with no mirrored pending-write counter

- [ ] **Step 1: Mutation-check the macrotask regression test before refactoring**

Temporarily replace the synchronous removal operation with promise-based removal:

```ts
import { rm } from 'node:fs/promises';

// Inside remove(), for this mutation only:
await rm(this.filePath, { force: true });
```

Run:

```powershell
npm test -- live-run-snapshot-writer
```

Expected RED: `writer removes the snapshot without yielding to a macrotask` fails because `immediateFired` is `true`. Restore the `rmSync` import and call immediately using an explicit reverse patch; do not use destructive Git restoration.

- [ ] **Step 2: Mutation-check the stopped-write regression test before refactoring**

Temporarily delete only this guard from `writeOnce()`:

```ts
    if (this.stopped) {
      return;
    }
```

Run:

```powershell
npm test -- live-run-snapshot-writer
```

Expected RED: `writer does not recreate the snapshot after stop` fails because the file exists. Restore the guard immediately with an explicit reverse patch.

- [ ] **Step 3: Remove redundant async and pending-write state**

Delete the `pendingWrites` field, its increment, both decrement paths, and the conditional queue wait. Replace the affected methods with:

```ts
  flushNow(): Promise<void> {
    return this.enqueueWrite();
  }

  async remove(): Promise<void> {
    await this.queue;
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // A snapshot we cannot delete is a stale file, never a failed run.
    }
  }

  private enqueueWrite(): Promise<void> {
    this.queue = this.queue.then(() => this.writeOnce());
    return this.queue;
  }

  private writeOnce(): void {
    if (this.stopped) {
      return;
    }
    try {
      const text = `${JSON.stringify(this.collector.build(), null, 2)}\n`;
      saveContentAtomically(this.filePath, text);
    } catch (error) {
      this.collector.recordWriteError(error instanceof Error ? error.message : String(error));
    }
  }
```

Retain the promise queue: it still orders scheduled and explicit flush requests. Do not replace it with a counter, callback injection, mutex class, or additional state.

- [ ] **Step 4: Update the removal comment to match the completed architecture**

Use this comment above `remove()`:

```ts
  /**
   * Waits for serialized writes, then unlinks synchronously. Awaiting an idle
   * queue yields only a microtask; the sync unlink prevents deferred macrotask
   * persistence from running before request resolution.
   */
```

- [ ] **Step 5: Verify green behavior and removed artifacts**

Run:

```powershell
npm test -- live-run-snapshot-writer
npm run typecheck:test
siftkit repo-search 'Inspect src/repo-search/live-snapshot/writer.ts. Return remaining pendingWrites symbols, async declarations that contain no await, and every decrement/increment used only to mirror queue state. Give file:line anchors and a zero-match verdict. Do not propose changes.'
```

Expected GREEN: focused tests and test typecheck pass; `pendingWrites` is absent; `writeOnce` and `flushNow` are not `async`; `remove` remains async because it awaits the queue.

---

### Task 3: Deduplicate filesystem tests and run final validation

**Files:**
- Modify: `tests/fs-helpers.test.ts:9-27`
- Read only: `tests/config.test.ts:139-159`
- Validate: `src/lib/fs.ts`, `src/repo-search/live-snapshot/writer.ts`, `tests/live-run-snapshot-writer.test.ts`

**Interfaces:**
- Consumes: `saveContentAtomically(filePath: string, content: string): void`
- Produces: one focused helper test for overwrite plus temp-file cleanup; existing `config.test.ts` remains the owner of basic write and parent-directory coverage

- [ ] **Step 1: Establish both filesystem test baselines**

Run:

```powershell
npm test -- fs-helpers
npm test -- config
```

Expected: both focused targets pass before cleanup.

- [ ] **Step 2: Delete duplicate coverage and remove stale async naming**

Delete this entire duplicate test from `tests/fs-helpers.test.ts`:

```ts
test('saveContentAtomically creates missing directories and writes the content', () => {
  const tempRoot = createManagedTempDir('siftkit-fs-async-');
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.json');

  saveContentAtomically(target, '{"a":1}\n');

  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
});
```

In the retained overwrite/temp-cleanup test, change only the prefix:

```ts
const tempRoot = createManagedTempDir('siftkit-fs-atomic-overwrite-');
```

Do not modify `tests/config.test.ts`; its existing basic-write and parent-directory tests remain canonical.

- [ ] **Step 3: Verify focused filesystem coverage**

Run:

```powershell
npm test -- fs-helpers
npm test -- config
```

Expected: the retained overwrite/temp-cleanup test passes, and both canonical `saveContentAtomically` tests in `config.test.ts` pass.

- [ ] **Step 4: Review the complete scoped diff through SiftKit**

Run:

```powershell
git diff -- src/repo-search/live-snapshot/writer.ts tests/live-run-snapshot-writer.test.ts tests/fs-helpers.test.ts 2>&1 | siftkit summary --question "Return every changed hunk with file:line anchors. Flag remaining minIntervalMs, pendingWrites, stale async naming, duplicate saveContentAtomically coverage, forbidden TypeScript constructs, compatibility paths, scope drift, or changes outside the three planned files."
```

Expected: none of the targeted artifacts remain; no forbidden TypeScript constructs, compatibility paths, or out-of-scope edits are present.

- [ ] **Step 5: Run focused and broader verification**

Run each command separately:

```powershell
npm test -- live-run-snapshot-writer
npm test -- fs-helpers
npm test -- config
npm test 2>&1 | siftkit summary --question "Return upstream pass/fail, total/pass/fail counts, failing test names, root errors, and file:line anchors. State PASS only if npm test exits zero."
npm run typecheck 2>&1 | siftkit summary --question "Return upstream pass/fail, TypeScript diagnostic count, ESLint error/warning counts, and file:line anchors. State PASS only if the command exits zero."
npm run lint 2>&1 | siftkit summary --question "Return upstream pass/fail, ESLint error/warning counts, and file:line anchors. State PASS only if the command exits zero."
```

Expected: all focused targets, the broader applicable suite, typecheck, and lint pass. If an unrelated parallel test fails, investigate and report it without changing the parallel file; do not claim the tree is green or broaden scope without the user.

- [ ] **Step 6: Confirm workspace preservation and report**

Run:

```powershell
git status --short
```

Report the result, the three planned changed files, validation evidence, remaining risks, and any unverified or unrelated failures. Confirm that `src/lib/fs.ts`, `tests/repo-agent-sessions.test.ts`, `.scratch/` if present, and all other parallel user changes were preserved. Do not stage or commit.
