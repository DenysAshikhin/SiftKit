# Production EXL3 / Tabby update — September 29, 2026

## Result

SiftKit's production interpreter now contains EXL3 **1.5.3**, built from current upstream `dev` plus only the Windows WDDM memory-query fix. Tabby is clean official `main`. [PR #389](https://github.com/turboderp-org/exllamav3/pull/389) is updated, mergeable, and remains a draft: one commit, four changed files, no #386 dependency.

| Component | Verified revision |
|---|---|
| EXL3 upstream `dev` | `c42ff710539eb4b843a8395937f3c1583278b91f` |
| Production / PR #389 | `4a1f6e9220f489b1d9d11763d325fa5d48aed682` |
| Production source branch | `production-pr389-dev-20260929` |
| Tabby official `main` | `be74bf0a00bcb3a518e6feb7606f150c189be637` |
| Runtime | `C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe` |
| Stack | Python 3.14.7, Torch 2.14.0+cu132, CUDA build 13.2; RTX 4090, driver 610.47 |

Both upstream branch heads were checked again after deployment and still matched these revisions. Production service was initially stopped and was left stopped. All diagnostic process trees exited; the GPU returned to 0 MiB used and 0% utilization.

## Source and wheel

The custom diff contains only `doc/env_vars.md`, `exllamav3/util/memory.py`, `exllamav3/util/nvml.py`, and `tests/test_memory_headroom.py`. Upstream's loader and `autosplit_prepare` remain unchanged. The migrated loader test uses current upstream interfaces and no longer imports #386's removed fixture. An independent code review found no blocking issues.

The existing builder compiled with **12 workers** and installed first into the build venv. After validation, the same wheel was installed into the independent production venv with `--no-deps`; Python, Torch, CUDA, and model settings were preserved.

- Wheel: `C:\AI\exl3\packages\prod\4a1f6e9\exllamav3-1.5.3-cp314-cp314-win_amd64.whl`
- Wheel SHA-256: `64a009e311325909d3fcc489c67d0f32e3245b58467983bd4564bdb78e7d00b8`
- Extension SHA-256: `331790eebe5963b371839df3d3dd49e8ae13278315c3461361cd089aee9adeff`
- All **576** installed package/extension members matched the wheel in both environments. `pip check` passed.

The eight unrelated conversion/qbench edits were preserved in source-repository stash `c72c302e8796343b7f6121d74aca05103b3e51f1`, including all four untracked tests. They are absent from the new production branch and wheel.

Preserved source refs:

- `backup/production-before-pr389-resync-20260929`: previous production `a20bdd7`.
- `backup/pr389-before-dev-resync-20260929`: previous PR head `b2d2404`.
- Tabby `backup/production-before-main-resync-20260929`: previous production `f07131c`.

The previous `a20bdd7` wheel remains available. The PR fork branch was updated with an explicit lease against `b2d2404`, and its head/base/files/description were verified through GitHub. No upstream PR was merged. No SiftKit commit was made.

## Live checks

After the user's idle-GPU instruction, each GPU test waited for three consecutive samples of **0 MiB used and 0% utilization** before starting. Diagnostics used loopback port 8099 and the existing preset adapter; they did not change persisted configuration.

| Saved preset | Context / cache | CPU experts | Draft / vision | Long prompt / output | Prefill / generation time |
|---|---|---:|---|---:|---:|
| Swift 27B 5 bpw sc65 | 149000 / 149248, Q8 | 0 | MTP maximum 3; vision offloaded | 139766 / 25 | 96.07 s / 0.32 s |
| Flash Next 4 bpw sc | 165000 / 165120, Q8 | 408 | MTP disabled; vision offloaded | 149767 / 25 | 155.33 s / 1.34 s |

Both long requests recovered both reference markers. Both presets also passed streaming usage, image-color recognition, constrained JSON output, malformed-grammar rejection (HTTP 400), and invalid-request recovery (HTTP 422). Swift reported accepted/rejected draft tokens. These are functional checks, not a controlled performance comparison.

Long checks ran against the exact wheel in the build venv. After installation into `venv-runtime`, both presets passed another full load and short generation: Flash Next loaded in 50.466 s; Swift in 14.194 s. The model cards matched saved context, cache, chunk, slots, and vision settings. Swift again reported MTP activity.

An earlier Swift long attempt ended with CUDA launch failure 719 while unrelated Brawl workers were present. After that diagnostic exited, three Brawl processes still held 1008 MiB. The identical prompt succeeded after the GPU became empty. No code changed between those attempts; the failure's cause was not established, and competing GPU workloads are not validated here.

The serialized `app_config` row remained unchanged, SHA-256 `8e86f81c0daf2c86027cc76d60970c0ef9b778caa6bda4d7eced1bbfacb529cb`. Tabby's `config.yml` remained byte-identical, SHA-256 `74df24a1dd43d182aa67186b221731c20d2342e46337d041f5c143ae20db1f7f`.

## Tests and limits

- WDDM regression: pristine current `dev` had **13 failures / 8 passes**; the patch passed **21/21**.
- Installed loader/native tests: **385 passed, 1 skipped**, separately in build and production venvs.
- Tabby: **191 passed**. Its wheel-installer exercise was excluded to preserve the custom package stack.
- SiftKit: **4215 passed, 4 skipped**.
- Final `npm run typecheck`, including `npm run lint`, and `git diff --check` passed. The first lint attempt hit permissions on an elevated pytest scratch directory; the clean rerun passed after its removal.

The unrestricted EXL3 suite was run: **767 passed, 349 failed, 10 skipped, 8 collection errors, 27 subtests passed**. It is not a green full-suite result:

| Failure group | Count | Evidence |
|---|---:|---|
| `test_cache_rotate`, `test_gated_delta_rule`, `test_rope`, `test_sampler` | 292 | Hardcoded GPU 1/2; this machine has GPU 0 only |
| `test_mla`, `test_mla_dsa` | 47 | Upstream `FakeSTC.get_tensor` fixtures reject the current `arena` argument |
| `test_fla_vendored_` | 10 | Four KDA and six simple-GLA parity failures |

Pristine current-dev Python source with the identical extension reproduced all **57 MLA/FLA failures**, with 31 other cases passing. The collection errors were `test_build_sam` (optional `zstandard`), `test_device_copy_` and `test_reconstruct_had` (additional GPUs), `test_dsv4_cached` and `test_dsv4_state` (missing comparison helper), and `test_ngram_prefetch_`, `test_qgemm`, and `test_quant_fn` (unavailable model fixtures). These upstream/test-environment limitations were reported without modifying their tests or adding patches to production.

Native Linux, additional GPUs, tensor-parallel WDDM admission, competing GPU workloads, and the older saved 155k dense preset were not exercised. TCC detection retains #389's NVML requirement and explicit error when its driver DLL cannot load. Tensor-parallel budgets and the final verbose CUDA memory report remain upstream.

Selected logs, exact failure names, wheel comparisons, and model-response records are retained beside the wheel in `C:\AI\exl3\packages\prod\4a1f6e9\validation`. Temporary probes and copied source snapshots are removed at closeout.
