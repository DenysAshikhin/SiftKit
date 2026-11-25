# Session drift fixes

> Execute one task at a time with TDD. Do not commit, create temp files, or touch other tasks. No casts, `any`, `!`, namespace imports,
> or shims; delete what a task replaces. Comments are 1-2 lines. Keep each file's existing line endings.

**Goal:** remove duplication, hard-coded values and double mechanisms the session of 2026-11-24 introduced. Behavior changes only where a task says so.

Run one test file: `node ./src/test-runner/run-tests.ts <name-without-.test.ts>`; a file in `tests/process/` needs `--process` before the name.
Dashboard: `npx vitest run --config .\dashboard\vitest.config.ts <file>`. Every task ends with `npm run typecheck` and `npm run lint` clean.

---

### Task 1: One entry point for preset fields, one journal event rewrite

**Files:** create `src/state/schema-upgrades/journal-event-bodies.ts`; modify `src/state/schema-upgrades/stored-model-presets.ts`,
`admitted-preset-fields.ts`, `chat-model-selection.ts`, `chat-session-preset-snapshots.ts`, `model-preset-cache-auto.ts`,
`model-preset-ram-disk.ts`, `model-preset-sparse-draft-head.ts` (all in that folder); test `tests/runtime-db-schema-admitted-preset-fields.test.ts`.

- [ ] Step 1 (failing test): add to the test file a test named `an upgrade that adds a preset field reaches saved runs too`. It seeds with the
  file's `seedSchema99` one event `admitted(x)`, where `x` is `SEPTEMBER_PRESET` plus every key of `ADDED_FIELDS` except `RamDiskCache` and
  `RamDiskCacheGiB`, calls `upgradeModelPresetRamDisk(database)` (from `../src/state/schema-upgrades/model-preset-ram-disk.ts`) directly on a connection
  opened with `withRuntimeDatabaseConnection(dbPath, ...)`, without the upgrade chain, and asserts the stored `body_json` of sequence 1 has
  `modelPreset.RamDiskCache === false` and `modelPreset.RamDiskCacheGiB === 10` (parse with `JsonObjectSchema`/zod, no casts).
  Seed `app_config` only if the upgrade needs a row; with no row it loops over nothing.
- [ ] Step 2: run it; it fails because that upgrade never touches `chat_run_events`.
- [ ] Step 3: create `journal-event-bodies.ts`:

```ts
import { digestStableJson } from '../../lib/json-digest.ts';
import { parseJsonObjectText } from '../../lib/json.ts';
import type { JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int(), event_id: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

export type StoredJournalEvent = { operationId: string; sequence: number; eventId: string; body: JsonObject };

/** Every stored event of one kind; a corrupt digest aborts the upgrade. */
export function readJournalEvents(database: RuntimeDatabase, kind: string): StoredJournalEvent[] {
  const rows = EventRowsSchema.parse(database.prepare(
    'SELECT operation_id, sequence, event_id, body_json, payload_digest FROM chat_run_events WHERE kind = ?',
  ).all(kind));
  return rows.map((row) => {
    const body = parseJsonObjectText(row.body_json);
    if (digestStableJson(body) !== row.payload_digest) throw new Error(`Chat journal event ${row.event_id} has a corrupt payload digest.`);
    return { operationId: row.operation_id, sequence: row.sequence, eventId: row.event_id, body };
  });
}

/** Stores a new body for an event and keeps its digest in step. */
export function replaceJournalEventBody(database: RuntimeDatabase, event: StoredJournalEvent, body: JsonObject): void {
  database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?')
    .run(JSON.stringify(body), digestStableJson(body), event.operationId, event.sequence);
}
```

- [ ] Step 4: in `stored-model-presets.ts` replace the three exported `addMissing*PresetFields` functions by one exported
  `addMissingModelPresetFields(database, fields)` with the comment `/** Gives every stored model preset the fields it lacks, wherever one is kept: the config, each chat session's snapshot, each run's admission. */`
  that calls three private functions (config, snapshots, admissions). The admissions one uses the two helpers above. Remove the file's own `EventRowsSchema` and
  the imports nothing uses. Keep all error texts. `withMissingFields` stays exported.
- [ ] Step 5: every upgrade listed above calls `addMissingModelPresetFields` once with its fields, except `admitted-preset-fields.ts`, which repairs saved runs only and calls the admissions function. `chat-model-selection.ts` uses the two helpers
  for its `run_started` loop and drops its own `EventRowsSchema` (parse the upgraded body with `JsonObjectSchema.parse` if the types need it).
- [ ] Step 6: `node ./src/test-runner/run-tests.ts runtime-db-schema` is all green. `grep` finds no `addMissingStoredPresetFields`,
  `addMissingSnapshotPresetFields` or `addMissingAdmittedPresetFields`.

### Task 2: A command timed out only if it was stopped for its time

**Files:** modify `src/orchestrator/verification.ts`, `src/repo-search/engine/background-jobs.ts`; test `tests/process/orchestrator-check-digest.test.ts`.

- [ ] Step 1 (failing test): in the test file, following its existing `runVerificationCheck` helper, add a test `a check that itself exits 124 did not time out`:
  the command `exit 124` gives `exitCode` 124 and `timedOut` false.
- [ ] Step 2: run with `--process`; it fails (`timedOut` true).
- [ ] Step 3: `verification.ts` uses `timedOut: result.timedOut` and no longer imports `TIMEOUT_EXIT_CODE`. `background-jobs.ts` uses
  `exitCode: result.exitCode` (it is already 124 on a timeout) and no longer imports `TIMEOUT_EXIT_CODE` as a value.
- [ ] Step 4: that test file and `--process background-jobs` are green.

### Task 3: One way to keep output, one place for the open-pipes warning, one way a job ends

**Files:** create `src/output-digest/kept-output.ts`; modify `src/orchestrator/verification.ts`, `src/repo-search/engine/agent-command.ts`,
`src/repo-search/engine/background-jobs.ts`; test: create `tests/kept-output.test.ts`.

- [ ] Step 1 (failing test): `tests/kept-output.test.ts` asserts `keepOutput('abcdef', { tailChars: 3, digestChars: 100 })` deep-equals
  `{ output: 'def', digest: null }`, that output within the limit is returned whole, and that a tsc failure line
  (`src/a.ts(1,2): error TS2304: Cannot find name 'x'.`) gives a non-null digest no longer than `digestChars` while `output` is cut to its tail.
- [ ] Step 2: run; it fails because the module is missing.
- [ ] Step 3: create it:

```ts
import { copyText } from '../lib/bounded-output.ts';
import { cutDigest, digestOutput } from './digest.ts';

export type KeptOutput = { output: string; digest: string | null };

/** What is kept of a command's output: its tail, and a digest of all of it. Neither keeps the whole text alive. */
export function keepOutput(output: string, limits: { tailChars: number; digestChars: number }): KeptOutput {
  const digest = digestOutput(output);
  return {
    output: copyText(output.slice(-limits.tailChars)),
    digest: digest === null ? null : copyText(cutDigest(digest.text, limits.digestChars)),
  };
}
```

- [ ] Step 4: `verification.ts` returns `...keepOutput(result.output, { tailChars: CHECK_OUTPUT_MAX_CHARS, digestChars: CHECK_OUTPUT_MAX_CHARS })`;
  `background-jobs.ts` `settle` uses it with `RESULT_MAX_CHARS` and `DIGEST_MAX_CHARS`. `lastChars` stays only if the live tail still needs it; otherwise inline
  the live tail as `copyText(text.slice(-LIVE_TAIL_CHARS))` and delete `lastChars`.
- [ ] Step 5: in `agent-command.ts` replace the exported `PIPES_OPEN_WARNING` by a private constant declared above its first use and an exported
  `/** A command's output, saying so when something it started may have kept the rest. */ export function reportedOutput(result: CapturedCommandResult): string`
  that returns `result.pipesClosed ? result.output : \`${result.output}\n\n${PIPES_OPEN_WARNING}\`.trim()`. `runAgentCommand` returns
  `{ ...result, output: reportedOutput(result) }`; `settle` uses `reportedOutput(result)` for what it keeps. Shorten the file's header comment to 2 lines.
- [ ] Step 6: in `background-jobs.ts` remove `Job.waiters` and everything that fills it. `waitForEnd` becomes:

```ts
  private async waitForEnd(job: Job, waitMs: number, abortSignal: AbortSignal | undefined): Promise<void> {
    const timer = new AbortController();
    const signal = abortSignal === undefined ? timer.signal : AbortSignal.any([timer.signal, abortSignal]);
    try {
      await Promise.race([job.ended, delay(waitMs, undefined, { signal })]);
    } catch (error) {
      if (abortSignal?.aborted) throw getAbortError(abortSignal);
      throw error;
    } finally {
      timer.abort();
    }
  }
```

  (`delay` is `setTimeout` from `node:timers/promises`.) Split the type so no placeholder promise is needed: `JobState` holds every field but `ended`,
  `type Job = JobState & { readonly ended: Promise<void> }`, and `start` builds `const job: Job = Object.assign(state, { ended: this.settle(state, command) })`
  before `this.jobs.set`.
- [ ] Step 7: `kept-output`, `--process background-jobs`, `--process background-jobs-soak`, `--process background-job-tool`, `--process agent-command`,
  `--process orchestrator-check-digest` are green.

### Task 4: One run timeout rule, one list of tools that rewrite the tree

**Files:** modify `src/repo-search/repo-tool-arguments.ts`, `src/repo-search/engine/repo-tools.ts`, `src/repo-search/engine/tool-action-processor.ts`,
`src/repo-search/engine/status-updates.ts`, `src/repo-search/planner-protocol.ts`, `src/repo-search/prompts.ts`, `src/planner-protocol/repo-search.ts`; tests `tests/repo-tool-arguments.test.ts`.

- [ ] Step 1 (failing test): in `tests/repo-tool-arguments.test.ts` assert `resolveRunTimeoutMs`: `{}` gives `DEFAULT_RUN_TIMEOUT_MS`,
  `{ background: true }` gives `DEFAULT_BACKGROUND_TIMEOUT_MS`, and a given `timeoutMs` wins for both.
- [ ] Step 2: run; it fails.
- [ ] Step 3: export `/** How long a run may take: its own limit, or its kind's default. */ export function resolveRunTimeoutMs(args: Pick<RunToolArgs, 'background' | 'timeoutMs'>): number`
  from `repo-tool-arguments.ts`. `executeRun` and `startJob` use it. `buildRepoToolRequestedCommand` shows
  `args.background === true ? resolveRunTimeoutMs({ background: true, timeoutMs: parsePositiveInteger(args.timeoutMs) }) : parsePositiveInteger(args.timeoutMs)`.
  No other file resolves `DEFAULT_BACKGROUND_TIMEOUT_MS` or `DEFAULT_RUN_TIMEOUT_MS` for a `run` call (`verification.ts` keeps its own use).
- [ ] Step 4: in `planner-protocol.ts` split the set: `const COMMAND_TOOL_NAMES = ['run', BACKGROUND_JOB_TOOL_NAME, 'dispatch', 'decide', 'run_check', 'change_approach']`
  with the comment `/** Tools that run a command or a child, which can rewrite any file. */`, `TREE_MUTATING_TOOL_NAMES = new Set<string>([...COMMAND_TOOL_NAMES, 'write', 'edit'])`,
  and export `rewritesAnyFile(toolName: string): boolean` beside `isTreeMutatingToolName`. `invalidateAfterMutation` uses it instead of its own list of names.
- [ ] Step 5: in `src/planner-protocol/repo-search.ts` export `/** Tools that ride on top of any surface, so they never turn a full one into a restricted one. */ export const RIDING_TOOL_NAMES = [...WEB_CHAT_TOOL_NAMES, BACKGROUND_JOB_TOOL_NAME] as const;`.
  `hasExactToolSurface` in `prompts.ts` filters by one set built from it, and `WEB_CHAT_TOOL_NAME_SET` and the extra `!==` go if nothing else uses them.
- [ ] Step 6: replace the bare `'job'` in `EDIT_DEADLINE_TOOLS`, `repeatsByDesign` and `WINDOW_TOOLS` by `BACKGROUND_JOB_TOOL_NAME` (give the constant
  `as const`). Discriminant checks on a parsed call (`call.toolName === 'job'`, `case 'job'`) stay.
- [ ] Step 7: `repo-tool-arguments`, `status-updates`, `planner-protocol`, `prompts` test names, and `--process background-job-tool` are green.

### Task 5: One shape and one set of limits for status text

**Files:** create `packages/contracts/src/status-update.ts`; modify `packages/contracts/src/index.ts`, `chat-transcript-reducer.ts`, `orchestrator.ts` (same folder),
`src/repo-search/types.ts`, `src/orchestrator/prompts.ts`, `src/repo-search/engine/status-updates.ts`, `dashboard/src/lib/chatTurns.ts`;
tests `tests/contracts-orchestrator.test.ts`, `tests/status-updates.test.ts`, and the orchestrator prompt test.

- [ ] Step 1 (failing tests): assert the orchestrator prompt contains `at most ${ORCHESTRATOR_WHY_MAX_CHARS} characters` and
  `${ORCHESTRATOR_STATUS_LINE_MAX_CHARS} characters`, with both imported from `@siftkit/contracts`; in `contracts-orchestrator.test.ts` use
  those two constants in place of the literals 160 and 240; in `status-updates.test.ts` assert the instruction asks for at most `STATUS_UPDATE_ASKED_WORDS` words.
- [ ] Step 2: run; they fail (the constants are not exported).
- [ ] Step 3: `status-update.ts` exports `StatusUpdateFieldsSchema = z.object({ updateId: z.string().uuid(), text: z.string().min(1), createdAtUtc: z.string().datetime() })`
  with the comment `/** What a run said it was doing, for the person watching; never part of its own history. */`, and its inferred type `StatusUpdateFields`.
  The transcript event, `OrchestratorStatusUpdateSchema` and `StatusUpdateProgressEventSchema` spread `StatusUpdateFieldsSchema.shape` instead of restating the fields;
  each keeps its strictness. `ProgressReporter.statusUpdate` may take `StatusUpdateFields`.
- [ ] Step 4: export `ORCHESTRATOR_WHY_MAX_CHARS` and a new `ORCHESTRATOR_STATUS_LINE_MAX_CHARS = 240` used by `OrchestratorStatusLineSchema`; `prompts.ts` interpolates both.
- [ ] Step 5: `status-updates.ts` exports `STATUS_UPDATE_ASKED_WORDS = 30` with the comment `/** Asked for; a reply up to MAX_WORDS is still shown, because models overrun a little. */`
  and the instruction interpolates it. Remove the paragraph check from `parseStatusUpdate` only if `findStatusTextProblem` covers it after the newline collapse; otherwise leave it.
- [ ] Step 6: in `chatTurns.ts` replace the hand-written `StatusUpdate` type by `Pick<OrchestratorStatusUpdate, 'updateId' | 'text' | 'callsSince'>` from `@siftkit/contracts`.
- [ ] Step 7: the named tests, `chat-transcript` tests, the dashboard `chatTurns` tests, typecheck and lint are green.

### Task 6: Dashboard: one status updates component, one plural, one pass

**Files:** modify `dashboard/src/components/StatusUpdates.tsx`, `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/components/OrchestratorConversation.tsx`,
`dashboard/src/components/vault/GraphView.tsx`, `dashboard/src/lib/format.ts`, `dashboard/src/lib/chatTurns.ts`, `dashboard/src/hooks/usePaneFollow.ts`,
`dashboard/src/components/OrchestratorRunLine.tsx`; tests `dashboard/tests/lib/chatTurns.test.ts` and the format test.

- [ ] Step 1 (failing test): `plural(1, 'call')` is `1 call`, `plural(0, 'call')` is `0 calls`, `plural(1200, 'note')` is `1,200 notes`, imported from `dashboard/src/lib/format.ts`.
  Add to `chatTurns.test.ts` a turn with two updates and three tool calls that pins `callsSince` for both, the last call running.
- [ ] Step 2: run; the `plural` one fails.
- [ ] Step 3: `format.ts` exports `plural` (`count.toLocaleString('en-US')`); the private copies in `OrchestratorConversation.tsx` and `GraphView.tsx` go, and `StatusUpdates.tsx` uses it.
- [ ] Step 4: `StatusUpdates` takes `{ updates, live }`. Live is today's component. Not live renders exactly what `ChatTab.tsx` renders inline now
  (`details.status-updates`, summary `Updates (n)`, the list). Both use one private `UpdateList`. `ChatTab.tsx` renders `<StatusUpdates updates={turn.updates} live={turn.showRecentActivity} />`
  and nothing else; `OrchestratorTaskRow.tsx` passes `live`.
- [ ] Step 5: `pickStatusUpdates` goes through the messages once, from last to first, counting ended tool calls; an update's count is the ended calls after it plus the
  nearest tool call before it when that one has ended. Same results, no slicing per update.
- [ ] Step 6: `usePaneFollow<Pane extends HTMLElement>(selector: string | null)` types `paneRef` as `React.useRef<Pane>(null)`; `OrchestratorRunLine` passes `ref={paneRef}` and the callback ref goes.
- [ ] Step 7: the whole dashboard suite, typecheck and lint are green.
