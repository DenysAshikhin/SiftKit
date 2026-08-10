# Assistant Gate B completion handoff

Date: 2026-08-10  
Branch: `main`  
Base commit: `6435b95069fd66a6dcbaa2c88bd7bec7749d41a8`  
State: Gate B Tasks 21–26 are complete as uncommitted workspace changes.

## Outcome

Gate B now has the background job runner, deterministic bounded retrieval, strict preset opt-in,
the assistant composition root, status-server scheduling/preemption, chat retrieval and ingestion,
and end-to-end acceptance coverage.

The live dashboard uses the streaming chat endpoint. Final review found that the written Task 25
changes covered only the non-streaming route, so the same memory seam is now wired into both paths.
The streaming route retrieves before inference, injects the rendered block into the system prompt,
and ingests only the persisted final assistant answer after a successful turn.

## Main implementation anchors

- `src/assistant/jobs/job-runner.ts`: idle-only job claiming, recovery, retries, and interactive
  preemption.
- `src/assistant/domain/ranking.ts`, `src/assistant/retrieval/`: deterministic query intent,
  bounded graph retrieval, ranking, citation rendering, token budgeting, and projection usage.
- `src/assistant/assistant-service.ts`: one assistant composition root and the narrow
  `AssistantRuntime` host interface.
- `src/assistant/ingestion/candidate-promoter.ts`: stable owner-person resolution for user aliases.
- `packages/contracts/src/config.ts`, `src/preset-catalog.ts`, and dashboard settings files:
  required `assistantMemory`; built-in `chat` is on, other built-ins and new presets are off.
- `src/status-server/index.ts`, `server-ops.ts`, `assistant-idle-gate.ts`: fail-soft startup,
  periodic idle drain, shutdown cleanup, and request-time preemption.
- `src/status-server/chat-memory-seam.ts`, `chat.ts`, `routes/chat.ts`: opt-in-only retrieval and
  ingestion for streaming and non-streaming chat while preserving byte-identical prompts when no
  memory is present.

## Tests added

- `tests/assistant-job-runner.test.ts`
- `tests/assistant-retrieval.test.ts`
- `tests/assistant-preset-flag.test.ts`
- `tests/assistant-service.test.ts`
- `tests/assistant-chat-seam.test.ts`
- `tests/assistant-streaming-chat-memory.test.ts`
- `tests/assistant-gate-b-e2e.test.ts`

The streaming regression uses an injected `AssistantRuntime`, mock model responses, and a live HTTP
status server. It requires no assistant inference backend, GPU, or network service.

## Deliberate adaptations from the written plan

- Current `AssertionViewBuilder.build` accepts the assertion row directly; retrieval uses that API.
- `AssistantService` receives an explicit `TokenCounter`. Production passes
  `BackendTokenCounter`; tests pass `EstimateTokenCounter`, avoiding hidden backend access.
- Empty retrieval returns before token counting, so a miss performs no backend tokenizer request.
- The owner canonical key reuses `OWNER_PERSON_CANONICAL_KEY` from the existing schema source.
- Transactions use the current explicit transaction-manager scope API.
- The end-to-end query names `Bash` directly so the deterministic lexical retriever is tested
  without pretending it performs semantic synonym inference.
- End-to-end draining is bounded by a fixed number of passes.
- Both current chat transports are wired; this is required because the dashboard calls
  `/messages/stream`.

## Verification

Final commands run on the completed tree:

- `npm run typecheck`: passed all TypeScript projects; its embedded lint passed.
- `npm run lint`: passed independently.
- `npm run build:test`: passed.
- `npm test`: 2,807 tests; 2,805 passed; 0 failed; 2 skipped.
- `npm test -- assistant`: 287 passed; 0 failed.
- `npm test -- assistant-streaming-chat-memory`: 1 passed; 0 failed.
- `git diff --check`: passed before this handoff was added; rerun during closeout.

One earlier full-suite attempt, before the final streaming change, hit Windows process-cleanup
timing failures. Follow-up pressure testing reproduced two test-harness races: a 500 ms nested-run
budget could expire before its PID-file readiness signal, and managed-worker cleanup was sampled
before asynchronous Windows process exit completed. The tests now use separate startup, exit,
watchdog, and hard-limit ceilings and poll every managed PID to confirmed exit. The reproduced
eight-way and twelve-way pressure cases pass, as does the complete suite outside the sandbox.

## Workspace and continuation

- No commit was created, per repository instructions.
- This is the normal `main` checkout, not a worktree.
- Preserve these uncommitted Gate B changes when beginning Gate C.
- Gate C work is not started here; begin from its approved design/plan and keep Gate B behavior and
  acceptance tests green.
