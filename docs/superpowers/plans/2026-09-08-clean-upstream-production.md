# Clean upstream production implementation plan

**Goal:** Run pristine upstream EXL3 dev and Tabby main, retire experimental production changes and obsolete residency conversion, and verify the installed runtime.

**Architecture:** Preserve deployment paths and historical experimental branches. Select clean upstream source, build EXL3 against the existing Python/Torch/CUDA environment, and install only Tabby's base dependencies. Replace the external custom PowerShell updater with a checked-in TypeScript updater that accepts explicit paths, rejects divergent/dirty source, fast-forwards upstream, builds without dependency replacement, and checks installed provenance.

**Tech stack:** TypeScript/Zod, Node test runner, SQLite; upstream Python/C++/CUDA, Windows/MSVC.

**Spec:** `docs/analysis/2026-09-07-production-upstream-sync-audit.md` and the six-part scope approved in chat September 8.

## Constraints

- No SiftKit commands, worktrees, commits, or destructive Git operations.
- Preserve experimental commits and the untracked benchmark cache outside the active production checkout.
- All authored implementation/tests are TypeScript with validated IO and no assertions/any.
- One scratch directory: `C:/Users/denys/AppData/Local/Temp/siftkit-production-sync-20260908`; remove at completion. Test scratch must be outside the application checkout.
- No automatic conversion of obsolete residency values; validate all four persisted snapshot locations before advancing the schema marker.
- Upstream repositories remain pristine. No local Python patches or release CUDA extras.

## Tasks

### 1. Clean source and native runtime

- [x] Record source revisions, package/toolchain state, and active preset without exposing credentials.
- [x] Preserve cache outside active source; switch both clean tracked trees to new `production-upstream` branches at official upstream refs.
- [x] Install Tabby base dependencies; rebuild/install EXL3 using Python 3.13, Torch 2.13 cu132, CUDA 13.2 and MSVC, without resolving replacement wheels.
- [x] Check import paths, package version, extension hash, CUDA operation, pip check, and pristine Git diffs.

### 2. Strict residency migration

Files: `src/state/migrations/app-config-migrations.ts`, `src/state/migrations/registry.ts`, `src/state/runtime-db.ts`, `tests/model-idle-action-migration.test.ts`.

- [x] Add failing regressions: old freeze-containing active config and each snapshot must throw and leave schema marker/data unchanged; valid v64/v65 databases advance unchanged.
- [x] Remove mode abstraction and freeze conversion from v47 helper. Remove v65 conversion entry and add v66 validation using `ModelIdleActionSchema` for active config, chat snapshots, benchmark configs and cases.
- [x] Run migration/config/route/UI regression tests. Keep tests proving obsolete values/routes/UI are rejected.

### 3. Production updater

Files: `scripts/update-exllamav3.ts`, `tests/update-exllamav3.test.ts`, `tsconfig.scripts.json`; remove external `D:/personal/models/elx3/benchmark_tools/update-exllamav3.ps1` after replacement verification.

- [x] Write failing tests for invalid inputs, dirty/divergent source rejection, upstream fast-forward, and Windows build-environment quoting. Verify dependency preservation during the real build/install.
- [x] Implement explicit CLI paths and modes, bounded child commands, source validation, build/install/provenance checks. Use existing installed toolchain, fail if absent, and keep build artifacts under caller scratch.
- [x] Run updater tests, typecheck and lint; exercise its verification against actual production.

### 4. Upstream usage contract

Files: `tests/llm-protocol-streaming.test.ts`, `tests/tabby-usage-metrics.e2e.test.ts` or focused provider tests if lower-level boundary is necessary.

- [x] Verify zero-filled details, cached count boundaries, accepted/rejected aggregation and final streaming usage; change production parsing only if a regression proves necessary.
- [x] Run existing usage propagation and streaming tests.

### 5. Cleanup and documentation

Files: `docs/exl3-backend-setup.md`, obsolete feature plans/handoffs listed in audit, mixed historical documents containing obsolete operational instructions.

- [x] Delete dedicated obsolete feature artifacts and stale bytecode. Preserve unrelated history and ordinary CPU offloading.
- [x] Remove obsolete operational directions from mixed documents, linking current deployment instructions where needed.
- [x] Update setup with exact revisions, actual model/preset/interpreter, clean updater commands and retired database support.

### 6. Full and live verification

- [x] Run relevant tests, broader applicable Node/dashboard suites, `npm run typecheck`, `npm run lint`, and build.
- [x] Launch managed runtime using existing configuration. Verify load/unload/reload, vision/MTP, cold/warm cache usage, streaming, multi-generation aggregation and error recovery. Keep configured model/context unchanged after checks.
- [x] Review all diffs independently; record commands, results, hashes, limitations in `docs/analysis/2026-09-08-production-upstream-sync-result.md`.
- [x] Close out scratch cleanup: removal was attempted and rejected by automatic approval review (`blocked by policy`); both temporary directories remain, with paths documented in the result. Recovery database backup verified. Authorized changes remain uncommitted.

Closed September 8 at the user's request. Next remains at the verified 416 CPU experts with MTP disabled. The user assigned the discovered stale vision-weight retention bug and upstream PR to another agent; no local engine fix is included here. Configuration recovery fidelity remains limited as documented in the result.

### Validation findings incorporated

- [x] Add a failing regression for test scratch within an application checkout; reject it before any directory or runtime is created.
- [x] Recover configuration after a test fixture reached production through the earlier nested scratch root; remove identified fixture records. Record recovery limits in the result document.
- [x] Confirm actual 4.9/5.0-bit model files and preserve 155k/145k Q8 contexts. Set all draft ceilings to three, dynamic enabled, with MTP disabled for the big Next MoE preset, as requested.
