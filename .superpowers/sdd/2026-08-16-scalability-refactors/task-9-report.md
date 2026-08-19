# Task 9 report: versioned runtime schema migration registry

## Result

Extracted the current inline runtime schema migrations into `MIGRATIONS`, covering every existing block through `CURRENT_SCHEMA_VERSION = 48`.

- Registry versions: 2–17, 19–27, and 29–48 (45 entries).
- Versions 12 and 13 remain explicit no-op entries.
- The existing gaps at versions 18 and 28 remain gaps.
- Fresh-install handling and effective-version detection remain in `runtime-db.ts` unchanged.
- Migration SQL and migration bodies were mechanically moved; only schema-version bookkeeping moved to the registry runner.

## Changed files

- `src/state/migrations/types.ts` — migration contract.
- `src/state/migrations/schema-introspection.ts` — `tableExists` and `tableHasColumn`.
- `src/state/migrations/app-config-migrations.ts` — app-config/session/run-log migrations and their schemas, including v47 IdleAction migration.
- `src/state/migrations/registry.ts` — ordered v2–v48 migration registry.
- `src/state/runtime-db.ts` — registry runner and exports for shared schema helpers.
- `tests/runtime-db-migration-registry.test.ts` — ascending/current-version registry-shape test.

## TDD evidence

The new registry-shape test was run before implementation. `npm run build:test` failed as expected with the missing `../src/state/migrations/registry.js` module. After adding the registry and runner, the same test passed.

## Validation

- `npm run build:test` — pass.
- `npm run test -- migration-registry` — 1 passed.
- `npm run test -- runtime-db` — 18 passed.
- `npm run test -- runtime-db-schema` — 17 passed.
- `npm run test -- assistant-migration` — 21 passed.
- `npm run test -- model-idle-action-migration` — 14 passed.
- `npm run test -- config` — 162 passed.
- `npm run typecheck` — pass, including all typecheck targets and `npm run lint`.
- The known-hanging `llm-auto-approval` test file was not run.

## Review

Checked registry coverage, strict ordering, current-version endpoint, fresh-install behavior, v47/v48 behavior, and moved helper/function parity against the pre-extraction source. No known concerns.
