# Backend Identity and Context Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the active exl3 preset context from 150k to 140k, stop rejected duplicate tool calls from permanently inflating the repo-search transcript, and remove the `'llama.cpp'` naming collision so every reported "backend" is the real `InferenceBackendId`.

**Architecture:** Four independent workstreams. Task 1 is a runtime-data change applied through the supported `readConfig`/`writeConfig` path plus a guard test on the adapter's 256-token rounding. Task 2 documents the duplicate transcript cost. Tasks 3a–3c split the naming collision along its two real axes: the *provider* axis (`real` vs `mock`, a test-double switch owned by `src/summary/`) keeps its identity but loses the engine-shaped name, and the *engine* axis (`llama` vs `exl3`, already `InferenceBackendId`) becomes the only thing ever written to `run_logs.backend` or printed as a backend. Task 4 elides the arguments of a rejected duplicate at transcript-action construction time, so the payload never enters the message array.

**Tech Stack:** TypeScript (strict, no casts / no `any` / no non-null `!`), Zod-derived IO types, `node:test` + `node:assert/strict`, better-sqlite3, exllamav3/TabbyAPI, llama.cpp.

---

## Background Evidence

From run `b62673ac-a814-4c70-b8e8-5b6b217d7c1a` (2026-08-04T01:31Z, 69 turns, failed at the 15-minute budget) and inference run `94ba7848-fab7-4871-99fe-95188014a997`:

- Active preset `exl3-3-6-27b` has `NumCtx: 150000`, so `Exl3PresetAdapter.buildLoadRequest` emits `max_seq_len: 150000` and `cache_size: 150016`. The engine log confirms both.
- `nvidia-smi`: RTX 4090, 23,776 MiB of 24,564 MiB used by the TabbyAPI process alone (96.8%).
- Two requests collapsed to `Generate: 16.5 T/s` (baseline 55–95) with prefill collapsing in lockstep to `6.57 T/s` (baseline 240–1800), then recovered — a VRAM-headroom signature, not a cache miss. Prompt cache reuse was 97–99% on every turn.
- `run_logs.backend` recorded `llama.cpp` for a run that executed entirely on exl3 at `127.0.0.1:8098`.
- The CLI printed `tokenize=265ms(llama.cpp)` while tokenizing against TabbyAPI's `/v1/token/encode`.

---

## File Structure

**Task 1 — context budget**
- Modify (runtime data): `.siftkit/runtime.sqlite` → `app_config.server_llama_presets_json`, preset `exl3-3-6-27b`, `NumCtx`
- Modify: `tests/model-preset-adapters.test.ts` — guard the 256-token rounding at the new value
- Create (scratch, deleted at end): `.tmp/context-budget/apply-num-ctx.mjs`

**Task 2 — documentation**
- Create: `docs/analysis/2026-08-03-duplicate-tool-call-transcript-cost.md`

**Task 3a — provider axis rename (`'llama.cpp'` → `'real'`, field `backend` → `provider`)**
- Modify: `src/summary/types.ts`, `src/summary/core-runner.ts`, `src/summary/chunking.ts`, `src/summary/planner/mode.ts`, `src/summary/provider-invoke.ts`, `src/summary/request-runner.ts`, `src/summary/artifacts.ts`, `src/summary/progress-reporter.ts`, `src/summary/providers/mock-provider.ts`
- Modify: `src/cli/args.ts`, `src/cli/run-capture.ts`, `src/cli/run-command.ts`, `src/cli/run-preset.ts`, `src/cli/run-summary.ts`, `src/cli/run-internal.ts`
- Modify: `tests/summary-provider-default.test.ts` and the provider-axis occurrences in `tests/runtime-summarize.test.ts`, `tests/runtime-planner-mode*.test.ts`, `tests/summary-progress-reporter.test.ts`, `tests/summary-logging.test.ts`, `tests/runtime-planner-token-aware.test.ts`, `tests/processed-input-metrics.test.ts`, `tests/config-no-top-level-backend.test.ts`

**Task 3b — `run_logs.backend` carries the engine**
- Modify: `src/status-server/dashboard-runs/types.ts`, `src/status-server/dashboard-runs/artifact-upserts.ts`, `src/status-server/routes/core.ts`, `src/summary/artifacts.ts`
- Modify: `src/state/runtime-db.ts` — migration rewriting legacy `run_logs.backend` values
- Modify: `tests/runtime-metrics-aggregation.test.ts`, `tests/dashboard-runs-partition.test.ts`, `tests/dashboard-status-server.test.ts`, `tests/dashboard-benchmark.test.ts`, `tests/status-artifact-references.test.ts`, `tests/repo-search-status-server.test.ts`, `tests/helpers/dashboard-run-seed.ts`
- Create: `tests/run-log-backend-identity.test.ts`

**Task 3c — token-count source carries the engine**
- Modify: `src/repo-search/prompt-budget.ts`, `src/repo-search/engine/token-usage.ts`, `src/status-server/chat-turn-telemetry.ts`
- Modify: `tests/repo-search-preflight-log.test.ts`, `tests/timing-recorder.test.ts`, `tests/cli-progress-renderer.test.ts`, `tests/tabby-usage-metrics.e2e.test.ts`

**Task 4 — elide rejected duplicate tool-call arguments**
- Modify: `src/repo-search/engine/repo-tools.ts` — add `buildRejectedTranscriptAction` beside `buildEffectiveTranscriptAction`
- Modify: `src/repo-search/engine/tool-action-processor.ts:349,484` — the two rejected-call outcome sites
- Modify: `tests/repo-tools.test.ts`, `tests/repo-search-loop.core.test.ts:1162-1173`

---

## Task 1: Shrink the exl3 preset context to 140k

`NumCtx` is the only knob: `Exl3PresetAdapter.buildLoadRequest` derives `max_seq_len = NumCtx` and `cache_size = ceil(NumCtx / 256) * 256`, and `getConfiguredLlamaNumCtx` feeds `maxPromptBudget` (`150000 → 127500` today, `140000 → 119000` after). The value lives in runtime data, not source: `app_config.server_llama_presets_json`, preset id `exl3-3-6-27b`.

**Files:**
- Modify: `tests/model-preset-adapters.test.ts`
- Modify (runtime data): `.siftkit/runtime.sqlite`
- Create then delete: `.tmp/context-budget/apply-num-ctx.mjs`

- [ ] **Step 1: Add the rounding guard test**

`tests/model-preset-adapters.test.ts:42` already asserts `buildLoadRequest` for a llama-shaped preset. Append a dedicated exl3 case pinning the new value. Read the existing exl3 test at line 82 for the preset fixture shape and reuse it — do not build a second fixture.

```typescript
test('exl3 buildLoadRequest rounds a 140k context up to the next 256-token cache page', () => {
  const adapter = new Exl3PresetAdapter(MODEL_ROOT);
  const request = adapter.buildLoadRequest({ ...exl3Preset, NumCtx: 140_000 });
  assert.equal(request.max_seq_len, 140_000);
  assert.equal(request.cache_size, 140_032);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- model-preset-adapters`
Expected: PASS. This is a characterization guard, not a TDD-RED step — the `ceil/256*256` math already exists and this pins it at the value the preset is about to use. If it FAILS, the adapter rounding is wrong and that is the real bug; stop and report before touching config.

- [ ] **Step 3: Read the current value**

```bash
node -e "
const Database=require('better-sqlite3');
const db=new Database('.siftkit/runtime.sqlite',{readonly:true});
const presets=JSON.parse(db.prepare('select server_llama_presets_json from app_config where id=1').get().server_llama_presets_json);
const p=presets.find(x=>x.id==='exl3-3-6-27b');
console.log('id',p.id,'Backend',p.Backend,'NumCtx',p.NumCtx);
"
```

Expected: `id exl3-3-6-27b Backend exl3 NumCtx 150000`

- [ ] **Step 4: Write the scratch script that applies the change through the supported path**

Do not `UPDATE` the JSON column by hand — `writeConfig` normalizes the whole row and any hand-edit skips that.

Create `.tmp/context-budget/apply-num-ctx.mjs`:

The accessor is `config.Server.ModelPresets.Presets`, confirmed at `src/config/getters.ts:19-24`.

```javascript
import { readConfig, writeConfig } from '../../dist/status-server/config-store.js';

const CONFIG_PATH = '.siftkit/runtime.sqlite';
const PRESET_ID = 'exl3-3-6-27b';
const NEXT_NUM_CTX = 140_000;

const config = readConfig(CONFIG_PATH);
const preset = config.Server.ModelPresets.Presets.find((entry) => entry.id === PRESET_ID);
if (!preset) throw new Error(`preset ${PRESET_ID} not found`);
if (preset.Backend !== 'exl3') throw new Error(`preset ${PRESET_ID} backend=${preset.Backend}, expected exl3`);
console.log('before NumCtx', preset.NumCtx);
preset.NumCtx = NEXT_NUM_CTX;
writeConfig(CONFIG_PATH, config);

const applied = readConfig(CONFIG_PATH).Server.ModelPresets.Presets.find((entry) => entry.id === PRESET_ID);
console.log('after  NumCtx', applied.NumCtx);
```

- [ ] **Step 5: Build, then apply**

```bash
npm run build
node .tmp/context-budget/apply-num-ctx.mjs
```

Expected: `before NumCtx 150000` / `after  NumCtx 140000`

- [ ] **Step 6: Verify the derived load request**

```bash
node -e "
const Database=require('better-sqlite3');
const db=new Database('.siftkit/runtime.sqlite',{readonly:true});
const p=JSON.parse(db.prepare('select server_llama_presets_json from app_config where id=1').get().server_llama_presets_json).find(x=>x.id==='exl3-3-6-27b');
console.log('NumCtx',p.NumCtx,'cache_size',Math.ceil(p.NumCtx/256)*256,'maxPromptBudget',Math.floor(p.NumCtx*0.85));
"
```

Expected: `NumCtx 140000 cache_size 140032 maxPromptBudget 119000`

- [ ] **Step 7: Delete the scratch script and commit the test**

```bash
rm -rf .tmp/context-builder .tmp/context-budget
git add tests/model-preset-adapters.test.ts
git commit -m "test: pin exl3 cache-page rounding at a 140k context"
```

**Note for the report, not a step:** the running TabbyAPI process still holds the 150k allocation. `max_seq_len`/`cache_size` are launch env vars (`TABBY_MODEL_MAX_SEQ_LEN`, `TABBY_MODEL_CACHE_SIZE` in `Exl3PresetAdapter.buildLaunchEnvironment`), so the change takes effect on the next model reload through `PresetRuntimeCoordinator`. Per the user's decision, do not restart it.

---

## Task 2: Document the duplicate tool-call transcript cost

Explanation only — no production code changes in this task.

**Files:**
- Create: `docs/analysis/2026-08-03-duplicate-tool-call-transcript-cost.md`

- [ ] **Step 1: Write the analysis document**

The document must state, with the file:line anchors and run evidence below:

1. **The guard is necessarily reactive.** `ToolActionProcessor` computes `duplicateFingerprint` and calls `rejectAsDuplicate` (`src/repo-search/engine/tool-action-processor.ts:441-451`) only after the model has already streamed the entire tool call. There is no pre-generation short-circuit available and none is possible — the fingerprint is derived from arguments that do not exist until generation completes. Any claim that the duplicate could be "caught earlier" is wrong.

2. **What the rejection actually reclaims: only the tool result.** `rejectAsDuplicate` replaces the *tool* message (`transcript.replaceToolMessage(registration.activeReplayMessageIndex, duplicateMessage)`, `tool-action-processor.ts:481`) or appends a fresh 66-character tool message (`duplicate command requested x2. Issue a different/unique tool call`). The **assistant message carrying the rejected `tool_calls` arguments is never touched.**

3. **What that cost in run `b62673ac`.** At turn 37 the model emitted one `edit` call with **52,400 characters of arguments** — a single edit whose `oldText` is 25,448 chars and `newText` is 25,802 chars, i.e. it re-emitted a ~25k-character block to change ~354 characters. The request took **179.3 seconds**. It was rejected as a duplicate and stored as `duplicate_call_41`. Prompt tokens went `76,207 → 89,340` (+13,133) and **never came back down**: turn 39 was `89,340`, turn 69 was `100,646`. Those 13,133 tokens of a rejected, zero-information payload were re-sent on all 32 remaining turns.

4. **The compounding effect.** `contextOverflowPolicy` for this run is `fail`, not `compact` (`turn_preflight_budget.contextOverflowPolicy`), so nothing ever reclaims the dead payload. Pushing the prompt from 76k to 89k is what moved the run into the context range where the VRAM-starved GPU degraded (see Task 1 background), so the duplicate did not just waste 179 seconds once — it raised the floor cost of every later turn.

5. **The follow-on symptoms.** Turn 39 produced `"messages": []` (zero output, prompt unchanged) and cost another 194.8 seconds. Turn 41 repeated the pattern as `duplicate_call_44`. Turns 59 and 60 logged `turn_zero_output_countdown` with `zeroOutputStreak` 1 and 2. The rejection text gives the model no signal that the problem is the *shape* of the call (a whole-block rewrite), only that it was a repeat.

6. **The fix, implemented in Task 4.** The rejected call's arguments never need to reach the transcript. `rejectAsDuplicate` does not write a message — it pushes a `ToolBatchOutcome` whose `action` is built by `buildEffectiveTranscriptAction` (`tool-action-processor.ts:483-492`), and the assistant message is only assembled later by `appendToolBatchExchange`. Eliding at construction keeps the payload out entirely. This would have reclaimed ~13,100 tokens at turn 38 and kept the run under 90k.

7. **Why the messages are elided and not deleted.** Four constraints rule out dropping the assistant/tool pair:
   - `appendToolBatchExchange` (`src/tool-call-messages.ts:72-84`) folds *all* of a turn's outcomes into one assistant message, so a batch can mix accepted calls with a duplicate; deleting the message would take the accepted calls with it.
   - Every `role: 'tool'` message requires a matching `tool_calls[].id` on a preceding assistant message; removing the entry orphans it.
   - The rejection tool message is the only in-transcript signal that a repeat occurred. Removing it re-arms the exact loop the guard exists to break.
   - `DuplicateTracker.replayToolMessageIndex` (`src/repo-search/engine/duplicate-tracker.ts:46-56`) and `forcedFinishCountdownUserMessageIndex` are absolute indexes; `TranscriptManager` only bumps `generation` on `replaceWith` (`transcript-manager.ts:55-59`), so a mid-array splice would silently invalidate them.

- [ ] **Step 2: Verify every claim against the stored transcript**

```bash
node -e "
const Database=require('better-sqlite3');
const db=new Database('.siftkit/runtime.sqlite',{readonly:true});
const lines=db.prepare('select repo_search_transcript_jsonl from run_logs where run_id=?').get('b62673ac-a814-4c70-b8e8-5b6b217d7c1a').repo_search_transcript_jsonl.split('\n').filter(Boolean).map(JSON.parse);
for (const t of [37,38,39,41]) {
  const nm = lines.find(o => o.kind==='turn_new_messages' && o.turn===t);
  const ids = (nm.messages[0]?.tool_calls ?? []).map(c => c.id + ':' + c.function.arguments.length);
  console.log('turn', t, 'prompt', nm.promptTokenCount, 'calls', ids.join(',') || '(none)');
}
"
```

Expected: turn 37 `call_40:69`, turn 38 `duplicate_call_41:52400` at prompt `89340`, turn 39 prompt `89340` with `(none)`, turn 41 `duplicate_call_44:1463`.

- [ ] **Step 3: Commit**

```bash
git add docs/analysis/2026-08-03-duplicate-tool-call-transcript-cost.md
git commit -m "docs: analyze duplicate tool-call transcript cost"
```

---

## Task 3a: Rename the provider axis off the engine name

`SummaryProviderId` is a real, load-bearing axis — it gates chunking, planner activation, slot allocation and mock behaviour throughout `src/summary/`. Its *values* and the *field name* are the problem: `'llama.cpp'` means "the real provider, not the mock", and it is carried in fields called `backend`, which is what leaks an engine-shaped lie into `run_logs` and the CLI. Rename the value to `'real'` and the field to `provider`. The doc comment at `src/summary/types.ts:8-14` already explains the distinction and must be updated to match.

**Files:**
- Modify: `src/summary/types.ts:15-31,65`, `src/summary/core-runner.ts:79,196,201,209,217,246,286,296,383,390,433,439,448,563`, `src/summary/chunking.ts:204`, `src/summary/planner/mode.ts:1399`, `src/summary/provider-invoke.ts:138`, `src/summary/request-runner.ts:322`, `src/summary/artifacts.ts:192,211,234`, `src/summary/progress-reporter.ts`, `src/summary/providers/mock-provider.ts`
- Modify: `src/cli/args.ts:124-126`, `src/cli/run-capture.ts:32`, `src/cli/run-command.ts:47`, `src/cli/run-preset.ts:37`, `src/cli/run-summary.ts:56`, `src/cli/run-internal.ts:73,99,119,163`
- Test: `tests/summary-provider-default.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the three provider-identity assertions in `tests/summary-provider-default.test.ts:12-19` with:

```typescript
test('the default summary provider is the real provider', () => {
  assert.equal(DEFAULT_SUMMARY_PROVIDER, 'real');
  assert.equal(resolveSummaryProvider(undefined), 'real');
});

test('the provider domain is exactly real and mock', () => {
  assert.deepEqual(SummaryProviderIdSchema.options, ['real', 'mock']);
});

test('the provider domain never reuses an engine name', () => {
  assert.equal(SummaryProviderIdSchema.safeParse('llama.cpp').success, false);
  assert.equal(SummaryProviderIdSchema.safeParse('exl3').success, false);
});
```

Also update `tests/summary-provider-default.test.ts:50` from `isOversizedMockInput('llama.cpp', 100, 50)` to `isOversizedMockInput('real', 100, 50)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- summary-provider-default`
Expected: FAIL — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 'llama.cpp' !== 'real'`

- [ ] **Step 3: Rename the value in the schema**

`src/summary/types.ts`:

```typescript
/**
 * Summary provider identity. NOT the inference engine axis ('llama'/'exl3', see
 * getActiveInferenceBackend): 'real' means the real, fully-capable provider
 * (chunking, planner, slots) and is what the downstream summary gates compare
 * against; 'mock' is the test double. The two axes are unrelated, so this type is
 * threaded end-to-end and an engine id is a compile error wherever it is expected.
 */
export const SummaryProviderIdSchema = z.enum(['real', 'mock']);
export type SummaryProviderId = z.infer<typeof SummaryProviderIdSchema>;
export const DEFAULT_SUMMARY_PROVIDER: SummaryProviderId = 'real';
```

And at `src/summary/types.ts:28`:

```typescript
    throw new Error(`Unsupported provider '${value}'; expected one of: real, mock.`);
```

- [ ] **Step 4: Rename every remaining provider-axis value**

Every comparison against the literal that is typed `SummaryProviderId` becomes `=== 'real'` / `!== 'real'`. Locate them:

```bash
grep -rn "'llama\.cpp'" src/summary src/cli
```

Expected sites: `core-runner.ts:196,201,209,217,286,296,383,390,433,563`, `chunking.ts:204`, `planner/mode.ts:1399`, `provider-invoke.ts:138`, `request-runner.ts:322`. `core-runner.ts:378` is a different thing — it is a token-source string, leave it for Task 3c.

- [ ] **Step 5: Rename the field `backend` → `provider` on the provider axis**

Only where the declared type is `SummaryProviderId`. Confirmed declaration sites: `src/summary/types.ts:65` (`SummaryRequest`), `src/summary/core-runner.ts:79`, `src/summary/artifacts.ts:192,234`. Rename the property and every read (`this.options.backend` → `this.options.provider`, `options.backend` → `options.provider`, the object literals at `core-runner.ts:246,439,448` and `artifacts.ts:211`).

Do **not** rename `backend` where the type is `InferenceBackendId` — `src/inference-presets/request-compatibility.ts:18`, `src/llm-protocol/inference-backend.ts:17`, `src/providers/formatron-schema-lowering.ts:84`, `src/state/inference-runs.ts`, `dashboard/src/settings-draft-editor.ts` are all correct already.

- [ ] **Step 6: Rename the CLI flag**

`src/cli/args.ts:124-126`:

```typescript
      case '--provider':
        parsed.provider = parseOptionalSummaryProvider(tokens[++index]);
        break;
```

Rename `parsed.backend` → `parsed.provider` in the parsed-args type and at `src/cli/run-capture.ts:32`, `src/cli/run-command.ts:47`, `src/cli/run-preset.ts:37`, `src/cli/run-summary.ts:56`. Rename `readRequestBackend` → `readRequestProvider` and its four call sites in `src/cli/run-internal.ts:73,99,119,163`. There is no back-compat alias for `--backend`; an unknown flag must fail loud through the existing parser path.

- [ ] **Step 7: Update help text and docs**

```bash
grep -rn -- "--backend" src README.md docs assistant bench scripts
```

Every hit that refers to the summary provider becomes `--provider` with values `real|mock`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- summary-provider-default`
Expected: PASS

- [ ] **Step 9: Update the remaining provider-axis tests and typecheck**

```bash
npm run typecheck
grep -rn "'llama\.cpp'" src tests
```

Fix each remaining test occurrence that is on the provider axis: `tests/runtime-summarize.test.ts`, `tests/runtime-planner-mode.test.ts`, `tests/runtime-planner-mode.tools.test.ts`, `tests/runtime-planner-mode.fallbacks.test.ts`, `tests/runtime-planner-mode.integration.test.ts`, `tests/summary-progress-reporter.test.ts`, `tests/summary-logging.test.ts`, `tests/runtime-planner-token-aware.test.ts`, `tests/processed-input-metrics.test.ts`, `tests/config-no-top-level-backend.test.ts`. Leave `run_logs`-shaped occurrences for Task 3b and token-source occurrences for Task 3c.

Run: `npm test -- summary runtime-summarize runtime-planner`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src tests README.md docs
git commit -m "refactor: rename summary provider axis off the engine name"
```

---

## Task 3b: Record the real engine in `run_logs.backend`

`run_logs.backend` is currently written as the literal `'llama.cpp'` at three sites and from `artifactPayload.backend` (the provider axis) at a fourth. After Task 3a that payload field is `provider`, so this task gives the artifact payload a real `backend: InferenceBackendId` and points every write at `getActiveInferenceBackend(config)`.

**Files:**
- Modify: `src/status-server/dashboard-runs/types.ts:41`, `src/status-server/dashboard-runs/artifact-upserts.ts:237,306`, `src/status-server/routes/core.ts:124-148,164,209`, `src/summary/artifacts.ts:187-226`
- Modify: `src/state/runtime-db.ts` — legacy-value migration
- Test: `tests/run-log-backend-identity.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/run-log-backend-identity.test.ts`. Use `tests/helpers/dashboard-run-seed.ts` for the database fixture — read it first and reuse its seeding helper rather than opening a second raw connection.

The schema is `RunLogDbRowSchema`, exported from `src/status-server/dashboard-runs/types.ts:33`, with `backend: z.string().nullable()` at line 42.

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunLogDbRowSchema } from '../src/status-server/dashboard-runs/types.js';

test('run_logs.backend accepts only engine ids or null', () => {
  const backendSchema = RunLogDbRowSchema.shape.backend;
  assert.equal(backendSchema.safeParse('llama').success, true);
  assert.equal(backendSchema.safeParse('exl3').success, true);
  assert.equal(backendSchema.safeParse(null).success, true);
  assert.equal(backendSchema.safeParse('llama.cpp').success, false);
  assert.equal(backendSchema.safeParse('real').success, false);
  assert.equal(backendSchema.safeParse('mock').success, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- run-log-backend-identity`
Expected: FAIL — `'llama.cpp'` parses successfully because the field is an unconstrained `z.string().nullable()`.

- [ ] **Step 3: Tighten the schema**

`src/status-server/dashboard-runs/types.ts:41`:

```typescript
  backend: InferenceBackendSchema.nullable(),
```

Import `InferenceBackendSchema` from `../../config/types.js` (the same schema `src/state/inference-runs.ts:649` already uses). Update the mirrored `RunLogUpsertRow` field at `types.ts:75` from `backend: string | null` to `backend: InferenceBackendId | null`, and `src/status-server/dashboard-runs/run-records.ts:119` from `typeof row.backend === 'string' ? row.backend : null` to a parse through `InferenceBackendSchema.safeParse` returning `null` on failure. `run-records.ts:21` (`optionalStringField(record.backend)`) is the artifact-payload read path and follows the same treatment.

- [ ] **Step 4: Add the engine to the summary artifact payload**

`src/summary/artifacts.ts` — `buildSummaryRequestArtifact` currently carries only the provider. Add the engine beside it:

```typescript
export function buildSummaryRequestArtifact(options: {
  requestId: string;
  question: string;
  inputText: string;
  command?: string | null;
  provider: SummaryProviderId;
  backend: InferenceBackendId;
  model: string;
  // ...unchanged fields...
}): DeferredArtifact {
  return {
    artifactType: 'summary_request',
    artifactRequestId: options.requestId,
    artifactPayload: {
      requestId: options.requestId,
      command: options.command ?? null,
      question: options.question,
      inputText: options.inputText,
      provider: options.provider,
      backend: options.backend,
      model: options.model,
      // ...unchanged fields...
    },
  };
}
```

Apply the same two-field signature to `writeSummaryRequestDump` at `src/summary/artifacts.ts:228-241`. Every caller passes `backend: getActiveInferenceBackend(config)` — `getActiveInferenceBackend` is exported from `src/config/index.js`.

- [ ] **Step 5: Point the three hardcoded writes at the real engine**

`src/status-server/dashboard-runs/artifact-upserts.ts:237` reads the payload's engine, now correctly typed:

```typescript
    backend: InferenceBackendSchema.safeParse(options.artifactPayload?.backend).data ?? null,
```

`src/status-server/dashboard-runs/artifact-upserts.ts:306` takes the engine from the caller instead of the literal — add `backend: InferenceBackendId` to that function's options and replace `backend: 'llama.cpp'` with `backend: options.backend`.

`src/status-server/routes/core.ts` — add the engine to the admission record so both write sites share one source:

```typescript
type RepoSearchAdmissionRecord = {
  requestId: string;
  startedAtUtc: string;
  prompt: string;
  repoRoot: string;
  model: string | null;
  maxTurns: number | null;
  backend: InferenceBackendId;
};

function createRepoSearchAdmissionRecord(
  parsedBody: RepoSearchRouteRequest,
  config: SiftConfig,
): RepoSearchAdmissionRecord {
  return {
    requestId: randomUUID(),
    startedAtUtc: new Date().toISOString(),
    prompt: parsedBody.prompt,
    repoRoot: parsedBody.repoRoot,
    model: parsedBody.model,
    maxTurns: parsedBody.maxTurns,
    backend: getActiveInferenceBackend(config),
  };
}
```

Then `backend: 'llama.cpp'` at `core.ts:164` and `core.ts:209` both become `backend: record.backend`, and the call at `core.ts:869` becomes `createRepoSearchAdmissionRecord(repoSearchRequest, ctx.config)`. If `ctx` does not expose `config` at that point, read `src/status-server/server-types.ts` for the real accessor and use it — do not thread a new parameter through the route.

- [ ] **Step 6: Migrate legacy rows**

Historical rows hold `'llama.cpp'`, which the tightened schema now rejects, and the true engine for those rows is unknowable. Add a migration step in `src/state/runtime-db.ts` alongside the existing `run_logs` handling:

```sql
UPDATE run_logs SET backend = NULL WHERE backend IS NOT NULL AND backend NOT IN ('llama', 'exl3');
```

Bump the `runtime_schema` version the same way the neighbouring migrations do — read the surrounding block before adding, and follow its existing versioning pattern exactly.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- run-log-backend-identity`
Expected: PASS

- [ ] **Step 8: Update dependent tests and verify no legacy rows survive**

```bash
npm run typecheck
npm test -- dashboard-runs-partition dashboard-status-server dashboard-benchmark runtime-metrics-aggregation status-artifact-references repo-search-status-server
node -e "
const Database=require('better-sqlite3');
const db=new Database('.siftkit/runtime.sqlite',{readonly:true});
console.log(db.prepare(\"select backend, count(*) c from run_logs group by backend\").all());
"
```

Expected: all suites PASS; the query returns only `llama`, `exl3`, or `null` — no `llama.cpp`.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "refactor: record the real inference engine in run logs"
```

---

## Task 3c: Report the real engine as the token-count source

`tokenCountSource` is `'llama.cpp' | 'estimate'` and renders as `tokenize=265ms(llama.cpp)` even when tokenization ran against TabbyAPI. Its two consumers only ever ask "was this estimated?", so widening the non-estimate case to the engine id costs them nothing.

**Files:**
- Modify: `src/repo-search/prompt-budget.ts:28-58,77,132-134`
- Modify: `src/repo-search/engine/token-usage.ts:143`, `src/status-server/chat-turn-telemetry.ts:26,42`, `src/summary/core-runner.ts:378`
- Test: `tests/repo-search-preflight-log.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/repo-search-preflight-log.test.ts:14,21,35` currently asserts the `llama.cpp` label. Change the fixture and expectation to the engine id:

```typescript
      tokenCountSource: 'exl3',
```

```typescript
      fields: 't4/45  prompt=32,944tok/102.9kc  tokenize=111ms(exl3)  elapsed=31s',
```

Add a new case pinning the estimate path so both branches are covered:

```typescript
test('the preflight line reports estimate when the server tokenizer was unavailable', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 4,
    maxTurns: 45,
    promptChars: 102_900,
    promptTokenCount: 32_944,
    tokenizeElapsedMs: 111,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'completed',
    elapsedMs: 31_000,
  });
  assert.match(body.fields, /tokenize=111ms\(estimate\)/u);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- repo-search-preflight-log`
Expected: FAIL — the rendered line still contains `(llama.cpp)`, and `tokenCountSource: 'exl3'` is not assignable to `'llama.cpp' | 'estimate'`.

- [ ] **Step 3: Widen the source type to the engine axis**

`src/repo-search/prompt-budget.ts`:

```typescript
export type TokenCountWithFallbackResult = {
  tokenCount: number;
  source: InferenceBackendId | 'estimate';
  llamaTokenCount: LlamaCppTokenCountResult | null;
};
```

In `countTokensWithFallbackDetailed`, the success branch returns the live engine instead of a fixed label:

```typescript
  if (config) {
    const llamaTokenCount = await countLlamaCppTokensDetailed(config, text, options);
    if (Number.isFinite(llamaTokenCount.tokenCount) && Number(llamaTokenCount.tokenCount) > 0) {
      return {
        tokenCount: Number(llamaTokenCount.tokenCount),
        source: getActiveInferenceBackend(config),
        llamaTokenCount,
      };
    }
```

`PreflightResult.tokenCountSource` at `prompt-budget.ts:77` becomes `InferenceBackendId | 'estimate'`, and the collapse at `prompt-budget.ts:132-134` becomes:

```typescript
    tokenCountSource: tokenCount.source !== 'estimate'
      && (!reserveTokenCount || reserveTokenCount.source !== 'estimate')
      ? tokenCount.source
      : 'estimate',
```

- [ ] **Step 4: Update the two "was this estimated?" consumers**

`src/repo-search/engine/token-usage.ts:143`:

```typescript
    return { tokenCount: result.tokenCount, estimated: result.source === 'estimate' };
```

`src/status-server/chat-turn-telemetry.ts:26` and `:42`:

```typescript
      estimated: count.source === 'estimate',
```

```typescript
        thinkingTokensEstimated: count.source === 'estimate',
```

`src/summary/core-runner.ts:378` currently hardcodes the same label for its own token source:

```typescript
    const tokenSource = promptTokenCount === null ? 'unavailable' : getActiveInferenceBackend(this.options.config);
```

Read `core-runner.ts:370-385` first to confirm `this.options.config` is the accessor in scope; if the class holds the config under a different name, use that one.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- repo-search-preflight-log`
Expected: PASS

- [ ] **Step 6: Verify the collision is gone**

```bash
npm run typecheck
grep -rn "'llama\.cpp'" src tests
```

Expected: `npm run typecheck` passes and the grep returns **zero** hits across `src/` and `tests/`. Any survivor is either an unconverted provider-axis site (Task 3a) or an unconverted run-log site (Task 3b) — finish it here rather than leaving it.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: PASS. Report the exact totals and any failure verbatim; do not claim green without the output.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "refactor: report the real inference engine as the token-count source"
```

---

## Task 4: Elide rejected duplicate tool-call arguments

A rejected duplicate's arguments have no downstream value, but they are written into the transcript verbatim: `buildEffectiveTranscriptAction` returns `args: options.rawArgs` for native tools (`src/repo-search/engine/repo-tools.ts:257`), and that action is pushed into `state.batchOutcomes` by both rejected-call paths. In run `b62673ac` that cost 13,133 tokens on every one of 32 remaining turns (see Task 2).

The detection point is `rejectAsDuplicate`, which runs *before* the assistant message exists — `appendToolBatchExchange` assembles it at the end of the turn. So the elision belongs in the action builder, not in a transcript rewrite. The replay branch (`tool-action-processor.ts:480-481`) only replaces the tool message, so re-rejections of the same fingerprint never re-add arguments either.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:245-258`
- Modify: `src/repo-search/engine/tool-action-processor.ts:349,484`
- Test: `tests/repo-tools.test.ts`, `tests/repo-search-loop.core.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Append to `tests/repo-tools.test.ts` beside the existing `buildEffectiveTranscriptAction` cases at line 84. Import `buildRejectedTranscriptAction` and `REJECTED_ARGS_ELISION_LIMIT` from `../src/repo-search/engine/repo-tools.js`.

```typescript
test('buildRejectedTranscriptAction keeps small argument payloads intact', () => {
  const action = buildRejectedTranscriptAction({
    toolName: 'git',
    rawArgs: { command: 'git status --short' },
    isNativeTool: false,
    commandToRun: 'git status --short',
  });
  assert.deepEqual(action, { tool_name: 'git', args: { command: 'git status --short' } });
});

test('buildRejectedTranscriptAction elides an oversized argument payload', () => {
  const oldText = 'a'.repeat(25_448);
  const newText = 'b'.repeat(25_802);
  const action = buildRejectedTranscriptAction({
    toolName: 'edit',
    rawArgs: { path: 'src/summary/core-runner.ts', oldText, newText },
    isNativeTool: true,
    commandToRun: 'edit path="src/summary/core-runner.ts"',
  });
  assert.equal(action.tool_name, 'edit');
  assert.deepEqual(Object.keys(action.args), ['elided']);
  assert.match(String(action.args.elided), /^rejected edit call; 51,3\d\d chars of arguments discarded$/u);
  assert.ok(JSON.stringify(action.args).length < REJECTED_ARGS_ELISION_LIMIT);
});

test('buildRejectedTranscriptAction elides exactly above the limit', () => {
  const build = (padding: number) => buildRejectedTranscriptAction({
    toolName: 'run_repo_cmd',
    rawArgs: { command: 'x'.repeat(padding) },
    isNativeTool: false,
    commandToRun: 'x'.repeat(padding),
  });
  const atLimit = build(REJECTED_ARGS_ELISION_LIMIT - 20);
  const overLimit = build(REJECTED_ARGS_ELISION_LIMIT);
  assert.deepEqual(Object.keys(atLimit.args), ['command']);
  assert.deepEqual(Object.keys(overLimit.args), ['elided']);
});
```

The `51,3\d\d` figure is `JSON.stringify` of the three-key object; assert the real value the first run reports rather than guessing a digit.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- repo-tools`
Expected: FAIL — `buildRejectedTranscriptAction` is not exported from `src/repo-search/engine/repo-tools.ts`.

- [ ] **Step 3: Add the builder**

`src/repo-search/engine/repo-tools.ts`, directly below `buildEffectiveTranscriptAction`. It delegates rather than duplicating the read-window / command-tool normalization:

```typescript
/**
 * Serialized-argument size above which a rejected call's arguments are dropped. A rejected call
 * has no downstream value, but its arguments are re-sent on every later turn; small payloads are
 * cheaper to keep than to describe.
 */
export const REJECTED_ARGS_ELISION_LIMIT = 512;

/**
 * Transcript action for a call that was rejected before execution. Identical to the effective
 * action while the payload is small, and an elision marker once it is not.
 */
export function buildRejectedTranscriptAction(options: {
  toolName: string;
  rawArgs: JsonObject;
  isNativeTool: boolean;
  commandToRun: string;
}): ToolTranscriptAction {
  const effective = buildEffectiveTranscriptAction(options);
  const serializedLength = JSON.stringify(effective.args).length;
  if (serializedLength <= REJECTED_ARGS_ELISION_LIMIT) {
    return effective;
  }
  return {
    tool_name: effective.tool_name,
    args: {
      elided: `rejected ${effective.tool_name} call; ${serializedLength.toLocaleString('en-US')} chars of arguments discarded`,
    },
  };
}
```

`ToolTranscriptAction` and `JsonObject` are already imported in this file — confirm before adding either import.

- [ ] **Step 4: Point both rejected-call paths at it**

`src/repo-search/engine/tool-action-processor.ts:349` (`recordRejectedToolCall`, which serves the `duplicate_web_call` path) and `:484` (`rejectAsDuplicate`) both change `buildEffectiveTranscriptAction(` → `buildRejectedTranscriptAction(`. Update the import at `tool-action-processor.ts:32`.

Do **not** change `:859` — that is the accepted-execution path and its arguments are live context.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- repo-tools`
Expected: PASS

- [ ] **Step 6: Extend the E2E to prove the payload never reaches the wire**

`tests/repo-search-loop.core.test.ts:1128-1173` already drives a duplicate rejection against a fake server and inspects `chatRequests[5].messages`. Read that test first and extend it in place — do not add a second server harness.

Make the repeated tool call oversized in the server's scripted assistant response (pad the command argument past `REJECTED_ARGS_ELISION_LIMIT`), then add to the existing assertion block at line 1169:

```typescript
    const duplicateAssistant = assistantToolCalls.find((message) => asObjectArray(message?.tool_calls)
      .some((call) => String(call?.id || '').startsWith('duplicate_call_')));
    const duplicateArguments = String(asObjectArray(duplicateAssistant?.tool_calls)[0]?.function?.arguments || '');
    assert.match(duplicateArguments, /chars of arguments discarded/u);
    assert.ok(duplicateArguments.length < REJECTED_ARGS_ELISION_LIMIT);
    const acceptedAssistant = assistantToolCalls.find((message) => asObjectArray(message?.tool_calls)
      .some((call) => String(call?.id || '').startsWith('call_')));
    assert.match(String(asObjectArray(acceptedAssistant?.tool_calls)[0]?.function?.arguments || ''), /git grep -n "planner" src/u);
```

The existing counts at `:1169-1172` must be unchanged — the fix elides content, it does not add or remove messages. If `assistantToolCalls.length` or `toolMessages.length` moves, the change is wrong.

`asObjectArray` and the `function.arguments` access must stay cast-free; if the helper does not already narrow far enough, widen the helper rather than reaching for an assertion.

- [ ] **Step 7: Run the E2E and the neighbouring duplicate suites**

Run: `npm test -- repo-search-loop.core tool-loop-governor engine-transcript-manager runtime-planner-mode`
Expected: PASS

- [ ] **Step 8: Typecheck and full suite**

```bash
npm run typecheck
npm test
```

Expected: PASS. Report exact totals; do not claim green without the output.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "fix: elide rejected duplicate tool-call arguments from the transcript"
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Preset context applied | `node -e "…server_llama_presets_json…"` | `NumCtx 140000`, derived `cache_size 140032` |
| Rounding guard | `npm test -- model-preset-adapters` | PASS |
| Provider axis renamed | `npm test -- summary-provider-default` | PASS, domain is `['real','mock']` |
| Engine in run logs | `select backend, count(*) from run_logs group by backend` | only `llama` / `exl3` / `null` |
| CLI label honest | `npm test -- repo-search-preflight-log` | `tokenize=111ms(exl3)` |
| Collision eliminated | `grep -rn "'llama\.cpp'" src tests` | zero hits |
| Duplicate args elided | `npm test -- repo-tools` | PASS, oversized payload becomes `{ elided }` |
| Elision reaches the wire | `npm test -- repo-search-loop.core` | duplicate assistant args < 512 chars, message counts unchanged |
| Types | `npm run typecheck` | PASS |
| Suite | `npm test` | PASS |

## Out of Scope

- Restarting or reloading the TabbyAPI runtime (user decision: config only).
- Eliding arguments on the *invalid*-call path (`recordInvalidToolCall`, `tool-action-processor.ts:400-404`). Its arguments are the diagnostic — the model needs to see what it malformed in order to correct it. Duplicates are different: the identical earlier call is still in the transcript at full fidelity, so nothing is lost.
- Reclaiming the generation time of a duplicate. The fingerprint is derived from arguments that do not exist until the model finishes streaming, so detection is necessarily post-hoc (Task 2, item 1). Only the recurring per-turn tax is reclaimable.
- Any change to `contextOverflowPolicy`, `maxOutputTokens`, or the 15-minute repo-agent budget.
- Renaming `src/providers/llama-cpp.ts` or `src/llm-protocol/llama-cpp-client.ts`, which serve both engines. Their filenames are misleading but no reported value depends on them; call it out, do not refactor it here.
