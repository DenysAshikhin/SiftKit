# Formatron Boundary Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the canonical planner contract, isolate Formatron lowering to EXL3, reject synthesized repair nulls, and automate the real grammar regression.

**Architecture:** Canonical schema construction stays provider-neutral. `InferenceRequestBuilder` applies an EXL3-only lowering function. Planner parsing consumes the active tool schemas, retains parse provenance, and shares batch validation.

**Tech Stack:** TypeScript 5.9, `node:test`, Zod-derived JSON values, `jsonrepair`, TabbyAPI, Formatron, kbnf, Python.

## Global Constraints

- Follow strict red-green-refactor TDD.
- No casts, `any`, non-null assertions, namespace imports, shims, or legacy paths.
- Do not use worktrees or `siftkit`.
- Keep temporary diagnostics in one folder and remove them before completion.
- Canonical JSON Schema must retain optional properties and `minItems: 1`.
- Only EXL3 requests receive Formatron lowering.

---

### Task 1: Provenance-Aware Planner Parsing

**Files:**

- Modify: `tests/model-json.test.ts`
- Modify: `src/lib/model-json.ts`
- Modify parser call sites that supply active tool definitions.

**Interfaces:**

- Consumes: planner text and active tool definitions.
- Produces: strict/repaired parse provenance, schema-derived omission, and shared non-empty batch records.

- [ ] Add failing tests for repaired missing values, required/undeclared null retention, schema-optional null omission, safe repair, and both empty-batch parser paths.
- [ ] Run `npx tsx --test tests/model-json.test.ts` and confirm failures are behavioral.
- [ ] Implement provenance/null-synthesis detection, schema-derived optional fields, and shared batch validation.
- [ ] Update all parser call sites to pass the active tool definitions with no compatibility overload.
- [ ] Re-run the focused parser and affected loop tests until green.

### Task 2: Canonical Schema and EXL3 Lowering

**Files:**

- Modify: `tests/structured-output-schema.test.ts`
- Modify: `tests/inference-request-builder.test.ts`
- Modify: `src/providers/structured-output-schema.ts`
- Create: `src/providers/formatron-schema-lowering.ts`
- Modify: `src/llm-protocol/inference-request-builder.ts`

**Interfaces:**

- Consumes: canonical `LlamaCppResponseFormat` and backend identity.
- Produces: unchanged llama format or EXL3-lowered format.

- [ ] Replace global-normalization assertions with failing canonical-schema assertions.
- [ ] Add failing request-builder tests proving llama pass-through and EXL3-only optional/minItems lowering.
- [ ] Run both focused test files and confirm the expected failures.
- [ ] Restore canonical schema construction and implement the focused recursive lowering class.
- [ ] Apply lowering in `InferenceRequestBuilder` only for backend `exl3`.
- [ ] Re-run focused tests until green.

### Task 3: Gated Formatron Integration

**Files:**

- Create: `tests/formatron-planner-schema.integration.test.ts`
- Create: `tests/fixtures/formatron-planner-schema.py`
- Modify: `package.json`

**Interfaces:**

- Consumes: EXL3-lowered repo-search planner schema over stdin plus configured Python/Tabby/model paths.
- Produces: compile timing and accepted/rejected corpus verdicts as JSON.

- [ ] Add the gated Node test and Python harness; first run must fail when explicitly configured against the current canonical-only schema.
- [ ] Route the harness schema through the EXL3 lowering API and verify the configured run passes.
- [ ] Add a dedicated `test:formatron` script while keeping the normal suite safely gated.

### Task 4: Verification

**Files:** No new production changes.

- [ ] Run focused parser/schema/request-builder tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:coverage` and inspect touched-file branch coverage.
- [ ] Run `npm run build` and `git diff --check`.
- [ ] Confirm no temporary files remain and review the final diff.
