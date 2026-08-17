# Remove Grep-Between-Rereads Prompt Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "Two reads of the same file must have a grep search between them" rule from the repo-search planner system prompt, and the test assertion that pins it.

**Architecture:** The rule exists only as prompt text (`src/repo-search/prompts.ts:245`) — there is no code enforcement. Runtime guards already cover the rule's intent: duplicate screening (`rejectAsDuplicate`), `screenExhaustedRead` (reads with no unread content are rejected), and auto-skip of already-read lines. Session evidence (session `5a9975ad…`, 2026-08-16) shows the model spending thinking tokens on compliance bookkeeping and satisfying the rule with a grep of an *unrelated* file, so the text delivers cost without benefit. This is a pure deletion: prompt line + its exact-match test assertion.

**Tech Stack:** TypeScript, node:test.

**Test commands:** Targeted: `npm run build:test; node .\dist\test-runner\run-tests.js repo-search-prompts`. Full: `npm test`, then `npm run typecheck` (includes lint).

---

## File Structure

- Modify: `src/repo-search/prompts.ts:245` — delete one array element.
- Modify: `tests/repo-search-prompts.test.ts:183` — delete one assertion.

---

### Task 1: Delete the rule from the prompt and its pinned assertion

**Files:**
- Modify: `src/repo-search/prompts.ts:241-245`
- Modify: `tests/repo-search-prompts.test.ts:175-186`

The TDD shape here is inverted-by-necessity: the behavior change *is* the removal, so the test change comes first and the prompt edit makes it coherent. The pinning test currently asserts the exact sentence (`tests/repo-search-prompts.test.ts:183` inside `buildTaskSystemPrompt includes anti-loop and larger single-file read guidance`), so it will fail the moment the prompt line is removed — that is the regression signal we rely on.

- [ ] **Step 1: Add a failing negative assertion**

In `tests/repo-search-prompts.test.ts`, inside the test `buildTaskSystemPrompt includes anti-loop and larger single-file read guidance` (line 175), replace the line:

```ts
    assert.match(prompt, /Two reads of the same file must have a grep search between them/u);
```

with:

```ts
    assert.doesNotMatch(prompt, /Two reads of the same file/u);
```

Leave every other assertion in that test untouched (`Anchor-before-read`, `` `read` ``, `one large window per anchor|larger window`, `never tiny|tiny-slice`, `strengthen the anchor`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js repo-search-prompts`
Expected: FAIL — `assert.doesNotMatch` trips because the prompt still contains the sentence.

- [ ] **Step 3: Delete the prompt line**

In `src/repo-search/prompts.ts`, the `Anchor-before-read:` block (lines 241-245) currently reads:

```ts
    'Anchor-before-read:',
    '- ≥3 of your first 5 calls MUST be grep keyword searches; no file reads or list calls until you have anchors.',
    '- Turn 1: pick 5 keywords from the task and grep `"k1|k2|k3|k4|k5"` with no path (searches from the repo root; the ignore policy filters noise). If empty, reformulate before drilling.',
    '- Files >500 lines: run a file-scoped grep anchor first.',
    '- Two reads of the same file must have a grep search between them.',
```

Delete the last element so it becomes:

```ts
    'Anchor-before-read:',
    '- ≥3 of your first 5 calls MUST be grep keyword searches; no file reads or list calls until you have anchors.',
    '- Turn 1: pick 5 keywords from the task and grep `"k1|k2|k3|k4|k5"` with no path (searches from the repo root; the ignore policy filters noise). If empty, reformulate before drilling.',
    '- Files >500 lines: run a file-scoped grep anchor first.',
```

- [ ] **Step 4: Run the prompt suite to verify it passes**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js repo-search-prompts`
Expected: PASS — the negative assertion holds, and the compression-preservation test (`buildTaskSystemPrompt preserves load-bearing planner rules after compression`, line 92) stays green because it never asserted this sentence (it pins `3 of your first 5`, `5 keywords`, `500 lines`).

- [ ] **Step 5: Check for any other reference to the sentence**

Run: `rg -n "Two reads of the same file" --glob "!docs/superpowers/plans/**"`
Expected: no matches outside this plan document. If a match appears (docs, benchmarks, fixtures), remove or update it in the same commit — a stale reference to a deleted rule must not survive.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/prompts.ts tests/repo-search-prompts.test.ts
git commit -m "feat(repo-search): drop grep-between-rereads prompt rule"
```

---

### Task 2: Full verification

- [ ] **Step 1: Run the full suite, typecheck, and lint**

Run: `npm test`
Expected: PASS. Watch specifically for any loop/e2e test that fed mock responses relying on the old rule text — `tests/repo-search-loop.core.test.ts` and `tests/mock-repo-search-loop.test.ts` exercise loop behavior, not prompt wording, so they should be untouched; if one fails, read the failure before changing anything.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: Done**

No further commits expected.

---

## Self-Review Notes

- Deliberately **not** replacing the rule with a softer variant (e.g. "file-scoped grep"): current models re-anchor on their own, and the runtime already rejects exhausted reads (`screenExhaustedRead`, tool-action-processor.ts:702-719) and duplicate calls. Adding replacement text would recreate the compliance-bookkeeping cost this removal is meant to eliminate.
- The prompt token saving is trivial (~14 tokens); the real win is removing a rule the model demonstrably games (it inserted a grep of an unrelated file purely to "satisfy the requirement" — session `5a9975ad…` thinking trace, turns 7-9).
- `min 5 tool-call turns`, `>500 lines file-scoped anchor`, and batch guidance are untouched — only the one line goes.
