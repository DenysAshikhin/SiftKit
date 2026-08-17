# ReasoningEffort Preset Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ReasoningEffort` preset field (`low` | `medium` | `xhigh`, default `xhigh`) that is delivered to the model as `chat_template_kwargs.reasoning_effort` and edited from a dropdown in the Reasoning section of the preset config.

**Architecture:** The field follows the exact path every other preset field already takes — contract schema, config defaults and normalization, `PresetRequestDefaults`, `InferenceRequestBuilder`, then the dashboard editor. No new layer, no new abstraction. Two exhaustive `satisfies Record<ModelPresetField, ...>` maps force every backend-availability decision to be stated, so a partial migration cannot pass typecheck.

**Tech Stack:** TypeScript, zod (`@siftkit/contracts`), React (dashboard), `node:test` + `node:assert/strict`, custom test runner at `dist/test-runner/run-tests.js`.

**Spec:** `docs/superpowers/specs/2026-08-17-reasoning-effort-preset-field-design.md`

---

## Repo conventions that apply to every task

**Do not commit.** This repo's policy is that commits happen only when the user asks. Each task therefore ends in a verification step, not a commit step. Leave the tree dirty and report status.

**Running tests.** Tests compile before they run. From the repo root:

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js <filename-substring>
```

The filter is a substring of the compiled test file's basename, so
`node .\dist\test-runner\run-tests.js inference-request-builder` runs
`tests/inference-request-builder.test.ts` only. Every test file in this plan lives in
`tests/` and belongs to the `node` suite, so none of them need the `--dashboard` flag.

**Typecheck.** `npm run typecheck` builds `packages/contracts` first, then typechecks src,
scripts, dashboard, tests, dashboard tests, bench, analysis, and finally runs `npm run lint`.
It is slow; run it at the task boundaries the plan names, not after every step. Route the
output through `siftkit summary` when it is large.

**Expected-failure discipline.** A TDD step that says "expect FAIL" must actually fail for
the stated reason. If it fails for a different reason, stop and fix that first — a test that
fails because of a typo proves nothing.

**Complete preset literals in tests.** Adding a required field breaks any test fixture that
builds a whole `ModelRuntimePreset` from a literal instead of spreading a default. Partial
overrides are unaffected. `npm run typecheck:test` names every offender; add
`ReasoningEffort: 'xhigh',` to each. Known candidates to check:
`tests/dashboard-managed-presets.test.ts:50`, `tests/status-server-chat.test.ts:81` and
`:822`, `tests/host-sync.test.ts:158` and `:178`,
`tests/mock-repo-search-loop.test.ts:2082`, `tests/model-preset-adapters.test.ts:388`,
`dashboard/tests/fixtures.ts`.

**Contracts rebuild.** `packages/contracts` is a separate TS project. After changing it, the
rest of the repo will not see the change until `tsc -b .\packages\contracts\tsconfig.json`
runs. `npm run build:test` and `npm run typecheck` both do this for you.

---

## File Structure

**Modified — contract and config (the source of truth):**
- `packages/contracts/src/config.ts` — `ReasoningEffortSchema`, the preset field, the field-name enum
- `src/config/defaults.ts` — default value `xhigh`
- `src/config/normalization.ts` — `getReasoningEffort` resolver + wiring into `resolveManagedLlamaSettings`
- `src/config/host-sync.ts` — pass-through hosts own the field

**Modified — request path:**
- `src/inference-presets/preset-compatibility.ts` — `PresetRequestDefaults.reasoningEffort`, availability `both`
- `src/llm-protocol/types.ts` — `LlamaCppChatTemplateKwargs.reasoning_effort`
- `src/llm-protocol/inference-backend.ts` — `InferenceThinkingPolicy.effort`
- `src/llm-protocol/inference-request-builder.ts` — emit the kwarg
- `src/llm-protocol/llama-cpp-client.ts` — supply it from the active preset
- `src/status-server/routes/inference-passthrough.ts` — same, for proxied callers

**Modified — token accounting (reserve shapes, not wire requests):**
- `src/repo-search/planner-protocol.ts` — planner prompt reserve
- `src/status-server/chat.ts` — provider overhead estimate

**Modified — dashboard:**
- `dashboard/src/settings-draft-editor.ts` — action variant + setter + reset-on-off
- `dashboard/src/settings-action-groups.ts` — `setReasoningEffort` on the actions interface
- `dashboard/src/hooks/useSettingsController.ts` — the action implementation
- `dashboard/src/tabs/settings/ModelPresetsSection.tsx` — the dropdown
- `dashboard/src/settings-sections.ts` — help text
- `dashboard/src/tabs/settings/model-preset-groups.ts` — group summary

**Modified — tests:**
`tests/contracts-config.test.ts`, `tests/config-normalization.test.ts`,
`tests/model-preset-adapters.test.ts`, `tests/inference-request-builder.test.ts`,
`tests/inference-passthrough-status-server.test.ts`, `tests/host-sync.test.ts`,
`tests/settings-draft-editor.test.ts`, `tests/dashboard-model-presets-section.test.ts`

**Not touched:** the stale preset id `exl3-3-6-27b-2`, `ReasoningBudget` (stays llama-only),
`.siftkit/runtime.sqlite` (no migration — see Task 2).

---

## Task 1: Contract — the enum and the preset field

**Files:**
- Modify: `packages/contracts/src/config.ts:15`, `:67`, `:84`
- Test: `tests/contracts-config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/contracts-config.test.ts`:

```ts
test('ReasoningEffortSchema accepts the three levels this template distinguishes', () => {
  assert.equal(ReasoningEffortSchema.safeParse('low').success, true);
  assert.equal(ReasoningEffortSchema.safeParse('medium').success, true);
  assert.equal(ReasoningEffortSchema.safeParse('xhigh').success, true);
  // 'high' is a dead alias for 'xhigh' in the Qwen3.8 template; offering it would lie.
  assert.equal(ReasoningEffortSchema.safeParse('high').success, false);
  assert.equal(ReasoningEffortSchema.safeParse('').success, false);
});

test('ModelRuntimePresetSchema requires ReasoningEffort on every preset', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const { ReasoningEffort: _ReasoningEffort, ...withoutEffort } = preset;
  assert.equal(ModelRuntimePresetSchema.safeParse(withoutEffort).success, false);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, ReasoningEffort: 'low' }).success, true);
  assert.equal(ModelRuntimePresetSchema.safeParse({ ...preset, ReasoningEffort: 'high' }).success, false);
});

test('ReasoningEffort is an editable model preset field', () => {
  assert.equal(ModelPresetFieldSchema.safeParse('ReasoningEffort').success, true);
});
```

Add `ModelPresetFieldSchema` and `ReasoningEffortSchema` to the existing
`@siftkit/contracts` import block at the top of the file (it already imports
`ModelRuntimePresetSchema` at line 10).

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js contracts-config
```

Expected: build fails — `ReasoningEffortSchema` is not exported from `@siftkit/contracts`.

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/config.ts`, directly below `const ReasoningSchema = z.enum(['on', 'off']);` (line 15):

```ts
/**
 * Reasoning depth passed to the chat template as `reasoning_effort`. The Qwen3.8 template
 * collapses `high` into `xhigh`, so only the three levels it actually distinguishes are offered.
 */
export const ReasoningEffortSchema = z.enum(['low', 'medium', 'xhigh']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
```

- [ ] **Step 4: Add the field to the preset shape**

In the same file, replace line 67:

```ts
  Reasoning: ReasoningSchema, ReasoningContent: z.boolean(),
```

with:

```ts
  Reasoning: ReasoningSchema, ReasoningEffort: ReasoningEffortSchema, ReasoningContent: z.boolean(),
```

- [ ] **Step 5: Add the field name to the editable-field enum**

In the same file, replace line 84:

```ts
  'RepetitionPenalty', 'Reasoning', 'ReasoningContent', 'PreserveThinking', 'MaintainPerStepThinking',
```

with:

```ts
  'RepetitionPenalty', 'Reasoning', 'ReasoningEffort', 'ReasoningContent', 'PreserveThinking',
  'MaintainPerStepThinking',
```

- [ ] **Step 6: Run the test again**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js contracts-config
```

Expected: still FAILS, now inside `getDefaultConfigObject()` — the default preset has no
`ReasoningEffort`, so `ModelRuntimePresetSchema` rejects it. That is Task 2. Do not patch
the test to work around this; move on.

---

## Task 2: Config default and normalization

The five presets stored in `.siftkit/runtime.sqlite` do not carry this key.
`resolveManagedLlamaSettings` fills every field from `getDefaultModelPreset()` when the
stored record omits it, so adding a default is the whole migration — there is no sqlite
migration to write. The unknown-field guard at `normalization.ts:446` rejects *removed*
fields, not added ones, so existing rows keep loading.

**Files:**
- Modify: `src/config/defaults.ts:128` area
- Modify: `src/config/normalization.ts:388` area (new helper), `:537` area (wiring)
- Test: `tests/config-normalization.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/config-normalization.test.ts`, adjusting the import of
`normalizeModelRuntimePresetRecord` and `getDefaultConfigObject` to match the file's
existing import style:

```ts
test('a stored preset without ReasoningEffort defaults to xhigh', () => {
  const preset = normalizeModelRuntimePresetRecord(
    { id: 'legacy', label: 'Legacy', Backend: 'exl3', Reasoning: 'on' },
    'legacy',
    'Legacy',
  );

  assert.equal(preset.ReasoningEffort, 'xhigh');
});

test('a stored preset keeps a valid ReasoningEffort and falls back on an invalid one', () => {
  const low = normalizeModelRuntimePresetRecord(
    { id: 'low', label: 'Low', Backend: 'exl3', Reasoning: 'on', ReasoningEffort: 'low' },
    'low',
    'Low',
  );
  assert.equal(low.ReasoningEffort, 'low');

  const medium = normalizeModelRuntimePresetRecord(
    { id: 'medium', label: 'Medium', Backend: 'exl3', Reasoning: 'on', ReasoningEffort: 'medium' },
    'medium',
    'Medium',
  );
  assert.equal(medium.ReasoningEffort, 'medium');

  // 'high' is not a level this template distinguishes, so it normalizes rather than throwing,
  // matching how KvCacheQuantization and SpeculativeType treat unrecognized values.
  const bogus = normalizeModelRuntimePresetRecord(
    { id: 'bogus', label: 'Bogus', Backend: 'exl3', Reasoning: 'on', ReasoningEffort: 'high' },
    'bogus',
    'Bogus',
  );
  assert.equal(bogus.ReasoningEffort, 'xhigh');
});

test('the default model preset ships ReasoningEffort xhigh', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  assert.equal(preset.ReasoningEffort, 'xhigh');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js config-normalization
```

Expected: FAIL — `ReasoningEffort` is `undefined` on the normalized presets.

- [ ] **Step 3: Add the default**

In `src/config/defaults.ts`, replace:

```ts
    Reasoning: 'off' as const,
    ReasoningContent: false,
```

with:

```ts
    Reasoning: 'off' as const,
    ReasoningEffort: 'xhigh' as const,
    ReasoningContent: false,
```

- [ ] **Step 4: Add the normalization helper**

In `src/config/normalization.ts`, directly above `function getManagedKvCacheQuantization` (line 388):

```ts
function getReasoningEffort(value: JsonValue, fallback: ReasoningEffort): ReasoningEffort {
  const normalized = getNullableTrimmedString(value);
  if (normalized === 'low' || normalized === 'medium' || normalized === 'xhigh') {
    return normalized;
  }
  return fallback;
}
```

Add `ReasoningEffort` to the existing `@siftkit/contracts` type import block in this file.

- [ ] **Step 5: Wire it into the settings resolver**

In `resolveManagedLlamaSettings`, replace:

```ts
    Reasoning: reasoning === 'on' || reasoning === 'off'
      ? reasoning
      : defaults.Reasoning || 'off',
    ReasoningContent: reasoningContentEnabled,
```

with:

```ts
    Reasoning: reasoning === 'on' || reasoning === 'off'
      ? reasoning
      : defaults.Reasoning || 'off',
    ReasoningEffort: getReasoningEffort(input.ReasoningEffort, defaults.ReasoningEffort ?? 'xhigh'),
    ReasoningContent: reasoningContentEnabled,
```

Unlike `ReasoningContent`, effort is **not** zeroed when reasoning is off. The value is
inert while thinking is off and must survive a round trip through the toggle, so the user
does not silently lose their choice.

- [ ] **Step 6: Run both test files**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js config-normalization
node .\dist\test-runner\run-tests.js contracts-config
```

Expected: both PASS. Task 1's tests now pass too, because the default preset carries the field.

---

## Task 3: Preset request defaults and backend availability

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:17-46`, `:114` area
- Test: `tests/model-preset-adapters.test.ts:302` area

- [ ] **Step 1: Write the failing test**

Append to `tests/model-preset-adapters.test.ts`:

```ts
test('buildPresetRequestDefaults carries the preset reasoning effort', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');

  assert.equal(buildPresetRequestDefaults(preset).reasoningEffort, 'xhigh');
  assert.equal(buildPresetRequestDefaults({ ...preset, ReasoningEffort: 'low' }).reasoningEffort, 'low');
});
```

Reuse the file's existing imports of `buildPresetRequestDefaults` and `getDefaultConfigObject`;
add whichever is missing.

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js model-preset-adapters
```

Expected: build fails — `reasoningEffort` is not on `PresetRequestDefaults`. The field-support
matrix at line 302 also fails to compile, because `PRESET_FIELD_SUPPORT` is
`satisfies Record<ModelPresetField, ...>` and `ReasoningEffort` is now a `ModelPresetField`.
Both are expected.

- [ ] **Step 3: Add the field to the defaults schema and mapper**

In `src/inference-presets/preset-compatibility.ts`, replace:

```ts
  reasoning: z.enum(['on', 'off']),
  reasoningContent: z.boolean(),
```

with:

```ts
  reasoning: z.enum(['on', 'off']),
  reasoningEffort: ReasoningEffortSchema,
  reasoningContent: z.boolean(),
```

and replace:

```ts
    reasoning: preset.Reasoning,
    reasoningContent: preset.ReasoningContent,
```

with:

```ts
    reasoning: preset.Reasoning,
    reasoningEffort: preset.ReasoningEffort,
    reasoningContent: preset.ReasoningContent,
```

Add `ReasoningEffortSchema` to this file's `@siftkit/contracts` import. It is a value import,
not a type import, so it goes in the value import statement.

- [ ] **Step 4: Declare backend availability**

In the same file, replace:

```ts
  Reasoning: 'both',
  ReasoningContent: 'both',
```

with:

```ts
  Reasoning: 'both',
  ReasoningEffort: 'both',
  ReasoningContent: 'both',
```

`both`, not exl3-only: Jinja templates guard their variables with `is defined`, so a template
that does not read `reasoning_effort` ignores the extra kwarg. Hiding the field would make it
wrong the moment a GGUF ships a template that reads it.

- [ ] **Step 5: Update the test-side field matrix**

In `tests/model-preset-adapters.test.ts`, replace:

```ts
  Reasoning: ON_BOTH_BACKENDS,
  ReasoningContent: ON_BOTH_BACKENDS,
```

with:

```ts
  Reasoning: ON_BOTH_BACKENDS,
  ReasoningEffort: ON_BOTH_BACKENDS,
  ReasoningContent: ON_BOTH_BACKENDS,
```

Also add `reasoningEffort: preset.ReasoningEffort,` to the expected-defaults object near
line 371, beside the existing `maintainPerStepThinking: preset.MaintainPerStepThinking,`.

- [ ] **Step 6: Run the test**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js model-preset-adapters
```

Expected: PASS.

---

## Task 4: Emit `reasoning_effort` from the request builder

The template only reads effort when thinking is on (`chat_template.jinja:54`). Emitting it
with thinking off would be a kwarg that changes nothing while still perturbing prompt-prefix
reuse, so the builder gates it.

**Files:**
- Modify: `src/llm-protocol/types.ts:64-68`
- Modify: `src/llm-protocol/inference-backend.ts:10-14`
- Modify: `src/llm-protocol/inference-request-builder.ts:18-26`
- Test: `tests/inference-request-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/inference-request-builder.test.ts`:

```ts
test('thinking requests carry the preset reasoning effort', () => {
  for (const effort of ['low', 'medium', 'xhigh'] as const) {
    const request = new InferenceRequestBuilder().build({
      backend: 'exl3',
      model: '3.8_27b_4.6bpw',
      messages,
      tools: [],
      defaults: { ...defaults, reasoningEffort: effort },
      maxTokens: defaults.maxTokens,
      stream: false,
      thinking: { enabled: true, preserve: false, reasoningContent: false, effort },
      llama: { cachePrompt: true },
    });

    assert.deepEqual(request.chat_template_kwargs, { enable_thinking: true, reasoning_effort: effort });
  }
});

test('non-thinking requests omit reasoning effort because the template ignores it', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.8_27b_4.6bpw',
    messages,
    tools: [],
    defaults: { ...defaults, reasoningEffort: 'low' },
    maxTokens: defaults.maxTokens,
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false, effort: 'low' },
    llama: { cachePrompt: true },
  });

  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
});
```

Add `reasoningEffort: 'xhigh',` to the shared `defaults` object at the top of the file
(after `reasoning: 'off',`), and `effort: 'xhigh' as const,` to every existing
`thinking: { ... }` literal in the file so they keep compiling.

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js inference-request-builder
```

Expected: build fails — `effort` is not on `InferenceThinkingPolicy`.

- [ ] **Step 3: Widen the kwargs type**

In `src/llm-protocol/types.ts`, replace:

```ts
export type LlamaCppChatTemplateKwargs = {
  enable_thinking?: boolean;
  reasoning_content?: boolean;
  preserve_thinking?: boolean;
};
```

with:

```ts
export type LlamaCppChatTemplateKwargs = {
  enable_thinking?: boolean;
  reasoning_content?: boolean;
  preserve_thinking?: boolean;
  reasoning_effort?: ReasoningEffort;
};
```

Add `ReasoningEffort` to this file's `@siftkit/contracts` type import.

- [ ] **Step 4: Widen the thinking policy**

In `src/llm-protocol/inference-backend.ts`, replace:

```ts
export type InferenceThinkingPolicy = {
  enabled?: boolean;
  preserve: boolean;
  reasoningContent: boolean;
};
```

with:

```ts
export type InferenceThinkingPolicy = {
  enabled?: boolean;
  preserve: boolean;
  reasoningContent: boolean;
  /** Reasoning depth for the chat template; only sent when thinking is on. */
  effort: ReasoningEffort;
};
```

Add `ReasoningEffort` to this file's `@siftkit/contracts` type import.

- [ ] **Step 5: Emit the kwarg**

In `src/llm-protocol/inference-request-builder.ts`, replace:

```ts
            chat_template_kwargs: {
              enable_thinking: input.thinking.enabled,
              ...(compatibility.reasoningContent && input.thinking.reasoningContent ? { reasoning_content: true } : {}),
              ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
            },
```

with:

```ts
            chat_template_kwargs: {
              enable_thinking: input.thinking.enabled,
              ...(compatibility.reasoningContent && input.thinking.reasoningContent ? { reasoning_content: true } : {}),
              ...(input.thinking.preserve ? { preserve_thinking: true } : {}),
              // The template only reads effort while thinking is on, so sending it otherwise
              // would change nothing while still breaking prompt-prefix reuse.
              ...(input.thinking.enabled ? { reasoning_effort: input.thinking.effort } : {}),
            },
```

- [ ] **Step 6: Run the tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js inference-request-builder
```

Expected: PASS.

---

## Task 5: Supply the effort from the active preset

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:305-333`
- Test: `tests/llm-protocol.test.ts`

- [ ] **Step 1: Update the assertion this change breaks**

`tests/llm-protocol.test.ts:239` asserts the exact kwargs object, so it must grow the new
key. Replace:

```ts
  assert.deepEqual(body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
  });
```

with:

```ts
  assert.deepEqual(body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
    reasoning_effort: 'xhigh',
  });
```

The two `assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })` assertions
at `:339` and `:636` are correct as they stand — thinking is off there, so no effort is sent.

- [ ] **Step 2: Write the failing tests**

Append to `tests/llm-protocol.test.ts`. `buildProtocolConfig()` (`:192`) and
`CapturingHttpClient` already exist in this file:

```ts
test('chat requests send the active preset reasoning effort', async () => {
  const config = buildProtocolConfig();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('default config must include a managed llama preset');
  preset.ReasoningEffort = 'low';

  const http = new CapturingHttpClient();
  await new LlamaCppClient(http).chat({
    config,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: false,
    allowedToolNames: [],
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.deepEqual(body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
    reasoning_effort: 'low',
  });
});

test('chat requests omit reasoning effort when the preset has reasoning off', async () => {
  const config = buildProtocolConfig();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('default config must include a managed llama preset');
  preset.Reasoning = 'off';
  preset.ReasoningEffort = 'low';

  const http = new CapturingHttpClient();
  await new LlamaCppClient(http).chat({
    config,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: false,
    allowedToolNames: [],
  });

  const body = JSON.parse(String(http.requests[0]?.body || '{}'));
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol
```

Expected: FAIL — `reasoning_effort` is missing from the captured body in both the updated
`:239` assertion and the new `low` test.

- [ ] **Step 4: Pass the effort through**

In `src/llm-protocol/llama-cpp-client.ts`, replace:

```ts
        thinking: {
          ...(resolvedReasoning === undefined ? {} : { enabled: resolvedReasoning === 'on' }),
          reasoningContent: reasoningContentEnabled,
          preserve: preserveThinkingEnabled,
        },
```

with:

```ts
        thinking: {
          ...(resolvedReasoning === undefined ? {} : { enabled: resolvedReasoning === 'on' }),
          reasoningContent: reasoningContentEnabled,
          preserve: preserveThinkingEnabled,
          effort: defaults.reasoningEffort,
        },
```

- [ ] **Step 5: Run the tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol
```

Expected: PASS.

---

## Task 6: Pass-through route

`applyThinkingSettings` replaces a caller's `chat_template_kwargs` wholesale, because the
preset owns thinking policy. Effort joins that replacement.

**Files:**
- Modify: `src/status-server/routes/inference-passthrough.ts:74-83`
- Test: `tests/inference-passthrough-status-server.test.ts`

- [ ] **Step 1: Update the assertion this change breaks**

`tests/inference-passthrough-status-server.test.ts:459` asserts the exact kwargs object.
Replace:

```ts
    assert.deepEqual(forwarded.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_content: true,
      preserve_thinking: true,
    });
```

with:

```ts
    assert.deepEqual(forwarded.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_content: true,
      preserve_thinking: true,
      reasoning_effort: 'xhigh',
    });
```

The `{ enable_thinking: false }` assertion at `:434` is correct as it stands.

- [ ] **Step 2: Write the failing test**

Append to `tests/inference-passthrough-status-server.test.ts`. `withPassthroughChatServer`
(`:334`) takes preset field overrides and hands back a `postChat`; `readForwardedRequest`
(`:397`) reads what the upstream stub received:

```ts
test('chat passthrough replaces a caller reasoning effort with the preset one', async () => {
  await withPassthroughChatServer({
    Reasoning: 'on',
    ReasoningEffort: 'medium',
  }, async (postChat) => {
    const forwarded = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      // The preset owns thinking policy, so a caller cannot pick its own depth.
      chat_template_kwargs: { reasoning_effort: 'low' },
    }));
    assert.deepEqual(forwarded.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_effort: 'medium',
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js inference-passthrough-status-server
```

Expected: FAIL — the forwarded kwargs have no `reasoning_effort`, so the caller's `low`
is dropped rather than replaced by `medium`.

- [ ] **Step 4: Add the kwarg**

In `src/status-server/routes/inference-passthrough.ts`, replace:

```ts
  body.chat_template_kwargs = {
    enable_thinking: thinkingEnabled,
    ...(compatibility.reasoningContent && reasoningContent ? { reasoning_content: true } : {}),
    ...(reasoningContent && preset.PreserveThinking ? { preserve_thinking: true } : {}),
  };
```

with:

```ts
  body.chat_template_kwargs = {
    enable_thinking: thinkingEnabled,
    ...(compatibility.reasoningContent && reasoningContent ? { reasoning_content: true } : {}),
    ...(reasoningContent && preset.PreserveThinking ? { preserve_thinking: true } : {}),
    ...(thinkingEnabled ? { reasoning_effort: preset.ReasoningEffort } : {}),
  };
```

- [ ] **Step 5: Run the tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js inference-passthrough-status-server
node .\dist\test-runner\run-tests.js inference-passthrough-idle
```

Expected: both PASS.

---

## Task 7: Token-accounting reserve shapes

Neither of these builds a wire request; both estimate tokens for a rendered prompt. Because
effort changes the rendered system prompt (`chat_template.jinja:126-128, 146-148`), leaving
them alone makes the estimates drift and lets a prefix computed at one effort be reused at
another.

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:441-445`
- Modify: `src/status-server/chat.ts:209-213`, `:249-254` area
- Test: `tests/repo-search-request-normalizers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-search-request-normalizers.test.ts`:

```ts
test('the planner prompt reserve reflects the preset reasoning effort', () => {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  preset.Reasoning = 'on';
  preset.ReasoningEffort = 'low';

  const reserve = buildPlannerRequestPromptReserveText({
    config,
    model: '3.8_27b_4.6bpw',
    messageRoles: ['system', 'user'],
    maxTokens: 512,
    thinkingEnabled: true,
    reasoningContentEnabled: false,
    preserveThinking: false,
  });

  assert.match(reserve, /"reasoning_effort":"low"/u);
});
```

Add `buildPlannerRequestPromptReserveText` and `getDefaultConfigObject` to the file's imports.

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-search-request-normalizers
```

Expected: FAIL — the reserve text has no `reasoning_effort`.

- [ ] **Step 3: Add it to the planner reserve**

In `src/repo-search/planner-protocol.ts`, replace:

```ts
    chat_template_kwargs: {
      enable_thinking: Boolean(options.thinkingEnabled),
      ...(options.thinkingEnabled && options.reasoningContentEnabled ? { reasoning_content: true } : {}),
      ...(options.thinkingEnabled && options.reasoningContentEnabled && options.preserveThinking ? { preserve_thinking: true } : {}),
    },
```

with:

```ts
    chat_template_kwargs: {
      enable_thinking: Boolean(options.thinkingEnabled),
      ...(options.thinkingEnabled && options.reasoningContentEnabled ? { reasoning_content: true } : {}),
      ...(options.thinkingEnabled && options.reasoningContentEnabled && options.preserveThinking ? { preserve_thinking: true } : {}),
      ...(options.thinkingEnabled ? { reasoning_effort: samplerDefaults.reasoningEffort } : {}),
    },
```

`samplerDefaults` is already in scope in this function. Effort is preset-derived rather than
per-request, so `PlannerThinkingFlags` stays as it is — do not widen it.

- [ ] **Step 4: Add it to the chat overhead estimate**

In `src/status-server/chat.ts`, add beside `shouldPreserveThinking`:

```ts
function resolveReasoningEffort(config: SiftConfig): ReasoningEffort {
  return getActiveServerLlamaPreset(config)?.ReasoningEffort ?? 'xhigh';
}
```

and replace:

```ts
      chat_template_kwargs: {
        enable_thinking: thinkingEnabled,
        ...(thinkingEnabled && shouldReplayReasoningContent(config) ? { reasoning_content: true } : {}),
        ...(shouldPreserveThinking(config, thinkingEnabled) ? { preserve_thinking: true } : {}),
      },
```

with:

```ts
      chat_template_kwargs: {
        enable_thinking: thinkingEnabled,
        ...(thinkingEnabled && shouldReplayReasoningContent(config) ? { reasoning_content: true } : {}),
        ...(shouldPreserveThinking(config, thinkingEnabled) ? { preserve_thinking: true } : {}),
        ...(thinkingEnabled ? { reasoning_effort: resolveReasoningEffort(config) } : {}),
      },
```

Add `ReasoningEffort` to this file's `@siftkit/contracts` type import.

- [ ] **Step 5: Run the tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-search-request-normalizers
node .\dist\test-runner\run-tests.js status-server-chat
```

Expected: both PASS.

---

## Task 8: Host pass-through sync

**Files:**
- Modify: `src/config/host-sync.ts:23-25`, `:62-65`
- Test: `tests/host-sync.test.ts`

- [ ] **Step 1: Extend the existing overlay test**

`tests/host-sync.test.ts:140` — "applyHostLlamaRuntimeSettings overlays the host preset
request fields onto the local active preset" — already covers exactly this class of field.
Extend it rather than writing a parallel test.

In the **host** config's `presetFields`, add after `MaintainPerStepThinking: true,`:

```ts
      ReasoningEffort: 'medium',
```

In the **local** config's `presetFields`, add after `MaintainPerStepThinking: false,`:

```ts
        ReasoningEffort: 'xhigh',
```

In the assertion block, add after `assert.equal(preset.MaintainPerStepThinking, true);`:

```ts
    assert.equal(preset.ReasoningEffort, 'medium');
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js host-sync
```

Expected: FAIL — `preset.ReasoningEffort` is `xhigh`, because the local value survives when
the field is not host-owned.

- [ ] **Step 3: Add the field to the host-owned set**

In `src/config/host-sync.ts`, replace:

```ts
type HostPresetSettings = Pick<ModelRuntimePreset,
  'Model' | 'NumCtx' | 'Reasoning' | 'ReasoningContent' | 'PreserveThinking' | 'MaintainPerStepThinking'
  | 'MaxTokens' | 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty'>;
```

with:

```ts
type HostPresetSettings = Pick<ModelRuntimePreset,
  'Model' | 'NumCtx' | 'Reasoning' | 'ReasoningEffort' | 'ReasoningContent' | 'PreserveThinking'
  | 'MaintainPerStepThinking'
  | 'MaxTokens' | 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty'>;
```

- [ ] **Step 4: Copy it from the host preset**

In the same file, replace:

```ts
    ReasoningContent: hostPreset.ReasoningContent,
```

with:

```ts
    ReasoningEffort: hostPreset.ReasoningEffort,
    ReasoningContent: hostPreset.ReasoningContent,
```

- [ ] **Step 5: Run the test**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js host-sync
```

Expected: PASS.

- [ ] **Step 6: Checkpoint — the whole backend is wired**

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, error categories, and relevant file:line anchors."
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: typecheck clean, full suite green. Fix anything red before starting the dashboard.

---

## Task 9: Dashboard draft editor and controller action

**Files:**
- Modify: `dashboard/src/settings-draft-editor.ts:130` area, `:270` area, `:366-376`
- Modify: `dashboard/src/settings-action-groups.ts:90-91`
- Modify: `dashboard/src/hooks/useSettingsController.ts:340-347`
- Test: `tests/settings-draft-editor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/settings-draft-editor.test.ts`:

```ts
test('settings draft editor sets the model reasoning effort', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'set-model-reasoning', presetId: MANAGED_PRESET.id, value: 'on' });
  editor.apply({ type: 'set-model-reasoning-effort', presetId: MANAGED_PRESET.id, value: 'low' });

  const preset = editor.getConfig().Server.ModelPresets.Presets.find((entry) => entry.id === MANAGED_PRESET.id);
  assert.equal(preset?.ReasoningEffort, 'low');
});

test('turning reasoning off resets the effort to the template default', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'set-model-reasoning', presetId: MANAGED_PRESET.id, value: 'on' });
  editor.apply({ type: 'set-model-reasoning-effort', presetId: MANAGED_PRESET.id, value: 'low' });
  editor.apply({ type: 'set-model-reasoning', presetId: MANAGED_PRESET.id, value: 'off' });

  const preset = editor.getConfig().Server.ModelPresets.Presets.find((entry) => entry.id === MANAGED_PRESET.id);
  assert.equal(preset?.ReasoningEffort, 'xhigh');
});
```

If `dashboard/tests/fixtures.ts` builds its preset literals field-by-field rather than
spreading defaults, add `ReasoningEffort: 'xhigh',` to each preset literal there.

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js settings-draft-editor
```

Expected: build fails — `set-model-reasoning-effort` is not a known action type.

- [ ] **Step 3: Add the action variant**

In `dashboard/src/settings-draft-editor.ts`, replace:

```ts
  | { type: 'set-model-reasoning'; presetId: string; value: 'on' | 'off' }
```

with:

```ts
  | { type: 'set-model-reasoning'; presetId: string; value: 'on' | 'off' }
  | { type: 'set-model-reasoning-effort'; presetId: string; value: ReasoningEffort }
```

Add `ReasoningEffort` to this file's `@siftkit/contracts` type import.

- [ ] **Step 4: Handle the action**

In the same file's `apply` switch, replace:

```ts
      case 'set-model-reasoning':
        this.setModelReasoning(action.presetId, action.value);
        return;
```

with:

```ts
      case 'set-model-reasoning':
        this.setModelReasoning(action.presetId, action.value);
        return;
      case 'set-model-reasoning-effort':
        this.requireModelPreset(action.presetId).ReasoningEffort = action.value;
        return;
```

- [ ] **Step 5: Reset the effort when reasoning is turned off**

In the same file, replace:

```ts
    if (reasoning === 'off') {
      preset.ReasoningContent = false;
      preset.PreserveThinking = false;
      preset.MaintainPerStepThinking = false;
      return;
    }
```

with:

```ts
    if (reasoning === 'off') {
      preset.ReasoningEffort = 'xhigh';
      preset.ReasoningContent = false;
      preset.PreserveThinking = false;
      preset.MaintainPerStepThinking = false;
      return;
    }
```

This is the editor's deliberate reset on an explicit user toggle, which is different from
normalization (Task 2), where a stored value must survive load unchanged.

- [ ] **Step 6: Add the action to the interface and controller**

In `dashboard/src/settings-action-groups.ts`, replace:

```ts
  setReasoning(value: 'on' | 'off'): void;
  setReasoningContent(value: boolean): void;
```

with:

```ts
  setReasoning(value: 'on' | 'off'): void;
  setReasoningEffort(value: ReasoningEffort): void;
  setReasoningContent(value: boolean): void;
```

Add `ReasoningEffort` to that file's `@siftkit/contracts` type import.

In `dashboard/src/hooks/useSettingsController.ts`, replace:

```ts
    setReasoning(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-reasoning', presetId, value });
    },
```

with:

```ts
    setReasoning(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-reasoning', presetId, value });
    },
    setReasoningEffort(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-reasoning-effort', presetId, value });
    },
```

- [ ] **Step 7: Run the tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js settings-draft-editor
node .\dist\test-runner\run-tests.js dashboard-settings-actions-contract
node .\dist\test-runner\run-tests.js dashboard-settings-controller
```

Expected: all PASS. `dashboard-model-presets-section` will still fail to compile because its
`MODEL_PRESET_ACTIONS` literal is missing the new method; that is Task 10.

---

## Task 10: The dropdown

**Files:**
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx:312-322`
- Modify: `dashboard/src/settings-sections.ts:147` area
- Modify: `dashboard/src/tabs/settings/model-preset-groups.ts:37-40`
- Test: `tests/dashboard-model-presets-section.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/dashboard-model-presets-section.test.ts`, add `reasoning?: 'on' | 'off';` to
`PresetRenderOptions`, add `preset.Reasoning = options.reasoning ?? 'off';` to `renderPreset`
beside the other preset mutations, add `setReasoningEffort() {},` to `MODEL_PRESET_ACTIONS`,
and append:

```ts
test('the reasoning effort dropdown offers the three levels the template distinguishes', () => {
  const markup = renderPreset({ reasoning: 'on' });
  const field = getRenderedField(markup, 'Reasoning effort');

  assert.match(field, /<option value="low">low<\/option>/u);
  assert.match(field, /<option value="medium">medium<\/option>/u);
  assert.match(field, /<option value="xhigh" selected="">xhigh<\/option>/u);
  // 'high' collapses into 'xhigh' in the Qwen3.8 template, so it is never offered.
  assert.doesNotMatch(field, /value="high"/u);
});

test('the reasoning effort dropdown is hidden when reasoning is off', () => {
  assertFieldAbsent(renderPreset({ reasoning: 'off' }), 'Reasoning effort');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js dashboard-model-presets-section
```

Expected: FAIL — `Rendered field 'Reasoning effort' is missing.`

- [ ] **Step 3: Add the options constant**

In `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, beside the file's existing
`KV_CACHE_QUANT_OPTIONS` constant:

```tsx
const REASONING_EFFORT_OPTIONS = ['low', 'medium', 'xhigh'] as const;
```

- [ ] **Step 4: Render the dropdown**

In the same file, replace:

```tsx
          {reasoningEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Reasoning content">
```

with:

```tsx
          {reasoningEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Reasoning effort">
              <select
                value={preset.ReasoningEffort}
                onChange={(event) => {
                  const value = REASONING_EFFORT_OPTIONS.find((option) => option === event.target.value);
                  if (value) modelPresetActions.setReasoningEffort(value);
                }}
              >
                {REASONING_EFFORT_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </SettingsSectionField>
          ) : null}
          {reasoningEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Reasoning content">
```

The `find` guard mirrors the `KvCacheQuantization` select at `:274-277` and keeps the value
narrowed without a type assertion.

- [ ] **Step 5: Add the help text**

In `dashboard/src/settings-sections.ts`, replace:

```ts
      { label: 'Reasoning', layout: 'quarter', helpText: 'Controls whether llama.cpp reasoning is enabled or disabled.' },
```

with:

```ts
      { label: 'Reasoning', layout: 'quarter', helpText: 'Controls whether llama.cpp reasoning is enabled or disabled.' },
      { label: 'Reasoning effort', layout: 'quarter', helpText: 'Sent as `reasoning_effort`. On Qwen3.8 templates, `xhigh` asks the model to validate assumptions and weigh alternatives, `low` asks for brief thinking, and `medium` injects no guidance at all. Models whose chat template ignores `reasoning_effort` are unaffected.' },
```

- [ ] **Step 6: Show it in the group summary**

In `dashboard/src/tabs/settings/model-preset-groups.ts`, replace:

```ts
export function summarizeReasoning(preset: DashboardModelRuntimePreset): string {
  const perStep = preset.MaintainPerStepThinking ? 'on' : 'off';
  return `${preset.Reasoning} · per-step thinking ${perStep} · budget ${formatCompactTokenCount(preset.ReasoningBudget)}`;
}
```

with:

```ts
export function summarizeReasoning(preset: DashboardModelRuntimePreset): string {
  const perStep = preset.MaintainPerStepThinking ? 'on' : 'off';
  const effort = preset.Reasoning === 'on' ? ` · effort ${preset.ReasoningEffort}` : '';
  return `${preset.Reasoning}${effort} · per-step thinking ${perStep} · budget ${formatCompactTokenCount(preset.ReasoningBudget)}`;
}
```

- [ ] **Step 7: Run the tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js dashboard-model-presets-section
node .\dist\test-runner\run-tests.js dashboard-presets-section
```

Expected: both PASS.

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck and lint**

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, error categories, and relevant file:line anchors."
```

Expected: clean. `npm run typecheck` runs `npm run lint` as its last step.

- [ ] **Step 2: Full node suite**

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: green.

- [ ] **Step 3: Dashboard suite**

```powershell
npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: green.

- [ ] **Step 4: Confirm no stray files**

```powershell
git status --short
```

Expected: only the files this plan names, plus the pre-existing dirty files
(`src/assistant/assistant-service.ts`, `src/assistant/storage/policy-store.ts`,
`tests/assistant-policies.test.ts`) which are unrelated and must be left alone. Delete any
scratch file the work produced. Do not commit.

- [ ] **Step 5: Report**

State the result, the changed files, the validation commands and their outcomes, and any
unverified scope. Call out explicitly that the live behavior — the active `EXL3 3.8_27B`
preset actually rendering a different system preamble per level — has **not** been verified
against a running TabbyAPI instance, and offer to do so.

---

## Manual verification (optional, requires the running backend)

The automated tests prove SiftKit sends `reasoning_effort`. They do not prove the model
renders a different prompt. To check that end to end:

1. Open the dashboard settings, select the `EXL3 3.8_27B` preset, set Reasoning effort to
   `low`, and save.
2. Restart the managed backend so the preset applies, then issue a chat turn.
3. In the rendered prompt, the system block should contain "Reasoning effort is set to low."
   Switching to `xhigh` should produce the "think carefully through the task" sentence, and
   `medium` should produce neither.
