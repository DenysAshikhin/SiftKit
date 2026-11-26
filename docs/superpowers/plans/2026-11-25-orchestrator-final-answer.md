# Orchestrator Final Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A completed orchestrator run keeps its closing summary, and the panel and the CLI show it.

**Architecture:** One nullable `summary` field on the run state, committed when the run enters `cleaning`. Schema 100 -> 101 adds the field to stored runs, read from the parent's run log where one still exists. A blocked run already shows its reason as its failure, so nothing changes there.

**Tech Stack:** TypeScript, zod, better-sqlite3, React, node:test, vitest.

**As built:** the upgrade step reads the finish with a plain JSON parse. `ModelJson`, shown below, pulled config code into the dashboard test project and broke its typecheck.

---

### Task 1: Store the summary and upgrade stored runs

**Files:**
- Create: `src/state/schema-upgrades/orchestrator-run-summary.ts`
- Create: `tests/runtime-db-schema-orchestrator-run-summary.test.ts`
- Modify: `packages/contracts/src/orchestrator.ts` (`OrchestratorRunStateSchema`)
- Modify: `src/orchestrator/run-store.ts` (`OrchestratorRunChanges`, `create`)
- Modify: `src/orchestrator/run.ts` (`FinishOutcome`, `run`, `converse`, `review`)
- Modify: `src/cli/run-orchestrator.ts`, `src/state/runtime-db.ts`
- Modify fixtures: `tests/helpers/orchestrator-plan.ts`, `dashboard/tests/orchestrator-fixture.ts`, `tests/process/chat-overflow.test.ts` (only if it builds a full run state)
- Test: `tests/process/orchestrator-run.e2e.test.ts`, `tests/orchestrator-cli-result.test.ts`

- [ ] **Step 1: Write the failing upgrade test**, `tests/runtime-db-schema-orchestrator-run-summary.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { parseJsonObjectText } from '../src/lib/json.ts';
import { z } from '../src/lib/zod.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorRequest } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const AT = '2026-11-25T12:00:00.000Z';
const StateRowSchema = z.object({ state_json: z.string() });

type SeedRun = { phase: string; finalOutput: string | null };

/** A schema-100 file of runs without a summary; a run with a final output also has its parent's log. */
function seedSchema100(runs: readonly SeedRun[]): { dbPath: string; runIds: string[] } {
  const dbPath = path.join(createManagedTempDir('siftkit-run-summary-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const repoRoot = createManagedTempDir('siftkit-run-summary-repo-');
  const seeded = runs.map((run) => ({ ...run, parentRunId: randomUUID(),
    runId: store.create(makeOrchestratorRequest({ repoRoot, submissionId: randomUUID() })).runId }));
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    for (const { phase, finalOutput, parentRunId, runId } of seeded) {
      const { summary: _summary, ...stored } = parseJsonObjectText(StateRowSchema.parse(
        database.prepare('SELECT state_json FROM orchestrator_runs WHERE run_id = ?').get(runId)).state_json);
      database.prepare('UPDATE orchestrator_runs SET phase = ?, state_json = ? WHERE run_id = ?')
        .run(phase, JSON.stringify({ ...stored, phase, parentRunIds: [parentRunId] }), runId);
      if (finalOutput === null) continue;
      database.prepare(`INSERT INTO run_logs (run_id, request_id, run_kind, run_group, terminal_state, title, flushed_at_utc, repo_search_json)
        VALUES (?, ?, 'repo_search', 'repo_search', 'completed', 'run', ?, ?)`)
        .run(parentRunId, parentRunId, AT, JSON.stringify({ scorecard: { tasks: [{ finalOutput }] } }));
    }
    database.exec('UPDATE runtime_schema SET version = 100 WHERE id = 1');
  });
  return { dbPath, runIds: seeded.map(({ runId }) => runId) };
}

test('the 100 to 101 upgrade gives a completed run the summary its log still holds, and every other run none', (t) => {
  t.after(closeAllRuntimeDatabases);
  const finish = JSON.stringify({ status: 'completed', summary: 'Found 34 flaws.' });
  const { dbPath, runIds } = seedSchema100([
    { phase: 'completed', finalOutput: finish },
    { phase: 'completed', finalOutput: `All tasks are complete.\n\n${finish}` },
    { phase: 'completed', finalOutput: null },
    { phase: 'completed', finalOutput: 'No finish here.' },
    { phase: 'failed', finalOutput: JSON.stringify({ status: 'blocked', reason: 'No access.' }) },
  ]);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  // Reading parses each run with the current schema.
  const store = new OrchestratorRunStore(database);
  assert.deepEqual(runIds.map((runId) => store.read(runId).summary), ['Found 34 flaws.', 'Found 34 flaws.', null, null, null]);
});

test('the 100 to 101 upgrade fails loudly on an unreadable stored run, naming it, and leaves the file at 100', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runIds } = seedSchema100([{ phase: 'completed', finalOutput: null }]);
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?').run('{"parentRunIds":"none"}', runIds[0]);
  });
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${String(runIds[0])} has an unreadable stored state`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 100);
});
```

- [ ] **Step 2: Extend the existing tests so they fail**

In `tests/process/orchestrator-run.e2e.test.ts`, in the test starting `one conversation plans, dispatches a writer, reviews it, and finishes`, after its `assertCompleted(state, engine);` add `assert.equal(state.summary, 'Added the greeting module.');`. In the test `a fifth invalid response in a row ends the orchestrator conversation` add `assert.equal(state.summary, null);` at the end.

In `tests/orchestrator-cli-result.test.ts` add `summary: z.string().nullable(),` to `ResultSchema`, and `summary: 'Cached the index.',` both to the `makeOrchestratorRunState` call and to the expected object.

- [ ] **Step 3: Run them to verify they fail**

Run: `node ./src/test-runner/run-tests.ts runtime-db-schema-orchestrator-run-summary`, then `node ./src/test-runner/run-tests.ts orchestrator-cli-result`
Expected: FAIL (no `summary` on the run state, schema version 100).

- [ ] **Step 4: Implement**

`packages/contracts/src/orchestrator.ts`, in `OrchestratorRunStateSchema`, replace the `approval` line with:

```ts
  approval: OrchestratorPendingApprovalSchema.nullable(), failure: OrchestratorFailureSchema.nullable(),
  /** The orchestrator's accepted finish summary; null until then, and for a run that ended another way. */
  summary: z.string().min(1).nullable(),
```

`src/orchestrator/run-store.ts`: add `| 'summary'` to the `Pick` in `OrchestratorRunChanges`, and `summary: null` after `failure: null` in `create`.

`src/orchestrator/run.ts`: the completed member of `FinishOutcome` becomes `{ status: 'completed'; summary: string }`; `review` sets `this.finishOutcome = { status: 'completed', summary: finish.summary };`; `converse` becomes `Promise<string>`, its comment says it returns the accepted summary, and it ends with `return finish.summary;`; `run` uses it:

```ts
      const summary = await this.converse();
      this.commit({ phase: 'cleaning', summary }, 'Cleaning run scratch files.');
```

`src/cli/run-orchestrator.ts`: add `summary: state.summary,` after `planPath: state.planPath,`.

Fixtures (`tests/helpers/orchestrator-plan.ts`, `dashboard/tests/orchestrator-fixture.ts`): add `summary: null` after `failure: null`.

`src/state/schema-upgrades/orchestrator-run-summary.ts`:

```ts
import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { ModelJson } from '../../lib/model-json.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
// Pins only what this step reads. A run that already has a summary was written by current code.
const Stored100RunSchema = z.object({
  phase: z.string(), parentRunIds: z.array(z.string()), summary: JsonValueSchema.optional(),
}).catchall(JsonValueSchema);
const LogRowSchema = z.object({ repo_search_json: z.string().nullable() }).optional();
const LogSchema = z.object({ scorecard: z.object({ tasks: z.array(z.object({ finalOutput: z.string() })) }) });
const FinishSchema = z.object({ status: z.literal('completed'), summary: z.string().trim().min(1) });

/** The accepted finish in the parent's log; logs are pruned, so many finished runs have none left. */
function loggedSummary(database: RuntimeDatabase, parentRunId: string): string | null {
  const row = LogRowSchema.parse(database.prepare('SELECT repo_search_json FROM run_logs WHERE run_id = ?').get(parentRunId));
  if (row === undefined || row.repo_search_json === null) return null;
  try {
    const { scorecard } = LogSchema.parse(parseJsonObjectText(row.repo_search_json));
    return ModelJson.parseObject(scorecard.tasks[0]?.finalOutput ?? '', FinishSchema, 'orchestrator finish').summary;
  } catch {
    return null;
  }
}

/** Schema 100 -> 101: every stored run gains its summary; a completed one takes it from its log while that exists. */
export function upgradeOrchestratorRunSummary(database: RuntimeDatabase): void {
  const updateRun = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const parsed = Stored100RunSchema.safeParse(parseJsonObjectText(row.state_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored state: ${parsed.error.message}`);
    const { phase, parentRunIds, summary } = parsed.data;
    const parentRunId = parentRunIds.at(-1);
    const recovered = phase === 'completed' && parentRunId !== undefined ? loggedSummary(database, parentRunId) : null;
    updateRun.run(JSON.stringify({ ...parsed.data, summary: summary ?? recovered }), row.run_id);
  }
}
```

`src/state/runtime-db.ts`: `CURRENT_SCHEMA_VERSION = 101`, import the step, and add `{ from: 100, apply: upgradeOrchestratorRunSummary },` last.

- [ ] **Step 5: Run to verify they pass**

Run: `node ./src/test-runner/run-tests.ts runtime-db-schema`, `node ./src/test-runner/run-tests.ts orchestrator`, `node ./src/test-runner/run-tests.ts --process orchestrator-run`, `npm run typecheck`
Expected: PASS. Any other test that pins version 100 or builds a full run state is updated the same way. Do not commit.

### Task 2: Show the summary in the run panel

**Files:**
- Modify: `dashboard/src/components/OrchestratorRunPanel.tsx`, `dashboard/src/styles/orchestrator.css`
- Test: `dashboard/tests/orchestrator-run-panel.test.tsx`

- [ ] **Step 1: Write the failing tests**, appended to the test file:

```tsx
test('a finished run shows its final answer as markdown above the panes', () => {
  renderPanel(runState({ phase: 'completed', summary: 'Found **34** flaws.' }));
  const answer = screen.getByRole('region', { name: 'Final answer' });
  assert.equal(answer.querySelector('p')?.textContent, 'Found 34 flaws.');
  assert.equal(answer.querySelector('strong')?.textContent, '34');
  const panes = document.querySelector('.orch-panes');
  assert.ok(panes);
  assert.equal(answer.compareDocumentPosition(panes), Node.DOCUMENT_POSITION_FOLLOWING);
});

test('a run without a summary shows no final answer', () => {
  renderPanel(runState({ phase: 'failed' }));
  assert.equal(screen.queryByRole('region', { name: 'Final answer' }), null);
});
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npx vitest run --config ./dashboard/vitest.config.ts dashboard/tests/orchestrator-run-panel.test.tsx`
Expected: FAIL, no region named "Final answer".

- [ ] **Step 3: Implement**

In `OrchestratorRunPanel.tsx` import `MarkdownContent` from `./MarkdownContent.tsx` and add directly after the `state.failure` line:

```tsx
      {state.summary === null ? null : (
        <section className="orch-summary" aria-label="Final answer" tabIndex={0}>
          <header className="orch-title">Final answer</header>
          <div className="markdown-body"><MarkdownContent content={state.summary} /></div>
        </section>
      )}
```

In `orchestrator.css`, after the `.orchestrator-run .approval-card` rule:

```css
.orch-summary { margin: 10px 12px; padding: 8px 12px; max-height: 240px; overflow-y: auto; border: 1px solid var(--ok-line); border-radius: 8px; background: var(--panel2); font-size: 0.78rem; }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config ./dashboard/vitest.config.ts`, `npm run typecheck`
Expected: PASS. Do not commit.
