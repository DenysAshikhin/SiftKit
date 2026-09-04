# EXL3-only main integration

Date: 2026-09-04. Branch: remove-llama-backend.

Merged main at 59302ea76b0c0880ed6a78c8d22907921395e3a8 into the existing EXL3 branch and incorporated its preserved, previously uncommitted backend-removal work. Main itself was not changed or merged into.

## Result

- Main migrations v57-v62 remain in order and unchanged in behavior. EXL3 removal is appended as v63; fresh databases also use v63.
- Inference/runtime/config/dashboard/bench callers use the EXL3-only contracts and final inference names. Removed backend scripts remain deleted.
- Main measured-prompt accounting, operation-specific output caps, operation identities, and per-row chat token accounting are retained. Model-preset MaxTokens remains removed.
- EXL3 NcpuMoe expert offloading remains supported, including its editable dashboard control. The stale general-page Backend field is removed.
- Request tests isolate cwd-based SQLite storage. The benchmark subprocess inherits the caller cwd, keeping its runtime database aligned with the parent.
- Historical migration fixtures recreate historical column names rather than only changing version numbers. The v63 tests cover v62 upgrades, removed-backend data, preserved EXL3 presets and offloading settings, malformed JSON, and reopening.

## Validation

Final commands: npm run typecheck; npm run lint; npm run build:test; npm test; npm run test:dashboard.

All passed. Node: 3,507 passed, 0 failed, 6 skipped (3,513 total). Dashboard: 400 passed, 0 failed. The reference-removal guard passes. Focused migration/inference tests and benchmark interruption regression passed. SiftKit's bounded acceptance review found no concrete lost main behavior.

The six skips comprise a POSIX-only case, three live EXL3 cases, and two absent private-fixture cases. Live EXL3 inference was not rerun.

## Local worktree caveat

The existing ignored .siftkit/runtime.sqlite has experimental schema numbering: version 58 with server_model_presets_json already present. It is not a normal main-v58 database and needs a separate, explicit data reconciliation before launching this checkout against it. No compatibility migration or data reset was added. The supported main-v62 to v63 path is tested using isolated databases.

The unrelated assistant/personalized_llm_assistant_interactive_mockup.html edits are preserved byte-for-byte and remain outside the merge commit. The September 2 handoff is historical and superseded by this report.
