# Full-Repo Strict Typing — Zero-Cast Design

Date: 2026-06-18
Status: Approved-pending-review
Owner: Denys Ashikhin

## Goal

Make the entire SiftKit repo (backend `src`, frontend `dashboard`, plus
`tests`, `bench`, `scripts`, `eval`) fully typed with **no type assertions**:

- No `x as T` value/type assertions.
- No `<T>x` angle-bracket assertions.
- No multi/chained casts (`x as unknown as T`, `x as A as B`).
- No "escape" casts (`as any`, `as unknown` used to launder types).
- No namespace imports (`import * as fs from 'node:fs'`).
- No `var as String | Json`-style union-laundering casts.
- All types **auto-inferred** — from values (`satisfies`, `as const`) and from
  runtime schemas (`z.infer`), never hand-asserted.

**Allowed** (explicitly not casts / inference-preserving):
- `as const` (const assertions — drive literal-type inference).
- `satisfies T` (validates a value against a type while keeping its narrow
  inferred type).
- Type-only import renames: `import { a as b }` (a rename, not a cast).

**Out of scope:** non-null assertions (`foo!`) and definite-assignment (`x!`)
— left as-is for this effort; behavior changes; unrelated refactors.

## Decisions (captured from brainstorming)

| Question | Decision |
| --- | --- |
| Scope | Entire repo: `src` + `dashboard` + `tests` + `bench` + `scripts` + `eval` |
| I/O typing strategy | Add **zod**; schemas validate at boundaries, `z.infer` derives types |
| `as const` / `satisfies` | Allowed |
| Non-null `!` | Left as-is (only `as`-casts + `*`-imports targeted) |
| Approach | A — ratcheting ESLint gate, module-by-module |
| zod dependency | Production `dependencies` (runtime validation) |

## Current State (baseline, measured 2026-06-18)

- `strict: true` already enabled in all tsconfigs; `dashboard` additionally has
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- No ESLint / Biome / lint gate exists — nothing prevents new casts today.
- ~400 `as`-keyword occurrences in `src` (incl. `as const`, import renames),
  ~142 in `dashboard`; 40 `as unknown`/`as any` escape casts in `src`.
- ~249 `import * as` namespace imports across 119 files (mostly Node builtins:
  `fs`, `path`, `http`, `https`, `os`).
- ~50 `JSON.parse` sites across 34 files — primary untyped boundaries.
- Untyped I/O deps: `better-sqlite3` (rows `unknown`), `undici`/`node:http`
  (HTTP bodies), `jsonrepair` + `JSON.parse`, `process.env`.

## Architecture

### 1. Guardrail layer (ESLint flat config)

`eslint.config.mjs` at repo root, with `typescript-eslint`. Scoped to all
in-scope dirs. Rules:

- `@typescript-eslint/consistent-type-assertions` →
  `{ assertionStyle: 'never' }` — bans `x as T` and `<T>x`; still permits
  `as const`.
- `no-restricted-syntax` → selector `ImportNamespaceSpecifier` — bans
  `import * as`.
- `@typescript-eslint/no-explicit-any` — bans `any`.
- `@typescript-eslint/no-unnecessary-type-assertion` — catches redundant casts
  (type-aware; requires `parserOptions.project`).

`npm run lint` script added and wired into the `typecheck`/CI path.

**Ratchet mechanism:** a baseline disable-list (per-directory `eslint.config`
override entries, or a generated `// eslint-disable` seed) marks
currently-dirty directories so the gate is green on commit one. Each phase
deletes its entry once that directory is clean. CI fails if a *cleaned*
directory regresses. Final phase removes the list entirely → hard-fail
repo-wide.

### 2. zod boundary layer

Add `zod` to `dependencies`. For every boundary that ingests untrusted/untyped
data, define a zod schema **co-located with its domain**, export the inferred
type via `z.infer`, and reuse one schema across all readers/writers of that
shape (DRY). Replace `JSON.parse(raw) as T` with `Schema.parse(JSON.parse(raw))`.

Boundary inventory:

- **Config**: `status-server/config-store.ts`, `config/constants.ts`,
  `presets.ts`.
- **SQLite rows**: `state/runtime-db.ts`, `state/dashboard-benchmark.ts`,
  `state/benchmark-matrix.ts`, `state/chat-sessions.ts`,
  `state/runtime-results.ts`, `state/runtime-artifacts.ts`,
  `state/jsonl-transcript.ts` — schema per row shape.
- **HTTP**: `lib/http-client.ts`, `llm-protocol/llama-cpp-client.ts`,
  `status-server/routes/*` request/response bodies.
- **LLM tool-call JSON**: `llm-protocol/tool-call-parser.ts`,
  `repo-search/planner-protocol.ts`, `summary/planner/json-filter.ts`.
- **Misc JSON / files / env**: `lib/model-json.ts`,
  `lib/json-record-reader.ts`, `status-server/runtime-launch-snapshot.ts`.

The four `as unknown as` double-casts (`http-client.ts:135`,
`planner-protocol.ts:380`, `managed-llama.ts:425`,
`engine/transcript-manager.ts` ×3) get real types or schema validation — no
chained casts survive.

### 3. Namespace-import conversion

Mechanically convert `import * as X from 'mod'` → named imports
(`import { a, b } from 'mod'`) across all ~249 sites. Largely scriptable;
correctness verified by `tsc --noEmit`.

### 4. Residual-cast elimination

Replace remaining `as` with the right tool:
- `satisfies` for config/literal objects that must conform to a type.
- Generics / overloads for helpers that currently cast their return.
- `z.infer` + parse for anything derived from parsed data.
- Typed fixture builders for test mocks (no cast-mocks).

## Phasing

Too large for one PR. Each phase is independently green (typecheck + test +
lint) and drops its disable-list entries.

- **P0** — ESLint + zod scaffolding, baseline disable-list, `lint` in CI. No
  behavior change.
- **P1** — `src/lib` + `src/config` (shared foundations).
- **P2** — `src/state` + DB row schemas.
- **P3** — `src/status-server` (+ `routes`) + HTTP schemas.
- **P4** — `src/llm-protocol` + `src/providers` + `src/repo-search` +
  `src/summary` (tool-call JSON).
- **P5** — remaining `src/*` top-level + `src/web-search` + `src/capture` +
  `src/cli`.
- **P6** — `dashboard/src`.
- **P7** — `tests` + `dashboard/tests` + `bench` + `scripts` + `eval`.
- **P8** — remove disable-list; lint hard-fails repo-wide; delete baseline.

## Verification (per phase)

- `npm run typecheck` green.
- `npm run test` green.
- `npm run lint` green (cleaned scope has zero `as`-casts except `as const`,
  zero `import * as`, zero `any`).
- Spot-check: no `as unknown as` / chained casts in cleaned scope.

## Risks

- **better-sqlite3 row typing**: schemas must exactly match column shapes;
  mismatch surfaces at runtime as zod parse errors (loud, intended — no silent
  legacy fallback).
- **HTTP/undici typing**: `Response`/`RequestInit` shape mismatches may need
  small typed wrappers instead of casts.
- **Test mocks**: some partial mocks currently rely on casts; typed builders
  add code but remove the cast.
- **Diff size**: namespace-import conversion touches 119 files — isolate it in
  its own commit per phase for reviewability.
