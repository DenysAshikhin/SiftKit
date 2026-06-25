# Full-Repo Zero-Cast Strict Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every type assertion (`x as T`, `<T>x`, chained/escape casts), explicit `any`, explicit `unknown`, broad catch-all records (`Record<string, unknown>` / `Dict`), broad mixed input unions, and every `import * as` namespace import across the whole repo, with all types auto-inferred from values (`satisfies`/`as const`) or runtime zod schemas (`z.infer`), enforced permanently by an ESLint gate.

**Architecture:** Approach A — a ratcheting ESLint gate. P0 installs ESLint + `typescript-eslint` + `zod`, turns the rules on globally, and seeds a baseline disable-list of currently-dirty directories so CI is green immediately. P1–P8 each clean one directory group (convert namespace imports → named, type I/O boundaries with zod schemas, replace residual casts with `satisfies`/generics/guards) and remove that group from the disable-list. P8 deletes the list so lint hard-fails repo-wide.

**Strict typing clarification:** Cleaned scopes must also remove explicit `unknown`, `Record<string, unknown>` / `Dict` catch-all records, and broad mixed input unions. Do not replace casts with `unknown` guard helpers. Raw JSON/HTTP/SQLite/model input is parsed once at the boundary with a zod schema and only schema-derived DTOs flow beyond that boundary.

**Tech Stack:** TypeScript 5.9 (NodeNext + Bundler), ESLint 9 flat config, `typescript-eslint`, `zod`, `better-sqlite3`, `undici`, `tsx`, `node:test`, Vite/React (dashboard).

**Reference spec:** `docs/superpowers/specs/2026-06-18-full-repo-typing-zero-cast-design.md`

---

## File Structure

**P0 creates/modifies:**
- Create: `eslint.config.mjs` — root flat config; rules + ratchet disable-list.
- Create: `src/lib/zod.ts` — single re-export point for `zod` (`import { z } from '../lib/zod.js'`) so the dep has one chokepoint. *(Optional convenience; direct `import { z } from 'zod'` is also fine.)*
- Modify: `package.json` — add `zod` dep, `eslint`/`typescript-eslint`/`@eslint/js` devDeps, `lint` script, wire `lint` into `typecheck`.
- Modify: `dashboard/package.json` — add `zod` runtime dep for dashboard-side JSON/SSE validation in P6.
- Create: `tests/eslint-gate.test.ts` — asserts the gate flags casts, namespace imports, explicit `any`, explicit `unknown`, broad `JsonValue` unions, and project `.d.ts` files.
- Create: `tests/fixtures/eslint-gate/{cast.ts,namespace.ts,explicit-any.ts,explicit-unknown.ts,broad-json-union.ts,declaration.d.ts,clean.ts}` — committed lint fixtures outside the ratcheted `tests/**` scope by a dedicated clean override.

**P1–P8 create/modify (per the recipe):**
- Per cleaned directory: co-located `*-schema.ts` (or `schemas.ts`) zod files at I/O boundaries; edits to the directory's `.ts`/`.tsx`; one-line removals in `eslint.config.mjs`'s disable-list.

---

## Conventions used by every cleanup task (P1–P8)

These are the canonical transforms. Apply the matching one; never introduce a new cast.

**A. Namespace import → named import**
```ts
// before
import * as fs from 'node:fs';
import * as path from 'node:path';
// ... fs.readFileSync(p); path.join(a, b);

// after
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ... readFileSync(p); join(a, b);
```
If a module is consumed only as a whole and has no usable named exports, import the default (`import fsExtra from 'mod'`) — never `* as`.

**B. `JSON.parse(raw) as T` → zod-validated**
```ts
// before
const cfg = JSON.parse(raw) as SiftConfig;

// after
import { z } from 'zod';
const SiftConfigSchema = z.object({ /* exact shape */ });
type SiftConfig = z.infer<typeof SiftConfigSchema>;
const cfg = SiftConfigSchema.parse(JSON.parse(raw));
```
The schema is the single source of truth; delete the hand-written `interface`/`type` for that shape and re-export `z.infer` instead (DRY).

**C. better-sqlite3 row → zod-validated**
```ts
// before
const row = stmt.get(id) as RunRow;

// after
const RunRowSchema = z.object({ id: z.string(), created_at: z.number(), /* ... */ });
type RunRow = z.infer<typeof RunRowSchema>;
const row = RunRowSchema.parse(stmt.get(id));
// for .all(): z.array(RunRowSchema).parse(stmt.all())
```

**D. Literal/config object cast → `satisfies`**
```ts
// before
const presets = { fast: {...}, deep: {...} } as Record<string, Preset>;
// after
const presets = { fast: {...}, deep: {...} } satisfies Record<string, Preset>;
```

**E. Chained / escape cast (`as unknown as`, `as any`)** → give the value a real type:
- Wrap third-party calls in a typed helper whose signature is correct, OR
- Validate with a zod schema (B/C), OR
- Fix the generic so the cast is unnecessary.
No `as unknown as` may survive in cleaned scope.

**F. Helper that casts its return** → make it generic or add overloads so the type flows without assertion.

---

**G. `unknown`, `Record<string, unknown>`, `Dict`, broad JSON/input unions** -> delete the catch-all type surface. Add a co-located zod schema for the exact boundary shape and pass the inferred concrete DTO (`z.infer<typeof Schema>`) beyond the boundary. Do not replace casts with `unknown` guard helpers. Domain literal unions such as `'on' | 'off'`, provider IDs, HTTP methods, and schema-derived optional/null fields are allowed; catch-all unions such as `SiftConfig | Record<string, unknown>`, `string | JsonValue`, or `JsonValue | undefined` are not.

## Task 0.1: Add dependencies

**Files:**
- Modify: `package.json`
- Modify: `dashboard/package.json`

- [ ] **Step 1: Install zod (runtime) + lint toolchain (dev)**

Run:
```bash
npm install zod
npm --prefix dashboard install zod
npm install -D eslint @eslint/js typescript-eslint
```
Expected: root `zod` appears under root `dependencies`; dashboard `zod` appears under `dashboard/package.json` `dependencies`; `eslint`, `@eslint/js`, `typescript-eslint` appear under root `devDependencies`; install exits 0.

- [ ] **Step 2: Verify versions resolve**

Run: `node -e "console.log(require('zod/package.json').version, require('eslint/package.json').version, require('./dashboard/node_modules/zod/package.json').version)"`
Expected: prints a zod 3.x+ version and eslint 9.x version, no error.

- [ ] **Step 3: Commit**
```bash
git add package.json package-lock.json dashboard/package.json dashboard/package-lock.json
git commit -m "build(typing): add zod runtime dep + eslint toolchain"
```

---

## Task 0.2: Prove and add root ESLint flat config with rules + ratchet

**Files:**
- Create: `eslint.config.mjs`
- Create: `tests/eslint-gate.test.ts`
- Create: `tests/fixtures/eslint-gate/cast.ts`
- Create: `tests/fixtures/eslint-gate/namespace.ts`
- Create: `tests/fixtures/eslint-gate/explicit-any.ts`
- Create: `tests/fixtures/eslint-gate/declaration.d.ts`
- Create: `tests/fixtures/eslint-gate/clean.ts`

- [ ] **Step 1: Write the failing gate fixtures and test**

Create `tests/fixtures/eslint-gate/cast.ts`:
```ts
const x = 1 as number;
export { x };
```

Create `tests/fixtures/eslint-gate/namespace.ts`:
```ts
import * as fs from 'node:fs';
void fs;
```

Create `tests/fixtures/eslint-gate/explicit-any.ts`:
```ts
function takesAny(value: any): void {
  void value;
}
export { takesAny };
```

Create `tests/fixtures/eslint-gate/explicit-unknown.ts`:
```ts
function takesUnknown(value: unknown): void {
  void value;
}
export { takesUnknown };
```

Create `tests/fixtures/eslint-gate/broad-json-union.ts`:
```ts
import type { JsonValue } from '../../../src/lib/json-types.js';

type MixedPayload = string | JsonValue;

const payload: MixedPayload = 'raw';

export { payload };
```

Create `tests/fixtures/eslint-gate/declaration.d.ts`:
```ts
declare module 'eslint-gate-fixture' {
  import * as React from 'react';
  export const Component: React.ComponentType<{ label: string }>;
}
```

Create `tests/fixtures/eslint-gate/clean.ts`:
```ts
const x = { a: 1 } satisfies Record<string, number>;
const y = ['a', 'b'] as const;
export { x, y };
```

Create `tests/eslint-gate.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

type LintMessage = {
  ruleId: string | null;
  message: string;
};

type LintFileResult = {
  filePath: string;
  messages: LintMessage[];
  errorCount: number;
};

function parseLintOutput(output: string): LintFileResult {
  const results = JSON.parse(output) as LintFileResult[];
  assert.equal(results.length, 1);
  return results[0];
}

function lintFixture(fixtureName: string): LintFileResult {
  const output = execFileSync(
    'npx',
    ['eslint', '--no-ignore', '--format', 'json', `tests/fixtures/eslint-gate/${fixtureName}`],
    { encoding: 'utf8' },
  );
  return parseLintOutput(output);
}

function lintFixtureAllowingFailure(fixtureName: string): LintFileResult {
  try {
    return lintFixture(fixtureName);
  } catch (error) {
    const failed = error as { stdout?: string };
    return parseLintOutput(failed.stdout ?? '[]');
  }
}

test('eslint gate flags value casts', () => {
  const result = lintFixtureAllowingFailure('cast.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/consistent-type-assertions');
});

test('eslint gate flags namespace imports', () => {
  const result = lintFixtureAllowingFailure('namespace.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate flags explicit any', () => {
  const result = lintFixtureAllowingFailure('explicit-any.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, '@typescript-eslint/no-explicit-any');
});

test('eslint gate flags explicit unknown', () => {
  const result = lintFixtureAllowingFailure('explicit-unknown.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate flags broad JsonValue unions', () => {
  const result = lintFixtureAllowingFailure('broad-json-union.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate lints project declaration files', () => {
  const result = lintFixtureAllowingFailure('declaration.d.ts');
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0]?.ruleId, 'no-restricted-syntax');
});

test('eslint gate passes clean code', () => {
  const result = lintFixture('clean.ts');
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.messages, []);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx tsx --test tests/eslint-gate.test.ts`
Expected: FAIL because `eslint.config.mjs` does not exist yet and the rules are not installed/configured.

- [ ] **Step 3: Write the config**

Create `eslint.config.mjs`. The three target rules are **purely syntactic** —
no `projectService`/type-checked configs (which would fire hundreds of
unrelated type-aware rules across the not-yet-cleaned repo and break the
green-on-day-one ratchet). `no-unnecessary-type-assertion` is intentionally
omitted: once `consistent-type-assertions: never` bans *all* assertions, none
remain to be "unnecessary".
```js
import tseslint from 'typescript-eslint';

// Directories NOT YET cleaned. Each cleanup phase deletes its entries.
// When this array is empty, the gate is hard-fail repo-wide (P8).
const RATCHET_DIRTY = [
  'src/lib/**', 'src/config/**',                                   // P1
  'src/state/**',                                                  // P2
  'src/status-server/**',                                          // P3
  'src/llm-protocol/**', 'src/providers/**',
  'src/repo-search/**', 'src/summary/**',                          // P4
  'src/web-search/**', 'src/capture/**', 'src/cli/**',
  'src/command-output/**', 'src/agent-loop/**', 'src/types/**',
  'src/*.ts',                                                      // P5
  'dashboard/src/**',                                              // P6
  'tests/**', 'dashboard/tests/**', 'bench/**',
  'scripts/**', 'eval/**',                                         // P7
];

const CLEAN_FIXTURES = ['tests/fixtures/eslint-gate/**'];

const TYPING_RULES = {
  '@typescript-eslint/consistent-type-assertions': [
    'error', { assertionStyle: 'never' },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportNamespaceSpecifier',
      message: 'Namespace imports (import * as) are banned; use named imports.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dashboard/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '.siftkit/**',
      '.npm-cache/**',
      'eval/**/fixtures/**',
    ],
  },
  // tseslint.configs.base wires up the TS parser + plugin with NO rules and NO
  // type information requirement. Our rules are syntactic, so this is enough.
  tseslint.configs.base,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: TYPING_RULES,
  },
  // Ratchet: silence the typing rules for not-yet-cleaned dirs so CI stays green.
  {
    files: RATCHET_DIRTY,
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Gate fixtures must stay clean even while tests/** is ratcheted until P7.
  {
    files: CLEAN_FIXTURES,
    rules: TYPING_RULES,
  },
);
```

- [ ] **Step 4: Add scripts to package.json**

Add to `scripts`:
```json
"lint": "eslint .",
"lint:fix": "eslint . --fix"
```
And append `lint` to the existing `typecheck` chain:
```
"typecheck": "... && npm run typecheck:analysis && npm run lint",
```

- [ ] **Step 5: Run the gate test, expect PASS**

Run: `npx tsx --test tests/eslint-gate.test.ts`
Expected: PASS (7/7). The `declaration.d.ts` fixture proves project declaration files are linted; do not add a blanket `**/*.d.ts` ignore.

- [ ] **Step 6: Run the gate on the whole repo**

Run: `npm run lint`
Expected: exits 0 (everything dirty is currently ratcheted off; the committed clean fixture path passes). If files outside the intended TypeScript scope are linted unexpectedly, add narrow `ignores` for generated/vendor artifacts only. Do not ignore project `.d.ts` files under `src/**` or `dashboard/src/**`.

- [ ] **Step 7: Commit**
```bash
git add eslint.config.mjs package.json tests/eslint-gate.test.ts tests/fixtures/eslint-gate
git commit -m "test(typing): prove strict typing eslint gate"
```

---

## Tasks P1–P8: per-directory cleanup recipe

Each phase below names a **directory group**. For that group, run this exact loop, then commit. Phases are independent commits but must run in listed order (later dirs import earlier ones).

**Recipe (run once per directory group):**

- [ ] **Step 1 — Enable the gate for this group:** delete this group's glob lines from `RATCHET_DIRTY` in `eslint.config.mjs`.

- [ ] **Step 2 — See the work:** run `npx eslint <group-glob>` and capture every error. These are your tasks.

- [ ] **Step 3 — Namespace imports:** apply transform **A** to every `no-restricted-syntax` (ImportNamespaceSpecifier) error. Commit-isolate this if the group has many (reviewability).

- [ ] **Step 4 — Boundary types:** for each `JSON.parse`/`stmt.get`/`stmt.all`/HTTP-body site in the group, apply transform **B** or **C** — add a co-located zod schema, replace the hand-written type with `z.infer`, validate at the boundary. Reuse one schema per shape across the group (DRY).

- [ ] **Step 5 — Residual casts:** apply transform **D**/**E**/**F** to every remaining `consistent-type-assertions` / `no-explicit-any` error. No `as` (except `as const`) and no `any` may remain.

- [ ] **Step 6 — Verify all three gates green:**
```bash
npm run typecheck
npm run test
npx eslint <group-glob>
```
Expected: typecheck 0 errors; tests pass; eslint 0 errors for the group.

- [ ] **Step 7 — Commit:**
```bash
git add -A
git commit -m "refactor(typing): zero-cast <group-name>"
```

### Phase worklist (apply the recipe to each, in order)

- [ ] **P1** — group `src/lib/**`, `src/config/**`. Boundaries: `model-json.ts`, `json-record-reader.ts`, `json.ts`, `http-client.ts`, `config/constants.ts`. Namespace imports: `fs`/`path`/`http`/`https`/`os` throughout `lib`.
- [ ] **P2** — group `src/state/**`. Boundaries: DB rows in `runtime-db.ts`, `dashboard-benchmark.ts`, `benchmark-matrix.ts`, `chat-sessions.ts`, `runtime-results.ts`, `runtime-artifacts.ts`, `jsonl-transcript.ts`. Heaviest zod-schema phase (sqlite rows).
- [ ] **P3** — group `src/status-server/**` (incl. `routes/**`, `dashboard-runs/**`). Boundaries: route request/response bodies, `config-store.ts` (5 parse sites), `status-file.ts`, `metrics.ts`, `idle-summary.ts`. Resolve `managed-llama.ts:425` `as unknown as` (transform E).
- [ ] **P4** — group `src/llm-protocol/**`, `src/providers/**`, `src/repo-search/**`, `src/summary/**`. Boundaries: `tool-call-parser.ts`, `planner-protocol.ts` (incl. `:380` `as unknown as`), `summary/planner/json-filter.ts`, `llama-cpp-client.ts`, `llama-cpp.ts`. Resolve `engine/transcript-manager.ts` ×3 `as unknown as` (transform E/F).
- [ ] **P5** — group `src/web-search/**`, `src/capture/**`, `src/cli/**`, `src/command-output/**`, `src/agent-loop/**`, `src/types/**`, and top-level `src/*.ts` (`eval.ts`, `presets.ts`, `install.ts`, `find-files.ts`, `line-read-guidance.ts`, `summary.ts`, `tool-*.ts`, `thinking-retention-policy.ts`, `benchmark-spec-settings.ts`, `execution-lock.ts`). `presets.ts` → transform D (`satisfies`). Include project declaration files such as `src/types/better-sqlite3.d.ts`; do not hide them behind a `.d.ts` ignore.
- [ ] **P6** — group `dashboard/src/**`. Boundaries: `api.ts`, `lib/chat-stream-parser.ts`, `lib/format.ts`, `settings-sections.ts`, `metric-graph-persistence.ts`, `ambient.d.ts`. Many `as` in `.tsx` are prop/DOM casts → narrow or type props. Use dashboard's own `zod` dependency for browser-runtime JSON/SSE schemas.
- [ ] **P7** — group `tests/**`, `dashboard/tests/**`, `bench/**`, `scripts/**`, `eval/**`. Replace cast-mocks with typed fixture builders (transform per the design's §4).
- [ ] **P8** — remove the now-empty `RATCHET_DIRTY` array and its override block from `eslint.config.mjs` so the rules apply repo-wide unconditionally. Run full `npm run typecheck && npm run test && npm run lint`; expect all green. Commit `refactor(typing): drop ratchet — zero-cast enforced repo-wide`.

---

## Self-Review

**Spec coverage:** Guardrail (§1) → Tasks 0.1–0.2. zod boundary layer (§2) → recipe Step 4 + P1–P6 boundary lists, including dashboard's own runtime dependency. Namespace conversion (§3) → recipe Step 3, all phases, including project `.d.ts` files. Residual casts (§4) → recipe Step 5 + transforms D–F. Phasing (§5) → P0–P8. Verification (§6) → recipe Step 6 + P8. The spec's `no-unnecessary-type-assertion` rule is intentionally omitted from implementation because `consistent-type-assertions: never` bans all assertions syntactically; if the spec must be literal, update the companion spec to record that decision.

**Placeholder scan:** No TBD/TODO. Transforms A–F give concrete before/after code. Per-cast edits in P1–P8 are intentionally discovery-driven (the exact cast set cannot be pre-enumerated without doing the edit); the recipe + eslint error list make each task mechanical and verifiable — this is a procedure, not a placeholder.

**Type consistency:** Schema→type pattern is uniform (`z.infer<typeof XSchema>`), `RATCHET_DIRTY` name used consistently, rule IDs match across config and tests (`consistent-type-assertions`, `no-restricted-syntax`).

**Known risks to watch:** The three gate rules are syntactic and need no type
info, so there is no `projectService`/tsconfig-include coupling. Watch instead
that `consistent-type-assertions: never` still permits `as const` (it does),
that `import { a as b }` renames are not flagged (they aren't — only
`ImportNamespaceSpecifier` is restricted), that project `.d.ts` files remain
linted, and that dashboard zod imports resolve from `dashboard/package.json`.
