# Production upstream synchronization result — September 8, 2026

Production now uses pristine upstream EXL3 dev and Tabby main. Both dense presets passed live usage, streaming, vision, request-error recovery, and unload/reload checks. The big Next MoE preset passed generation with upstream CPU offloading and MTP disabled. The active preset is the 4.9bpw dense model.

The migration is operational. Configuration recovery has an unresolved fidelity limit described below; this report does not claim every pre-session preference was recovered exactly. No commits, worktrees, SiftKit retrieval commands, or local upstream source patches were used.

## Installed runtime

| Component | Verified state |
|---|---|
| EXL3 | `1.4.8`, `a99c30994f6d9173e505254e81b0e5d784caa36e`, official `dev` |
| TabbyAPI | `92198cca1aa48f83121027f5b9058c24d7c2d894`, official `main` |
| Local production branches | Both named `production-upstream`, tracking the corresponding upstream branch |
| Python | `C:/envs/rl313-turbo/Scripts/python.exe`, Python 3.13.14 |
| Torch / CUDA | `2.13.0+cu132` / CUDA 13.2 |
| GPU | RTX 4090, compute capability 8.9 |
| EXL3 source | `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench/exllamav3/__init__.py` |
| Native extension | `C:/envs/rl313-turbo/Lib/site-packages/exllamav3_ext.cp313-win_amd64.pyd` |
| Extension SHA-256 | `428b420f48441f5458db8467cb0478bf2c6f5f63136eec69504a8f9d70c80609` |

EXL3 was rebuilt against the installed Torch/CUDA stack. The new TypeScript updater completed a full production update, followed by a separate manifest verification. `pip check` passed. Both upstream working trees match their upstream revisions without tracked changes.

Tabby's base dependencies were installed without CUDA extras. Its release-wheel EXL3/Torch dependencies were not selected. The previous custom EXL3 version, zero-copy modifications, custom qbench/quantization changes, and local Tabby usage patch are absent from the selected production source. Historical custom branches and experimental checkouts remain separate. The untracked benchmark cache was preserved in `D:/personal/models/elx3/benchmark_tools/experimental-cache-20260908`.

## Final presets

Use model paths and their quantization metadata to identify these presets; labels alone are ambiguous.

| Model folder | Context | KV cache | Dynamic draft ceiling | MTP | CPU experts per layer |
|---|---:|---|---:|---|---:|
| `3.8_27b_4.9bpw` | 155000 | Q8 | 3 | Enabled | 0 |
| `3.8_27b_sc_5.00bpw_h6` | 145000 | Q8 | 3 | Enabled | 0 |
| `td_flash-next_4.05bpw_h6_ng6` | 155000 | FP16 | 3, dormant | Disabled | 416 |

All three store dynamic drafting enabled; Next's master speculative-decoding switch disables drafting entirely. Vision offload is enabled. The active 4.9bpw preset uses chunk size 512 and one parallel slot. Context limits were not increased automatically.

The initial 16-token draft ceiling consumed approximately 1.69 GiB more main-model recurrent history than a four-token ceiling. Four allowed the 4.9bpw model to load at 155k/Q8; the user then requested three for every preset. These float32 recurrent rollback states are separate from the main and draft Q8 KV caches. Next's initial 410-expert CPU split failed at the output layer; 416 loaded and generated successfully without changing its context or cache precision.

Follow-up [allocator tracing](2026-09-08-upstream-vram-accounting-check.md) confirmed that Next's 410-expert failure was the new headroom check reserving a genuine 540.38 MiB temporary embedding allocation, with a measured 116.61 MiB shortfall. The cumulative budget formula retains the earlier double-count fix, but a subsequent ownership probe found a separate streamed-vision defect: stale native MLP handles retain 193.64 MiB of original GPU weights after offloading. Rebuilding those handles freed the storage in an isolated probe; no production fix or inference validation has been performed. The approximately 700 MiB freed by six extra CPU experts is not a measured upstream increase, and 416 has not been established as the minimum needed.

## Application changes

- `scripts/update-exllamav3.ts` replaces the external `update-exllamav3.ps1`, which was removed. It validates CLI paths, requires official clean upstream source, rejects local commits, fast-forwards without merge commits, builds without dependency replacement, and verifies source, binary hash, GPU operation and dependencies. Build provenance is stored in `C:/envs/rl313-turbo/exllamav3-build.json`.
- Schema v66 validates existing idle actions in active presets, chat snapshots, benchmark configurations and benchmark cases. The v65 automatic conversion is removed. Unsupported or missing values fail without rewriting snapshots or advancing the marker. The v47 migration retains its original missing-field initialization responsibility.
- Added upstream streaming usage boundary coverage and an opt-in live Tabby test. Existing provider parsing already supports upstream counters; it needed no production change. Both streaming and non-streaming requests must set `stream_options.include_usage: true`.
- Added a test-directory guard that rejects scratch inside an application checkout, with a reproduced failing regression followed by a passing fix.
- Removed seven obsolete feature/rollout documents and 12 stale bytecode files. Mixed historical records are marked superseded and link to the current setup; historical evidence and rejection tests remain.

## Validation

| Check | Result |
|---|---|
| `npm run build:test` | Passed |
| `npm test` | 3537 passed, 0 failed, 5 skipped |
| `npm test -- --dashboard` | 399 passed, 0 failed |
| `npm run typecheck` | Passed, including its lint step |
| `npm run lint` | Passed separately |
| `npm run build` | Passed |
| Upstream Tabby pytest suite, excluding the wheel-install exercise | 157 passed; 14 Torch deprecation warnings |
| Native update, separate manifest verification, `pip check` | Passed |
| Live 4.9bpw / 155k / Q8 / dynamic max 3 | Passed |
| Live 5.0bpw / 145k / Q8 / dynamic max 3 | Passed |
| Live Next MoE / 155k / FP16 / MTP disabled | Passed with 416 CPU experts |

The dense live tests verified loaded context through `/props`, real cold/warm cache hits, MTP counters, final streaming usage and `[DONE]`, two-completion aggregation, a successful concurrent request alongside an HTTP 422 rejection, subsequent recovery, an image response, unload, reload, and generation after reload. Both cache tests reported 0 cached tokens cold and 256 warm for a 386-token prompt. After reload, cached tokens returned to zero. Next returned `upstream verified` with both draft counters exactly zero.

Upstream unit tests also cover zero defaults, counter aggregation and generator recovery after internal generation failures. The live request-error test covers HTTP rejection isolation; it does not inject an internal CUDA fault. Short live requests validate serving and allocated context, not sustained full-context workloads or a throughput/quality benchmark. Next received a generation smoke check, not the full dense-model vision/streaming sequence.

## Configuration incident and recovery limits

An early test run placed its scratch directories under this checkout. Cwd-based runtime discovery then resolved some fixtures to the production `.siftkit` directory. A benchmark fixture overwrote `app_config`, and tests created records in the runtime database. This was an execution error during this session.

The server was stopped when the fixture preset was detected. Recovery used a full configuration recorded September 2, complete model-preset records recorded September 5 UTC, and the selected runtime fields captured before the test run. The resulting configuration was validated against the current schema. The actual model paths, 155k/145k dense contexts, final Q8 settings and user-requested three-token drafting changes were subsequently verified live.

Every other pre-session preference could not be independently reconstructed. Non-runtime preferences and unobserved preset fields may differ from their immediate pre-session values. A newer configuration backup was requested; none was supplied during the session. This uncertainty remains and must not be described as an exact restoration.

Identified fixture records were removed: 34 run logs, four benchmark sessions with dependent records, four question presets, and 36 runtime artifacts. Startup also applied the application's standard seven-day runtime-history retention. No claim is made that history removed by that normal retention pass can be restored.

Recovery sources and configuration backups are retained under `.siftkit/backups/20260908-configuration-recovery` and the dated backup JSON files beside it. These local files may contain private settings and are not committed. The new test-directory guard prevents the nested-scratch failure from recurring through the shared test helper. All subsequent broad tests ran with scratch outside the checkout.

## Cleanup limitation

Automatic approval review rejected removal of the old audit comparison repositories with only `blocked by policy` as its reason. They remain at `C:/Users/denys/AppData/Local/Temp/siftkit-upstream-audit-22cc710286024eb78956f909cff35a93` (`exl3.git` and `tabby.git`).

Automatic approval review also rejected removal of the current-session scratch directory, `C:/Users/denys/AppData/Local/Temp/siftkit-production-sync-20260908`, with `blocked by policy`. It remains intact. The recovery database was copied to `.siftkit/backups/20260908-configuration-recovery/runtime-before-recovery.sqlite` and verified against the source by SHA-256 before the cleanup attempt.

## Closeout

Closed at the user's request with Next fixed at the working **416 CPU experts per layer**, MTP disabled, and vision offload enabled. The user assigned the stale vision-weight fix and upstream PR to a different agent; that work is outside this task. No local workaround was applied to production source.

Final schema-validated configuration readback confirmed dynamic drafting with a ceiling of three for all presets, Next at 416 with MTP disabled, and the dense 4.9bpw/155000 and 5.0bpw/145000 presets using Q8. The active 4.9bpw runtime reported ready and returned `ready` with a normal stop finish reason in a final generation probe. The first probe's 16-token limit with thinking enabled exhausted its answer budget and produced null answer content; the corrected probe explicitly disabled thinking and allowed 64 tokens, matching the established live-test settings.

`npm run typecheck` was rerun successfully at closeout, including its lint step. Earlier full Node/dashboard, build, native and live-preset results above were retained; no application implementation changed after those checks. The final configuration backup is `.siftkit/backups/20260908-closeout-config.json`. All repository changes remain uncommitted. The unresolved preference-recovery fidelity and policy-blocked temporary cleanup are the remaining limitations.

See [the deployment guide](../exl3-backend-setup.md) for the updater command and operational configuration.
