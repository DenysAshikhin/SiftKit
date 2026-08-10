# Assistant Gate C completion handoff

Date: 2026-08-10  
Branch: `main`  
Base commit: `a9fc22b58cac658924fd756c65b9d80f59ebe856`  
State: Gate C Tasks 1–21 are complete as uncommitted workspace changes.

## Outcome

Gate C adds proactive question planning, explicit-answer ingestion, configurable background resource
policy, projection summarization, authenticated memory control surfaces, CLI commands, and dashboard
inspection/settings UI while preserving Gate B opt-in and disabled behavior.

The Assistant settings page includes:

- all Gate C configuration groups;
- a `Pending validation` view for `pending` and `needs_confirmation` proof candidates;
- durable user notes and audited `removed_by_user` queue removal without deleting evidence; and
- an unbounded `Memory history` view with simple added/changed/deleted descriptions, reasons, and
  linked proof references.

The dashboard Memory Inspector includes search across nodes/assertions/projections, bounded
neighborhood lists, metadata-only evidence display, confirm/correct/pin/demote actions, signed
forget preview/confirm, the current question, and question-policy controls. The bearer token is
bootstrapped once per component/controller lifecycle and kept only in memory.

## Main implementation anchors

- `packages/contracts/src/config.ts`, `packages/contracts/src/assistant.ts`: strict config and public
  Gate C DTO schemas.
- `src/assistant/questions/`: deterministic candidate/policy logic, text-only planning, scheduling,
  feedback, and explicit-answer ingestion.
- `src/assistant/control/`: query, audit-history, signed deletion preview, and memory mutation
  services.
- `src/assistant/jobs/`: explicit Gate C job branches, resource policy, configured priorities, and
  preemption.
- `src/status-server/routes/assistant.ts`, `assistant-auth.ts`, `assistant-rate-limiter.ts`: guarded
  loopback-only HTTP surface, bootstrap/bearer auth, limits, and ordinary 404s for later-gate routes.
- `src/cli/assistant-args.ts`, `src/cli/run-assistant.ts`: Gate C status, pause/resume, memory,
  policy, and projection commands.
- `dashboard/src/tabs/settings/AssistantSettings.tsx`: configuration, pending-proof validation, and
  memory history.
- `dashboard/src/tabs/AssistantTab.tsx`, `dashboard/src/hooks/useAssistantController.ts`: Memory
  Inspector and current-question UI.
- `dashboard/vite.config.ts`: development proxy for `/assistant`.

## Acceptance coverage

New focused coverage includes migration/config/contracts, resource policy, retrieval usage,
projection summarization, auth and transport guards, query/mutation services, question policy,
planner/scheduler/feedback, all job branches, CLI parsing/help, settings UI, Memory Inspector UI,
live dashboard API, and Gate C end-to-end workflows.

The Gate C E2E proves that an eligible question answer becomes `explicit_question_answer` memory,
refreshes projections, remains searchable/explainable/mutable, rejects a stale deletion preview,
and disappears after a fresh signed forget. It also proves disabled mode performs no work. Existing
focused tests cover every policy branch, preemption with unchanged attempt count, loopback/bearer
security, future-route absence, and text-only inference.

## Validation

Final commands on the completed tree:

- `npm run build:test`: passed.
- `npm test -- assistant`: 351 passed, 0 failed.
- `npm test`: 2,870 tests; 2,868 passed, 0 failed, 2 pre-existing skips.
- `npm run typecheck`: passed every TypeScript project and embedded ESLint.
- `npm run lint`: passed independently.
- `npm run build`: passed contracts, server/CLI, scripts, and dashboard production build.
- `git diff --check`: passed; only existing line-ending normalization warnings were reported.
- Direct Windows process-table and listener checks found no remaining fake launcher, test runner,
  status server, Vite server, or llama server.

The production dashboard build reports its existing large-chunk warning: the main minified bundle
is about 1 MB. This is a performance warning, not a build failure.

## Windows cleanup investigation

One full parallel run reproduced the previously documented timing pair: the managed-llama readiness
test exceeded a 1-second request deadline, and its nested cleanup watchdog observed two of three
launcher PIDs. Both tests passed immediately in isolation, including the path that deliberately
makes Windows `taskkill /T /F` fail so the fallback cleanup is exercised. A subsequent unchanged
default-concurrency full run passed all 2,870 tests. Direct OS inspection found zero survivors.

`terminateProcessTree` does use `taskkill /T /F` on Windows because a normal child signal does not
reap descendants; it falls back to `SIGTERM` when taskkill fails. No product or test timeout was
weakened during this investigation.

## Deliberate boundaries and Gate D decisions

No decision remains that blocks Gate C. Gate D still needs explicit choices for:

- OS-keychain integration and migration from the current local file key;
- native activity, idle, lock, fullscreen, do-not-disturb, and power providers;
- tray/popup delivery and how an eligible question is marked shown;
- screenshot/accessibility/OCR capture policy, exclusions, and retention enforcement; and
- a deliberate sensitive-evidence content-reveal preview flow.

Observation controls are present but do not claim capture is active. Evidence content is not loaded
by the Gate C dashboard.

## Workspace notes

- No commit was created.
- This is the normal `main` checkout; no worktree or subagent was used.
- SiftKit was not invoked during this session.
- The pre-existing repository-local `.siftkit/runtime.sqlite` contains old preset rows without the
  required Gate B `assistantMemory` field and therefore fails loudly on status-server startup, as
  designed. It was not modified or deleted. Browser verification used an isolated temp runtime;
  no browser instance was available, so final UI verification is component/E2E/build based.
