# Prompt Cache Prefix Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder `PresetSystemPromptComposer` output so the large, repo-stable `systemContext` block leads the composed system prompt, so llama.cpp's `cache_prompt` KV prefix survives every per-request instruction change.

**Architecture:** One array literal in `src/preset-system-prompt.ts` changes order: `systemContext` moves from position 4 to position 1, `additionalPromptPrefix` moves from position 2 to position 4. No call site, signature, or public type changes — all five consumers inherit the new layout. The property is then locked by longest-common-prefix regression tests rather than by literal-layout assertions alone.

**Tech Stack:** TypeScript (strict, NodeNext), `node:test` + `node:assert/strict`, run through `tsx`.

---

## Background: why this ordering

llama.cpp prefix caching keeps a slot's KV up to the first token that differs and re-prefills everything after. The composed system prompt is a single linear token stream (`transcript-manager.ts:22-26` for repo-search; a single concatenated string for summary via `core-runner.ts:309-331`), so any volatile text placed above the `systemContext` block invalidates it.

Measured against this repo, `PresetSystemContextBuilder(repoRoot).build(summaryPreset).content` is **49,803 chars / 1,096 lines** (~14–16k tokens of path text; no `AGENTS.md` present). All five builtin presets set `includeAgentsMd: true` and `includeRepoFileListing: true`.

Today that block sits *below*:

- `additionalPromptPrefix` (per-request; HTTP-only, set at `src/status-server/routes/core.ts:911` and `:1024`)
- `baseSystemPrompt`, which for summary has **eight** per-request variance sites in `buildSummarySystemInstructions` (`src/summary/prompt.ts:165-204`): `phasePrompt` (line 1 of the block), `allowUnsupportedInput` ×2, `getSourceInstructions(sourceKind, commandExitCode)`, `profilePrompt`, `chunkRules`, `outputFormatPrompt`, `rawReviewPrompt`.

`rawReviewRequired` is derived from the *input text itself* (`src/summary/decision.ts:52-72`, error-line count and ratio), so a green vs. red test log flips it deterministically and re-prefills the entire listing.

Moving `systemContext` above the base block makes the reusable prefix ~16k tokens instead of ~10. The base block (~400-700 tokens) still re-prefills on variance; that residual was judged not worth splitting each builder into static/volatile halves.

`systemContext` goes to position **1**, above `presetPromptPrefix`, because:
- It matches the invariant this repo already states at `src/repo-search/prompts.ts:321-323` ("Stable content (file listing) leads and the volatile task trails").
- It matches Anthropic's long-context guidance (longform data at the top, instructions and query at the end).
- It lets two presets sharing a llama.cpp slot share the listing prefix. Four of five builtin presets have `promptPrefix: ''` (`src/preset-catalog.ts:32,50,85,104`) and `compose()` drops empty blocks via `.trim()` + `.filter(Boolean)`, so position 1 vs 2 is byte-identical output for `summary`, `repo-search`, `plan`, and `repo-agent`; it differs only for `chat` and custom presets.

## Verified non-impact (do not "fix" these)

- `extractPromptSection(prompt, 'Input:')` (`src/summary/prompt.ts:69-74`, consumed by `src/summary/mock.ts:17`) scans for the first `Input:\n` and terminates on the next `\n[A-Z][^\n]*:\n` or end-of-string. The input section stays last and contiguous; moving `systemContext` from below the base block to above it never lands between `Input:` and its terminator.
- `buildTaskSystemPrompt` / `buildAgentSystemPrompt` read only the boolean `context.hasRepoFileListing` and emit "A repository file listing is provided in this system message" — still true.
- `tests/repo-search-prompts.test.ts` makes no ordering assertions.
- `src/config/getters.ts:54` `getConfiguredPromptPrefix` is unused by any production prompt path but **is** live at `bench/repro/repro-fixture60-malformed-json.ts:366`. Leave it alone; it is out of scope.

## File Structure

**Create:**
- `tests/helpers/common-prefix.ts` — single exported pure function `longestCommonPrefixLength(left, right)`. Lives in `tests/helpers/` alongside the existing `empty-preset-system-context.ts` because two different test files consume it.

**Modify:**
- `src/preset-system-prompt.ts:10-15` — the composed array order, plus an invariant comment.
- `tests/preset-system-prompt.test.ts` — two stale expected-layout arrays; one new composer-level regression test.
- `tests/summary-prompt-composition.test.ts` — six stale `assertOrderedOnce` sentinel lists; two new builder-level regression tests.
- `tests/runtime-summarize.test.ts:704-718` — one stale `/^…/` anchor assertion.

---

### Task 1: Write the failing regression tests

**Files:**
- Create: `tests/helpers/common-prefix.ts`
- Test: `tests/preset-system-prompt.test.ts`
- Test: `tests/summary-prompt-composition.test.ts`

- [ ] **Step 1: Create the shared longest-common-prefix helper**

Create `tests/helpers/common-prefix.ts`:

```ts
// Prefix-cache regression tests assert that volatile prompt inputs never shorten the
// shared head of two composed prompts below the systemContext block, which is what
// llama.cpp's cache_prompt reuses.
export function longestCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}
```

- [ ] **Step 2: Add the composer-level regression test**

In `tests/preset-system-prompt.test.ts`, add this import directly below the existing `PresetSystemPromptComposer` import on line 4:

```ts
import { longestCommonPrefixLength } from './helpers/common-prefix.js';
```

Then append this test to the end of the file:

```ts
test('composer keeps the system context in the shared prefix when an additional prefix is added', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  const withoutAdditional = composer.compose('Base system prompt.');
  const withAdditional = composer.compose('Base system prompt.', 'Benchmark addition.');

  assert.ok(
    longestCommonPrefixLength(withoutAdditional, withAdditional) >= context.content.length,
    `additional prefix shortened the shared prefix to `
    + `${longestCommonPrefixLength(withoutAdditional, withAdditional)} chars; `
    + `system context is ${context.content.length} chars`,
  );
});
```

This guards every consumer of the composer, including `src/repo-search/execute.ts:357` and `src/status-server/chat-prompt-context.ts:47,64`, whose base prompts are otherwise frozen literals.

- [ ] **Step 3: Add the summary and planner builder regression tests**

In `tests/summary-prompt-composition.test.ts`, add these two imports below the existing import block (after line 20):

```ts
import { buildPlannerToolDefinitions } from '../src/summary/planner/tools.js';
import { longestCommonPrefixLength } from './helpers/common-prefix.js';
```

Then append the following to the end of the file. `SummaryPromptOptions` is derived from the builder rather than re-declared, matching the pattern already used at `bench/repro/summary-prompt-builder.ts:9`; `REPO_CONTEXT` uses a listing long enough that a shortened prefix is unambiguous.

```ts
type SummaryPromptOptions = Parameters<typeof buildSummaryPrompt>[0];
type PlannerPromptOptions = Parameters<typeof buildPlannerSystemPrompt>[0];

const REPO_CONTEXT: PresetSystemContext = {
  content: [
    '--- Repository file listing (respects ignore policy) ---',
    '',
    ...Array.from({ length: 200 }, (_unused, index) => `src/module-${index}.ts`),
  ].join('\n'),
  warnings: [],
  hasAgentsMd: false,
  hasRepoFileListing: true,
  loadedFiles: [],
};

function assertSharedPrefixCoversSystemContext(
  variants: readonly { label: string; prompt: string }[],
): void {
  for (const left of variants) {
    for (const right of variants) {
      const shared = longestCommonPrefixLength(left.prompt, right.prompt);
      assert.ok(
        shared >= REPO_CONTEXT.content.length,
        `${left.label} vs ${right.label}: shared prefix is ${shared} chars, `
        + `system context is ${REPO_CONTEXT.content.length} chars`,
      );
    }
  }
}

test('every volatile summary prompt input leaves the system context inside the shared prefix', () => {
  const baseOptions = {
    question: QUESTION,
    inputText: INPUT,
    format: 'text',
    policyProfile: 'general',
    rawReviewRequired: false,
    sourceKind: 'standalone',
    presetPromptPrefix: PRESET,
    additionalPromptPrefix: '',
    systemContext: REPO_CONTEXT,
  } satisfies SummaryPromptOptions;

  const variants: readonly { label: string; options: SummaryPromptOptions }[] = [
    { label: 'baseline', options: baseOptions },
    { label: 'merge phase', options: { ...baseOptions, phase: 'merge' } },
    { label: 'pass-fail profile', options: { ...baseOptions, policyProfile: 'pass-fail' } },
    { label: 'json format', options: { ...baseOptions, format: 'json' } },
    { label: 'raw review required', options: { ...baseOptions, rawReviewRequired: true } },
    { label: 'exit code 0', options: { ...baseOptions, sourceKind: 'command-output', commandExitCode: 0 } },
    { label: 'exit code 1', options: { ...baseOptions, sourceKind: 'command-output', commandExitCode: 1 } },
    { label: 'unsupported input disallowed', options: { ...baseOptions, allowUnsupportedInput: false } },
    {
      label: 'default chunk',
      options: {
        ...baseOptions,
        chunkContext: { isGeneratedChunk: true, mayBeTruncated: true, chunkPath: '1/2', retryMode: 'default' },
      },
    },
    {
      label: 'strict chunk retry',
      options: {
        ...baseOptions,
        chunkContext: { isGeneratedChunk: true, mayBeTruncated: true, chunkPath: '1/2', retryMode: 'strict' },
      },
    },
    { label: 'additional prefix', options: { ...baseOptions, additionalPromptPrefix: ADDITIONAL } },
  ];

  assertSharedPrefixCoversSystemContext(
    variants.map((variant) => ({ label: variant.label, prompt: buildSummaryPrompt(variant.options) })),
  );
});

test('every volatile planner prompt input leaves the system context inside the shared prefix', () => {
  const baseOptions = {
    presetPromptPrefix: PRESET,
    additionalPromptPrefix: '',
    systemContext: REPO_CONTEXT,
    sourceKind: 'standalone',
    rawReviewRequired: false,
    toolDefinitions: buildPlannerToolDefinitions(),
  } satisfies PlannerPromptOptions;

  const variants: readonly { label: string; options: PlannerPromptOptions }[] = [
    { label: 'baseline', options: baseOptions },
    { label: 'exit code 0', options: { ...baseOptions, sourceKind: 'command-output', commandExitCode: 0 } },
    { label: 'exit code 1', options: { ...baseOptions, sourceKind: 'command-output', commandExitCode: 1 } },
    { label: 'raw review required', options: { ...baseOptions, rawReviewRequired: true } },
    { label: 'reduced tools', options: { ...baseOptions, toolDefinitions: buildPlannerToolDefinitions(['find_text', 'read_lines']) } },
    { label: 'additional prefix', options: { ...baseOptions, additionalPromptPrefix: ADDITIONAL } },
  ];

  assertSharedPrefixCoversSystemContext(
    variants.map((variant) => ({ label: variant.label, prompt: buildPlannerSystemPrompt(variant.options) })),
  );
});
```

- [ ] **Step 4: Run the new tests and verify all three fail**

Run:

```bash
npx tsx --test tests/preset-system-prompt.test.ts tests/summary-prompt-composition.test.ts
```

Expected: the two pre-existing `preset-system-prompt` tests and the six pre-existing `summary-prompt-composition` tests still PASS. The three new tests FAIL, each with an `AssertionError [ERR_ASSERTION]` carrying the custom message. Shape of the failures (the exact character counts depend on the fixture strings — do not treat these numbers as expected values):

```
composer keeps the system context in the shared prefix when an additional prefix is added
  AssertionError [ERR_ASSERTION]: additional prefix shortened the shared prefix to <small> chars; system context is <large> chars
```

```
every volatile summary prompt input leaves the system context inside the shared prefix
  AssertionError [ERR_ASSERTION]: baseline vs merge phase: shared prefix is <small> chars, system context is <large> chars
```

In every case the reported shared prefix is a few tens of characters — the length of `PRESET_INSTRUCTIONS` plus a separator — against a system context in the thousands. Do not commit; the tree is red by design.

---

### Task 2: Reorder the composer

**Files:**
- Modify: `src/preset-system-prompt.ts:9-16`

- [ ] **Step 1: Replace the composed array**

Replace the body of `compose` in `src/preset-system-prompt.ts` so the file reads in full:

```ts
import type { PresetSystemContext } from './preset-system-context.js';

export class PresetSystemPromptComposer {
  constructor(
    private readonly presetPromptPrefix: string,
    private readonly systemContext: PresetSystemContext,
  ) {}

  // Ordered stable-to-volatile so llama.cpp's cache_prompt keeps the largest possible KV
  // prefix across runs: the repo context block is the bulk of the tokens and changes only
  // when the repository does, while the base instructions and the caller-supplied prefix
  // vary per request. Same invariant as buildTaskInitialUserPrompt in
  // repo-search/prompts.ts, applied one layer up.
  compose(baseSystemPrompt: string, additionalPromptPrefix: string = ''): string {
    return [
      this.systemContext.content,
      this.presetPromptPrefix.trim(),
      baseSystemPrompt.trim(),
      additionalPromptPrefix.trim(),
    ].filter(Boolean).join('\n\n');
  }
}
```

The signature is deliberately unchanged: parameter order no longer mirrors output order, which the parameter names already disambiguate, and a second base segment was ruled out of scope.

- [ ] **Step 2: Run the three new tests and verify they pass**

Run:

```bash
npx tsx --test tests/preset-system-prompt.test.ts tests/summary-prompt-composition.test.ts
```

Expected: the three tests added in Task 1 now PASS. Nine pre-existing assertions now FAIL because they encode the old layout — the two in `preset-system-prompt.test.ts` and the six `assertOrderedOnce` calls in `summary-prompt-composition.test.ts` (one test contains two of them). Failures read like:

```
summary prompt exposes separate instruction and input sections in exact order
  AssertionError [ERR_ASSERTION]: ADDITIONAL_INSTRUCTIONS is out of order
```

Task 3 repairs those. Do not commit yet.

---

### Task 3: Repair the stale layout assertions and gate the change

**Files:**
- Modify: `tests/preset-system-prompt.test.ts:14-39`
- Modify: `tests/summary-prompt-composition.test.ts:70,82,97,98,116,158-167`
- Modify: `tests/runtime-summarize.test.ts:704-718`

- [ ] **Step 1: Update the two composer layout tests**

In `tests/preset-system-prompt.test.ts`, replace both existing tests. The second test's name no longer describes what it asserts, so it is renamed:

```ts
test('composer includes the preset prefix exactly once', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.'),
    [
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
      'Preset instructions.',
      'Base system prompt.',
    ].join('\n\n'),
  );
});

test('composer places a genuine additional prefix last, below the system context', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.', 'Benchmark addition.'),
    [
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
      'Preset instructions.',
      'Base system prompt.',
      'Benchmark addition.',
    ].join('\n\n'),
  );
});
```

- [ ] **Step 2: Update the six `assertOrderedOnce` sentinel lists**

In `tests/summary-prompt-composition.test.ts`, make exactly these six replacements. Nothing else in those tests changes.

Line 70 (`summary prompt exposes separate instruction and input sections in exact order`):

```ts
  assertOrderedOnce(prompt, [STARTUP, PRESET, BASE, ADDITIONAL, QUESTION, INPUT]);
```

Line 82 (`compact summary prompt composes preset and startup context exactly once`):

```ts
  assertOrderedOnce(prompt, [STARTUP, PRESET, 'Summarize the input', ADDITIONAL, QUESTION, INPUT]);
```

Lines 97-98 (`chunk and merge summary prompts independently compose every section once`):

```ts
  assertOrderedOnce(chunkPrompt, [STARTUP, PRESET, BASE, ADDITIONAL, QUESTION, INPUT]);
  assertOrderedOnce(mergePrompt, [STARTUP, PRESET, 'You are merging', ADDITIONAL, QUESTION, INPUT]);
```

Line 116 (`planner summary request keeps composed system instructions before user input`):

```ts
  assertOrderedOnce(request, [STARTUP, PRESET, BASE, ADDITIONAL, QUESTION, INPUT]);
```

Lines 158-167 (`summary repro prompt uses configured preset instructions and startup context`). The three sentinels inside `systemContext.content` keep their relative order, because `PresetSystemContextBuilder.build` emits AGENTS.md, then the file listing, then autoloaded files (`src/preset-system-context.ts:37-51`):

```ts
    assertOrderedOnce(prompt, [
      'REPRO_AGENT_RULE',
      'Repository file listing',
      'REPRO_AUTOLOAD_RULE',
      'REPRO_PRESET_RULE',
      BASE,
      'REPRO_ADDITIONAL_RULE',
      QUESTION,
      INPUT,
    ]);
```

- [ ] **Step 3: Update the anchored assertion in the runtime summarize test**

`tests/runtime-summarize.test.ts:704-718` uses `createEmptyPresetSystemContext()` and `presetPromptPrefix: ''`, so both leading blocks are dropped by `filter(Boolean)` and the prompt now starts with the base instructions. Replace the whole test:

```ts
test('buildSummaryPrompt composes an additional prompt prefix when provided', () => {
  const prompt = buildSummaryPrompt({
    question: 'summarize this',
    inputText: 'hello world',
    format: 'text',
    policyProfile: 'general',
    rawReviewRequired: false,
    presetPromptPrefix: '',
    additionalPromptPrefix: 'Always answer in terse benchmark mode.',
    systemContext: createEmptyPresetSystemContext(),
  });

  const baseIndex = prompt.indexOf('You are SiftKit');
  const additionalIndex = prompt.indexOf('Always answer in terse benchmark mode.');
  const questionIndex = prompt.indexOf('Question:');

  assert.match(prompt, /^You are SiftKit/u);
  assert.ok(additionalIndex > baseIndex, 'additional prefix must follow the base instructions');
  assert.ok(questionIndex > additionalIndex, 'additional prefix must precede the input section');
});
```

- [ ] **Step 4: Run the three affected test files and verify they pass**

Run:

```bash
npx tsx --test tests/preset-system-prompt.test.ts tests/summary-prompt-composition.test.ts tests/runtime-summarize.test.ts
```

Expected: PASS, 0 failures. `tests/runtime-summarize.test.ts` spawns a stub server for its other cases and is slower than the first two; allow it to finish.

- [ ] **Step 5: Run the full suite**

Run:

```bash
npm test
```

Expected: PASS, 0 failures. This also runs `typecheck:test` and `build:test` first. If any test outside the three files above fails, it is an ordering assumption this plan did not find — read the assertion, confirm it is layout-related, and fix it the same way (stable blocks first, `additionalPromptPrefix` last). Do not weaken the new prefix-stability tests to accommodate it.

- [ ] **Step 6: Run typecheck and lint**

Run:

```bash
npm run typecheck
```

Expected: PASS. This covers `packages/contracts`, `src`, `scripts`, `dashboard`, `bench`, `tests`, `analysis`, and `eslint .`. `bench/repro/summary-prompt-builder.ts` forwards through `buildSummaryPrompt` unchanged and needs no edit; confirm it still typechecks rather than assuming it.

- [ ] **Step 7: Commit**

```bash
git add src/preset-system-prompt.ts tests/helpers/common-prefix.ts tests/preset-system-prompt.test.ts tests/summary-prompt-composition.test.ts tests/runtime-summarize.test.ts docs/superpowers/plans/2026-07-31-prompt-cache-prefix-ordering.md
git commit -m "$(cat <<'EOF'
perf: compose the preset system context ahead of all per-request prompt text

PresetSystemPromptComposer placed additionalPromptPrefix and the base
instructions above systemContext.content, so any per-request change
invalidated the llama.cpp cache_prompt KV prefix and re-prefilled the whole
repository file listing (49,803 chars / ~16k tokens in this repo).

The summary builder alone has eight variance sites above that block, and
rawReviewRequired is derived from the input text itself, so a green vs red
test log re-prefilled the listing every time.

Order is now systemContext, presetPromptPrefix, base instructions,
additionalPromptPrefix - stable to volatile, matching the invariant already
stated in repo-search/prompts.ts. Locked by longest-common-prefix regression
tests over every volatile summary and planner input.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Verification of the outcome

The change is a pure reordering: no information is added to or removed from any prompt, and no call site changes. The regression tests prove the caching property directly rather than by proxy.

Runtime confirmation is optional and requires a live llama.cpp backend. If you want it, run the same question twice through `siftkit summary` against inputs that flip `rawReviewRequired` (one clean log, one with 5+ error lines) and compare `prompt_cache_tokens` in the run record — it should now cover the listing on the second call instead of dropping to near zero.

## Explicitly out of scope

- Splitting `buildSummarySystemInstructions` (`src/summary/prompt.ts:165-204`) or `buildPlannerSystemPrompt` (`src/summary/planner/prompts.ts:84-128`) into static and volatile halves. Rejected: ~500 tokens of marginal prefill saved, against regrouping eight sites and separating section headers from the rules they qualify by 16k tokens.
- Removing `getConfiguredPromptPrefix` (`src/config/getters.ts:54`). It is live at `bench/repro/repro-fixture60-malformed-json.ts:366`.
- Changing llama.cpp slot allocation (`src/repo-search/engine/task-loop-support.ts:71-77`).
- Changing `PresetSystemContextBuilder` output, the repo file listing, or the ignore policy.
