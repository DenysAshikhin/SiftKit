# EXL3 loader regression: changes in the last three weeks

Investigated 2026-09-21. Window: 2026-08-31 through 2026-09-21. Upstream `dev` inspected at `958ec933361b24eb8426ec7222e5b0062a679dcd`; the last commit before the window is `3ddd811be9240d5f10956133441e6fb31217f7c2`. Dates below use the commits' recorded author dates. No SiftKit commands were used.

Two September commits introduced the rejection paths seen in the Windows investigation. The measuring forward and the reserve helper's CUDA memory query existed before the window. The newer checks made that query's WDDM headroom underestimate consequential in additional places.

The Windows follow-up is open as **draft [PR #389](https://github.com/turboderp-org/exllamav3/pull/389)**: runtime change `c54e384` and test-isolation follow-up `b2d2404` on top of #386's `e66acec`. Its [incremental diff](https://github.com/DenysAshikhin/exllamav3/compare/e66acec756b6ee51dc5f9c8a8a714d47e46a397f...b2d2404a643b92e706e282ba8910d02c25af0f03) changes five files: the shared memory helper, lazy Windows NVML binding, LS loader query, regression tests, and memory documentation. It leaves Linux's CUDA query unchanged. The follow-up was subsequently [installed in production](2026-09-21-exl3-pr389-production-deployment.md).

## September 7: retain each device's largest measured transient

[`9d771c9`](https://github.com/turboderp-org/exllamav3/commit/9d771c9fccf01a3a9c1dae556396f3d8c8fe7cf6), “Loader: Explicitly measure transients and carry through to subsequent layers on the same device,” added:

```python
transient = max(0, torch.cuda.max_memory_allocated(load_device) - alloc_before)
max_transient[i] = max(max_transient.get(i, 0), transient)
if torch.cuda.memory_allocated(load_device) + max_transient[i] > device_budget[i]:
    raise torch.cuda.OutOfMemoryError(...)
```

Exact current-dev locations: [`model_ls.py:203`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/model/model_ls.py#L203), [`206–214`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/model/model_ls.py#L206-L214). The same commit made the reserve/use helpers return their allocator budget and stored it in `device_budget` at lines 161/163.

This correctly protects earlier layers with larger workspaces, but the original peak delta also counts allocations that remain resident after the measuring forward. Those allocations are then present in both `memory_allocated` and the retained `max_transient`. PR [#386](https://github.com/turboderp-org/exllamav3/pull/386) addresses that double counting through remeasurement.

This is also the **first check that rejected the previously measured 185k Windows load even with #386's remeasurement**: 22,492.48 MiB allocated + 548.95 MiB transient exceeded the CUDA-derived 22,846 MiB budget by 195.43 MiB. Switching the memory source produced a 23,612.04 MiB budget without changing those measured allocations. Those numbers come from the earlier [memory-source investigation](2026-09-21-exl3-windows-loader-pr-investigation.md), not a historical full-model bisect.

## September 11: check CUDA-reported physical headroom and cap explicit use

[`0ca3587`](https://github.com/turboderp-org/exllamav3/commit/0ca3587b48ec1c739400488413071468c4b12517), “MoE: Add worstcase measurement during autosplit load,” added:

```python
autosplit_margin = int(os.environ.get("EXL3_AUTOSPLIT_MARGIN_MB", 256)) << 20
free_now, _ = torch.cuda.mem_get_info(load_device)
reusable = free_now + torch.cuda.memory_reserved(load_device) - torch.cuda.memory_allocated(load_device)
if reusable < max_transient[i] + autosplit_margin:
    raise torch.cuda.OutOfMemoryError(...)
```

Exact current-dev locations: [`model_ls.py:123`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/model/model_ls.py#L123) and [`222–231`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/model/model_ls.py#L222-L231).

On the observed WDDM configuration, CUDA reported no free bytes while NVML still reported dedicated memory available. This new check would also reject the measured 185k load: 437.52 MiB of CUDA-derived reusable memory versus 804.95 MiB required. NVML-derived reusable memory was 1,203.55 MiB. Thus correcting only the first budget comparison would leave a second rejection.

The same commit changed the explicit `use_per_device` helper from:

```python
fraction = min((current + use) / total, 1.0)
```

to:

```python
free, _ = torch.cuda.mem_get_info(device)
fraction = min((current + min(use, free)) / total, 1.0)
```

Exact current-dev location: [`memory.py:61–62`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/util/memory.py#L61-L62). This extends the same underestimate to explicit split budgets. The tested single-GPU Tabby configuration uses its default **96 MiB reserve** instead, so this explicit-use change is an additional affected path, not the initial cause in that preset. The reserve helper's `mem_get_info` call at line 32 predates this three-week window.

## Why CPU-offloaded MoE exposed the accounting problem

`0ca3587` also added `BlockSparseMLP.autosplit_extra_measure` and moved persistent CPU-streaming device buffers into the measuring window. Current-dev references: [`block_sparse_mlp.py:880–905`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/modules/block_sparse_mlp.py#L880-L905) and [`moe_cpu_host.py:1374–1378`](https://github.com/turboderp-org/exllamav3/blob/958ec933361b24eb8426ec7222e5b0062a679dcd/exllamav3/model/moe_cpu_host.py#L1374-L1378).

This made the required allocations visible during loading, which is necessary. In combination with September 7's peak accounting, it also exposed the persistent-as-transient double count fixed by #386. The Windows follow-up retains these measurements and both safety checks, changing only their free-memory source for WDDM.

## Verification scope

Commit attribution is verified with `git log`, `git show`, and `git blame` on the upstream branch. The pre-window source already runs `module.forward`; the September changes did not introduce that forward pass.

Isolated regressions executed the **actual historical loader/helper source** from each commit and its immediate parent against the same current dependencies and real CUDA fake modules:

| Controlled case | Before commit | At commit |
| --- | --- | --- |
| `9d771c9`: four 64 MiB modules, 128 MiB recurring forward workspace, first module leaves 512 MiB resident; 1,152 MiB load budget | Loads | Rejected |
| `0ca3587`: one 64 MiB module, 128 MiB workspace, fixed 2 GiB budget; CUDA free query reports zero while real allocations fit | Loads | Rejected |
| `0ca3587`: explicit-use helper, 100 MiB already reserved, 400 MiB requested, 1,000 MiB total, zero reported free | 500 MiB budget | 100 MiB budget |

The second case holds the budget fixed to isolate the new physical-headroom comparison. The third separately isolates the explicit-use clamp. The first uses enough allocator slack to separate persistent double counting from actual allocation failure. These controlled results confirm the introduced failure mechanisms; they do not reproduce the entire application, model implementation, driver, or PyTorch build from three weeks ago.

The follow-up's final applicable suite passed **56 tests, with 3 skipped**. Ruff fatal-error rules, Python compilation, and diff checks passed. Full-suite collection was blocked by unavailable second-GPU/model fixtures and the missing `compare_deepseek_v4_hf_` module; the draft lists each affected test. A real 185k-capacity load completed a 149,851-token prompt and 1,024 generated tokens with all markers recovered and zero sampled allocator retries/OOMs. The existing guard rejected a 230k load. Native Linux hardware, other drivers, and full 185k occupancy remain untested. [Compact validation evidence](2026-09-21-exl3-wddm-pr389-validation.json).

The linked validation JSON records the initial PR revision `c54e384`. The later test-isolation revision
`b2d2404` and installed wheel are covered by the [deployment record](2026-09-21-exl3-pr389-production-deployment.md).

Automatic approval review rejected guarded removal of the task scratch and pytest cache with “blocked by policy.” Temporary artifacts remain under `C:\Users\denys\Documents\GitHub\exllamav3-wddm\.scratch\wddm-pr` and that checkout's `.pytest_cache`. No alternative deletion was attempted. At the end of this investigation, the PR checkout was clean, installed production files retained their original hashes, and all diagnostic servers had stopped. Production was updated during the subsequent deployment.
