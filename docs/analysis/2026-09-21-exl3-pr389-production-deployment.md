# EXL3 PR #389 production deployment

Deployed 2026-09-21. No SiftKit retrieval or execution tools were used.

The production Python environment at `C:\AI\exl3\prod\venv` now contains EXL3 1.5.1 built from `production-pr389` at `7940b78262b98fb73914fe2ceb2fa0d2b2f0c999`. That source includes latest fetched upstream `dev` at `8271af4e245a32ff339d1516a0b3702c0cb699a5` and [draft PR #389](https://github.com/turboderp-org/exllamav3/pull/389) at `b2d2404a643b92e706e282ba8910d02c25af0f03`, including #386.

GitHub verification confirmed **#386, #387, and #389 all target `turboderp-org/exllamav3:dev`**. #387 is closed and superseded by upstream `6b84a21`, which implements a portable bit-count loop. The production branch uses that upstream fix. #389 remains a draft. No upstream branch was pushed or merged by this deployment.

## Rebuild command

```powershell
npm run exl3:build-wheel
```

`scripts/build-exllamav3-wheel.ts` builds, installs, and verifies the wheel. The npm command explicitly supplies **`--jobs 12`**, which sets `MAX_JOBS=12`; the live compiler command was verified as `ninja -v -j 12`. Refresh and merge the desired upstream/PR revisions before invoking it; it rejects dirty source and source that does not contain the locally fetched `origin/dev`.

Final wheel: `C:\AI\exl3\packages\prod\7940b78\exllamav3-1.5.1-cp314-cp314-win_amd64.whl`.

SHA-256: `de950579be76d08a45028e186ed06d537c16309b92410d312bbc0d0da06e9fc0`.

The adjacent `build.json`, `source.sha`, and `wheel.sha256` record provenance and 12 workers. Torch remains `2.14.0+cu132`, CUDA `13.2`, Python `3.14.7`. Package and extension imports resolve inside the production venv. Previous wheels and the previous production source branch remain available.

## Verification

- Deployment-time builder/preflight suite: **32 passed**. `npm run typecheck`, including lint, passed; `git diff --check` passed.
- Final installed EXL3 wheel: **52 passed, 3 skipped**. Four optimizer tests that inspect checkout source passed separately in the source checkout. The 25 loader/NVML regression cases also passed with parent CUDA tests first.
- Installed `model_ls.py`, `util/memory.py`, and `util/nvml.py` hashes match the production source. A real NVML query selected the installed System32 driver DLL.
- Saved production preset: 150000 context, 150016 Q8 cache, chunk 2048, 411 CPU experts, offloaded vision enabled, MTP disabled. The saved configuration was read without changes.
- Long-context validation: 124852 input tokens, 1024 output tokens, all three reference markers recovered, 920.4 prefill tokens/s and 20.47 decode tokens/s. This ran on the first build, `ffa2ab2`.
- A test-only follow-up corrected NVML cache isolation after earlier real CUDA tests; the exact final source was rebuilt as `7940b78`. Runtime source is unchanged, but relinking changed the extension hash, so the final wheel received another load and generation smoke test: 51.4 s load, 103 generated tokens. These were diagnostic servers using the saved preset on loopback port 8099; they were stopped afterward. Production was not running before deployment.

The full SiftKit suite ran: **4143 passed, 3 failed, 5 skipped**. The failures are existing fixtures in `tests/contracts-chat.test.ts` that omit the required `sessionThroughput` field:

- `assistant narration and progress persist with the stopped transcript`
- `ChatSessionSchema no longer carries a condensed summary`
- `ChatSessionSchema requires modelPresetId`

Both that test file and `packages/contracts/src/chat.ts` matched HEAD and were not changed. These failures do not concern the EXL3 deployment. SiftKit tests used the official compiled runner; source-layout tests ran in the EXL3 checkout.

The [validation record](2026-09-21-exl3-pr389-production-deployment.json) contains build provenance, source hashes, model settings, and measured results. This validates the current Windows machine and saved preset, not native Linux or other hardware.

Automatic approval review rejected guarded deletion of `C:\AI\exl3\staging\pr389-deploy-20260921` with “blocked by policy.” Its temporary logs, test dependencies, and probes remain. No alternative deletion was attempted.
