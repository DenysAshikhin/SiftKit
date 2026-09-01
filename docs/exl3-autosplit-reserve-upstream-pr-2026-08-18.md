# Upstream PR handoff: autosplit reserve double-counts already-reserved VRAM

Target: `turboderp-org/exllamav3`, base branch **`dev`** (the repo default is `master`, but
merged code PRs go to `dev` — see #280, #276, #274, #257).

Local branch: `fix/autosplit-reserve-double-count` at `ceab221`, cut from `origin/dev` at
`04b21ee`. One commit, one file, +7/-2.

## The defect

`exllamav3/util/memory.py:set_memory_fraction_reserve()` compares two incompatible quantities:

- `torch.cuda.mem_get_info()` returns memory free **after** whatever this process has already
  reserved — a marginal quantity.
- `torch.cuda.set_per_process_memory_fraction(f)` limits the process's **cumulative** reserved
  bytes to `f * total`.

So the computed ceiling is only correct when the caching allocator is empty. Any caller that
loads more than one `Model` into one process has its earlier allocations subtracted from the
budget a second time. `_load_autosplit()` installs the cap once per load and releases it with
`unset_memory_fraction()` at the end, so the binding ceiling is the one installed for the
*last* component — computed with every earlier component already resident.

This is not an exotic usage pattern. It is what `examples/generator.py:166,176` (draft + main)
and `examples/multimodal.py:79,83` (vision + main) do, and how TabbyAPI loads a vision tower,
an MTP draft and the main model.

## The change

```python
     touch_device(device)
     free, total = torch.cuda.mem_get_info(device)
-    fraction = (free - reserve) / total
-    fraction = max(0.01, fraction)
+    # mem_get_info reports memory free *after* whatever this process has already reserved, but
+    # set_per_process_memory_fraction limits the process's *cumulative* reserved bytes. Add the
+    # current reservation back, or memory held by an earlier load in the same process (a draft
+    # model, a vision tower) is subtracted from the budget twice.
+    current = torch.cuda.memory_reserved(device)
+    fraction = (current + free - reserve) / total
+    fraction = min(1.0, max(0.01, fraction))
     torch.cuda.set_per_process_memory_fraction(fraction, device = device)
```

`min(1.0, ...)` is defensive only: `current + free <= total` always holds, so `fraction` cannot
exceed `(total - reserve) / total`.

## Evidence

RTX 4090, 24,563 MiB. Qwen3.5-27B EXL3 4.6bpw (`head_bits: 6`) with vision tower and MTP
drafting, `cache_mode 8,8`, `chunk_size 2048`, `cache_size 130048`. Instrumented by wrapping
`set_memory_fraction_reserve` and `free_mem` in `model_ls`; no source modified for the
measurement.

Cap installed at each of the three components:

| stage  | already_reserved | cap as computed today | cap with fix | lost     |
|--------|------------------|-----------------------|--------------|----------|
| vision | 0 MiB            | 22,940 MiB            | 22,940 MiB   | 0 MiB    |
| draft  | 1,184 MiB        | 21,646 MiB            | 22,830 MiB   | 1,184 MiB|
| main   | 1,568 MiB        | 21,262 MiB            | 22,830 MiB   | 1,568 MiB|

With the fix the ceiling is stable at 22,830 MiB regardless of how many components precede it,
which is what "reserve 96 MiB on the device" should mean.

Unpatched, the main model then dies at the `lm_head` (module 66/67):

```
RuntimeError: Insufficient VRAM in split for model and cache
allocated=20403.5MiB  reserved=21248MiB  cap=21262MiB  driver_free=1678MiB
```

It OOMs with 1.6 GB physically free. Patched, the same configuration loads and settles at
21,540 MiB.

Verified on **pristine upstream**: upstream TabbyAPI `e632af4` plus the official prebuilt
upstream `exllamav3` cu128/torch2.9.0 cp313 wheel in a clean venv — reproduces
unpatched, loads patched.

Runtime check after loading at 130k context: a 119,881-token prompt completed in 89.9 s with a
peak of 22,866 MiB. The load-time cap, not physical VRAM, was the constraint.

## Scope — read before writing the PR body

**Do not claim this fixes #50.** Issue #50 ("Insufficient VRAM in split ... despite remaining
1GB VRAM", open since 2025-06-09) is an umbrella symptom report on a 24 GB 4090 with TabbyAPI,
and it has at least three distinct contributors:

1. The load-time dummy forward reserving worst-case transient headroom. turboderp explained
   this in-thread on 2025-06-11; working as intended, adjustable via chunk size.
2. TabbyAPI's `autosplit_reserve` being unreachable on single-GPU (see below). Diagnosed
   in-thread by @Vhallo on 2025-06-14.
3. This double-count — not identified by anyone in that thread.

Of the two models in #50, only `gemma3-27b` (vision tower + main) is affected by this change.
`Nemotron-Super-49B` is a single-component load and is **not** explained by it. Say "relates to
/ addresses one cause of #50", and consider posting the measurement table as a comment there.

Adjacent, already closed, do not conflate: #229 (`_load_autosplit` double-allocating the dequant
buffer) and #187 (autosplit discarding KV cache placeholders per-layer). Both are in the same
function and both were accepted, which is useful precedent — this class of fix lands.

Single-component loads are effectively unchanged: `already_reserved` at that point is only the
few MiB `touch_device()` itself reserves, and adding that back is correct too (it is already
excluded from `free`). Note the 0 MiB in the vision row above was sampled *before*
`touch_device()` ran, so it understates by that small amount.

## Steps

`origin` in the checkout points at `turboderp-org/exllamav3`, so a fork remote is needed.

1. Fork `turboderp-org/exllamav3` on GitHub.
2. Add the remote and push:
   ```
   cd C:\Users\denys\Documents\GitHub\exllamav3
   git remote add fork https://github.com/<you>/exllamav3.git
   git push -u fork fix/autosplit-reserve-double-count
   ```
3. Open the PR against **`turboderp-org/exllamav3:dev`**.
4. Title: `Loader: Account for already-reserved memory in autosplit reserve`
5. Body: the commit message already contains the measurement table; the draft below expands it.
6. Optionally comment on #50 with the table and an explicit note that it covers the
   multi-component case only.

The commit is authored with a `Co-Authored-By: Claude Opus 5` trailer. Drop it with
`git commit --amend` before pushing if you'd rather it not appear upstream.

### Draft PR body

> `set_memory_fraction_reserve()` derives the per-process cap from `torch.cuda.mem_get_info()`,
> which reports memory free *after* whatever this process has already reserved.
> `torch.cuda.set_per_process_memory_fraction()` then applies that as a limit on the process's
> *cumulative* reserved bytes, so memory allocated by an earlier load in the same process is
> subtracted from the budget twice.
>
> This affects any caller loading more than one `Model` per process — the pattern in
> `examples/generator.py` (draft + main) and `examples/multimodal.py` (vision + main), and how
> TabbyAPI loads a vision tower, an MTP draft and the main model. `_load_autosplit()` installs
> the cap once per load, so by the third component the ceiling has collapsed by the size of the
> first two.
>
> Measured on a 24 GB RTX 4090 loading a 27B EXL3 model with a vision tower and MTP drafting at
> 130k context:
>
> | stage | already_reserved | cap installed | cap with this change |
> |---|---|---|---|
> | vision | 0 MiB | 22940 MiB | 22940 MiB |
> | draft | 1184 MiB | 21646 MiB | 22830 MiB |
> | main | 1568 MiB | 21262 MiB | 22830 MiB |
>
> The main model then fails with `Insufficient VRAM in split for model and cache` while 1678 MiB
> is still free on the device. Adding the already-reserved bytes back holds the cap steady at
> 22830 MiB across all three stages and the load succeeds.
>
> Single-component loads are unaffected beyond the few MiB `touch_device()` reserves.
>
> Relates to #50 — this is one cause of that report (the multi-component case); the
> single-component numbers there are not explained by this change.

## Likely reviewer questions

**Is `memory_reserved` the right counterpart to the fraction limit?** Yes. The caching allocator
checks the fraction against its total cudaMalloc'd bytes, which is what `memory_reserved`
reports. Confirmed empirically: the OOM fires at `reserved=21248` against `cap=21262`, not at
`allocated=20403`.

**Does this let a process fill the card and starve the desktop?** No — the `reserve` argument
still applies, and it now applies once rather than compounding per component. Today's behaviour
reserves `96 MiB × (number of components)` plus the components' own footprint, which is not what
the parameter says it does.

**Why not fix it in TabbyAPI?** Not possible through the API exllamav3 exposes. Compensating via
`reserve_per_device` requires a negative reserve, and `model/model.py` filters
`reserve_per_device[i] >= 0`, dropping the device from `active_devices` and failing immediately.
Reordering components is strictly worse. The only Tabby-side option is switching to
`use_per_device`, which discards the reserve semantics.

**cudaMallocAsync backend?** All measurements above were taken with
`PYTORCH_CUDA_ALLOC_CONF=backend:cudaMallocAsync`, which is what TabbyAPI sets. An earlier run
that accidentally used the native allocator behaved differently enough to matter — worth stating
if allocator behaviour comes up.

## Optional second report (TabbyAPI, separate)

`autosplit_reserve` in Tabby's config is dead on single-GPU: `gpu_count == 1` sets
`gpu_split_auto = False`, so the `elif gpu_split_auto` branch that reads the config value is
never reached and `self.autosplit_reserve` keeps its constructor default `[96 / 1024]`. Still
present at upstream `e632af4`. Already described by @Vhallo in exllamav3#50 but never filed
against TabbyAPI or fixed. Independent of the PR above; file separately if at all.

## Local state

- `exllamav3` `siftkit` @ `08d4b22` — your two commits, plus the fix cherry-picked as `f38cfbb`,
  plus a version bump to `1.3.0+siftkit.freeze.1`.
- `exllamav3` `fix/autosplit-reserve-double-count` @ `ceab221` — the clean single commit for the PR.
- `TabbyAPI` `siftkit` @ `4d6554e` — unchanged; no Tabby change was needed.
- Installed in `rl313`: `exllamav3 1.3.0+siftkit.freeze.1`. Repacked rather than recompiled —
  only `util/memory.py` changed since the previous wheel's source commit, and the local CUDA
  toolkits are 12.1/12.4 against a cu128 torch, so recompiling would have built the extension
  against the wrong CUDA. The `.pyd` is carried through bit-identical (sha256 `d7f1aa04…`).
- Reproduction rig: `c:\tmp\rsx\upstream-check` (upstream TabbyAPI clone + matching venv),
  `c:\tmp\rsx\exl3-memprobe.py` (allocator instrumentation), `c:\tmp\rsx\exl3-probe2.ps1`
  (launch harness), `c:\tmp\rsx\bigprompt.py` (120k-token runtime check),
  `c:\tmp\rsx\probe2-*.records.txt` (captured ladders). Scratch — treat as disposable.
