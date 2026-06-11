# Kill Dict Server Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `Dict = Record<string, unknown>` from the remaining server boundary code for chat sessions, runs, presets, status parsing, metrics snapshots, and all status-server routes.

**Architecture:** Replace `Dict` boundary typing with explicit domain types plus one small JSON reader class for raw JSON edges. Route bodies become typed request DTOs before business logic sees them. Persisted SQLite rows, artifact payloads, repo-search scorecards, chat sessions, chat messages, presets, and route responses get first-class TypeScript types.

**Tech Stack:** TypeScript, Node HTTP routes, better-sqlite3 row typing, `node:test`, existing `npm run typecheck`, `npm test`.

---

## Scope

This plan targets these files because they are the F3/F18 boundary set named in `ARCHITECTURE-REVIEW.md`:

- `src/lib/json-types.ts`: new JSON value/object types.
- `src/lib/json-record-reader.ts`: new shared typed JSON reader class.
- `src/status-server/http-utils.ts`: parse request JSON as `JsonObject`, not `Dict`.
- `src/presets.ts`: replace preset input `Dict` casts with typed preset overlay records.
- `src/state/chat-sessions.ts`: make `ChatMessage` and `ChatSession` explicit typed records.
- `src/thinking-retention-policy.ts`: preserve typed persisted chat messages through thinking-pruning policy.
- `src/status-server/chat.ts`: consume typed chat messages and typed repo-search scorecards.
- `src/status-server/dashboard-runs.ts`: type run DB rows, raw paths, artifact payloads, repo-search totals, and JSONL payloads.
- `src/status-server/status-file.ts`: type status metadata and deferred artifact parsing.
- `src/status-server/idle-summary.ts`: type idle-summary snapshot/metrics inputs.
- `src/status-server/metrics.ts`: type metrics JSON inputs and DB rows.
- `src/status-server/server-types.ts`: stop importing and re-exporting `Dict`; type deferred artifacts with `JsonObject`.
- `src/status-server/routes/core.ts`: normalize POST bodies into explicit request DTOs.
- `src/status-server/routes/chat.ts`: normalize dashboard chat bodies into explicit request DTOs.
- `src/status-server/routes/dashboard.ts`: normalize dashboard admin/benchmark bodies into explicit request DTOs.
- `src/status-server/routes/llama-passthrough.ts`: remove the remaining route-level `Dict` import.
- `src/status-server/managed-llama.ts`: remove the remaining server-side `Dict` import.
- `src/state/runtime-results.ts`: type runtime result payload persistence.
- `src/state/runtime-artifacts.ts`: type runtime artifact JSON persistence.
- `src/state/dashboard-benchmark.ts`: type benchmark DB rows, managed preset JSON, and spec override JSON.
- `src/state/jsonl-transcript.ts`: type JSONL transcript payloads.
- Tests covering contract, JSON reader behavior, route normalizers, chat sessions, presets, and run artifacts.

Out of scope for this plan:

- Removing every `Dict` use in unrelated subsystems such as web-search providers, eval payloads, non-server CLI helpers, and tests that intentionally use test-local response maps.
- `src/state/benchmark-matrix.ts` remains out of scope for this plan because the architecture review tracks benchmark harness relocation separately under F15/priority #4. Do not treat that file as part of the F3/F18 server-boundary resolution unless the benchmark relocation plan is merged into this work.
- Runtime DB schema changes. The work is type-level and parser-level only.
- Legacy compatibility shims. Existing persisted data is normalized into current first-class shapes; old `Dict` aliases are deleted.

Follow-up after this plan: convert the remaining non-server `Dict` consumers in web-search providers, eval payloads, and test helpers, then delete `export type Dict = Record<string, unknown>` from `src/lib/types.ts`. This plan must not leave any server-side dependency on that alias.

## File Structure Decisions

- `src/lib/json-types.ts`
  - Owns JSON primitives and recursive JSON object/array types.
  - No dependency on status-server code.

- `src/lib/json-record-reader.ts`
  - Owns reusable coercion methods.
  - Implemented as `JsonRecordReader` class with explicit methods.
  - Replaces duplicated `getPositiveNumber`, `getOptionalNumber`, `getTrimmedString`, object casts, and array casts in the target files.

- `src/status-server/route-request-normalizers.ts`
  - New file for core/dashboard route DTO parsers shared across route files.
  - Keeps route files readable and makes request parsing directly unit-testable.

- `src/status-server/chat-route-request-normalizers.ts`
  - New file for chat-session route DTO parsers.
  - Kept separate because chat routes have many session-specific bodies and repo-root resolution rules.

- `src/status-server/repo-search-scorecard-types.ts`
  - New file for typed repo-search result/scorecard/task/command structures consumed by chat and dashboard runs.

- `src/state/chat-sessions.ts`
  - Remains persistence owner for chat sessions and messages.
  - Exports explicit `ChatMessage`, `ChatSession`, and narrow helper types.

- `src/status-server/dashboard-runs.ts`
  - Remains run-log persistence owner.
  - Adds local DB row and artifact payload types instead of generic map usage.

---

## Task 1: Add Server Boundary Contract Harness

**Files:**
- Create: `tests/server-boundary-dict-contract.test.ts`
- Modify: none
- Test: `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Write the contract harness and regex self-test**

Create `tests/server-boundary-dict-contract.test.ts`:

```ts
import * as fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const TARGETS: readonly string[] = [];

const DICT_PATTERNS = [
  /import type \{ Dict \} from/u,
  /export type \{ Dict \}/u,
  /\btype\s+Dict\b/u,
  /:\s*Dict\b/u,
  /\bas\s+Dict\b/u,
  /\bDict\[\]/u,
  /\bRecord<string,\s*unknown>/u,
] as const;

const DUPLICATE_HELPERS = [
  /\bfunction\s+getPositiveNumber\b/u,
  /\bfunction\s+getOptionalNumber\b/u,
  /\bfunction\s+getTrimmedString\b/u,
  /\bfunction\s+getNonNegativeNumber\b/u,
  /\bfunction\s+getFiniteInteger\b/u,
  /\bfunction\s+getFiniteNumber\b/u,
  /\bfunction\s+isRecord\b/u,
] as const;

test('server boundary target files do not use Dict or Record<string, unknown>', () => {
  for (const target of TARGETS) {
    const source = fs.readFileSync(target, 'utf8');
    for (const pattern of DICT_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${target} still matches ${pattern}`);
    }
  }
});

test('server boundary target files use shared JSON reader instead of local coercion helpers', () => {
  for (const target of TARGETS) {
    const source = fs.readFileSync(target, 'utf8');
    for (const pattern of DUPLICATE_HELPERS) {
      assert.doesNotMatch(source, pattern, `${target} still defines ${pattern}`);
    }
  }
});

test('contract catches Record<string, unknown> syntax at punctuation and whitespace boundaries', () => {
  const recordPattern = DICT_PATTERNS[6];
  assert.match('type X = Record<string, unknown>;', recordPattern);
  assert.match('let x: Record<string, unknown> = {};', recordPattern);
});
```

- [ ] **Step 2: Run the contract harness and confirm it passes**

Run:

```powershell
npm run build:test
npm test -- server-boundary-dict-contract
```

Expected: PASS. The full target list is added incrementally as each boundary is converted, so each commit stays bisectable and `npm test` is not intentionally red for multiple tasks.

For every later task that removes `Dict` from a boundary file, first append that task's file paths to `TARGETS`, run `npm test -- server-boundary-dict-contract`, and confirm the contract fails for those files. After the implementation step, re-run the same contract and commit the source changes plus the updated `TARGETS` list together.

- [ ] **Step 3: Commit the passing contract harness**

```powershell
git add tests/server-boundary-dict-contract.test.ts
git commit -m "test: add server boundary Dict contract harness"
```

---

## Task 2: Add Shared JSON Types and Reader

**Files:**
- Create: `src/lib/json-types.ts`
- Create: `src/lib/json-record-reader.ts`
- Create: `tests/json-record-reader.test.ts`
- Test: `tests/json-record-reader.test.ts`

- [ ] **Step 1: Write JSON reader tests**

Create `tests/json-record-reader.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import type { JsonObject } from '../src/lib/json-types.js';

test('JsonRecordReader reads trimmed strings and optional strings', () => {
  const reader = new JsonRecordReader({ name: '  alpha  ', empty: '   ', count: 4 });

  assert.equal(reader.string('name'), 'alpha');
  assert.equal(reader.string('missing'), '');
  assert.equal(reader.optionalString('name'), 'alpha');
  assert.equal(reader.optionalString('empty'), undefined);
  assert.equal(reader.optionalString('count'), undefined);
});

test('JsonRecordReader reads positive and non-negative numbers', () => {
  const reader = new JsonRecordReader({ good: '4', zero: 0, bad: -1, text: 'x' });

  assert.equal(reader.positiveNumber('good', 9), 4);
  assert.equal(reader.positiveNumber('zero', 9), 9);
  assert.equal(reader.nonNegativeInteger('good', 0), 4);
  assert.equal(reader.nonNegativeInteger('bad', 7), 7);
  assert.equal(reader.nullableNonNegativeInteger('text'), null);
});

test('JsonRecordReader reads booleans, arrays, and nested objects without exposing unknown maps', () => {
  const nested: JsonObject = { enabled: true, tags: ['a', 'b'], child: { id: 'x' } };
  const reader = new JsonRecordReader(nested);

  assert.equal(reader.boolean('enabled', false), true);
  assert.deepEqual(reader.stringArray('tags'), ['a', 'b']);
  assert.deepEqual(reader.object('child'), { id: 'x' });
  assert.equal(reader.object('missing'), null);
});

test('JsonRecordReader rejects non-object input through fromUnknown', () => {
  assert.deepEqual(JsonRecordReader.fromUnknown(null).record, {});
  assert.deepEqual(JsonRecordReader.fromUnknown(['x']).record, {});
  assert.deepEqual(JsonRecordReader.fromUnknown({ id: 'ok' }).record, { id: 'ok' });
});
```

- [ ] **Step 2: Run the JSON reader test and confirm it fails**

Run:

```powershell
npm run typecheck:test
```

Expected: FAIL because `src/lib/json-record-reader.ts` does not exist.

- [ ] **Step 3: Add JSON value types**

Create `src/lib/json-types.ts`:

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

export type MutableJsonObject = { [key: string]: JsonValue };
export type MutableJsonArray = JsonValue[];
```

- [ ] **Step 4: Add the JSON reader class**

Create `src/lib/json-record-reader.ts`:

```ts
import type { JsonObject, JsonValue, MutableJsonObject } from './json-types.js';

export class JsonRecordReader {
  public readonly record: JsonObject;

  public constructor(record: JsonObject) {
    this.record = record;
  }

  public static fromUnknown(value: unknown): JsonRecordReader {
    return new JsonRecordReader(JsonRecordReader.asObject(value) || {});
  }

  public static asObject(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null;
  }

  public static parseObjectText(text: string | null): JsonObject | null {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }
    const parsed = JSON.parse(text) as unknown;
    return JsonRecordReader.asObject(parsed);
  }

  public value(key: string): JsonValue | undefined {
    return this.record[key];
  }

  public string(key: string, fallback: string = ''): string {
    const value = this.value(key);
    return typeof value === 'string' ? value.trim() : fallback;
  }

  public optionalString(key: string): string | undefined {
    const value = this.string(key);
    return value ? value : undefined;
  }

  public nullableString(key: string): string | null {
    return this.optionalString(key) || null;
  }

  public boolean(key: string, fallback: boolean): boolean {
    const value = this.value(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  public number(key: string): number | null {
    const value = this.value(key);
    if (typeof value !== 'number' && typeof value !== 'string') {
      return null;
    }
    if (typeof value === 'string' && !value.trim()) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  public positiveNumber(key: string, fallback: number): number {
    const parsed = this.number(key);
    return parsed !== null && parsed > 0 ? parsed : fallback;
  }

  public nonNegativeInteger(key: string, fallback: number): number {
    const parsed = this.number(key);
    return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : fallback;
  }

  public nullableNonNegativeInteger(key: string): number | null {
    const parsed = this.number(key);
    return parsed !== null && parsed >= 0 ? Math.trunc(parsed) : null;
  }

  public nullableNonNegativeNumber(key: string): number | null {
    const parsed = this.number(key);
    return parsed !== null && parsed >= 0 ? parsed : null;
  }

  public object(key: string): JsonObject | null {
    return JsonRecordReader.asObject(this.value(key));
  }

  public stringArray(key: string): string[] {
    const value = this.value(key);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  public mutableCopy(): MutableJsonObject {
    return { ...this.record };
  }
}
```

- [ ] **Step 5: Run JSON reader tests**

Run:

```powershell
npm run typecheck:test
npm test -- json-record-reader
```

Expected: PASS.

- [ ] **Step 6: Commit JSON reader**

```powershell
git add src/lib/json-types.ts src/lib/json-record-reader.ts tests/json-record-reader.test.ts
git commit -m "feat: add typed JSON record reader"
```

---

## Task 3: Type the HTTP JSON Boundary

**Files:**
- Modify: `src/status-server/http-utils.ts`
- Modify: `src/status-server/server-types.ts`
- Test: `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Add HTTP files to the contract and confirm failure**

Modify `tests/server-boundary-dict-contract.test.ts`:

```ts
const TARGETS = [
  'src/status-server/http-utils.ts',
  'src/status-server/server-types.ts',
] as const;
```

Run:

```powershell
npm test -- server-boundary-dict-contract
```

Expected: FAIL for `src/status-server/http-utils.ts` and `src/status-server/server-types.ts`.

- [ ] **Step 2: Change `parseJsonBody` to return `JsonObject`**

Modify `src/status-server/http-utils.ts`:

```ts
/**
 * HTTP server-side helpers for the status-server routes.
 *
 * Client-side HTTP helpers (requestJson, requestJsonFull, requestText) live
 * in `lib/http.ts`.  Filesystem utilities live in `lib/fs.ts`.
 */
import * as http from 'node:http';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function parseJsonBody(bodyText: string): JsonObject {
  if (!bodyText || !bodyText.trim()) {
    return {};
  }
  const parsed = JSON.parse(bodyText) as unknown;
  const record = JsonRecordReader.asObject(parsed);
  if (!record) {
    throw new Error('Expected valid JSON object.');
  }
  return record;
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
```

- [ ] **Step 3: Stop exporting `Dict` from server types**

Modify `src/status-server/server-types.ts`:

```ts
import type * as http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Metrics } from './metrics.js';
import type { JsonObject } from '../lib/json-types.js';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama.js';
import type { ManagedLlamaStreamKind } from '../state/managed-llama-runs.js';
import type { ManagedLlamaFlushQueue } from './managed-llama-flush-queue.js';
import type { StatusEngineService } from './engine-service.js';
import type { SiftConfig } from '../config/types.js';

export type DatabaseInstance = InstanceType<typeof Database>;
```

Then change deferred artifact types in the same file:

```ts
export type DeferredArtifact = {
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed';
  artifactRequestId: string;
  artifactPayload: JsonObject;
};
```

- [ ] **Step 4: Run targeted checks**

Run:

```powershell
npm run typecheck
npm test -- server-boundary-dict-contract
```

Expected: typecheck may still fail in route files because their local variables are typed as `Dict`; the contract target list has not been expanded yet, so the contract test still passes.

- [ ] **Step 4.1: Re-run the HTTP boundary contract**

Run:

```powershell
npm test -- server-boundary-dict-contract
```

Expected: PASS. These files are now protected from reintroducing `Dict`, `Record<string, unknown>`, or duplicated F18 helpers.

- [ ] **Step 5: Commit HTTP boundary typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/http-utils.ts src/status-server/server-types.ts
git commit -m "refactor: type status server JSON boundary"
```

---

## Task 4: Type Preset Normalization Inputs

**Files:**
- Modify: `src/presets.ts`
- Modify: `tests/presets.test.ts`
- Test: `tests/presets.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Add tests for rejecting malformed preset overlays without `Dict`**

Append to `tests/presets.test.ts`:

```ts
test('normalizePresets accepts only typed object overlays', () => {
  const presets = normalizePresets([
    null,
    ['bad'],
    { id: 'custom', label: ' Custom ', presetKind: 'repo-search', operationMode: 'read-only', allowedTools: ['repo_rg'] },
    { id: 'bad-tools', presetKind: 'repo-search', allowedTools: ['missing-tool'] },
  ]);

  assert.equal(findPresetById(presets, 'custom')?.label, 'Custom');
  assert.deepEqual(findPresetById(presets, 'custom')?.allowedTools, ['repo_rg']);
  assert.deepEqual(findPresetById(presets, 'bad-tools')?.allowedTools, REPO_SEARCH_TOOLS);
});
```

- [ ] **Step 2: Run the preset tests**

Run:

```powershell
npm run build:test
npm test -- presets
```

Expected: PASS before refactor. This protects behavior while the implementation removes `Dict`.

- [ ] **Step 3: Replace `Dict` with `JsonRecordReader` and typed preset records**

Modify `src/presets.ts` imports:

```ts
import { JsonRecordReader } from './lib/json-record-reader.js';
import type { JsonObject } from './lib/json-types.js';
```

Add after exported preset types:

```ts
type PresetInputRecord = JsonObject;
```

Replace helper signatures:

```ts
function getLegacyExecutionFamily(record: PresetInputRecord): PresetExecutionFamily | null {
  return isExecutionFamily(record.executionFamily) ? record.executionFamily : null;
}

function getPresetKindFromRecord(record: PresetInputRecord, fallback: PresetKind): PresetKind {
  if (isPresetKind(record.presetKind)) {
    return record.presetKind;
  }
  return getLegacyExecutionFamily(record) || fallback;
}

function getOperationModeFromRecord(record: PresetInputRecord, fallback: PresetOperationMode, presetKind: PresetKind): PresetOperationMode {
  if (isPresetOperationMode(record.operationMode)) {
    return record.operationMode;
  }
  const legacyExecutionFamily = getLegacyExecutionFamily(record);
  if (legacyExecutionFamily === 'plan' || legacyExecutionFamily === 'repo-search') {
    return 'read-only';
  }
  if (legacyExecutionFamily === 'summary' || legacyExecutionFamily === 'chat') {
    return 'summary';
  }
  if (presetKind === 'plan' || presetKind === 'repo-search') {
    return 'read-only';
  }
  return fallback;
}
```

Replace record construction sites:

```ts
function normalizePresetRecord(input: unknown, fallback: SiftPreset): SiftPreset {
  const record = JsonRecordReader.fromUnknown(input).record;
  const reader = new JsonRecordReader(record);
  const presetKind = getPresetKindFromRecord(record, fallback.presetKind);
  const operationMode = getOperationModeFromRecord(record, fallback.operationMode, presetKind);
  return buildPreset({
    id: fallback.id,
    label: reader.optionalString('label') || fallback.label,
    description: reader.optionalString('description') || fallback.description,
    presetKind,
    operationMode,
    promptPrefix: normalizePromptPrefix(record.promptPrefix ?? fallback.promptPrefix),
    allowedTools: normalizeToolList(record.allowedTools, fallback.allowedTools),
    surfaces: normalizeSurfaceList(record.surfaces, fallback.surfaces),
    useForSummary: record.useForSummary === undefined ? fallback.useForSummary : Boolean(record.useForSummary),
    builtin: fallback.builtin,
    deletable: false,
    includeAgentsMd: record.includeAgentsMd === undefined ? fallback.includeAgentsMd : Boolean(record.includeAgentsMd),
    includeRepoFileListing: record.includeRepoFileListing === undefined ? fallback.includeRepoFileListing : Boolean(record.includeRepoFileListing),
    repoRootRequired: record.repoRootRequired === undefined ? fallback.repoRootRequired : Boolean(record.repoRootRequired),
    maxTurns: normalizeNullableInteger(record.maxTurns, fallback.maxTurns),
  });
}
```

Use the same `JsonRecordReader.asObject(...)` pattern in:

- `normalizeUserPreset`
- `normalizeOperationModeAllowedTools`
- `normalizePresets`
- `getConfigPresets`

Concrete replacements:

```ts
function normalizeUserPreset(input: unknown): SiftPreset | null {
  const record = JsonRecordReader.asObject(input);
  if (!record) {
    return null;
  }
  const reader = new JsonRecordReader(record);
  const id = normalizePresetId(record.id);
  if (!id || BUILTIN_PRESET_IDS.has(id)) {
    return null;
  }
  const presetKind = getPresetKindFromRecord(record, 'summary');
  const operationMode = getOperationModeFromRecord(record, presetKind === 'plan' || presetKind === 'repo-search' ? 'read-only' : 'summary', presetKind);
  const defaultAllowedTools = getDefaultAllowedToolsForOperationMode(operationMode);
  return buildPreset({
    id,
    label: reader.optionalString('label') || id,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    presetKind,
    operationMode,
    promptPrefix: normalizePromptPrefix(record.promptPrefix),
    allowedTools: normalizeToolList(record.allowedTools, defaultAllowedTools),
    surfaces: normalizeSurfaceList(record.surfaces, presetKind === 'summary' ? ['cli'] : ['web']),
    useForSummary: Boolean(record.useForSummary),
    builtin: false,
    deletable: true,
    includeAgentsMd: record.includeAgentsMd === undefined ? true : Boolean(record.includeAgentsMd),
    includeRepoFileListing: record.includeRepoFileListing === undefined ? true : Boolean(record.includeRepoFileListing),
    repoRootRequired: record.repoRootRequired === undefined ? (presetKind === 'plan' || presetKind === 'repo-search') : Boolean(record.repoRootRequired),
    maxTurns: normalizeNullableInteger(record.maxTurns, presetKind === 'plan' || presetKind === 'repo-search' ? 45 : null),
  });
}
```

```ts
export function normalizeOperationModeAllowedTools(input: unknown): OperationModeAllowedTools {
  const record = JsonRecordReader.fromUnknown(input).record;
  const summaryTools = normalizeToolList(record.summary, DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.summary);
  if (
    summaryTools.includes('find_text')
    && summaryTools.includes('read_lines')
    && summaryTools.includes('json_filter')
    && !summaryTools.includes('json_get')
  ) {
    summaryTools.push('json_get');
  }
  return {
    summary: summaryTools,
    'read-only': normalizeToolList(record['read-only'], DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']),
    full: normalizeToolList(record.full, DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full),
  };
}
```

```ts
export function normalizePresets(input: unknown): SiftPreset[] {
  const presetsById = new Map<string, SiftPreset>();
  const overlays = Array.isArray(input) ? input : [];
  const overlayById = new Map<string, unknown>();
  for (const item of overlays) {
    const record = JsonRecordReader.asObject(item);
    if (!record) {
      continue;
    }
    const id = normalizePresetId(record.id);
    if (!id) {
      continue;
    }
    overlayById.set(id, item);
  }
  for (const builtin of BUILTIN_PRESETS) {
    presetsById.set(builtin.id, normalizePresetRecord(overlayById.get(builtin.id), builtin));
  }
  for (const item of overlays) {
    const normalized = normalizeUserPreset(item);
    if (!normalized || presetsById.has(normalized.id)) {
      continue;
    }
    presetsById.set(normalized.id, normalized);
  }
  const result = Array.from(presetsById.values());
  const hasSummaryDefault = result.some((preset) => preset.presetKind === 'summary' && preset.useForSummary);
  if (!hasSummaryDefault) {
    const summaryPreset = result.find((preset) => preset.id === 'summary');
    if (summaryPreset) {
      summaryPreset.useForSummary = true;
    }
  }
  return result;
}
```

```ts
export function getConfigPresets(config: unknown): SiftPreset[] {
  const record = JsonRecordReader.fromUnknown(config).record;
  return normalizePresets(record.Presets);
}
```

- [ ] **Step 4: Run preset and contract tests**

Run:

```powershell
npm run typecheck
npm test -- presets
npm test -- server-boundary-dict-contract
```

Expected: preset tests PASS. Contract test no longer reports `src/presets.ts`.

- [ ] **Step 5: Commit preset typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/presets.ts tests/presets.test.ts
git commit -m "refactor: type preset normalization boundary"
```

---

## Task 5: Make Chat Sessions and Messages First-Class Types

**Files:**
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/thinking-retention-policy.ts`
- Modify: `tests/chat-sessions-db.test.ts`
- Modify: `tests/status-server-chat.test.ts`
- Test: `tests/chat-sessions-db.test.ts`, `tests/status-server-chat.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Add behavior tests for typed persisted messages**

Append to `tests/chat-sessions-db.test.ts`:

```ts
test('chat session persistence keeps typed tool and timing fields', () => {
  const runtimeRoot = createRuntimeRoot();
  const session: ChatSession = {
    id: 'typed-session',
    title: 'Typed Session',
    model: 'model-a',
    contextWindowTokens: 4096,
    thinkingEnabled: true,
    webSearchEnabled: false,
    presetId: 'repo-search',
    mode: 'repo-search',
    planRepoRoot: runtimeRoot,
    condensedSummary: '',
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    updatedAtUtc: '2026-01-01T00:00:00.000Z',
    messages: [{
      id: 'm1',
      role: 'assistant',
      kind: 'assistant_tool_call',
      content: 'rg -n Dict src',
      inputTokensEstimate: 3,
      outputTokensEstimate: 5,
      thinkingTokens: 7,
      inputTokensEstimated: false,
      outputTokensEstimated: false,
      thinkingTokensEstimated: false,
      promptCacheTokens: 1,
      promptEvalTokens: 2,
      promptTokensPerSecond: 10,
      generationTokensPerSecond: 20,
      requestDurationMs: 30,
      promptEvalDurationMs: 40,
      generationDurationMs: 50,
      requestStartedAtUtc: '2026-01-01T00:00:01.000Z',
      thinkingStartedAtUtc: '2026-01-01T00:00:02.000Z',
      thinkingEndedAtUtc: '2026-01-01T00:00:03.000Z',
      answerStartedAtUtc: '2026-01-01T00:00:04.000Z',
      answerEndedAtUtc: '2026-01-01T00:00:05.000Z',
      speculativeAcceptedTokens: 6,
      speculativeGeneratedTokens: 8,
      associatedToolTokens: 9,
      thinkingContent: 'thinking',
      toolCallCommand: 'rg -n Dict src',
      toolCallTurn: 1,
      toolCallMaxTurns: 2,
      toolCallExitCode: 0,
      toolCallPromptTokenCount: 11,
      toolCallOutputSnippet: 'snippet',
      toolCallOutput: 'full output',
      createdAtUtc: '2026-01-01T00:00:06.000Z',
      sourceRunId: 'run-1',
      compressedIntoSummary: false,
      groundingStatus: 'fetched',
    }],
  };

  saveChatSession(runtimeRoot, session);

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, 'typed-session'));
  assert.equal(reloaded?.messages?.[0]?.kind, 'assistant_tool_call');
  assert.equal(reloaded?.messages?.[0]?.toolCallCommand, 'rg -n Dict src');
  assert.equal(reloaded?.messages?.[0]?.groundingStatus, 'fetched');
  assert.equal(reloaded?.messages?.[0]?.promptEvalDurationMs, 40);
  assert.equal(reloaded?.messages?.[0]?.generationTokensPerSecond, 20);
});
```

Use the existing test helper for runtime root in that file. If the file already exposes a helper with another name, use the existing helper and keep the body unchanged.

- [ ] **Step 2: Run focused chat session tests**

Run:

```powershell
npm run build:test
npm test -- chat-sessions-db
npm test -- status-server-chat
```

Expected: PASS before refactor.

- [ ] **Step 3: Replace `Dict` aliases with explicit types**

Modify `src/state/chat-sessions.ts` imports only if a typed JSON row parser is needed. Do not add a generic `JsonRecordReader` pass over already-typed `ChatMessage` values.

Add explicit message/session types:

```ts
export type ChatSessionMode = 'chat' | 'plan' | 'repo-search';
export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageKind = 'user_text' | 'assistant_answer' | 'assistant_thinking' | 'assistant_tool_call';
export type ChatGroundingStatus = 'ungrounded' | 'snippet_only' | 'fetched';

export type ChatMessage = {
  id: string;
  role: ChatMessageRole;
  kind: ChatMessageKind;
  content: string;
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  thinkingTokens: number;
  inputTokensEstimated: boolean;
  outputTokensEstimated: boolean;
  thinkingTokensEstimated: boolean;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  requestDurationMs: number | null;
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  requestStartedAtUtc: string | null;
  thinkingStartedAtUtc: string | null;
  thinkingEndedAtUtc: string | null;
  answerStartedAtUtc: string | null;
  answerEndedAtUtc: string | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  associatedToolTokens: number | null;
  thinkingContent: string | null;
  toolCallCommand: string | null;
  toolCallTurn: number | null;
  toolCallMaxTurns: number | null;
  toolCallExitCode: number | null;
  toolCallPromptTokenCount: number | null;
  toolCallOutputSnippet: string | null;
  toolCallOutput: string | null;
  createdAtUtc: string;
  sourceRunId: string | null;
  compressedIntoSummary: boolean;
  groundingStatus: ChatGroundingStatus | null;
};

export type ChatSession = {
  id: string;
  title: string;
  model: string | null;
  contextWindowTokens: number;
  thinkingEnabled: boolean;
  webSearchEnabled: boolean;
  presetId: string;
  mode: ChatSessionMode;
  planRepoRoot: string;
  condensedSummary: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  messages: ChatMessage[];
};
```

Add a typed SQLite row mapper for the actual untyped boundary, immediately after `normalizeGroundingStatus`:

```ts
function mapMessageRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    kind: normalizeMessageKind(row.kind, row.role),
    content: row.content,
    inputTokensEstimate: row.input_tokens_estimate,
    outputTokensEstimate: row.output_tokens_estimate,
    thinkingTokens: row.thinking_tokens,
    inputTokensEstimated: row.input_tokens_estimated === 1,
    outputTokensEstimated: row.output_tokens_estimated === 1,
    thinkingTokensEstimated: row.thinking_tokens_estimated === 1,
    promptCacheTokens: row.prompt_cache_tokens,
    promptEvalTokens: row.prompt_eval_tokens,
    promptTokensPerSecond: row.prompt_tokens_per_second,
    generationTokensPerSecond: row.output_tokens_per_second,
    requestDurationMs: row.request_duration_ms,
    promptEvalDurationMs: row.prompt_eval_duration_ms,
    generationDurationMs: row.generation_duration_ms,
    requestStartedAtUtc: row.request_started_at_utc,
    thinkingStartedAtUtc: row.thinking_started_at_utc,
    thinkingEndedAtUtc: row.thinking_ended_at_utc,
    answerStartedAtUtc: row.answer_started_at_utc,
    answerEndedAtUtc: row.answer_ended_at_utc,
    speculativeAcceptedTokens: row.speculative_accepted_tokens,
    speculativeGeneratedTokens: row.speculative_generated_tokens,
    associatedToolTokens: row.associated_tool_tokens,
    thinkingContent: row.thinking_content,
    toolCallCommand: row.tool_call_command,
    toolCallTurn: row.tool_call_turn,
    toolCallMaxTurns: row.tool_call_max_turns,
    toolCallExitCode: row.tool_call_exit_code,
    toolCallPromptTokenCount: row.tool_call_prompt_token_count,
    toolCallOutputSnippet: row.tool_call_output_snippet,
    toolCallOutput: row.tool_call_output,
    createdAtUtc: row.created_at_utc,
    sourceRunId: row.source_run_id,
    compressedIntoSummary: row.compressed_into_summary === 1,
    groundingStatus: normalizeGroundingStatus(row.grounding_status),
  };
}
```

Add a signed integer helper for exit codes:

```ts
function toNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
```

Use `mapMessageRow` in `readSessionById`:

```ts
messages: messageRows.map((message) => mapMessageRow(message)),
```

In `saveChatSession`, replace:

```ts
const message = messages[index] as Dict;
```

with:

```ts
const message = messages[index];
```

Then use `message` fields directly in `insertMessage.run(...)`. Keep existing defaulting for generated IDs and timestamps, but do not re-parse a `ChatMessage` through a generic object reader. For `toolCallExitCode`, use `toNullableInteger(message.toolCallExitCode)` so negative process exit codes persist.

- [ ] **Step 3.1: Type thinking retention policy with chat messages**

Modify `src/thinking-retention-policy.ts`:

```ts
import type { ChatMessage as PlannerChatMessage } from './repo-search/planner-protocol.js';
import type { ChatMessage as PersistedChatMessage } from './state/chat-sessions.js';

export class ThinkingRetentionPolicy {
  constructor(private readonly maintainPerStepThinking: boolean) {}

  prunePersistedMessages(messages: PersistedChatMessage[]): PersistedChatMessage[] {
    if (this.maintainPerStepThinking) {
      return messages;
    }
    const latestThinkingIndex = this.findLatestPersistedThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return messages;
    }
    return messages.filter((message, index) => message.kind !== 'assistant_thinking' || index === latestThinkingIndex);
  }

  prunePlannerMessages(messages: PlannerChatMessage[]): void {
    if (this.maintainPerStepThinking) {
      return;
    }
    const latestThinkingIndex = this.findLatestPlannerThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return;
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (index !== latestThinkingIndex) {
        delete messages[index].reasoning_content;
      }
    }
  }

  recordTurnThinking(turnThinking: Record<number, string>, turn: number, thinkingText: string): void {
    if (!this.maintainPerStepThinking) {
      for (const key of Object.keys(turnThinking)) {
        delete turnThinking[Number(key)];
      }
    }
    turnThinking[turn] = thinkingText;
  }

  private findLatestPersistedThinkingIndex(messages: PersistedChatMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.kind === 'assistant_thinking') {
        return index;
      }
    }
    return -1;
  }

  private findLatestPlannerThinkingIndex(messages: PlannerChatMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const reasoningContent = messages[index].reasoning_content;
      if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
        return index;
      }
    }
    return -1;
  }
}
```

This preserves planner-retention behavior while removing the persisted-message `Dict[]` boundary.

In `src/status-server/chat.ts`, remove casts around the policy call:

```ts
const prunedMessages = new ThinkingRetentionPolicy(options.maintainPerStepThinking === true)
  .prunePersistedMessages(messages);
```

Add `src/thinking-retention-policy.ts` to `TARGETS` in `tests/server-boundary-dict-contract.test.ts` as part of this task.

- [ ] **Step 4: Run chat session tests**

Run:

```powershell
npm run typecheck
npm test -- chat-sessions-db
npm test -- status-server-chat
npm test -- server-boundary-dict-contract
```

Expected: chat session tests PASS. Contract no longer reports `src/state/chat-sessions.ts`.

- [ ] **Step 5: Commit chat session typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/state/chat-sessions.ts src/thinking-retention-policy.ts tests/chat-sessions-db.test.ts tests/status-server-chat.test.ts
git commit -m "refactor: make chat sessions typed"
```

---

## Task 6: Type Chat Runtime and Repo-Search Scorecards

**Files:**
- Create: `src/status-server/repo-search-scorecard-types.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `tests/status-server-chat.test.ts`
- Modify: `tests/repo-search-chat-types.test.ts`
- Test: `tests/status-server-chat.test.ts`, `tests/repo-search-chat-types.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Add tests for typed repo-search scorecard extraction**

Create or append to `tests/repo-search-chat-types.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRepoSearchResult,
  getRepoSearchTasks,
  getRepoSearchTotals,
} from '../src/status-server/repo-search-scorecard-types.js';

test('normalizeRepoSearchResult reads typed scorecard tasks and totals', () => {
  const result = normalizeRepoSearchResult({
    requestId: 'r1',
    transcriptPath: 'transcript.jsonl',
    artifactPath: 'artifact.json',
    scorecard: {
      totals: { promptTokens: 10, outputTokens: 20 },
      tasks: [{
        finalOutput: 'answer',
        turnsUsed: 2,
        groundingStatus: 'fetched',
        commands: [{ turn: 1, command: 'rg Dict', output: 'hit', exitCode: 0, outputTokens: 3 }],
        turnThinking: { 1: 'thinking' },
      }],
    },
  });

  const tasks = getRepoSearchTasks(result.scorecard);
  const totals = getRepoSearchTotals(result.scorecard);

  assert.equal(result.requestId, 'r1');
  assert.equal(tasks[0]?.finalOutput, 'answer');
  assert.equal(tasks[0]?.commands[0]?.command, 'rg Dict');
  assert.equal(totals.promptTokens, 10);
  assert.equal(totals.outputTokens, 20);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
npm run typecheck:test
```

Expected: FAIL because `repo-search-scorecard-types.ts` does not exist.

- [ ] **Step 3: Add typed scorecard module**

Create `src/status-server/repo-search-scorecard-types.ts`:

```ts
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { ChatGroundingStatus } from '../repo-search/chat-grounding-policy.js';

export type RepoSearchCommandResult = {
  turn: number | null;
  command: string;
  displayCommand: string;
  output: string;
  outputSnippet: string;
  exitCode: number | null;
  outputTokens: number | null;
  outputTokensEstimated: boolean;
};

export type RepoSearchTaskResult = {
  finalOutput: string;
  turnsUsed: number | null;
  groundingStatus: ChatGroundingStatus | null;
  commands: RepoSearchCommandResult[];
  turnThinking: { readonly [turn: string]: string };
  missingSignals: string[];
};

export type RepoSearchTotals = {
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  outputTokensEstimatedCount: number | null;
  thinkingTokensEstimatedCount: number | null;
};

export type RepoSearchScorecard = {
  totals: RepoSearchTotals;
  tasks: RepoSearchTaskResult[];
};

export type RepoSearchResult = {
  requestId: string;
  transcriptPath: string;
  artifactPath: string;
  scorecard: RepoSearchScorecard;
};

function normalizeGroundingStatus(value: unknown): ChatGroundingStatus | null {
  return value === 'ungrounded' || value === 'snippet_only' || value === 'fetched' ? value : null;
}

function readNullableNumber(reader: JsonRecordReader, key: string): number | null {
  return reader.nullableNonNegativeNumber(key);
}

function normalizeCommand(value: unknown): RepoSearchCommandResult {
  const reader = JsonRecordReader.fromUnknown(value);
  return {
    turn: reader.nullableNonNegativeInteger('turn'),
    command: reader.string('command'),
    displayCommand: reader.string('displayCommand'),
    output: reader.string('output'),
    outputSnippet: reader.string('outputSnippet'),
    exitCode: reader.number('exitCode'),
    outputTokens: reader.nullableNonNegativeInteger('outputTokens'),
    outputTokensEstimated: reader.value('outputTokensEstimated') !== false,
  };
}

function normalizeTask(value: unknown): RepoSearchTaskResult {
  const reader = JsonRecordReader.fromUnknown(value);
  const commandsRaw = reader.value('commands');
  const missingSignalsRaw = reader.value('missingSignals');
  const turnThinkingRaw = reader.object('turnThinking') || {};
  const turnThinking: { [turn: string]: string } = {};
  for (const [turn, thinking] of Object.entries(turnThinkingRaw)) {
    if (typeof thinking === 'string') {
      turnThinking[turn] = thinking;
    }
  }
  return {
    finalOutput: reader.string('finalOutput'),
    turnsUsed: reader.nullableNonNegativeInteger('turnsUsed'),
    groundingStatus: normalizeGroundingStatus(reader.value('groundingStatus')),
    commands: Array.isArray(commandsRaw) ? commandsRaw.map((entry) => normalizeCommand(entry)) : [],
    turnThinking,
    missingSignals: Array.isArray(missingSignalsRaw)
      ? missingSignalsRaw.map((entry) => String(entry)).filter((entry) => entry.length > 0)
      : [],
  };
}

function normalizeTotals(value: unknown): RepoSearchTotals {
  const reader = JsonRecordReader.fromUnknown(value);
  return {
    promptTokens: readNullableNumber(reader, 'promptTokens'),
    outputTokens: readNullableNumber(reader, 'outputTokens'),
    thinkingTokens: readNullableNumber(reader, 'thinkingTokens'),
    promptCacheTokens: readNullableNumber(reader, 'promptCacheTokens'),
    promptEvalTokens: readNullableNumber(reader, 'promptEvalTokens'),
    promptEvalDurationMs: readNullableNumber(reader, 'promptEvalDurationMs'),
    generationDurationMs: readNullableNumber(reader, 'generationDurationMs'),
    outputTokensEstimatedCount: readNullableNumber(reader, 'outputTokensEstimatedCount'),
    thinkingTokensEstimatedCount: readNullableNumber(reader, 'thinkingTokensEstimatedCount'),
  };
}

export function normalizeRepoSearchScorecard(value: unknown): RepoSearchScorecard {
  const reader = JsonRecordReader.fromUnknown(value);
  const tasksRaw = reader.value('tasks');
  return {
    totals: normalizeTotals(reader.value('totals')),
    tasks: Array.isArray(tasksRaw) ? tasksRaw.map((entry) => normalizeTask(entry)) : [],
  };
}

export function normalizeRepoSearchResult(value: unknown): RepoSearchResult {
  const reader = JsonRecordReader.fromUnknown(value);
  return {
    requestId: reader.string('requestId'),
    transcriptPath: reader.string('transcriptPath'),
    artifactPath: reader.string('artifactPath'),
    scorecard: normalizeRepoSearchScorecard(reader.value('scorecard')),
  };
}

export function getRepoSearchTasks(scorecard: RepoSearchScorecard): RepoSearchTaskResult[] {
  return scorecard.tasks;
}

export function getRepoSearchTotals(scorecard: RepoSearchScorecard): RepoSearchTotals {
  return scorecard.totals;
}
```

- [ ] **Step 4: Refactor `src/status-server/chat.ts` to use typed messages and scorecards**

Modify imports:

```ts
import type { ChatMessage, ChatSession } from '../state/chat-sessions.js';
import {
  normalizeRepoSearchResult,
  type RepoSearchCommandResult,
  type RepoSearchResult,
  type RepoSearchScorecard,
} from './repo-search-scorecard-types.js';
```

Replace message helper signatures:

```ts
function getMessageContextTokenEstimate(message: ChatMessage): number
function getMessageThinkingTokenEstimate(message: ChatMessage): number
function formatChatMessageForPrompt(message: ChatMessage): string
function getMessageToolTokenEstimate(message: ChatMessage): number
function getMessageToolTokenFallbackEstimate(message: ChatMessage): number
function appendReplayToolMessages(history: PlannerChatMessage[], message: ChatMessage, reasoningContent: string): void
```

Replace local `getTrimmedString` with direct null-aware reads:

```ts
function trimText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}
```

This helper name is not in the duplicate-helper contract. Keep it only if needed; prefer inline `trimText(message.toolCallOutput)`.

Replace `buildPlanMarkdownFromRepoSearch` signature:

```ts
export function buildPlanMarkdownFromRepoSearch(userPrompt: string, repoRoot: string, result: RepoSearchResult | null | undefined): string {
  const normalized = result ? normalizeRepoSearchResult(result) : null;
  const tasks = normalized?.scorecard.tasks || [];
  const primaryTask = tasks[0] || null;
  const modelOutput = primaryTask?.finalOutput
    ? RepoSearchOutputFormatter.collapseRepeatedWholeOutput(primaryTask.finalOutput)
    : 'No final planner output was produced.';
  const commandEvidence: Array<{ command: string; output: string }> = [];
  for (let taskIndex = tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
    const task = tasks[taskIndex];
    for (let commandIndex = task.commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
      const command = task.commands[commandIndex];
      const commandText = command.displayCommand || command.command;
      const output = command.output || command.outputSnippet;
      if (commandText || output) {
        commandEvidence.push({ command: commandText, output: truncatePlanEvidence(output) });
      }
      if (commandEvidence.length >= 8) {
        break;
      }
    }
    if (commandEvidence.length >= 8) {
      break;
    }
  }
```

Continue building the markdown lines in the same order as the current function, with `primaryTask?.missingSignals` changed to `primaryTask?.missingSignals || []` and transcript/artifact paths read from `normalized`.

Replace `getScorecardTotal`:

```ts
export function getScorecardTotal(scorecard: RepoSearchScorecard | null | undefined, key: keyof RepoSearchScorecard['totals']): number | null {
  const value = scorecard?.totals[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
```

Replace `buildToolMessageFromCommand`:

```ts
function buildToolMessageFromCommand(command: RepoSearchCommandResult, turnsUsed: number): PersistToolMessage | null {
  const commandText = getDisplayToolCommand(command);
  const output = command.output || command.outputSnippet;
  if (!commandText && !output) {
    return null;
  }
  const turn = typeof command.turn === 'number' && command.turn >= 1 ? command.turn : 1;
  const outputTokens = getChatUsageValue(command.outputTokens);
  return {
    id: crypto.randomUUID(),
    content: commandText,
    toolCallCommand: commandText,
    toolCallTurn: turn,
    toolCallMaxTurns: turnsUsed,
    toolCallExitCode: command.exitCode,
    toolCallPromptTokenCount: null,
    toolCallOutputSnippet: output.length > 200 ? `${output.slice(0, 200)}...` : output,
    toolCallOutput: output,
    outputTokens,
    outputTokensEstimated: outputTokens === null || command.outputTokensEstimated !== false,
  };
}
```

The existing `getDisplayToolCommand` accepts the old `Dict`; update it in Task 8 or overload it here with a local explicit string:

```ts
const commandText = command.displayCommand || command.command;
```

Replace `buildPersistTurnsFromRepoSearchResult`:

```ts
export function buildPersistTurnsFromRepoSearchResult(result: RepoSearchResult | null | undefined): PersistTurn[] {
  const normalized = result ? normalizeRepoSearchResult(result) : null;
  const tasks = normalized?.scorecard.tasks || [];
  const turns: PersistTurn[] = [];
  for (const task of tasks) {
    const commandTurns = task.commands
      .map((command) => command.turn)
      .filter((turn): turn is number => Number.isInteger(turn) && turn >= 1);
    const maxCommandTurn = commandTurns.length ? Math.max(...commandTurns) : 0;
    const rawTurnsUsed = task.turnsUsed;
    const turnsUsed = rawTurnsUsed && rawTurnsUsed >= maxCommandTurn ? rawTurnsUsed : Math.max(maxCommandTurn, 1);
    const toolsByTurn = new Map<number, PersistToolMessage[]>();
    for (const command of task.commands) {
      const toolMessage = buildToolMessageFromCommand(command, turnsUsed);
      if (!toolMessage) {
        continue;
      }
      const turn = toolMessage.toolCallTurn || 1;
      const list = toolsByTurn.get(turn) || [];
      list.push(toolMessage);
      toolsByTurn.set(turn, list);
    }
    const thinkingTurns = Object.keys(task.turnThinking)
      .map((key) => Number(key))
      .filter((turn) => Number.isFinite(turn));
    const orderedTurns = [...new Set([...toolsByTurn.keys(), ...thinkingTurns])].sort((a, b) => a - b);
    for (const turn of orderedTurns) {
      const rawThinking = task.turnThinking[String(turn)];
      const thinkingText = typeof rawThinking === 'string' ? rawThinking.trim() : '';
      const toolMessages = toolsByTurn.get(turn) || [];
      if (!thinkingText && toolMessages.length === 0) {
        continue;
      }
      turns.push({ thinkingText, toolMessages });
    }
  }
  return turns;
}
```

Replace `buildRepoSearchMarkdown` with the same typed scorecard pattern as `buildPlanMarkdownFromRepoSearch`.

- [ ] **Step 5: Normalize route-level repo-search results in `routes/chat.ts`**

In `src/status-server/routes/chat.ts`, import:

```ts
import { normalizeRepoSearchResult } from '../repo-search-scorecard-types.js';
```

After each `executeRepoSearch(...)`, add:

```ts
const repoSearchResult = normalizeRepoSearchResult(result);
```

Then replace:

```ts
const scorecardTasks = ((result.scorecard as Dict)?.tasks as Dict[]) || [];
assistantContent = String(scorecardTasks[0]?.finalOutput || '').trim();
```

with:

```ts
const scorecardTasks = repoSearchResult.scorecard.tasks;
assistantContent = scorecardTasks[0]?.finalOutput.trim() || '';
```

Replace `result.scorecard` arguments with `repoSearchResult.scorecard` for:

- `getScorecardTotal`
- `hasEstimatedScorecardTokens`
- `getRepoSearchGenerationTokensPerSecond`
- `getChatGroundingStatus`

Pass `repoSearchResult` to:

- `buildPersistTurnsFromRepoSearchResult`
- `buildPlanMarkdownFromRepoSearch`
- `buildRepoSearchMarkdown`

- [ ] **Step 6: Run chat and scorecard tests**

Run:

```powershell
npm run typecheck
npm test -- repo-search-chat-types
npm test -- status-server-chat
npm test -- server-boundary-dict-contract
```

Expected: PASS for scorecard and chat tests. Contract no longer reports `src/status-server/chat.ts` except route files still pending.

- [ ] **Step 7: Commit typed chat runtime**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/repo-search-scorecard-types.ts src/status-server/chat.ts src/status-server/routes/chat.ts tests/status-server-chat.test.ts tests/repo-search-chat-types.test.ts
git commit -m "refactor: type chat repo-search scorecards"
```

---

## Task 7: Type Dashboard Run Records and Artifact Payloads

**Files:**
- Modify: `src/status-server/dashboard-runs.ts`
- Modify: `tests/runtime-status-server.test.ts`
- Modify: `tests/status-server-speculative-metrics.test.ts`
- Modify: `tests/processed-input-metrics.test.ts`
- Test: `tests/runtime-status-server.test.ts`, `tests/status-server-speculative-metrics.test.ts`, `tests/processed-input-metrics.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Add a focused run artifact typing test**

Append to `tests/runtime-status-server.test.ts`:

```ts
const { getProcessedPromptTokens } = require('../dist/lib/provider-helpers.js');
const { upsertRunArtifactPayload } = require('../dist/status-server/dashboard-runs.js');

test('upsertRunArtifactPayload persists typed artifact metrics without map casts', () => {
  return withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const database = new Database(runtimeDbPath);
    try {
      upsertRunArtifactPayload({
        database,
        requestId: 'typed-artifact',
        artifactType: 'summary_request',
        artifactPayload: {
          question: 'Q',
          prompt: 'P',
          model: 'm',
          backend: 'b',
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          finishedAtUtc: '2026-01-01T00:00:02.000Z',
          inputTokens: 10,
          promptCacheTokens: 3,
          promptEvalTokens: 2,
          outputTokens: 20,
          thinkingTokens: 5,
          toolTokens: 7,
          promptEvalDurationMs: 11,
          generationDurationMs: 12,
          wallDurationMs: 2000,
          providerDurationMs: 1500,
        },
      });

      const row = database.prepare('SELECT run_id, title, input_tokens, output_tokens, wall_duration_ms FROM run_logs WHERE run_id = ?')
        .get('typed-artifact') as { run_id: string; title: string; input_tokens: number; output_tokens: number; wall_duration_ms: number };

      assert.equal(row.run_id, 'typed-artifact');
      assert.equal(row.title, 'Q');
      assert.equal(row.input_tokens, getProcessedPromptTokens(10, 3, 2));
      assert.equal(row.output_tokens, 20);
      assert.equal(row.wall_duration_ms, 2000);
    } finally {
      database.close();
    }
  });
});
```

Use the existing `withTempEnv` helper in the file. If the file already imports from `../dist/status-server/dashboard-runs.js`, extend that existing require instead of adding a duplicate require.

- [ ] **Step 2: Run focused run tests**

Run:

```powershell
npm run build:test
npm test -- runtime-status-server
npm test -- status-server-speculative-metrics
npm test -- processed-input-metrics
```

Expected: PASS before refactor.

- [ ] **Step 3: Add typed payload and row structures**

Modify `src/status-server/dashboard-runs.ts` imports:

```ts
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { normalizeRepoSearchResult, type RepoSearchResult, type RepoSearchTotals } from './repo-search-scorecard-types.js';
```

Add local types near `RunRecord`:

```ts
export type RunRawPaths = {
  statusPath: string | null;
  artifactPath: string | null;
  transcriptPath: string | null;
  repoSearchPath: string | null;
  repoSearchTranscriptPath: string | null;
};

type RunRecordInput = Omit<RunRecord, 'rawPaths'> & {
  rawPaths: RunRawPaths;
};

type RunLogDbRow = {
  run_id: string | null;
  run_kind: string | null;
  terminal_state: string | null;
  started_at_utc: string | null;
  finished_at_utc: string | null;
  title: string | null;
  model: string | null;
  backend: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  tool_tokens: number | null;
  prompt_cache_tokens: number | null;
  prompt_eval_tokens: number | null;
  prompt_eval_duration_ms: number | null;
  generation_duration_ms: number | null;
  speculative_accepted_tokens: number | null;
  speculative_generated_tokens: number | null;
  duration_ms: number | null;
  provider_duration_ms: number | null;
  wall_duration_ms: number | null;
  source_paths_json: string | null;
  request_json?: string | null;
  planner_debug_json?: string | null;
  failed_request_json?: string | null;
  abandoned_request_json?: string | null;
  repo_search_json?: string | null;
};

export type RunArtifactPayload = JsonObject & {
  question?: string;
  prompt?: string;
  model?: string;
  backend?: string;
  repoRoot?: string;
  error?: string;
  createdAtUtc?: string;
  abandonedAtUtc?: string;
  finishedAtUtc?: string;
  updatedAtUtc?: string;
  inputTokens?: number;
  promptCacheTokens?: number;
  promptEvalTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  toolTokens?: number;
  promptEvalDurationMs?: number;
  generationDurationMs?: number;
  wallDurationMs?: number;
  requestDurationMs?: number;
  providerDurationMs?: number;
  outputTokensTotal?: number;
};
```

Change `RunRecord`:

```ts
export type RunRecord = {
  id: string;
  kind: string;
  status: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  durationMs: number | null;
  providerDurationMs: number | null;
  wallDurationMs: number | null;
  rawPaths: RunRawPaths;
};
```

- [ ] **Step 4: Replace run normalization map access**

Replace `normalizeRunRecord(record: Dict)` with:

```ts
function normalizeRunRecord(record: RunRecordInput): RunRecord {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    startedAtUtc: record.startedAtUtc,
    finishedAtUtc: record.finishedAtUtc,
    title: record.title,
    model: record.model,
    backend: record.backend,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    thinkingTokens: record.thinkingTokens,
    toolTokens: record.toolTokens,
    promptCacheTokens: record.promptCacheTokens,
    promptEvalTokens: record.promptEvalTokens,
    promptEvalDurationMs: record.promptEvalDurationMs,
    generationDurationMs: record.generationDurationMs,
    speculativeAcceptedTokens: record.speculativeAcceptedTokens,
    speculativeGeneratedTokens: record.speculativeGeneratedTokens,
    durationMs: record.durationMs,
    providerDurationMs: record.providerDurationMs,
    wallDurationMs: record.wallDurationMs,
    rawPaths: record.rawPaths,
  };
}
```

Replace `parseJsonObjectText`:

```ts
function parseJsonObjectText(text: string | null): JsonObject | null {
  try {
    return JsonRecordReader.parseObjectText(text);
  } catch {
    return null;
  }
}
```

Replace `normalizeRunRecordFromDbRow(row: Dict)` with:

```ts
function normalizeRunRecordFromDbRow(row: RunLogDbRow): RunRecord {
  return normalizeRunRecord({
    id: String(row.run_id || ''),
    kind: String(row.run_kind || 'unknown'),
    status: normalizeStatusForRunRecord(String(row.terminal_state || 'unknown')),
    startedAtUtc: typeof row.started_at_utc === 'string' ? row.started_at_utc : null,
    finishedAtUtc: typeof row.finished_at_utc === 'string' ? row.finished_at_utc : null,
    title: String(row.title || ''),
    model: typeof row.model === 'string' ? row.model : null,
    backend: typeof row.backend === 'string' ? row.backend : null,
    inputTokens: toNonNegativeInteger(row.input_tokens),
    outputTokens: toNonNegativeInteger(row.output_tokens),
    thinkingTokens: toNonNegativeInteger(row.thinking_tokens),
    toolTokens: toNonNegativeInteger(row.tool_tokens),
    promptCacheTokens: toNonNegativeInteger(row.prompt_cache_tokens),
    promptEvalTokens: toNonNegativeInteger(row.prompt_eval_tokens),
    promptEvalDurationMs: toNonNegativeInteger(row.prompt_eval_duration_ms),
    generationDurationMs: toNonNegativeInteger(row.generation_duration_ms),
    speculativeAcceptedTokens: toNullableNonNegativeInteger(row.speculative_accepted_tokens),
    speculativeGeneratedTokens: toNullableNonNegativeInteger(row.speculative_generated_tokens),
    durationMs: toNullableNonNegativeInteger(row.wall_duration_ms) ?? toNullableNonNegativeInteger(row.duration_ms),
    providerDurationMs: toNullableNonNegativeInteger(row.provider_duration_ms),
    wallDurationMs: toNullableNonNegativeInteger(row.wall_duration_ms),
    rawPaths: parseRunRawPaths(row.source_paths_json),
  });
}
```

Add:

```ts
function parseRunRawPaths(text: string | null): RunRawPaths {
  const parsed = parseJsonObjectText(text);
  const reader = new JsonRecordReader(parsed || {});
  return {
    statusPath: reader.nullableString('statusPath'),
    artifactPath: reader.nullableString('artifactPath'),
    transcriptPath: reader.nullableString('transcriptPath'),
    repoSearchPath: reader.nullableString('repoSearchPath'),
    repoSearchTranscriptPath: reader.nullableString('repoSearchTranscriptPath'),
  };
}
```

- [ ] **Step 5: Type artifact payload entry points**

Change signatures:

```ts
export function upsertRunArtifactPayload(options: {
  database: DatabaseInstance;
  requestId: string;
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed' | 'request_abandoned';
  artifactPayload: RunArtifactPayload;
}): void
```

```ts
export function upsertRepoSearchRun(options: {
  database: DatabaseInstance;
  requestId: string;
  taskKind: 'plan' | 'repo-search' | 'chat';
  prompt: string;
  repoRoot: string;
  model: string | null;
  requestMaxTokens: number | null;
  maxTurns: number | null;
  transcriptText: string;
  artifactPayload: RepoSearchResult;
  terminalState: 'completed' | 'failed';
  startedAtUtc: string;
  finishedAtUtc: string;
  requestDurationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
}): void
```

At the start of `upsertRepoSearchRun`, normalize external input:

```ts
const artifactPayload = normalizeRepoSearchResult(options.artifactPayload);
const repoSearchJson = JSON.stringify(artifactPayload, null, 2);
```

Replace uses of `options.artifactPayload` in the function body with `artifactPayload`.

- [ ] **Step 6: Type repo-search totals and title helpers**

Replace `parseRepoSearchTotals(payload: Dict | null): Dict | null` with:

```ts
function parseRepoSearchTotals(payload: RepoSearchResult | null): RepoSearchTotals | null {
  return payload?.scorecard.totals || null;
}
```

Change helper parameters:

```ts
function resolveTerminalState(
  requestPayload: RunArtifactPayload | null,
  failedRequestPayload: RunArtifactPayload | null,
  abandonedPayload: RunArtifactPayload | null,
  repoSearchPayload: RepoSearchResult | null,
): RunLogTerminalState
```

```ts
function resolveTitle(
  requestId: string,
  runKind: RunLogKind,
  requestPayload: RunArtifactPayload | null,
  failedRequestPayload: RunArtifactPayload | null,
  abandonedPayload: RunArtifactPayload | null,
  repoSearchPayload: RepoSearchResult | null,
): string
```

Where JSON is parsed from DB:

```ts
const requestPayload = parseJsonObjectText(requestJson) as RunArtifactPayload | null;
const failedRequestPayload = parseJsonObjectText(failedRequestJson) as RunArtifactPayload | null;
const abandonedPayload = parseJsonObjectText(abandonedRequestJson) as RunArtifactPayload | null;
const parsedRepoSearchPayload = parseJsonObjectText(repoSearchJson);
const repoSearchPayload = parsedRepoSearchPayload ? normalizeRepoSearchResult(parsedRepoSearchPayload) : null;
```

The only casts here are from `JsonObject` to a named payload type, not to `Dict`. The type is a JSON object with explicit known fields.

- [ ] **Step 7: Replace DB row casts**

Use named row types:

```ts
const row = database.prepare(`...`).get(normalizedRequestId) as RunLogDbRow | undefined;
const rows = database.prepare(`...`).all(limitPerGroup) as RunLogDbRow[];
```

For count-only rows:

```ts
type CountRow = { count: number };
const row = database.prepare(countSql).get(cutoff) as CountRow | undefined;
```

For id-only rows:

```ts
type RunIdRow = { run_id: string | null };
const rows = database.prepare(sql).all(...params) as RunIdRow[];
return rows.map((row) => String(row.run_id || ''));
```

For JSONL parsing, use `JsonObject`:

```ts
let parsed: JsonObject | null = null;
try {
  parsed = JsonRecordReader.parseObjectText(line);
} catch {
  parsed = null;
}
if (!parsed) {
  continue;
}
const payload = JsonRecordReader.asObject(parsed.payload) || parsed;
```

- [ ] **Step 8: Type idle summary snapshot rows**

Replace:

```ts
export function normalizeIdleSummarySnapshotRow(row: Dict | null): IdleSummarySnapshotRow | null
```

with:

```ts
type IdleSummarySnapshotDbRow = {
  emitted_at_utc: string | null;
  completed_request_count: number | null;
  input_characters_total: number | null;
  output_characters_total: number | null;
  compression_ratio: number | null;
  input_tokens_total: number | null;
  output_tokens_total: number | null;
  thinking_tokens_total: number | null;
  tool_tokens_total: number | null;
  prompt_cache_tokens_total: number | null;
  prompt_eval_tokens_total: number | null;
  prompt_cache_hit_rate: number | null;
  acceptance_rate: number | null;
  summary_text: string | null;
};

export function normalizeIdleSummarySnapshotRow(row: IdleSummarySnapshotDbRow | null): IdleSummarySnapshotRow | null
```

Use direct row fields in the function body.

- [ ] **Step 9: Run run-related tests**

Run:

```powershell
npm run typecheck
npm test -- runtime-status-server
npm test -- status-server-speculative-metrics
npm test -- processed-input-metrics
npm test -- dashboard-status-server.run-logs
npm test -- server-boundary-dict-contract
```

Expected: all targeted tests PASS. Contract no longer reports `src/status-server/dashboard-runs.ts`.

- [ ] **Step 10: Commit run typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/dashboard-runs.ts tests/runtime-status-server.test.ts tests/status-server-speculative-metrics.test.ts tests/processed-input-metrics.test.ts
git commit -m "refactor: type dashboard run boundaries"
```

---

## Task 8: Add Route Request Normalizers

**Files:**
- Create: `src/status-server/route-request-normalizers.ts`
- Create: `src/status-server/chat-route-request-normalizers.ts`
- Create: `tests/route-request-normalizers.test.ts`
- Test: `tests/route-request-normalizers.test.ts`

- [ ] **Step 1: Write request normalizer tests**

Create `tests/route-request-normalizers.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExecutionTokenRequest,
  parseRepoSearchRequest,
  parseSummaryRequest,
  parseDashboardRunLogDeleteRequest,
} from '../src/status-server/route-request-normalizers.js';
import {
  parseChatSessionCreateRequest,
  parseChatSessionUpdateRequest,
  parseChatMessageRequest,
  parseChatRepoRequest,
} from '../src/status-server/chat-route-request-normalizers.js';

test('core route request normalizers return typed values', () => {
  assert.deepEqual(parseExecutionTokenRequest({ token: ' abc ' }), { token: 'abc' });
  assert.equal(parseExecutionTokenRequest({ token: ' ' }), null);

  assert.deepEqual(parseRepoSearchRequest({ prompt: ' p ', repoRoot: ' C:/repo ', model: ' m ', maxTurns: '3' }), {
    prompt: 'p',
    repoRoot: 'C:/repo',
    model: 'm',
    maxTurns: 3,
  });

  assert.deepEqual(parseSummaryRequest({
    question: ' q ',
    inputText: ' text ',
    requestTimeoutSeconds: '5',
    format: 'json',
    backend: 'b',
    model: 'm',
    commandExitCode: 1,
  }), {
    question: 'q',
    inputText: ' text ',
    format: 'json',
    backend: 'b',
    model: 'm',
    commandExitCode: 1,
    requestTimeoutSeconds: 5,
    policyProfile: undefined,
    sourceKind: undefined,
    timing: undefined,
  });

  assert.deepEqual(parseDashboardRunLogDeleteRequest({ mode: 'count', type: 'summary', count: '4' }), {
    mode: 'count',
    type: 'summary',
    count: 4,
  });
  assert.deepEqual(parseDashboardRunLogDeleteRequest({ mode: 'beforeDate', type: 'repo_search', beforeDate: '2026-01-01' }), {
    mode: 'beforeDate',
    type: 'repo_search',
    beforeDate: '2026-01-01',
  });
});

test('chat route request normalizers return typed values', () => {
  assert.deepEqual(parseChatSessionCreateRequest({ presetId: ' plan ' }), { presetId: 'plan' });
  assert.deepEqual(parseChatSessionUpdateRequest({
    title: ' T ',
    thinkingEnabled: false,
    webSearchEnabled: true,
    presetId: ' repo-search ',
    planRepoRoot: ' C:/repo ',
  }), {
    title: 'T',
    thinkingEnabled: false,
    webSearchEnabled: true,
    presetId: 'repo-search',
    mode: undefined,
    planRepoRoot: 'C:/repo',
  });
  assert.deepEqual(parseChatMessageRequest({ content: ' hello ', assistantContent: ' answer ' }), {
    content: 'hello',
    assistantContent: 'answer',
  });
  assert.deepEqual(parseChatRepoRequest({ content: ' plan ', repoRoot: ' C:/repo ' }), {
    content: 'plan',
    repoRoot: 'C:/repo',
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
npm run typecheck:test
```

Expected: FAIL because normalizer modules do not exist.

- [ ] **Step 3: Implement shared route normalizers**

Create `src/status-server/route-request-normalizers.ts`:

```ts
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import type {
  SummaryPolicyProfile,
  SummarySourceKind,
} from '../summary/types.js';
import type { DashboardRunLogType } from './dashboard-runs.js';

export type ExecutionTokenRequest = { token: string };
export type RepoSearchRouteRequest = { prompt: string; repoRoot: string; model: string | null; maxTurns: number | null };
export type SummaryRouteRequest = {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile | undefined;
  backend: string | undefined;
  model: string | undefined;
  sourceKind: SummarySourceKind | undefined;
  commandExitCode: number | undefined;
  requestTimeoutSeconds: number;
  timing: { processStartedAtMs?: number | null; stdinWaitMs?: number | null; serverPreflightMs?: number | null } | undefined;
};
export type DashboardRunLogDeleteRequest = { mode: 'count' | 'beforeDate'; type: DashboardRunLogType; count?: number; beforeDate?: string };

const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS = 30;

function optionalString(reader: JsonRecordReader, key: string): string | undefined {
  return reader.optionalString(key);
}

function optionalNumber(reader: JsonRecordReader, key: string): number | undefined {
  const value = reader.number(key);
  return value === null ? undefined : value;
}

function normalizeSummaryPolicyProfile(value: unknown): SummaryPolicyProfile | undefined {
  return value === 'fast' || value === 'balanced' || value === 'thorough' ? value : undefined;
}

function normalizeSummarySourceKind(value: unknown): SummarySourceKind | undefined {
  return value === 'stdin' || value === 'file' || value === 'command' || value === 'text' ? value : undefined;
}

function readSummaryTiming(value: unknown): SummaryRouteRequest['timing'] {
  const record = JsonRecordReader.asObject(value);
  if (!record) {
    return undefined;
  }
  const reader = new JsonRecordReader(record);
  return {
    processStartedAtMs: reader.number('processStartedAtMs'),
    stdinWaitMs: reader.number('stdinWaitMs'),
    serverPreflightMs: reader.number('serverPreflightMs'),
  };
}

export function parseExecutionTokenRequest(body: JsonObject): ExecutionTokenRequest | null {
  const token = new JsonRecordReader(body).optionalString('token');
  return token ? { token } : null;
}

export function parseRepoSearchRequest(body: JsonObject): RepoSearchRouteRequest | null {
  const reader = new JsonRecordReader(body);
  const prompt = reader.optionalString('prompt');
  if (!prompt) {
    return null;
  }
  return {
    prompt,
    repoRoot: reader.optionalString('repoRoot') || process.cwd(),
    model: reader.nullableString('model'),
    maxTurns: reader.nullableNonNegativeInteger('maxTurns'),
  };
}

export function parseSummaryRequest(body: JsonObject): SummaryRouteRequest | null {
  const reader = new JsonRecordReader(body);
  const question = reader.optionalString('question');
  const inputText = typeof reader.value('inputText') === 'string' ? String(reader.value('inputText')) : '';
  if (!question || !inputText.trim()) {
    return null;
  }
  return {
    question,
    inputText,
    format: reader.value('format') === 'json' ? 'json' : 'text',
    policyProfile: normalizeSummaryPolicyProfile(reader.value('policyProfile')),
    backend: optionalString(reader, 'backend'),
    model: optionalString(reader, 'model'),
    sourceKind: normalizeSummarySourceKind(reader.value('sourceKind')),
    commandExitCode: optionalNumber(reader, 'commandExitCode'),
    requestTimeoutSeconds: reader.positiveNumber('requestTimeoutSeconds', DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS),
    timing: readSummaryTiming(reader.value('timing')),
  };
}

export function parseDashboardRunLogDeleteRequest(body: JsonObject): DashboardRunLogDeleteRequest | null {
  const reader = new JsonRecordReader(body);
  const modeText = reader.string('mode').toLowerCase();
  const type = reader.string('type').toLowerCase() as DashboardRunLogType;
  const validType = type === 'all' || type === 'summary' || type === 'repo_search' || type === 'planner' || type === 'chat' || type === 'other';
  if (!validType) {
    return null;
  }
  if (modeText === 'count') {
    return { mode: 'count', type, count: Math.max(1, reader.nonNegativeInteger('count', 1)) };
  }
  if (modeText === 'beforedate') {
    const beforeDate = reader.optionalString('beforeDate');
    return beforeDate ? { mode: 'beforeDate', type, beforeDate } : null;
  }
  return null;
}
```

- [ ] **Step 4: Implement chat route normalizers**

Create `src/status-server/chat-route-request-normalizers.ts`:

```ts
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import type { ChatSessionMode } from '../state/chat-sessions.js';

export type ChatSessionCreateRequest = { presetId: string };
export type ChatSessionUpdateRequest = {
  title?: string;
  thinkingEnabled?: boolean;
  webSearchEnabled?: boolean;
  presetId?: string;
  mode?: ChatSessionMode;
  planRepoRoot?: string;
};
export type ChatMessageRequest = { content: string; assistantContent?: string };
export type ChatRepoRequest = { content: string; repoRoot?: string };
export type ChatRepoAppendPreviewRequest = { repoRoot?: string };

function readMode(value: unknown): ChatSessionMode | undefined {
  return value === 'chat' || value === 'plan' || value === 'repo-search' ? value : undefined;
}

export function parseChatSessionCreateRequest(body: JsonObject): ChatSessionCreateRequest {
  const reader = new JsonRecordReader(body);
  return { presetId: reader.optionalString('presetId') || 'chat' };
}

export function parseChatSessionUpdateRequest(body: JsonObject): ChatSessionUpdateRequest {
  const reader = new JsonRecordReader(body);
  return {
    title: reader.optionalString('title'),
    thinkingEnabled: typeof reader.value('thinkingEnabled') === 'boolean' ? Boolean(reader.value('thinkingEnabled')) : undefined,
    webSearchEnabled: typeof reader.value('webSearchEnabled') === 'boolean' ? Boolean(reader.value('webSearchEnabled')) : undefined,
    presetId: reader.optionalString('presetId'),
    mode: readMode(reader.value('mode')),
    planRepoRoot: reader.optionalString('planRepoRoot'),
  };
}

export function parseChatMessageRequest(body: JsonObject): ChatMessageRequest | null {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content');
  if (!content) {
    return null;
  }
  return {
    content,
    assistantContent: reader.optionalString('assistantContent'),
  };
}

export function parseChatRepoRequest(body: JsonObject): ChatRepoRequest | null {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content');
  if (!content) {
    return null;
  }
  return {
    content,
    repoRoot: reader.optionalString('repoRoot'),
  };
}

export function parseChatRepoAppendPreviewRequest(body: JsonObject): ChatRepoAppendPreviewRequest {
  return { repoRoot: new JsonRecordReader(body).optionalString('repoRoot') };
}
```

- [ ] **Step 5: Run normalizer tests**

Run:

```powershell
npm run typecheck
npm test -- route-request-normalizers
```

Expected: PASS.

- [ ] **Step 6: Commit request normalizers**

```powershell
git add src/status-server/route-request-normalizers.ts src/status-server/chat-route-request-normalizers.ts tests/route-request-normalizers.test.ts
git commit -m "feat: add typed route request normalizers"
```

---

## Task 9: Refactor Core Routes to Typed Requests

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/status-server/dashboard-runs.ts`
- Test: `tests/dashboard-status-server.test.ts`, `tests/runtime-status-server.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Run core route tests before refactor**

Run:

```powershell
npm run build:test
npm test -- dashboard-status-server
npm test -- runtime-status-server
```

Expected: PASS or known unrelated failures must be captured before editing.

- [ ] **Step 2: Replace imports and helpers**

In `src/status-server/routes/core.ts`, remove:

```ts
import type { Dict } from '../../lib/types.js';
```

Add:

```ts
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import {
  parseExecutionTokenRequest,
  parseRepoSearchRequest,
  parseSummaryRequest,
} from '../route-request-normalizers.js';
```

Delete local helpers:

```ts
function getOptionalNumber(...)
function getPositiveNumber(...)
function isRecord(...)
function getSummaryTiming(...)
function normalizeSummaryFormat(...)
```

Keep domain-specific enum normalizers only if they are not moved to `route-request-normalizers.ts`.

- [ ] **Step 3: Type repo-search admission input**

Replace:

```ts
function createRepoSearchAdmissionRecord(parsedBody: Dict): RepoSearchAdmissionRecord
```

with:

```ts
function createRepoSearchAdmissionRecord(parsedBody: RepoSearchRouteRequest): RepoSearchAdmissionRecord {
  return {
    requestId: crypto.randomUUID(),
    startedAtUtc: new Date().toISOString(),
    prompt: parsedBody.prompt,
    repoRoot: parsedBody.repoRoot,
    model: parsedBody.model,
    maxTurns: parsedBody.maxTurns,
  };
}
```

Import `type RepoSearchRouteRequest` from `route-request-normalizers.ts`.

- [ ] **Step 4: Replace token body parsing**

For `/execution/heartbeat`:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const tokenRequest = parseExecutionTokenRequest(parsedBody);
if (!tokenRequest) {
  sendJson(res, 400, { error: 'Expected token.' });
  return true;
}
const lease = getActiveExecutionLease(ctx);
if (!lease || lease.token !== tokenRequest.token) {
  sendJson(res, 409, { error: 'Execution lease is not active.' });
  return true;
}
```

For `/execution/release`:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const tokenRequest = parseExecutionTokenRequest(parsedBody);
if (!tokenRequest) {
  sendJson(res, 400, { error: 'Expected token.' });
  return true;
}
const released = releaseExecutionLease(ctx, tokenRequest.token);
```

- [ ] **Step 5: Replace `/repo-search` body parsing**

```ts
const parsedBody = parseJsonBody(await readBody(req));
const repoSearchRequest = parseRepoSearchRequest(parsedBody);
if (!repoSearchRequest) {
  sendJson(res, 400, { error: 'Expected prompt.' });
  return true;
}
const admission = createRepoSearchAdmissionRecord(repoSearchRequest);
```

Use `repoSearchRequest.prompt`, `repoSearchRequest.repoRoot`, `repoSearchRequest.model`, and `repoSearchRequest.maxTurns` when calling `ctx.engineService.executeRepoSearch`.

- [ ] **Step 6: Replace `/summary` body parsing**

```ts
const parsedBody = parseJsonBody(await readBody(req));
const summaryRequest = parseSummaryRequest(parsedBody);
if (!summaryRequest) {
  sendJson(res, 400, { error: 'Expected question and inputText.' });
  return true;
}
```

Then call:

```ts
const result = await ctx.engineService.summarize({
  question: summaryRequest.question,
  inputText: summaryRequest.inputText,
  format: summaryRequest.format,
  policyProfile: summaryRequest.policyProfile,
  backend: summaryRequest.backend,
  model: summaryRequest.model,
  sourceKind: summaryRequest.sourceKind,
  commandExitCode: summaryRequest.commandExitCode,
  requestTimeoutSeconds: summaryRequest.requestTimeoutSeconds,
  timing: summaryRequest.timing,
  statusBackendUrl: `${serviceBaseUrl}/status`,
  skipExecutionLock: true,
  config: readConfig(configPath),
});
```

- [ ] **Step 7: Replace remaining `let parsedBody: Dict` declarations**

Use inferred `const parsedBody = parseJsonBody(...)` for:

- `/command-output/analyze`
- `/preset/run`
- `/eval/run`
- `/status/complete`
- `/config/llama-cpp/test`

Where ad hoc access remains, use `JsonRecordReader`:

```ts
const reader = new JsonRecordReader(parsedBody);
const baseUrl = reader.optionalString('BaseUrl')?.replace(/\/$/u, '') || '';
```

- [ ] **Step 8: Run route tests**

Run:

```powershell
npm run typecheck
npm test -- dashboard-status-server
npm test -- runtime-status-server
npm test -- server-boundary-dict-contract
```

Expected: PASS for core route coverage. Contract no longer reports `src/status-server/routes/core.ts`.

- [ ] **Step 9: Commit core route typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/routes/core.ts src/status-server/dashboard-runs.ts
git commit -m "refactor: type core route requests"
```

---

## Task 10: Refactor Chat Routes to Typed Requests

**Files:**
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/chat.ts`
- Test: `tests/dashboard-status-server.test.ts`, `tests/chat-route-file-listing.test.ts`, `tests/status-server-chat-route-metrics.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Run chat route tests before refactor**

Run:

```powershell
npm run build:test
npm test -- dashboard-status-server
npm test -- chat-route-file-listing
npm test -- status-server-chat-route-metrics
```

Expected: PASS or known unrelated failures captured before editing.

- [ ] **Step 2: Replace imports**

In `src/status-server/routes/chat.ts`, remove:

```ts
import type { Dict } from '../../lib/types.js';
```

Add:

```ts
import {
  parseChatMessageRequest,
  parseChatRepoAppendPreviewRequest,
  parseChatRepoRequest,
  parseChatSessionCreateRequest,
  parseChatSessionUpdateRequest,
} from '../chat-route-request-normalizers.js';
```

Delete local duplicate helper:

```ts
function getPositiveNumber(...)
```

Use the typed scorecard module from Task 6 for all repo-search result access.

- [ ] **Step 3: Type `getChatGroundingStatus`**

Change:

```ts
function getChatGroundingStatus(scorecard: RepoSearchScorecard): ChatGroundingStatus | null {
  return scorecard.tasks[0]?.groundingStatus || null;
}
```

Import `type RepoSearchScorecard` from `../repo-search-scorecard-types.js`.

- [ ] **Step 4: Replace session update parsing**

For `PUT /dashboard/chat/sessions/:id`:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const updateRequest = parseChatSessionUpdateRequest(parsedBody);
const updated: ChatSession = { ...session, updatedAtUtc: new Date().toISOString() };
if (updateRequest.title) {
  updated.title = updateRequest.title;
}
if (updateRequest.thinkingEnabled !== undefined) {
  updated.thinkingEnabled = updateRequest.thinkingEnabled;
}
if (updateRequest.webSearchEnabled !== undefined) {
  updated.webSearchEnabled = updateRequest.webSearchEnabled;
}
if (updateRequest.presetId) {
  const presetId = updateRequest.presetId;
  updated.presetId = findPresetById(presets, presetId)?.id || presetId;
  updated.mode = mapPresetIdToLegacyMode(updated.presetId, presets);
}
if (updateRequest.mode) {
  updated.mode = updateRequest.mode;
  updated.presetId = mapLegacyModeToPresetId(updateRequest.mode);
}
if (updateRequest.planRepoRoot) {
  updated.planRepoRoot = path.resolve(updateRequest.planRepoRoot);
}
```

- [ ] **Step 5: Replace deleted message cast**

Replace:

```ts
const deletedMessage = result.deletedMessage as Dict;
const runId = typeof deletedMessage.sourceRunId === 'string' ? deletedMessage.sourceRunId.trim() : '';
const commandText = typeof deletedMessage.toolCallCommand === 'string'
  ? deletedMessage.toolCallCommand.trim()
  : '';
```

with:

```ts
const deletedMessage = result.deletedMessage;
const runId = deletedMessage.sourceRunId?.trim() || '';
const commandText = deletedMessage.toolCallCommand?.trim() || '';
```

- [ ] **Step 6: Replace session create parsing**

For `POST /dashboard/chat/sessions`:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const createRequest = parseChatSessionCreateRequest(parsedBody);
const requestedPresetId = createRequest.presetId;
```

- [ ] **Step 7: Replace message body parsing**

For non-streaming and streaming message routes:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const messageRequest = parseChatMessageRequest(parsedBody);
if (!messageRequest) {
  sendJson(res, 400, { error: 'Expected content.' });
  return true;
}
const userContent = messageRequest.content;
const usesProvidedAssistantContent = Boolean(messageRequest.assistantContent);
```

Use `messageRequest.assistantContent` when provided.

- [ ] **Step 8: Replace plan/repo-search body parsing**

For `/plan`, `/plan/stream`, and `/repo-search/stream`:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const repoRequest = parseChatRepoRequest(parsedBody);
if (!repoRequest) {
  sendJson(res, 400, { error: 'Expected content.' });
  return true;
}
const requestedRepoRoot = repoRequest.repoRoot
  || session.planRepoRoot?.trim()
  || process.cwd();
```

For `/repo-search/append-preview`:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const previewRequest = parseChatRepoAppendPreviewRequest(parsedBody);
const requestedRepoRoot = previewRequest.repoRoot
  || session.planRepoRoot?.trim()
  || process.cwd();
```

- [ ] **Step 9: Normalize repo-search result once per route**

After each `executeRepoSearch`, use:

```ts
const repoSearchResult = normalizeRepoSearchResult(result);
```

Then:

```ts
const assistantContent = repoSearchResult.scorecard.tasks[0]?.finalOutput.trim() || '';
```

Pass `repoSearchResult.scorecard` to token helpers and `repoSearchResult` to persistence helpers.

- [ ] **Step 10: Run chat route tests**

Run:

```powershell
npm run typecheck
npm test -- dashboard-status-server
npm test -- chat-route-file-listing
npm test -- status-server-chat-route-metrics
npm test -- server-boundary-dict-contract
```

Expected: PASS. Contract no longer reports `src/status-server/routes/chat.ts`.

- [ ] **Step 11: Commit chat route typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/routes/chat.ts src/status-server/chat.ts
git commit -m "refactor: type chat route requests"
```

---

## Task 11: Refactor Dashboard Routes to Typed Requests

**Files:**
- Modify: `src/status-server/routes/dashboard.ts`
- Modify: `src/status-server/dashboard-runs.ts`
- Test: `tests/dashboard-status-server.test.ts`, `tests/dashboard-status-server.run-logs.test.ts`, `tests/benchmark-spec-settings.test.ts`, `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Run dashboard route tests before refactor**

Run:

```powershell
npm run build:test
npm test -- dashboard-status-server
npm test -- dashboard-status-server.run-logs
npm test -- benchmark-spec-settings
```

Expected: PASS or known unrelated failures captured before editing.

- [ ] **Step 2: Replace imports**

In `src/status-server/routes/dashboard.ts`, remove:

```ts
import type { Dict } from '../../lib/types.js';
```

Add:

```ts
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import { parseDashboardRunLogDeleteRequest } from '../route-request-normalizers.js';
import type { JsonObject } from '../../lib/json-types.js';
```

- [ ] **Step 3: Type benchmark spec overrides**

Replace:

```ts
.filter((entry): entry is Dict => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
```

with:

```ts
.map((entry) => JsonRecordReader.asObject(entry))
.filter((entry): entry is JsonObject => entry !== null)
```

Then use a reader in the map:

```ts
.map((entry) => {
  const reader = new JsonRecordReader(entry);
  return {
    label: reader.optionalString('label'),
    SpeculativeEnabled: typeof reader.value('SpeculativeEnabled') === 'boolean' ? Boolean(reader.value('SpeculativeEnabled')) : undefined,
    SpeculativeType: reader.optionalString('SpeculativeType'),
    SpeculativeNgramSizeN: reader.number('SpeculativeNgramSizeN') ?? undefined,
    SpeculativeNgramSizeM: reader.number('SpeculativeNgramSizeM') ?? undefined,
    SpeculativeNgramMinHits: reader.number('SpeculativeNgramMinHits') ?? undefined,
    SpeculativeDraftMax: reader.number('SpeculativeDraftMax') ?? undefined,
    SpeculativeDraftMin: reader.number('SpeculativeDraftMin') ?? undefined,
  };
});
```

- [ ] **Step 4: Replace run-log delete criteria parser**

Delete `parseDashboardRunLogDeleteCriteria(body: Dict)` from `dashboard.ts`.

For preview:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const request = parseDashboardRunLogDeleteRequest(parsedBody);
if (!request) {
  sendJson(res, 400, { error: 'Expected valid run-log delete criteria.' });
  return true;
}
const preview = idleSummaryDatabase
  ? previewDashboardRunLogDeletion(idleSummaryDatabase, request)
  : { matchCount: 0 };
```

For delete:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const request = parseDashboardRunLogDeleteRequest(parsedBody);
if (!request) {
  sendJson(res, 400, { error: 'Expected valid run-log delete criteria.' });
  return true;
}
const deletion = idleSummaryDatabase
  ? deleteDashboardRunLogs(idleSummaryDatabase, request)
  : { deletedCount: 0, deletedRunIds: [] };
```

- [ ] **Step 5: Replace remaining `let parsedBody: Dict` declarations**

Use inferred `const parsedBody = parseJsonBody(...)` plus `JsonRecordReader` for:

- `POST /dashboard/benchmark/question-presets`
- `PUT /dashboard/benchmark/question-presets/:id`
- `POST /dashboard/benchmark/sessions`
- `PUT /dashboard/benchmark/attempts/:id/grade`
- `POST /dashboard/system/pick-file`

Concrete pattern:

```ts
const parsedBody = parseJsonBody(await readBody(req));
const reader = new JsonRecordReader(parsedBody);
const preset = createBenchmarkQuestionPreset({
  title: reader.string('title'),
  taskKind: reader.string('taskKind') as 'repo-search' | 'summary',
  prompt: reader.string('prompt'),
  enabled: reader.value('enabled') !== false,
});
```

For grade route:

```ts
const outputQualityRaw = reader.value('outputQualityScore');
const toolUseQualityRaw = reader.value('toolUseQualityScore');
const attempt = updateBenchmarkAttemptGrade({
  attemptId,
  outputQualityScore: outputQualityRaw === null ? null : Number(outputQualityRaw),
  toolUseQualityScore: toolUseQualityRaw === null ? null : Number(toolUseQualityRaw),
  reviewNotes: reader.nullableString('reviewNotes'),
  reviewedBy: reader.optionalString('reviewedBy') || 'codex',
});
```

For file picker:

```ts
const target = reader.string('target') as ManagedFilePickerTarget;
const initialPath = reader.nullableString('initialPath');
```

- [ ] **Step 6: Run dashboard route tests**

Run:

```powershell
npm run typecheck
npm test -- dashboard-status-server
npm test -- dashboard-status-server.run-logs
npm test -- benchmark-spec-settings
npm test -- server-boundary-dict-contract
```

Expected: PASS. Contract no longer reports `src/status-server/routes/dashboard.ts`.

- [ ] **Step 7: Commit dashboard route typing**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/routes/dashboard.ts src/status-server/dashboard-runs.ts
git commit -m "refactor: type dashboard route requests"
```

---

## Task 12: Remove Remaining Server Boundary Dict Usages

**Files:**
- Modify:
  - `src/status-server/tool-command-display.ts`
  - `src/status-server/preset-runner.ts`
  - `src/status-server/dashboard-benchmark-runner.ts`
  - `src/status-server/routes/llama-passthrough.ts`
  - `src/status-server/status-file.ts`
  - `src/status-server/idle-summary.ts`
  - `src/status-server/metrics.ts`
  - `src/status-server/managed-llama.ts`
  - `src/state/runtime-results.ts`
  - `src/state/runtime-artifacts.ts`
  - `src/state/dashboard-benchmark.ts`
  - `src/state/jsonl-transcript.ts`
  - `src/thinking-retention-policy.ts`
  - `tests/server-boundary-dict-contract.test.ts`
- Test: `tests/server-boundary-dict-contract.test.ts`, affected focused tests

- [ ] **Step 1: Expand the contract target list to every remaining server boundary file**

Modify `tests/server-boundary-dict-contract.test.ts` so `TARGETS` includes:

```ts
const TARGETS = [
  'src/presets.ts',
  'src/state/chat-sessions.ts',
  'src/state/dashboard-benchmark.ts',
  'src/state/jsonl-transcript.ts',
  'src/state/runtime-artifacts.ts',
  'src/state/runtime-results.ts',
  'src/thinking-retention-policy.ts',
  'src/status-server/chat.ts',
  'src/status-server/dashboard-benchmark-runner.ts',
  'src/status-server/dashboard-runs.ts',
  'src/status-server/http-utils.ts',
  'src/status-server/idle-summary.ts',
  'src/status-server/managed-llama.ts',
  'src/status-server/metrics.ts',
  'src/status-server/preset-runner.ts',
  'src/status-server/routes/chat.ts',
  'src/status-server/routes/core.ts',
  'src/status-server/routes/dashboard.ts',
  'src/status-server/routes/llama-passthrough.ts',
  'src/status-server/server-types.ts',
  'src/status-server/status-file.ts',
  'src/status-server/tool-command-display.ts',
] as const;
```

Run:

```powershell
npm test -- server-boundary-dict-contract
```

Expected: FAIL with the remaining files listed above. This is the per-task failing test for the residual boundary work; do not commit until the task passes.

- [ ] **Step 2: Search exact remaining target usages**

Run:

```powershell
rg -n "from '../lib/types|from '../../lib/types|server-types.*Dict|type \\{ Dict \\}|: Dict\\b|as Dict\\b|Dict\\[\\]|Record<string, unknown>|function getPositiveNumber|function getOptionalNumber|function getTrimmedString|function getNonNegativeNumber|function isRecord" src/presets.ts src/state/chat-sessions.ts src/state/dashboard-benchmark.ts src/state/jsonl-transcript.ts src/state/runtime-artifacts.ts src/state/runtime-results.ts src/thinking-retention-policy.ts src/status-server/chat.ts src/status-server/dashboard-benchmark-runner.ts src/status-server/dashboard-runs.ts src/status-server/http-utils.ts src/status-server/idle-summary.ts src/status-server/managed-llama.ts src/status-server/metrics.ts src/status-server/preset-runner.ts src/status-server/routes/chat.ts src/status-server/routes/core.ts src/status-server/routes/dashboard.ts src/status-server/routes/llama-passthrough.ts src/status-server/server-types.ts src/status-server/status-file.ts src/status-server/tool-command-display.ts
```

Expected: output for the residual files. Use this as the fix list for Steps 3-8. Repeat the search after Step 8; only then should it return no output.

- [ ] **Step 3: Type tool command display**

Change `src/status-server/tool-command-display.ts` to:

```ts
export type DisplayToolCommand = {
  command?: string | null;
  displayCommand?: string | null;
  content?: string | null;
};

export function getDisplayToolCommand(command: DisplayToolCommand): string {
  return command.displayCommand?.trim()
    || command.command?.trim()
    || command.content?.trim()
    || '';
}

export function commandMatchesDisplayText(command: DisplayToolCommand, text: string): boolean {
  return getDisplayToolCommand(command) === text.trim();
}
```

Run:

```powershell
npm run typecheck
npm test -- status-server-chat
```

Expected: PASS.

- [ ] **Step 4: Type preset runner scorecard access**

Update `src/status-server/preset-runner.ts` to import `normalizeRepoSearchResult` and use typed tasks:

```ts
const repoSearchResult = normalizeRepoSearchResult(result);
const tasks = repoSearchResult.scorecard.tasks;
const output = tasks[0]?.finalOutput.trim() || '';
```

Run:

```powershell
npm run typecheck
npm test -- preset-execution
```

Expected: PASS.

- [ ] **Step 5: Type status-file metadata and deferred artifacts**

In `src/status-server/status-file.ts`, replace `Dict` with `JsonObject`, `JsonRecordReader`, and named metadata shapes:

```ts
type StatusMetadataJson = JsonObject & {
  artifactType?: string;
  artifactRequestId?: string;
  artifactPayload?: JsonObject;
  deferredMetadata?: JsonObject;
  deferredArtifacts?: readonly JsonObject[];
  toolStats?: JsonObject;
};
```

Use `JsonRecordReader.parseObjectText(...)` for JSON parsing. Convert each deferred artifact object through a typed reader and return the existing `StatusMetadata` shape. Keep invalid metadata loud by returning the current error/empty behavior; do not add legacy fallbacks.

Run:

```powershell
npm run typecheck
npm test -- runtime-status-server
npm test -- dashboard-status-server
```

Expected: PASS.

- [ ] **Step 6: Type idle-summary and metrics inputs**

In `src/status-server/metrics.ts`, replace generic JSON map parsing with explicit metric input types:

```ts
type ToolStatsInput = { readonly [toolType: string]: { count?: number; inputTokens?: number; outputTokens?: number } };
type MetricsInput = {
  schemaVersion?: number;
  completedRequestCount?: number;
  taskTotals?: { readonly [taskKind: string]: number };
  toolStats?: ToolStatsInput;
};
```

In `src/status-server/idle-summary.ts`, import the typed `Metrics`/snapshot types instead of `Dict`. Replace `SnapshotTimeseriesRow = Dict` with an explicit row type that lists the selected columns. Replace `queryRecentSnapshots(...): Dict[]` with the explicit row type array.

Run:

```powershell
npm run typecheck
npm test -- dashboard-status-server
npm test -- processed-input-metrics
```

Expected: PASS.

- [ ] **Step 7: Type runtime result, artifact, transcript, and benchmark stores**

Use `JsonObject` and named row types in:

- `src/state/runtime-results.ts`: `payload: JsonObject`, `parsePayload(...): JsonObject`, and typed DB rows.
- `src/state/runtime-artifacts.ts`: `contentJson: JsonObject | null`, `payload: JsonObject`, typed DB rows, and `JsonRecordReader.parseObjectText(...)`.
- `src/state/jsonl-transcript.ts`: `JsonlEvent = { kind: string; at: string | null; payload: JsonObject }`, with parsed lines accepted only when they are JSON objects.
- `src/state/dashboard-benchmark.ts`: replace `Record<string, unknown>` DB rows with named row types for question presets, sessions, cases, attempts, and output comparison rows. Replace managed preset/spec override payloads with `JsonObject`.

Run:

```powershell
npm run typecheck
npm test -- benchmark-spec-settings
npm test -- dashboard-status-server
```

Expected: PASS.

- [ ] **Step 8: Type llama passthrough, managed llama, and benchmark runner residue**

In `src/status-server/routes/llama-passthrough.ts`, replace the remaining `Dict` request/response typing with `JsonObject` or a named request/response DTO.

In `src/status-server/managed-llama.ts`, remove the imported `Dict` and replace the one use with the named config/preset type already available in the file. If the value is JSON, use `JsonObject`.

In `src/status-server/dashboard-benchmark-runner.ts`, replace `cloneDict` with a typed JSON clone:

```ts
function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
```

Do not use `JsonObject` as a substitute for typed config when a `SiftConfig` or managed preset type is available.

Run:

```powershell
npm run typecheck
npm test -- dashboard-status-server
npm test -- benchmark-spec-settings
```

Expected: PASS.

- [ ] **Step 9: Run the contract test**

Run:

```powershell
npm test -- server-boundary-dict-contract
```

Expected: PASS.

- [ ] **Step 10: Commit remaining boundary cleanup**

```powershell
git add tests/server-boundary-dict-contract.test.ts src/status-server/tool-command-display.ts src/status-server/preset-runner.ts src/status-server/dashboard-benchmark-runner.ts src/status-server/routes/llama-passthrough.ts src/status-server/status-file.ts src/status-server/idle-summary.ts src/status-server/metrics.ts src/status-server/managed-llama.ts src/state/runtime-results.ts src/state/runtime-artifacts.ts src/state/dashboard-benchmark.ts src/state/jsonl-transcript.ts src/thinking-retention-policy.ts
git commit -m "refactor: remove remaining server Dict boundaries"
```

---

## Task 13: Update Architecture Documentation

**Files:**
- Modify: `ARCHITECTURE-REVIEW.md`
- Test: `tests/server-boundary-dict-contract.test.ts`

- [ ] **Step 1: Verify the single boundary contract covers all server files**

Run:

```powershell
npm test -- server-boundary-dict-contract
```

Expected: PASS. Do not add a duplicate contract test to `tests/config-schema-contract.test.ts`; the dedicated contract file is the single source for the server-boundary invariant.

- [ ] **Step 2: Update `ARCHITECTURE-REVIEW.md`**

Edit `ARCHITECTURE-REVIEW.md` to move the F3/F18 priority item from active to resolved. Use concrete wording:

```md
- Resolved 2026-06-11: server boundary `Dict` usage was removed from chat sessions, thinking retention, chat runtime, dashboard runs, presets, status metadata, idle summaries, metrics, runtime result/artifact stores, benchmark persistence, HTTP JSON parsing, and all status-server routes. Shared JSON parsing now flows through `JsonRecordReader`; boundary request bodies normalize into named DTOs; persisted rows normalize through named row types.
```

Do not claim unrelated `Dict` usage outside this plan was removed.

- [ ] **Step 3: Run contract tests**

Run:

```powershell
npm run typecheck
npm test -- server-boundary-dict-contract
```

Expected: PASS.

- [ ] **Step 4: Commit docs and contract**

```powershell
git add ARCHITECTURE-REVIEW.md
git commit -m "docs: mark server Dict boundary resolved"
```

---

## Task 14: Final Verification

**Files:**
- No planned source edits unless verification fails.
- Test: full repo suite.

- [ ] **Step 1: Run exact residual search**

Run:

```powershell
rg -n "from '../lib/types|from '../../lib/types|server-types.*Dict|type \\{ Dict \\}|: Dict\\b|as Dict\\b|Dict\\[\\]|Record<string, unknown>|function getPositiveNumber|function getOptionalNumber|function getTrimmedString|function getNonNegativeNumber|function isRecord" src/presets.ts src/state/chat-sessions.ts src/state/dashboard-benchmark.ts src/state/jsonl-transcript.ts src/state/runtime-artifacts.ts src/state/runtime-results.ts src/thinking-retention-policy.ts src/status-server/chat.ts src/status-server/dashboard-benchmark-runner.ts src/status-server/dashboard-runs.ts src/status-server/http-utils.ts src/status-server/idle-summary.ts src/status-server/managed-llama.ts src/status-server/metrics.ts src/status-server/preset-runner.ts src/status-server/routes/chat.ts src/status-server/routes/core.ts src/status-server/routes/dashboard.ts src/status-server/routes/llama-passthrough.ts src/status-server/server-types.ts src/status-server/status-file.ts src/status-server/tool-command-display.ts
```

Expected: no output.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Run coverage**

Run:

```powershell
npm run test:coverage
```

Expected: PASS. Review branch coverage output. Add focused branch tests if any new parser/normalizer branch is not covered.

- [ ] **Step 5: Inspect diff**

Run:

```powershell
git diff --stat
git diff -- tests/server-boundary-dict-contract.test.ts src/lib/json-record-reader.ts src/presets.ts src/state/chat-sessions.ts src/state/dashboard-benchmark.ts src/state/jsonl-transcript.ts src/state/runtime-artifacts.ts src/state/runtime-results.ts src/thinking-retention-policy.ts src/status-server/chat.ts src/status-server/dashboard-benchmark-runner.ts src/status-server/dashboard-runs.ts src/status-server/http-utils.ts src/status-server/idle-summary.ts src/status-server/managed-llama.ts src/status-server/metrics.ts src/status-server/preset-runner.ts src/status-server/routes/chat.ts src/status-server/routes/core.ts src/status-server/routes/dashboard.ts src/status-server/routes/llama-passthrough.ts src/status-server/server-types.ts src/status-server/status-file.ts src/status-server/tool-command-display.ts
```

Expected:

- No `Dict` in target boundary files.
- No `Record<string, unknown>` in target boundary files.
- Route bodies parsed once, then consumed through named request types.
- No compatibility alias such as `type Dict = ...`.
- No `any`.
- No dynamic function passing introduced.

- [ ] **Step 6: Final commit if verification required fixes**

If fixes were needed during final verification:

```powershell
git add src tests ARCHITECTURE-REVIEW.md
git commit -m "fix: close typed server boundary verification gaps"
```

If no fixes were needed after Task 13, do not create an empty commit.

---

## Completion Criteria

- `siftkit` discovery was attempted first. If unavailable, direct `rg`/file reads are acceptable for implementation.
- `tests/server-boundary-dict-contract.test.ts` is the single server boundary invariant and passes.
- `rg` over the target files returns no `Dict`, no `Record<string, unknown>`, and no duplicated helper names from F18.
- `src/status-server/http-utils.ts` returns `JsonObject` from `parseJsonBody`.
- `src/status-server/server-types.ts` no longer imports or exports `Dict`.
- `src/state/chat-sessions.ts` exports explicit `ChatSession` and `ChatMessage` types.
- `src/presets.ts` uses typed JSON input normalization, not `Dict`.
- `src/status-server/dashboard-runs.ts` uses typed DB rows, typed artifact payloads, and typed repo-search result payloads.
- `src/status-server/routes/core.ts`, `src/status-server/routes/chat.ts`, `src/status-server/routes/dashboard.ts`, and `src/status-server/routes/llama-passthrough.ts` parse request bodies into named DTOs before business logic.
- `src/status-server/status-file.ts`, `src/status-server/idle-summary.ts`, `src/status-server/metrics.ts`, `src/state/runtime-results.ts`, `src/state/runtime-artifacts.ts`, `src/state/dashboard-benchmark.ts`, `src/state/jsonl-transcript.ts`, and `src/thinking-retention-policy.ts` use named row/payload/message types instead of `Dict`.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run test:coverage` passes or any coverage failure is fixed before completion.
