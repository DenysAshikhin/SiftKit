# Live Stream Drift Fixes Implementation Plan

> **For Codex:** Execute inline with TDD. Do not use agents, SiftKit, worktrees, or commits.

**Goal:** Remove all seven identified drift points from live narration and tool activity.

**Architecture:** Use one incremental content projection from provider through planner, split live and persisted message contracts, and make tool activity progress an explicit enforced budget.

**Tech Stack:** TypeScript, Zod, Node test runner, React Testing Library.

---

### Task 1: Replace incremental content classification

- [x] Add failing tests for incomplete and completed Markdown code containing tool markup and raw/safe response separation.
- [x] Implement parser-owned incremental projection and a typed normalized response.
- [x] Route mock and network responses through the same helper; make action parsing use raw text.
- [x] Run focused protocol/planner tests.

### Task 2: Split live and persisted chat contracts

- [x] Add failing contract tests proving narration is live-only.
- [x] Define inferred persisted/live schemas and migrate state/dashboard consumers.
- [x] Replace handwritten state and scorecard result types with schema-inferred types.
- [x] Run focused contract/state/status tests.

### Task 3: Correct activity ring lifecycle and progress

- [x] Add failing UI/stream tests for the empty live ring and truthful tool-call denominator.
- [x] Carry and enforce a tool-call limit through engine events, persistence, and dashboard models.
- [x] Render the ring for the whole pre-answer live assistant phase and keep the last three command rows.
- [x] Run focused engine/dashboard tests.

### Task 4: Verify and hand off

- [x] Review the complete diff and remove obsolete paths.
- [x] Run full tests, typecheck, lint, and build with summarized large output.
- [x] Leave changes uncommitted and report the existing history issue separately.
