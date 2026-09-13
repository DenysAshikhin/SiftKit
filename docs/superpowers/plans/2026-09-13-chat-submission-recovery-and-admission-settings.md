# Chat Submission Recovery and Admission Settings Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute this plan task-by-task only after the user requests implementation. Run tasks sequentially. This document authorizes no implementation, deployment, or production-data changes. Do not use SiftKit, worktrees, or commits.

**Goal:** Recover a streamed submission after its response is lost without creating a second execution, and ensure a waiting Web run executes the settings captured when it was admitted.

**Architecture:** Add a durable receipt for each logical streamed submission while preserving the existing reusable control-operation identity. Repeating that submission attaches to its recorded run through the existing projection protocol. Capture one validated execution context before waiting for a model and use it throughout the run.

**Tech Stack:** TypeScript, Zod, React hooks, SQLite/better-sqlite3, the existing SSE projection protocol, Node tests, and the repository's test/build runners.

**Spec:** The two findings from the September 13 review of `652b95d1`, expanded into the requirements and design below. This is a self-contained plan; no separate design document is needed.

## 1. Scope and evidence

The repository was clean at `652b95d1` when planning began. Recheck that baseline before execution and preserve concurrent work.

### Finding A: lost initial submission response

`dashboard/src/hooks/useChatSessions.ts:543-586` only schedules owned-stream recovery after a snapshot, a matching queue operation ID, or a busy response. An operation can be accepted and finish while both connections are unavailable. The queue then reconnects with `activeOperationId: null`, which does not trigger recovery.

The isolated review probe observed: the server accepted/completed the submission, the queue connected twice, operation-attach requests remained at one, detail requests remained at two, visible messages remained empty, and the original prompt returned to the composer.

The existing client `operationId` cannot become the idempotency key: `tests/status-server-chat-routes.test.ts:841` deliberately verifies that two sequential turns may reuse it and still create distinct durable runs.

### Finding B: settings change during a model wait

`openChatOperationStream()` rereads the session after acquiring the model lock (`src/status-server/routes/chat.ts:258-264`). `ChatRepoOperationRunner.run()` then selects from that session and the current config (`src/status-server/chat-repo-operation-runner.ts:113-140`), even though the recorder already holds admitted settings.

The isolated review probe recorded `presetId: 'plan'` but dispatched `presetId: 'new-plan'` and its different tool list. The session-update endpoint permits updates from another client while the first operation waits.

### Global constraints

- This turn produces this plan only. Do not create regression tests or change implementation until execution is requested.
- During implementation, use TDD: reproduce each defect with a failing test, implement the minimum complete correction, run the relevant tests, then refactor.
- All code/tests are TypeScript. Parse IO with runtime schemas and derive types with `z.infer`. No `any`, unknown laundering, type assertions, non-null assertions, namespace imports, or schema-duplicating types. `as const`, `satisfies`, named aliases, and valid type guards remain allowed.
- Keep dependencies explicit. Use classes only for shared state/behavior; use no dynamically passed functions except where an external API requires them. Comments stay within one or two lines.
- Preserve intentional operation-preset substitution, approval policy, model-readiness checks, image deletion/retention, queue FIFO, Stop behavior, and the bounded projection codec.
- Refactors replace their old paths completely. Missing submission identity is an explicit request error after client/server cutover; do not add a compatibility path that invents it.
- Use one task scratch directory for authored probes/logs: `.scratch/chat-submission-admission/`. Existing test fixtures retain their automatic isolated-runtime teardown. Remove task scratch at completion.
- Never run tests against `.siftkit/runtime.sqlite`. Keep the existing production-database guard and use isolated fixtures.
- No live model jobs, production migration/repair, new dependencies, CLI feature changes, UI redesign, or unrelated test fixes are included.

## 2. Design decisions

### A. Durable submission receipts and idempotent stream admission

Use three explicit identities:

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| `submissionId` | One logical browser submission | Stable across connection retries; fresh for a deliberate new turn |
| Existing client `operationId` | Handle used by Stop and active-operation controls | Preserve the existing reusable-handle contract |
| Existing journal `operationId` | One durable execution | Server-generated UUID; never repointed |

Add required `submissionId` to the four Web streaming POST payloads: message, plan, repo-search, and repo-agent. The hook creates it once alongside the control ID. Queue enqueue/Force already have their own durable identities and keep them; detached successors do not manufacture browser submission receipts. Non-streaming operations are outside this new identity requirement.

Add `chat_submissions` in runtime schema **72**:

```sql
CREATE TABLE IF NOT EXISTS chat_submissions (
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  run_operation_id TEXT NOT NULL UNIQUE REFERENCES chat_runs(operation_id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, submission_id)
);
```

Store only identity and a digest, never a second prompt/image payload. The 71-to-72 upgrade creates an empty table. Do not invent receipts for historical runs or change journal event version 2. Session/run deletion and whole-database backups include the receipt through existing ownership and foreign keys.

The digest is SHA-256 of `stableStringify({ operationKind, body })`, where `body` is the JSON object validated by the existing body parser and contains both required UUIDs. This includes explicit content, images, options, and mock/test fields, but no newly resolved config/session defaults. Object key order is irrelevant; changed field values conflict. Retries retain the exact original payload.

Admission order:

1. Read/parse the complete body and validate its submission/control UUIDs.
2. Compute the digest and look up `(sessionId, submissionId)` before mutable preset/root/image checks, busy rejection, or queue admission. A receipt hit must remain usable after those settings change.
3. Matching receipt: verify the referenced run belongs to the session and attach to that exact run. Do not acquire a new lease, bind an engine, claim queue rows, or execute anything. A different digest returns a typed 409 conflict.
4. No receipt: read the current session/config, perform ordinary admission, then commit the run, `run_started`, and receipt in one synchronous SQLite transaction. Set the admitted recorder on its lease before yielding/publishing. A failed transaction leaves neither accepted run nor receipt.
5. Dispatch only after that transaction commits. Concurrent identical submissions converge on the same receipt and execution. Session ownership continues to fence other server processes.

Extract the existing recorded-run subscription setup so both normal GET attach and duplicate POST use the same `ChatOperationSseSubscriber`. Subscribe to a live broadcast only when its recorder matches the requested durable run; a terminal old receipt must not attach to a newer operation's broadcast. Return an integrity error for a broken receipt; never silently create a replacement execution.

For ambiguous transport failures, the browser reconnects by repeating the original POST with its original `submissionId` and payload. If the first request committed, this only reattaches. If it never committed, this admits the original user-requested turn once. A crashed admitted run is recovered as terminal by startup recovery; repeating its submission does not restart its computation.

This avoids a separate status protocol and the race in which a lookup says “absent” while the original POST is still admitting. Client-only refresh is insufficient because “latest run” does not reliably identify the failed submission.

### B. Preserve submission state until its outcome is known

Separate these outcomes in the API/transition layer:

| Outcome | Browser action |
| --- | --- |
| Explicit pre-admission 4xx rejection | Restore that submitted input once; retain normal busy/conflict behavior |
| Fetch failure, body read failure, malformed/truncated transfer, or ambiguous HTTP 5xx | Retain the original request and readable view; reconnect the same submission with an abortable delay |
| Valid projection failure/recovery issue | Report the failure; do not automatically start/retry computation |
| Valid terminal followed by failed detail refresh | Keep the committed terminal view and original identity; retry reconciliation |
| Terminal and successful detail refresh | Release that submission's ownership and clear only its submitted input |

Replace the Set of owned session IDs with ownership keyed by the retained submission object/ID. A stale completion or cleanup may only release its own submission. Keep the current draft and newly added images separate from the immutable submitted payload.

Expose a small submission phase in runtime state: `sending`, `streaming`, `reconnecting`, `settling`, or null. Derive its type from a Zod enum. While reconnecting/settling, display “Reconnecting…” or the existing waiting presentation and disable Send, Retry, queue submission, and Force for that session. Keep draft editing and other sessions usable. Never let an unresolved submission enter the normal “restore draft and send a fresh turn” path.

Use one abortable reconnect delay, reusing the existing one-second reconnect policy. Do not create independent polling loops or replay callbacks. Recreate the stream through a direct operation-kind switch over the retained, schema-validated request. Ordinary page reload continues to use the server's existing durable attach/history flow; this plan does not add persistent browser draft storage.

### C. One execution context captured at admission

Add `src/status-server/chat-run-admission.ts` as the single owner of operation-preset selection and execution-input capture. Reuse existing schemas rather than defining parallel config/session types:

```ts
export const ChatRunAdmissionSchema = z.strictObject({
  settings: ChatRunEffectiveSettingsSchema,
  config: SiftConfigSchema,
  session: StoredChatSessionSchema.omit({ messages: true }),
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
  imageMeta: z.array(ImageMetadataSchema),
});
export type ChatRunAdmission = z.infer<typeof ChatRunAdmissionSchema>;
```

Define and export the builder input as follows. Parse the metadata-only session shape directly so validation does not clone history first:

```ts
export const BuildChatRunAdmissionInputSchema = ChatRunAdmissionSchema.pick({
  config: true, session: true, content: true, images: true,
}).extend({
  operationKind: ChatSessionOperationKindSchema,
  repoRoot: z.string().trim().min(1),
  approval: ApprovalModeSchema.nullable(),
  maxTurns: z.number().int().positive().optional(),
  webSearchOverride: ChatWebSearchOverrideSchema.optional(),
  webToolsAllowed: z.boolean(),
});
export type BuildChatRunAdmissionInput = z.infer<typeof BuildChatRunAdmissionInputSchema>;
```

`buildChatRunAdmission(input: BuildChatRunAdmissionInput): ChatRunAdmission` owns the existing operation-specific policies. Require a starting approval mode for repo-agent; preserve null for modes without approval. The input root must be the actual execution root: `process.cwd()` for ordinary messages, the resolved request/session root for repo operations, and the session root for condense.

The builder selects the operation preset once, resolves the effective model config once, validates/copies it with the existing schemas, admits images, and derives `settings` from those exact values. Capture session metadata without copying its potentially large transcript. History remains a current journal read so accepted deletions and queued steering still take effect.

Normalize the captured model snapshot to the effective model/settings that execution actually receives while preserving its logical model-preset identity. Do not persist a runtime-normalized model snapshot back over the user's session metadata. Keep existing active/inactive model resolution rules.

Replace `ChatRunSubmission` with this admission value. Carry it alongside the recorder through `ChatSessionOperationRequest`, `ChatRepoOperationRequest`, and Web repo-agent execution. `requireChatRunAdmission()` must throw if a model operation lacks it. Caption/history-only operations explicitly carry null.

- Build admission after reading the request body and immediately before the first await/dispatch. New queue successors build their own admission when they acquire their run; retries of a browser receipt do not rebuild it.
- Selectable chat/plan/repo-search/repo-agent presets use the existing selector once. Condense keeps the session's own preset and no web tools. Preserve existing endpoint-specific web/default-turn policies.
- The selected preset object remains inside captured `config.Presets`; engine resolution by `settings.presetId` therefore sees the captured prompt, tool list, and defaults even if the live preset is edited or deleted.
- Pass captured config, effective model snapshot, root, images, web flag, and turn limit to execution. Apply the captured thinking flag where the operation already supports a per-run override; retain other modes' existing thinking policy from the captured config. Do not widen the engine's override policy. Remove post-wait selection and `readConfig()` calls used to reconstruct execution settings.
- Fresh session reads after waiting may check existence/deletion or build a REST response; they must not replace admitted execution inputs.
- Move intended preset/mode/root metadata writes to admission before waiting. Remove runner writes that save a stale full session after waiting and could overwrite another client's later selection. Response construction may read current metadata.
- Keep model readiness live. If the admitted model cannot run under the existing runtime coordinator, report admission/execution failure; never silently select a different model. This is not a runtime-coordinator redesign.
- Preserve the explicit mid-run repo-agent approval-mode update API. The captured approval is the starting mode; subsequent user decisions remain journaled policy changes.

The full config snapshot is in-process only. Existing restart recovery terminates orphaned runs instead of resuming them, so this fix needs no new durable config blob or journal migration. New continuations use newly selected settings.

## 3. Implementation tasks

### Task 1: Add durable submission identity and receipt storage

**Files**

- Modify: `packages/contracts/src/chat.ts`, `packages/contracts/src/index.ts`, `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`.
- Create: `src/state/chat-submissions.ts`, `src/state/schema-upgrades/chat-submissions.ts`, `tests/chat-submissions.test.ts`, `tests/runtime-db-schema-chat-submissions.test.ts`.
- Update affected schema/table expectations in `tests/runtime-db-schema.test.ts`, `tests/runtime-db-schema-stores.test.ts`, and `tests/assistant-backup-restore.test.ts`.

**Interfaces**

- Contracts: `ChatSubmissionIdSchema`; `ChatStreamSubmissionIdentitySchema = z.strictObject({ submissionId: ChatSubmissionIdSchema, operationId: ChatOperationIdSchema })`; schema-derived identity type.
- State: `ChatSubmissionReceiptSchema` with `sessionId`, `submissionId`, `requestDigest` (64 lowercase hex characters), and `runOperationId`.
- `ChatSubmissionStore(database)` exposes `read(sessionId, submissionId): ChatSubmissionReceipt | null` and `insert(receipt): void`. Insert is new-entry-only: it validates the referenced run/session and refuses duplicate keys. Receipt replay uses `read`, not another insert. The caller owns the outer admission transaction; the store accepts no callbacks.
- `digestChatSubmission(operationKind, body: JsonObject): string` uses the canonical digest described above.

- [ ] Add failing storage/schema tests for lookup, identical identity, changed digest, cross-session run linkage, malformed rows, cascade deletion, and atomic rollback. Test a real schema-71 fixture and the existing 66-to-current upgrade chain.

```ts
assert.equal(receipts.read(sessionId, submissionId), null);
database.transaction(() => {
  const recorder = ChatRunRecorder.begin(database, start);
  receipts.insert({ sessionId, submissionId, requestDigest, runOperationId: recorder.operationId });
})();
assert.equal(receipts.read(sessionId, submissionId)?.runOperationId, start.operationId);
assert.throws(() => receipts.insert({ sessionId, submissionId, requestDigest: otherDigest,
  runOperationId: otherRun.operationId }));
```

Use `createTestChatSession`, `createTestChatRunRecorder`, and the existing schema fixtures to provide the session/run records. For rollback, throw inside the outer transaction after creating the run and before/after inserting its receipt, then assert neither remains.

- [ ] Run `npm run build:test`, then `node dist/test-runner/run-tests.js chat-submissions runtime-db-schema-chat-submissions`; confirm the new requirements fail before implementing them.
- [ ] Define the SQL above once as `CHAT_SUBMISSIONS_SCHEMA_SQL` and use it in idempotent bootstrap and the explicit 71-to-72 upgrade. The upgrade must reject an unexpected pre-existing receipt table in a schema-71 fixture rather than accepting an unknown shape. Set `CURRENT_SCHEMA_VERSION = 72`; keep the existing upgrade chain and journal version intact.
- [ ] Implement schema-validated receipt reads/writes and stable digest generation. Confirm stored digests contain no prompt/image body and reordering JSON object keys produces the same digest.
- [ ] Run the focused tests plus `runtime-db-schema`, `runtime-db-lifecycle`, and `assistant-backup-restore`. Verify exact table ownership and rollback, not only the schema marker.

**Acceptance:** A receipt links exactly one accepted logical submission to one run, survives reopen/backup, and cannot outlive deletion of its session/run. Existing historical runs remain readable without guessed receipts.

### Task 2: Make Web streaming admission idempotent

**Files**

- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts`, `src/status-server/routes/chat-operation-attach.ts`, `src/status-server/routes/chat.ts`, `src/status-server/routes/chat-repo-agent.ts`, `packages/contracts/src/chat.ts`, `dashboard/src/api.ts`, `dashboard/src/hooks/useChatSessions.ts`.
- Create: `tests/chat-submission-http.test.ts`.
- Update request fixtures/call sites in `tests/status-server-chat-routes.test.ts`, `tests/status-server-chat-stop.test.ts`, `tests/status-server-chat-repo-agent.test.ts`, `tests/helpers/dashboard-model-queue-harness.ts`, `tests/helpers/chat-recovery-process.ts`, `dashboard/tests/api-stream.test.ts`, and `dashboard/tests/hooks/useChatSessions.test.tsx`. Find and migrate every remaining streaming-POST fixture in this task; do not add a server default for a missing ID.

**Interfaces**

- All four streaming request schemas/API payload types include required `submissionId` and existing `operationId`, derived from the shared identity schema.
- Export `streamRecordedChatOperation(ctx, req, res, sessionId, runOperationId): void` from `routes/chat-operation-attach.ts`; both normal GET attach and receipt replay use it.
- Add a schema-validated 409 error discriminator `submission_conflict`. Preserve the distinct existing busy-session response.

- [ ] Add failing HTTP tests parameterized over all four operation modes. Repeat the exact body during execution and after completion; assert one execution run, one provider operation, and one user message. Use a mock repo-agent write with a counted effect to assert one effect across reconnect.

```ts
const body = { content: 'perform once', operationId: randomUUID(), submissionId: randomUUID() };
const first = await requestSse(streamUrl, { method: 'POST', body: JSON.stringify(body) });
const repeated = await requestSse(streamUrl, { method: 'POST', body: JSON.stringify(body) });
const firstView = readChatStream(first, sessionId).views.at(-1)?.snapshot;
const repeatedView = readChatStream(repeated, sessionId).views.at(-1)?.snapshot;
assert.ok(firstView);
assert.equal(repeatedView?.operationId, firstView.operationId);
assert.equal(journal.listSessionRuns(sessionId).filter(run => run.recordKind === 'execution').length, 1);
```

Build `streamUrl` from the existing `startHarness()` base URL and mode route; provide the existing mock planner responses/tool results for the chosen mode. Use `requestJson`/`requestSse` for HTTP fixture traffic, avoiding the known random-port restriction of Node `fetch`.

- [ ] Add rejection/race tests: same identity with changed content/images/options/mode; a different submission while busy; a queued original whose socket closes before headers; and same receipt after another run becomes current. The old receipt must return its own terminal projection.
- [ ] Preserve the existing control-ID reuse test by giving its two deliberate turns distinct submission IDs. Add a same-content/new-submission-ID test proving an intentional second turn still executes.
- [ ] Run `npm run build:test` and `node dist/test-runner/run-tests.js chat-submission-http status-server-chat-routes status-server-chat-repo-agent`; confirm failures at the new admission assertions.
- [ ] Implement the ordered lookup/admission transaction from section 2A. Receipt replay precedes mutable-root/image/preset and busy checks. New submissions still receive every normal validation and queue guard.
- [ ] Extract shared recorded-run streaming; ensure the selected broadcast belongs to the receipt's recorder, and terminal replay never executes the engine.
- [ ] Update dashboard payload construction and all fixtures to allocate one submission ID per deliberate submission. Do not add reconnection behavior until Task 3.
- [ ] Run the new HTTP tests, all `status-server-chat` tests, queue tests, contract tests, and dashboard API/hook tests. Test a failed run and restart replay as well as successful completion.

**Acceptance:** Repeating an accepted submission cannot create another run or effect; changing its payload fails explicitly. Existing Stop IDs, deliberate repeated turns, queue successors, and historical GET attach remain valid.

### Task 3: Recover owned submissions without restoring an ambiguous retry

**Files**

- Modify: `dashboard/src/api.ts`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/lib/chat-stream-transitions.ts`, `dashboard/src/lib/chat-session-runtime-store.ts`, `dashboard/src/lib/chat-session-state.ts`, `dashboard/src/tabs/ChatTab.tsx`.
- Test: `dashboard/tests/api-stream.test.ts`, `dashboard/tests/hooks/useChatSessions.test.tsx`, `dashboard/tests/chat-stream-transitions.test.ts`, `dashboard/tests/chat-session-runtime-store.test.ts`, `dashboard/tests/chat-tab.test.tsx`.

**Interfaces**

- Add schema-derived `ChatSubmissionPhase` and retain an immutable, discriminated request value for each owned submission; reuse the four request schemas, with an `operationKind` discriminator.
- Add an `interrupted` transition for an ambiguous connection failure. Keep `failure` for a valid server/projection failure and explicit rejection.
- API functions accept an optional `AbortSignal` for cancellation of a connection retry; their payload carries its stable submission identity.

- [ ] Restore the review reproduction in `useChatSessions.test.tsx`: reject the initial streaming POST after simulated server completion, drop the queue connection, reconnect it with an idle queue, and expose the saved final answer on receipt replay. Assert the recovered answer appears and the original prompt is not restored.
- [ ] Include a pre-existing completed turn in a second version of that test. Recovery must request the original submission rather than accepting an unrelated latest/previous run as its acknowledgement.

```ts
assert.ok(postBodies.length >= 2);
assert.equal(new Set(postBodies.map(body => body.submissionId)).size, 1);
assert.deepEqual(postBodies[1], postBodies[0]);
assert.equal(hook.result.current.selectedSession?.messages.at(-1)?.content, 'Executed successfully');
assert.equal(hook.result.current.runtimeStore.get(sessionId).draft, 'new unsent draft');
```

Extend the existing `ChatFetchFixture` to parse/capture submission identities and model receipt replay. Simulate both the lost POST response and a real queue-reader failure, and close its controllers correctly on teardown. Do not implement production reconnection in the fixture.

- [ ] Add branches for failure before admission, HTTP 400/404/busy/conflict, ambiguous HTTP 500, partial first transfer, active approval, failed terminal detail GET, session switching, unmount, and two simultaneous sessions. Advance the existing reconnect delay with deterministic test control or a bounded wait.
- [ ] Run the affected dashboard tests after `npm run build:test`; confirm the original lost-response case fails on current behavior.
- [ ] Retain and reconnect the same request via a direct mode switch. Release ownership only when that exact submission settles or is definitively rejected. Remove the `accepted`/queue-ID heuristic as the decision for whether an owned submission may recover.
- [ ] Apply `interrupted` without clearing submitted input/approval/readable messages or restoring the original prompt. Protect all reconnect/final-refresh cleanup with its submission identity so older callbacks cannot clear newer activity.
- [ ] Add runtime phase handling and UI action guards from section 2B. Keep drafts/new images intact; rejection restoration occurs once. Existing successful streaming may continue to accept queued steering.
- [ ] Run the complete dashboard suite and Task 2's HTTP tests. Confirm that projection failure and recovered crash-terminal state do not enter a provider-resubmission loop.

**Acceptance:** The exact review reproduction passes. Connection retries retain one logical identity and one execution; the UI cannot present unresolved work as a fresh retry. Another session, a new draft, and a newer operation cannot be overwritten by stale callbacks.

### Task 4: Capture and consume admission settings across Web execution paths

**Files**

- Create: `src/status-server/chat-run-admission.ts`, `tests/chat-run-admission.test.ts`, `tests/chat-admission-settings-http.test.ts`.
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts`, `src/status-server/routes/chat.ts`, `src/status-server/routes/chat-repo-agent.ts`, `src/status-server/routes/chat-image-caption.ts`, `src/status-server/chat-repo-operation-runner.ts`, `src/status-server/chat-run-recorder.ts`, `src/status-server/chat-queue-successor.ts`, `src/status-server/chat.ts`.
- Test/update callers: `tests/chat-repo-operation-runner.test.ts`, `tests/helpers/chat-run-recorder.ts`, `tests/status-server-chat-routes.test.ts`, `tests/status-server-chat-repo-agent.test.ts`, `tests/chat-message-queue-force.test.ts`, `tests/chat-message-queue-delivery.test.ts`, `tests/helpers/dashboard-model-queue-harness.ts`.
- Inspect and adjust `src/status-server/routes/repo-agent.ts` only where its Web input plumbing needs the captured values; preserve its standalone CLI path.

**Interfaces**

- The schema, builder, and `ChatRunAdmission` type are defined in section 2C.
- `ChatSessionOperationRequest<TParsed>` gains `admission: ChatRunAdmission | null`; `requireChatRunAdmission(request: { admission: ChatRunAdmission | null }): ChatRunAdmission` validates presence.
- Replace each endpoint's `describeRun()` with a `describeAdmission()` returning `ChatRunAdmission | null`. Both direct and detached admission use it.
- Replace the separate execution `session`/`config` inputs in `ChatRepoOperationRequest` with `admission: ChatRunAdmission`; remove redundant content/images/root inputs when already owned by admission. Preserve engine service, recorder, logging, queue delivery, and abort dependencies. Narrow pure config/prompt helpers that currently require a full `ChatSession` to the metadata shape they consume; do not reconstruct dummy empty transcripts to satisfy those signatures.
- `ChatRunRecorder.begin()` receives the admission's existing `settings`, content, and admitted images. No journal shape changes are required.

- [ ] Add the failing runner regression: admit `plan`, change the session to a custom plan with different prompt/tools, then dispatch. Extend the current recording engine fixture and assert request preset/config/tools match admission.

```ts
assert.equal(engineRequest.presetId, admission.settings.presetId);
assert.equal(engineRequest.maxTurns, admission.settings.maxTurns ?? undefined);
assert.equal(engineRequest.webToolsEnabled, admission.settings.webSearchEnabled);
assert.equal(engineRequest.config?.Presets.find(preset => preset.id === engineRequest.presetId)?.promptPrefix,
  admission.config.Presets.find(preset => preset.id === admission.settings.presetId)?.promptPrefix);
```

- [ ] Add builder tests proving deep detachment: mutate the original config's nested preset/tool arrays, model settings, and session fields after building admission; captured values and derived journal settings must remain unchanged. Test invalid/missing preset/model/image settings and existing mode substitution/defaults.
- [ ] Add a real HTTP model-wait regression using `DashboardModelQueueHarness`: occupy its single slot, submit a plan, wait for `dashboard_plan_stream` to queue, update the session preset and config, release the holder, and inspect the recorded engine request and `run_started`.
- [ ] Cover changing a preset's contents under the same ID and deleting that preset from live config. Assert the waiting run retains its captured prompt/tools while the next new run uses current settings or rejects a missing preset explicitly.
- [ ] Add equivalent message/repo-search cases, Web repo-agent/condense coverage, and a detached-successor case. Test Stop/session deletion while waiting and verify no model dispatch after cancellation.
- [ ] Run `npm run build:test` and the new/affected test files to establish the failing settings mismatch before changing the execution path.
- [ ] Implement `buildChatRunAdmission()` using existing selector, config/session/model schemas, image admission, and `buildChatRunSettings()`. Remove `messages` before copying the session into the execution context; do not freeze history or duplicate retained image/tool payloads.
- [ ] Construct admission after body parsing from current state before any model wait. For new streamed submissions, commit the recorder and Task 1 receipt with these values. Repeated receipts bypass this builder entirely.
- [ ] Pass admission through direct, streaming, detached, and Web repo-agent runners. Remove execution-time preset selection, current-config replacement, and redundant re-resolution of admitted options. Continue reading history through the recorder at the existing boundaries.
- [ ] Move intended metadata writes to admission and remove post-wait full-session saves. Verify that another client's new title/preset/root survives completion of the older run. Keep current-state reads used for responses separate from execution inputs.
- [ ] Validate captured effective model/thinking/context inputs against engine requests and preserve live readiness failures and explicit approval-mode updates. Do not change model-loading policy to make a snapshot run.
- [ ] Run `chat-run-admission`, `chat-admission-settings-http`, `chat-repo-operation-runner`, `status-server-chat`, `chat-message-queue`, `repo-agent`, and `preset-unification-gate` tests. Search for and remove the old `ChatRunSubmission` type and obsolete post-wait selection paths.

**Acceptance:** Captured execution inputs and the journal agree across a real wait. Edits after admission affect subsequent operations without changing or being overwritten by the waiting run. The original CLI engine and approval behavior remain intact.

### Task 5: Prove combined recovery and release readiness

**Files**

- Modify/test: `tests/chat-submission-http.test.ts`, `tests/status-server-chat-crash-recovery.test.ts`, `tests/helpers/chat-recovery-process.ts`, `docs/web-chat-recovery.md`, and this plan's execution record.

- [ ] Add an integrated lost-response test using a real isolated server: close the original response after durable admission, repeat the same body, and assert one run/user message/provider operation and one counted mock side effect.
- [ ] Extend the existing child-process recovery fixture to repeat the same submission after a kill at submission, effect, result, and terminal barriers. Receipt replay must return recovered evidence without a new provider request or tool effect. Test crash-before-commit separately: the retry may create the first run, never a second one.
- [ ] Combine both fixes: admit while queued under preset A, lose the connection, change the live selection to B, and reconnect the original submission. Assert one run executed A; a new submission then executes B.
- [ ] Verify session deletion cascades receipts, backup includes them, and deleting an image/history row before receipt replay returns the revised projection without restoring deleted payloads.
- [ ] Update `docs/web-chat-recovery.md` with submission/control/run identity, receipt retention, immutable execution settings, explicit approval changes, retry semantics, and the schema-72 cutover. Record that historical receipts are not fabricated.
- [ ] Run the complete validation below. Record every failure and skipped/unverified live scenario; do not silently fix unrelated failures or weaken tests.
- [ ] Review the final diff against the two findings, remove obsolete paths and task scratch, and leave the changes uncommitted for user review.

**Acceptance:** Both findings are closed with reproductions, real HTTP coverage, crash coverage, and clean relevant/static checks. Production rollout remains a separate action.

## 4. Validation commands for implementation

Use one scratch directory for output and retain each command's exit status. Run commands separately; redirect large output and inspect its summary plus bounded failure extracts. Rebuild the test manifest after source/test changes. Do not edit source during a broad suite.

```powershell
$env:SIFTKIT_GUARD_RUNTIME_DATABASE = Join-Path (Get-Location) '.siftkit/runtime.sqlite'
npm run build:test
node dist/test-runner/run-tests.js chat-submission chat-run-admission chat-admission-settings-http chat-repo-operation-runner status-server-chat chat-message-queue runtime-db-schema contracts-chat
node dist/test-runner/run-tests.js --dashboard
npm test
npm run typecheck
npm run lint
npm run build
npm --prefix dashboard run build
git diff --check
```

`npm run typecheck` includes lint; still run the explicit lint command. Production frontend build currently emits the existing large-chunk warning; do not turn this work into a bundling refactor.

The preceding review's baseline was 4,010 backend passes, 5 skips, and one `fetch` failure caused by an ephemeral server listening on blocked port 5060; the affected five-test attach file passed on rerun. Dashboard had 485 passes; builds/typecheck/lint passed. These are historical results, not validation of this plan's future implementation.

## 5. Final acceptance matrix

| Scenario | Required result | Task |
| --- | --- | --- |
| Response lost before first snapshot; queue reconnects idle | Original result appears; no restored fresh retry of accepted work | 2, 3, 5 |
| Response lost before admission committed | Same submission can admit its first execution once | 2, 3, 5 |
| Repeat during wait/running/approval/terminal | Same durable run; one provider operation and counted effect | 2, 5 |
| Changed payload under same submission ID | Typed conflict; no new execution | 1, 2 |
| New submission reuses old control ID | A deliberate new run still works | 2 |
| Old receipt replay while newer run exists | Exact old projection; no attachment to newer broadcast | 2, 3 |
| Server restart after acceptance/effect/result | Receipt survives; recovery never repeats the effect | 5 |
| Reconnect/terminal-refresh failure with newer draft | Readable view and newer draft/images survive | 3 |
| Unmount/session switch/stale asynchronous callback | No orphan timer or cross-submission/session overwrite | 3 |
| Preset selection/content changes during model wait | Engine and journal use admitted preset/options | 4, 5 |
| Model readiness unavailable, Stop, or session deletion | Explicit failure/cancellation; no substituted dispatch | 4 |
| Next manual turn or queued successor | Fresh admission uses then-current settings | 4, 5 |
| Session metadata edited while waiting | Completion does not overwrite those edits | 4 |
| History/image deletion before receipt replay | Revised projection remains authoritative | 5 |
| Historical DB, upgrade rollback, cascade, backup | Data preserved; no guessed receipts; schema transition atomic | 1, 5 |

## 6. Execution status

**Plan only. No implementation has started.** All task checkboxes are intentionally unchecked. No source files, tests, database contents, or deployed services were changed while writing this document.
