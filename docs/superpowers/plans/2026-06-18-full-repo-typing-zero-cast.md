# Full-Repo Zero-Cast Strict Typing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every type assertion (`x as T`, `<T>x`, chained/escape casts) and every `import * as` namespace import across the whole repo, with all types auto-inferred from values (`satisfies`/`as const`) or runtime zod schemas (`z.infer`), enforced permanently by an ESLint gate.

**Architecture:** Approach A — a ratcheting ESLint gate. P0 installs ESLint + `typescript-eslint` + `zod`, turns the rules on globally, and seeds a baseline disable-list of currently-dirty directories so CI is green immediately. P1–P8 each clean one directory group (convert namespace imports → named, type I/O boundaries with zod schemas, replace residual casts with `satisfies`/generics/guards) and remove that group from the disable-list. P8 deletes the list so lint hard-fails repo-wide.

**Tech Stack:** TypeScript 5.9 (NodeNext + Bundler), ESLint 9 flat config, `typescript-eslint`, `zod`, `better-sqlite3`, `undici`, `tsx`, `node:test`, Vite/React (dashboard).

**Reference spec:** `docs/superpowers/specs/2026-06-18-full-repo-typing-zero-cast-design.md`

---

## File Structure

**P0 creates/modifies:**
- Create: `eslint.config.mjs` — root flat config; rules + ratchet disable-list.
- Create: `src/lib/zod.ts` — single re-export point for `zod` (`import { z } from '../lib/zod.js'`) so the dep has one chokepoint. *(Optional convenience; direct `import { z } from 'zod'` is also fine.)*
- Modify: `package.json` — add `zod` dep, `eslint`/`typescript-eslint`/`@eslint/js` devDeps, `lint` script, wire `lint` into `typecheck`.
- Create: `tests/eslint-gate.test.ts` — asserts the gate flags a cast and a namespace import in a fixture, and that a clean file passes.

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

## Task 0.1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install zod (runtime) + lint toolchain (dev)**

Run:
```bash
npm install zod
npm install -D eslint @eslint/js typescript-eslint
```
Expected: `zod` appears under `dependencies`; `eslint`, `@eslint/js`, `typescript-eslint` under `devDependencies`; install exits 0.

- [ ] **Step 2: Verify versions resolve**

Run: `node -e "console.log(require('zod/package.json').version, require('eslint/package.json').version)"`
Expected: prints a zod 3.x+ version and eslint 9.x version, no error.

- [ ] **Step 3: Commit**
```bash
git add package.json package-lock.json
git commit -m "build(typing): add zod runtime dep + eslint toolchain"
```

---

## Task 0.2: Root ESLint flat config with rules + ratchet

**Files:**
- Create: `eslint.config.mjs`

- [ ] **Step 1: Write the config**

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
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts', '.siftkit/**', '.npm-cache/**', 'eval/**/fixtures/**'],
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
);
```

- [ ] **Step 2: Add scripts to package.json**

Add to `scripts`:
```json
"lint": "eslint .",
"lint:fix": "eslint . --fix"
```
And append `lint` to the existing `typecheck` chain:
```
"typecheck": "... && npm run typecheck:analysis && npm run lint",
```

- [ ] **Step 3: Run the gate on the whole repo**

Run: `npm run lint`
Expected: exits 0 (everything dirty is currently ratcheted off; clean dirs — none yet — pass). If parser-project errors appear for files outside the `tsconfig` includes (e.g. `*.mjs`, `bench`, `scripts`), add their tsconfigs to `projectService` allowance or an `extraFileExtensions`/`disableTypeChecked` override block for those globs. Iterate until exit 0.

- [ ] **Step 4: Commit**
```bash
git add eslint.config.mjs package.json
git commit -m "build(typing): ratcheting eslint gate (casts + namespace imports banned)"
```

---

## Task 0.3: Prove the gate works (failing test → passing)

**Files:**
- Create: `tests/eslint-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/eslint-gate.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function lint(source: string): { code: number; out: string } {
  // Place fixture in a CLEANED location so the ratchet does not silence it.
  // tests/** is ratcheted until P7, so write under a temp dir referenced by a
  // throwaway clean override added for this fixture path.
  const dir = mkdtempSync(join(tmpdir(), 'eslint-gate-'));
  const file = join(dir, 'fixture.ts');
  writeFileSync(file, source, 'utf8');
  try {
    const out = execFileSync('npx', ['eslint', '--no-ignore', file], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('eslint gate flags a value cast', () => {
  const r = lint('const x = (1 as unknown) as string;\nexport {};\n');
  assert.equal(r.code, 1);
  assert.match(r.out, /consistent-type-assertions/);
});

test('eslint gate flags a namespace import', () => {
  const r = lint("import * as fs from 'node:fs';\nvoid fs;\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /no-restricted-syntax/);
});

test('eslint gate passes clean code', () => {
  const r = lint("const x = { a: 1 } satisfies Record<string, number>;\nexport { x };\n");
  assert.equal(r.code, 0);
});
```

> Note: a temp file outside the repo is linted with its own resolution. If `projectService` rejects out-of-project files, instead point the fixtures at `tests/fixtures/eslint-gate/{cast,ns,clean}.ts` and add a dedicated clean override for `tests/fixtures/eslint-gate/**` in `eslint.config.mjs`. Adjust the test to lint those committed fixtures. Pick whichever resolves cleanly under `projectService`.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx tsx --test tests/eslint-gate.test.ts`
Expected: FAIL — gate not yet proven / fixtures missing.

- [ ] **Step 3: Make it pass**

Adjust config/fixtures per the Step-1 note until all three sub-tests pass (cast flagged, namespace flagged, clean passes).

- [ ] **Step 4: Run, expect PASS**

Run: `npx tsx --test tests/eslint-gate.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**
```bash
git add tests/eslint-gate.test.ts eslint.config.mjs
git commit -m "test(typing): prove eslint gate flags casts and namespace imports"
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
- [ ] **P5** — group `src/web-search/**`, `src/capture/**`, `src/cli/**`, `src/command-output/**`, `src/agent-loop/**`, `src/types/**`, and top-level `src/*.ts` (`eval.ts`, `presets.ts`, `install.ts`, `find-files.ts`, `line-read-guidance.ts`, `summary.ts`, `tool-*.ts`, `thinking-retention-policy.ts`, `benchmark-spec-settings.ts`, `execution-lock.ts`). `presets.ts` → transform D (`satisfies`).
- [ ] **P6** — group `dashboard/src/**`. Boundaries: `api.ts`, `lib/chat-stream-parser.ts`, `lib/format.ts`, `settings-sections.ts`. Many `as` in `.tsx` are prop/DOM casts → narrow or type props.
- [ ] **P7** — group `tests/**`, `dashboard/tests/**`, `bench/**`, `scripts/**`, `eval/**`. Replace cast-mocks with typed fixture builders (transform per the design's §4).
- [ ] **P8** — remove the now-empty `RATCHET_DIRTY` array and its override block from `eslint.config.mjs` so the rules apply repo-wide unconditionally. Run full `npm run typecheck && npm run test && npm run lint`; expect all green. Commit `refactor(typing): drop ratchet — zero-cast enforced repo-wide`.

---

## Self-Review

**Spec coverage:** Guardrail (§1) → Tasks 0.1–0.3. zod boundary layer (§2) → recipe Step 4 + P1–P4/P6 boundary lists. Namespace conversion (§3) → recipe Step 3, all phases. Residual casts (§4) → recipe Step 5 + transforms D–F. Phasing (§5) → P0–P8 match spec exactly. Verification (§6) → recipe Step 6 + P8. All spec sections mapped.

**Placeholder scan:** No TBD/TODO. Transforms A–F give concrete before/after code. Per-cast edits in P1–P8 are intentionally discovery-driven (the exact cast set cannot be pre-enumerated without doing the edit); the recipe + eslint error list make each task mechanical and verifiable — this is a procedure, not a placeholder.

**Type consistency:** Schema→type pattern is uniform (`z.infer<typeof XSchema>`), `RATCHET_DIRTY` name used consistently, rule IDs match across config and tests (`consistent-type-assertions`, `no-restricted-syntax`).

**Known risk to watch:** The three gate rules are syntactic and need no type
info, so there is no `projectService`/tsconfig-include coupling. Watch instead
that `consistent-type-assertions: never` still permits `as const` (it does) and
that `import { a as b }` renames are not flagged (they aren't — only
`ImportNamespaceSpecifier` is restricted).
