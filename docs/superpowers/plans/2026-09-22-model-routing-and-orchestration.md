# Model Routing and Orchestration Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for task-by-task implementation when separately requested. Do not invoke SiftKit, create worktrees, or commit. Steps in the linked plans use checkboxes for tracking.

**Goal:** Add per-operation model selection, resident-model queue ordering, and an orchestrator that validates plans and supervises bounded worker tasks.

**Architecture:** Extend the existing runtime coordinator and request queue so execution always receives the admitted model snapshot. Build the orchestrator above that admission layer, releasing the parent model lease while children work. Reuse the existing engine, approvals, run evidence, and chat transport.

**Tech stack:** TypeScript, Zod, Node `node:test`, React, SQLite, existing EXL3/Tabby runtime.

**Spec:** [Design and decisions](../specs/2026-09-22-preset-model-routing-and-orchestration-design.md).

## Global constraints

- TypeScript throughout; parse IO with Zod and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, or schema-duplicating types.
- No worktrees; preserve unrelated changes; no commits without a separate request.
- Explicit versioned migrations; no runtime compatibility readers or silent invalid-reference fallback.
- Do not invoke SiftKit to execute this implementation plan. This is a planning-only request.

## Confirmed behavior

| Setting or policy | Decision |
|---|---|
| Operation model default | Current model at operation admission, including existing chats |
| After automatic model switch | Keep the selected model active |
| Queue ordering | Oldest resident-model match; otherwise oldest request after active work drains |
| Fairness override | None; keep matching the resident model while matches exist |
| Orchestrator child cap | Configurable `maxSubagents`, default 1 |
| Shared-checkout concurrency | Serialize modifications; parallelize independent reads |
| Failed task | One redispatch with updated instructions; two attempts total |
| Task completion | Child result + independent verification + owned-artifact cleanup |

## Execution order

| Stage | Plan | Tasks | Gate |
|---|---|---|---|
| 1 | [Model routing and queue](2026-09-22-preset-model-routing.md) | M1–M7 | All routes use admitted snapshots; model-affinity tests pass |
| 2 | [Orchestrator preset](2026-09-22-orchestrator-preset.md) | O1–O8 | Plan validation, bounded attempts, concurrency, lifecycle, and UI/CLI pass |

Implement sequentially in this checkout. The existing dirty chat/runtime files are inputs to the plan, not files to revert. Re-read the named anchors immediately before editing because other work is already present.

## Review focus

1. Different model requested while current requests remain active: no unload and no lock/transition deadlock — M3/M4.
2. Session snapshots, image preflight, or cached host settings substitute the old model — M5.
3. A later same-model request overtakes an older other-model request indefinitely — M4, deliberately accepted and tested.
4. Parent holds its model lease while waiting for a child — O3/O4, test with one model slot.
5. Retry, reconnect, or approval continuation dispatches a third attempt or loses user edits — O2/O4/O5/O8.

## Final verification

The plans contain focused red/green commands per task. After both plans are implemented, run:

```powershell
npm run build:test
npm test
npm run test:dashboard
npm run typecheck
npm run lint
```

Use the repository test runner and isolated fixtures. Do not load/unload the user's live models merely to validate tests. A real two-model smoke run is a separate explicit verification step once test-only acceptance passes.

Report failing commands and unverified runtime scope. A planning-only closeout verifies these documents and their repository anchors; it does not claim the proposed code exists or passes tests.

## Planning verification — 2026-09-22

- Four documents checked for valid internal links, balanced code fences, unresolved placeholders, and coverage of the confirmed policies; 15 implementation tasks.
- `npm run build:test`: passed.
- `npm test -- preset- model-request-queue config- chat-operation settings-draft-editor dashboard-presets dashboard-settings`: 300 passed, 0 failed, 0 skipped.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Existing implementation was not changed. These are current-tree baseline results; the new behavior and its proposed tests are not implemented or live-validated yet.
