# Model Routing and Orchestration Implementation Plan

> **For agentic workers:** Execution is now authorized using `siftkit repo-agent` for defined task batches, with primary-agent review and validation. Use the applicable Superpowers execution workflow. Do not create worktrees or commit. Steps in the linked plans use checkboxes for tracking.

**Goal:** Add per-operation model selection, resident-model queue ordering, and an orchestrator that validates plans and supervises bounded worker tasks.

**Architecture:** Extend the existing runtime coordinator and request queue so execution always receives the admitted model snapshot. Build the orchestrator above that admission layer, releasing the parent model lease while children work. Reuse the existing engine, approvals, run evidence, and chat transport.

**Tech stack:** TypeScript, Zod, Node `node:test`, React, SQLite, existing EXL3/Tabby runtime.

**Spec:** [Design and decisions](../specs/2026-09-22-preset-model-routing-and-orchestration-design.md).

## Global constraints

- TypeScript throughout; parse IO with Zod and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, or schema-duplicating types.
- No worktrees; preserve unrelated changes.
- For this implementation session, the primary commits each independently verified task and starts every repo-agent dispatch from a clean Git working tree. Workers do not commit; controller artifacts stay in ignored scratch storage.
- Delegate review corrections and further implementation fixes to repo-agent with bounded findings and exact instructions. The primary owns review, independent validation, planning, and commits.
- Explicit versioned migrations; no runtime compatibility readers or silent invalid-reference fallback.
- Execute defined implementation tasks through `siftkit repo-agent` as newly requested; the primary agent owns planning, review, and validation. Follow the session's SiftKit-first discovery policy and wait for every invocation to finish.

## Confirmed behavior

| Setting or policy | Decision |
|---|---|
| Operation model default | Current model at operation admission, including existing chats |
| After automatic model switch | Keep the selected model active |
| Queue ordering | Oldest resident-model match; otherwise oldest request after active work drains |
| Fairness override | None; keep matching the resident model while matches exist |
| Orchestrator child cap | Configurable `maxSubagents`, default 1 |
| Shared-checkout concurrency | Serialize modifications; parallelize independent reads |
| Failed implementation | One redispatch with updated instructions; two implementation attempts total |
| Drift review | After each code-changing delegated step; confirmed impact or lasting code drift only |
| Drift correction | `repo-agent` receives scoped findings/fix bullets; no extra Markdown plan required |
| Drift correction budget | Two additional attempts per code-changing step; shared across findings/re-reviews |
| Task completion | Child result + independent verification + resolved drift + owned-artifact cleanup |

## Execution order

| Stage | Plan | Tasks | Gate |
|---|---|---|---|
| 1 | [Model routing and queue](2026-09-22-preset-model-routing.md) | M1–M7 | All routes use admitted snapshots; model-affinity tests pass |
| 2 | [Orchestrator preset](2026-09-22-orchestrator-preset.md) | O1–O8, including O5b | Plan validation, separate bounded implementation/correction attempts, critical drift gate, concurrency, lifecycle, and UI/CLI pass |

Implement sequentially in this checkout. The existing dirty chat/runtime files are inputs to the plan, not files to revert. Re-read the named anchors immediately before editing because other work is already present.

## Review focus

1. Different model requested while current requests remain active: no unload and no lock/transition deadlock — M3/M4.
2. Session snapshots, image preflight, or cached host settings substitute the old model — M5.
3. A later same-model request overtakes an older other-model request indefinitely — M4, deliberately accepted and tested.
4. Parent holds its model lease while waiting for a child — O3/O4, test with one model slot.
5. A cosmetic finding triggers churn, or retries/reattachment reset implementation or correction budgets — O2/O4/O5b/O8.

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

- Current plan: four documents checked for valid internal links, balanced code fences, unresolved placeholders, and policy consistency; 16 implementation tasks including the critical drift gate in O5b.
- Documented drift schemas and the correction-prompt function passed a strict TypeScript check and runtime smoke assertions, including empty findings and a correction payload with no plan reference.
- Original planning baseline: `npm run build:test` passed; `npm test -- preset- model-request-queue config- chat-operation settings-draft-editor dashboard-presets dashboard-settings` passed 300 tests, with 0 failures and 0 skipped. This suite was not repeated for the documentation amendment.
- `npm run typecheck` and `npm run lint`: passed again after the drift-review amendment.
- Existing implementation was not changed by this planning work. The new workflow tests and live-model drift-judgment calibration are not implemented or validated yet.
