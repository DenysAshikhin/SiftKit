# ExLlamaV3: deferred / fused GDN replay investigation

2026-11-24. Investigation only: no ExLlamaV3, TabbyAPI or SiftKit code was changed and no prototype was built.

Evidence tags: **[M]** measured, **[S]** read from source, **[P]** measured through an equivalent existing kernel, **[E]** estimate or arithmetic, **[H]** hypothesis.

## 1. Summary

- **Deferred replay is applicable but not worth building for single-user use.** Current upstream does not have it. At batch 1 with fp16 state it beats today's replay for 1-2 kept tokens, ties at 3 and loses above that [P]. Net GPU effect on 27B MTP decoding: about 0.04-0.12% [E].
- **Two smaller changes are worth more.**
  1. Launch `batched_scan_replay` with `v_split = 1` instead of 4: 1.9-2.2x faster at 3-5 kept tokens, bit-identical state [P]. About 0.15-0.24% end to end [E].
  2. Stop rebuilding the rewind job lists in Python every cycle: saves about 0.2-0.27 ms of host time per cycle [M], 0.4-1.1% per cycle on the 27B [M], with identical GPU work.
- **VRAM:** fusion alone saves nothing. Dropping the second state row saves 72 MiB per sequence on the 27B and 54 MiB on Flash-Next, about 2,300 tokens of Q8 KV on the 27B [E]. It does not need fusion: the batched replay can settle in place (design D).
- **Recommendation:** propose changes 1 and 2 upstream. Treat the single row as a separate optional follow-up. Do not build fused replay unless batch >= 4 becomes a target.
- **Main risk of fusion:** the next verify pass overwrites the staged inputs before its scan would read them (section 6), so it needs a second staging set and graph rebinding.

Against section 20 of the brief: fusion is well below 1%, so reject. Changes 1 and 2 together are around 1% at short context and less at 128K, for a small patch.

## 2. Baseline

| Item | Value |
|---|---|
| Upstream `dev` HEAD | `2d79ab55ad4697126249ef31c3558fdba2d1ff1b` |
| Build measured | `8909b92` = `2d79ab55` + the local WDDM loader commit (no GDN files) |
| Runtime | torch 2.14.0+cu132, Python 3.14, RTX 4090 at a 360 W limit, driver 610.88 |
| llama.cpp | #31669 merged 2026-11-23 as `d35dc4d9e`, still the last commit to the CUDA GDN file. Master when checked: `33aeb17f` |

Checked: exllamav3 #489 (merged); issues #457, #505, #506 (closed; #505 is an issue, not a PR); `3a8e2fb8` (replay), `0f685aa9` (register-resident state), `02446529` (fp16 by default). Open draft **#618** (quantized GDN state) edits the same launcher and shares the memory goal. Searches for "replay" and "rewind" across PRs, and "GDN replay" across issues, found no deferred replay. llama.cpp follow-ups: #32721 (Vulkan, merged), #32944 (SYCL, open).

The brief's preliminary description of ExLlamaV3 held up against source. One addition: a pass always keeps at least its first token, so a prefix of 0 never occurs.

## 3. Current architecture [S]

### State lifecycle

| Event | Recurrent state | Conv state | Notes |
|---|---|---|---|
| Prefill, 1-token decode | read and write base row | window updated in place | `SCAN_INPLACE`, or fla chunk kernel when seqlen >= 48 |
| Draft (MTP) | none | none | the 27B's MTP cache has 0 recurrent layers [M]; Flash-Next's MTP layer is full attention |
| Verify (`recurrent_history`) | read base, write scratch | inputs written to ring tail | `SCAN_SPEC`; scan inputs land in `spec_conv/beta/g` |
| Full accept | parity flip | ring copied back | no replay |
| Partial accept | replay base -> scratch, then flip | ring copied back | one launch per 48 layers per sequence |
| Reject all drafts | same, prefix 1 | same | |
| EOS, cancel | not settled; slot released | same | the next owner clears both rows |
| Page boundary (256 tokens) | drafts cut, state settled, stashed | stashed | rolling checkpoint |
| Banned-string rewind | restored from a stash or reset, then re-prefilled | same | `rollback_capacity()` is 0 |
| Stash | asserts `last_history == 0` | same | `stash_header` |

`rewind(n)` keeps `last_history + 1 - n` inputs. The bonus token is not an input of the verified pass, so kept inputs = accepted drafts + 1.

### Buffers (Qwen3.8-27B, 1 slot, `max_history` 8, fp16) [M]

| Buffer | Shape per layer | All 48 layers | Lifetime |
|---|---|---|---|
| `recurrent_state` | (2 x slots, 1, 48, 128, 128) | 144.00 MiB | cache |
| `conv_state` | (slots, 10240, 4 + hist) bf16 | 11.25 MiB | cache |
| `spec_conv` | (slots x (hist + 1), 10240) bf16 | 8.44 MiB | cache |
| `spec_beta`, `spec_g` | (.., 48) bf16 / fp32 | 0.12 MiB | cache |
| **Total** | | **163.81 MiB** | |

No buffer is shared between layers. All scale with slots; all but the state scale with depth. The staging views are the captured graphs' statics for history slots (`stage_key`); the state pointer and slot-index pointers are patched per launch. Replay allocates no transient VRAM: its job table is about 3 KB of kernel arguments. One checkpoint is 75.75 MiB of system RAM. Flash-Next has a 108 MiB state pool [M].

### Kernels [S]

- Blocks are 128 x 2 threads. Each thread owns 64 k-rows of one v-column. With `v_split = 4` only 32 of 128 columns are active per block, so 75% of threads only help normalise q and k.
- The state slice stays in registers for the whole pass: loaded once, stored once. k, q and the partial sums use 5.1 KB of shared memory. q, k, v, g and beta are read from global memory per token.
- Replay runs the same body without the attention output. It still reads and normalises q.
- The 128x128 kernels use 64 registers with no spills, scan and replay, fp16 and fp32 [M: compile of unmodified `gdn.cu`]. The generic 256-wide kernels do spill.
- The scan uses `v_split = 4` only at batch 1 (192 blocks on 128 SMs). Replay always uses 4 for this geometry: 48 layers give 9,216 blocks where roughly 512 fit at once [E].

## 4. llama.cpp comparison [S]

#31669 keeps one committed state row plus k, v, g and beta for up to `n_rs_seq + 1` pending tokens. `seq_rm` only lowers the pending count. The next ubatch's op replays the kept tokens in registers, writes the replayed state back when the ubatch must stay rollbackable (`keep`), then scans the new tokens and discards their final state. Full acceptance is therefore replayed too. Long prefills do a separate replay-only launch first. Pending inputs travel in checkpoints.

| llama.cpp idea | ExLlamaV3 |
|---|---|
| Replay instead of snapshots | Already present |
| Register-resident state | Already present (`0f685aa9`) |
| Reduced-precision storage | ExLlamaV3 is ahead: fp16 state and bf16 staging against fp32 |
| Full accept without replay | ExLlamaV3 only |
| Cross-layer batched replay | ExLlamaV3 only |
| Replay fused into the next scan | Not present; small or negative gain at batch 1 |
| One state row | Not present; transferable without fusion |
| No Q in pending data | Not present; 1.69 MiB, not worth it (section 7) |
| Pending data in checkpoints | Not needed; ExLlamaV3 settles before stashing |

The 73-91% saving is against snapshots ExLlamaV3 no longer keeps. llama.cpp reports 163 MiB at depth 3; ExLlamaV3 uses 164 MiB at depth 8 with two rows.

## 5. Measurements

### Replay versus fused: GPU time, 48 layers, batch 1, fp16 [P]

Fused cost is bounded above by `scan(s + p) - scan(s)`, which includes q and output work that a replay loop could skip. Launches were queued behind a GPU delay, so host speed is excluded. Microseconds, verify width 5.

| Kept tokens | Replay today | Fused, upper bound | Replay at `v_split = 1` (proxy) |
|---|---|---|---|
| 1 | 167 | 92 | 137 |
| 2 | 228 | 198 | 143 |
| 3 | 290 | 293 | 155 |
| 4 | 361 | 371 | 171 |
| 5 | 409 | 476 | 189 |
| 8 | 606 | 725 (width 8) | 253 |

The proxy is one 48-row `SCAN_SPEC` call, which already uses `v_split = 1`. It does the same work plus the attention output write. Its state was bit-equal to the replay in every case tried (2, 4, 8, 12, 36 and 48 layers; fp16 and fp32; 1-15 tokens) and it was never slower. At fp32 the 48-layer gain is small for short prefixes: 303 vs 291 us at 1 token, 441 vs 312 us at 5.

Batches of 2 / 4 / 8 at 3 kept tokens: replay 579 / 1,156 / 2,275 us, fused bound 239 / 338 / 548 us. Merging all sequences' jobs into one call did not help (581 / 1,161 / 2,281 us). Fusion does pay at higher batch. `v_split = 1` extrapolates to about half of today's figure there [E].

### Memory traffic [E from M]

Replay reads and writes 72 + 72 MiB (fp16). Fusion could avoid up to 144 MiB per partial accept, or 288 MiB at fp32. A 1-token replay moves data at roughly 900-980 GB/s (167 us fp16, 306 us fp32), close to the card's nominal 1,008 GB/s, so state I/O is most of the fixed cost. DRAM counters and L2 hit rate were not captured. The 144 MiB state set exceeds the 72 MB L2, so I assume little residency.

### Where the time goes: real 27B MTP decoding [M]

Close to the served settings (Q8 KV, 1 slot, `-ndt 4`, hybrid 8, dynamic), 400 greedy tokens, short context:

| Prompt | tok/s | Cycle | Partial / full | Replay GPU, share of generation |
|---|---|---|---|---|
| code | 153-155 | 25 ms | 37-42 / 60-68 | 0.32-0.38% |
| prose | 89 | 24 ms | 137-142 / 45-48 | 0.62-0.64% |
| copy | 304-306 | 27 ms | 3 / 45 | 0.06% |

`rewind()` host time in these runs was about 410-490 us for partial accepts on code and prose, and 160-210 us for full accepts, with timing hooks on.

### Ablation: forced acceptance, 27B, no drafting, back to back [M]

Change in ms per cycle. Width 5 unless noted. Arm standard deviations were 0.01-0.1 ms, so single cells under about 0.1 ms are noise.

| Kept | Cycle | All replay work removed | GPU launch removed | Replay jobs memoised |
|---|---|---|---|---|
| 1 | 22.43 | -0.12 | -0.09 | -0.21 |
| 2 | 22.45 | -0.22 | -0.06 | -0.19 |
| 3 | 22.61 | -0.35 | -0.18 | -0.27 |
| 4 | 22.59 | -0.36 | -0.16 | -0.23 |
| 5 (full) | 22.42 | -0.02 | -0.03 | -0.04 |
| 8 of 16 | 25.89 | -0.57 | -0.31 | -0.24 |

Free replay would save 0.5-1.6% of a width-5 verify cycle (2.2% at 8 of 16). Building the conv rewind jobs costs about another 0.15-0.2 ms of host time on every cycle, full accepts included.

### Host-side memoisation in real decoding [M]

GPU work is identical; only the conv and replay job lists were cached. Median of 8 random-order pairs, ms per cycle:

| Case | Engine | Memoised | Pair gain |
|---|---|---|---|
| 27B code, short | 26.58 | 26.31 | 0.75% |
| 27B prose, short | 24.37 | 24.17 | 1.11% |
| 27B code, 128K | 34.13 | 33.94 | 0.55% |
| 27B prose, 128K | 31.67 | 31.40 | 0.76% |
| 27B prose, 128K, repeat with control | 31.40 | 31.27 | 0.36% |
| Flash-Next 3.5bpw, 4 cases | 22.7-30.1 | 22.5-29.6 | not resolved |

The A/A control for the 128K repeat ranged from -0.65% to +0.64%. All 8 memoised pairs were positive (0.11-1.01%), but the size of that gain is within control noise. Flash-Next cycles vary by 1-5 ms (CPU MoE), which hides the effect; `rewind()` itself dropped from 0.29-0.33 to 0.11-0.13 ms. An earlier tok/s version of this test read 0.6-2.5%; it is superseded because tok/s also moves with cycle count.

Outputs matched 8/8 between arms in three of the four first 27B cases. The 128K prose case did not match. In the control run the unmodified engine matched itself in only 1 of 8, the same as engine vs memoised, so exact text cannot decide correctness there.

### Not measured

DRAM and L2 counters, SM occupancy, 200K context, depth 15 in real decoding, end-to-end batch > 1, DFlash2 (only Flash-Next drafters are on disk), fp32 end to end, tensor parallel, Linux, ROCm, KDA and Mamba2. Prefill and TTFT were not measured because nothing changed.

## 6. Why fusion is awkward here [S]

1. **Staging overwrite.** The next verify pass writes `conv_out`, `beta` and `g` into the same staging rows before its scan runs. Pending inputs must survive that, so fusion needs a second staging set (about 8.6 MiB) and captured graphs bound to each, or patched pointers.
2. **Layout.** Staged rows follow the previous pass's `(bsz, seqlen)`; batch membership can change before the next pass.
3. **Graphs.** Counts can be dynamic through a small GPU buffer like `slots_in`. Unrecorded scalar kernel arguments are baked in. The no-replay variant should stay a separate specialisation.
4. **Materialisation points.** Page-boundary stashes, pipelined prefill snapshots, requeue, the disk tier and any pass that takes the chunk kernel need a real state.
5. **Rounding.** Rounding the register state fp32 -> fp16 -> fp32 between the phases should keep committed states identical to today's. Skipping it is not numerically equivalent. Not tested.
6. **Lost parallelism.** 48 layers replay concurrently today. Fused replay would run serially inside each layer.

**Convolution** is a separate dependency: the next pass's conv reads the corrected window before its scan. The immediate `batched_conv_rewind` (about 26 us GPU for 48 layers on the pre-update build, whose GDN code is the same) should stay under every design.

## 7. Candidate designs

Speed is the estimated GPU change per cycle for the code / prose mixes above, against today. Negative is faster.

| Design | VRAM | Speed (code / prose) | Complexity | Verdict |
|---|---|---|---|---|
| A. `v_split = 1` in `batched_scan_replay` | 0 | -36 / -59 us | one expression + test | **Do** |
| B. Rewind job tables built once or in C++ | 0 | host: about -0.2 to -0.27 ms [M] | small | **Do** |
| C. Fused replay, two rows | +8.6 MiB | -10 / -30 us; also removes the replay job building that B removes | large | Reject at batch 1 |
| D. One row, batched in-place settle, with A | -72 MiB | +86 / -23 us, before the saved verify state write (up to about 80 us) | moderate | Optional |
| E. Fused, one row (llama.cpp style) | about -63 MiB | +299 / +30 us | large | Reject |
| F. Adaptive C/D | mixed | - | highest | Reject: no trade-off worth a switch |

**A.** The launcher's comment justifies the split as keeping batch-1 passes occupied, but a replay launch carries one job per layer. Two layers still gained; one job was not tested, so keep 4 for `n == 1`. KDA takes the same branch and was not measured.

**B.** Job addresses depend only on the layer allocation, slot, rows, shape and prefix. Either cache them per cache allocation or pass base pointers once to C++ and compute the offsets there. C++ is the cleaner form because it also covers batches and tensor parallel. Failure mode: stale addresses after free/alloc.

**C.** Numerics as in section 6 item 5. Failure modes: replaying overwritten inputs, replaying twice, stale pending counts after slot reuse. Adds a second scan variant and new graph parameters to maintain.

**D.** Verify discards its final state and settle replays base -> base. Each thread reads its slice once and writes it once, so in place is safe [S], but the launcher currently asserts that the rows differ. Full accepts then cost a replay (189 us at 5 tokens with A). Recurrent draft models (`recurrent_spec_step`) continue on the scratch row and must keep two rows. Long speculative passes through the chunk kernel need a no-write mode. The checkpoint format is unchanged.

**Shared scratch** between layers does not work with batched replay, which touches all layers at once.

**Replay buffers.** Q is 20% of `spec_conv`: 1.69 MiB at depth 8. It is part of the scan's own input layout, so dropping it needs a copy or a split conv output. Not worth it. Served with 1 slot there is no excess row capacity beyond the configured depth. #618 (int8 state) is the larger memory lever on the same pool.

## 8. Answers to the 25 questions

1. No.
2. Replay, register residency, reduced-precision storage, and batched launch; see section 4.
3. A single row (as design D); fusion only for high batch.
4. 163.81 MiB (27B, 1 slot, depth 8), of which 144 MiB is state.
5. None in VRAM.
6. About 170-300 us per partial accept; 0.06-0.64% of generation on the 27B.
7. 144 MiB nominal per partial accept (fp16). Actual DRAM traffic was not captured.
8. In principle yes; the staging overwrite blocks it today.
9. Yes.
10. Yes; the body already works that way.
11. Unknown without a prototype. Existing kernels: 64 registers, no spills.
12. With two rows yes; with one row no.
13. Yes for targets and non-recurrent drafters (design D).
14. Not if settle is in place. A shared scratch would not work.
15. Yes: 1.69 MiB, as part of a shared layout.
16. Barely.
17. By an immediate batched conv rewind, independent of the scan state.
18. One round per pass today. A and B do not touch it. D keeps the same committed sequence [S]. Fusion must round in registers.
19. Yes with a GPU-resident count; the staging pointers are the real obstacle.
20. State is settled before a stash today. Deferral needs an explicit materialise step at each point in section 6.
21. Fusion 0.04-0.12% [E]; A 0.15-0.24% [E]; B 0.4-1.1% [M].
22. Fusion costs 3-4x less GPU time than today's replay at batch 4-8 [P]; end to end not measured. B should scale with slots, because `rewind` runs per sequence [H].
23. A and B should not. C and E could, through graph and register changes.
24. A and B yes; D after discussion; C no.
25. A + B.

## 9. Recommended work

1. `exllamav3_ext/gdn.cu`, `batched_scan_replay` (line 2375): choose `v_split` from the job count (1 unless `n == 1`). Extend `tests/kernels/recurrent/test_gated_delta_rule.py::test_scan_replay_matches_kernel_prefix` with fp16 and the 48-head geometry, and time KDA.
2. `modules/gated_delta_net.py` (`_rewind_layers`, `rewind_conv_job`, `replay_job`) and `bindings.cpp`: per-allocation base pointers, offsets computed in C++. Regression test: free and reallocate a cache, then rewind.
3. Re-measure. Then raise D with the maintainer alongside #618.

## 10. Reproduction

Interpreter: `C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -I`. Set `XDG_CACHE_HOME` to a scratch copy of `~/.cache/exllamav3`, because the engine persists sparse-head token counts and expert profiles. The first 27B end-to-end runs here did **not** do that and added benchmark tokens to `token_stats/e431518ee9ad94cd.pt`.

```text
micro2.py                                                     replay vs fused bound
micro3.py                                                     v_split A/B
ablate.py <27B dir>                                           forced acceptance
e2e.py <27B dir> 40960 4 600                                  replay share of real decoding
e2e4.py <27B dir> 140032 4 100,128000 8 -cq 8 -chunk_size 1024
e2e4.py <Flash-Next dir> 40960 3 100,16000 8 -hdt 5 -mcs 399 -mcpa -chunk_size 2048
```

`micro.py` supplies shared setup to `micro2.py`, which supplies it to `micro3.py`. Paths are as run. The filler text is the PR #31669 diff. The first 27B memoisation rows came from `e2e4.py`'s predecessor, which lacked only the A/A control and the `__main__` guard.


<details><summary>micro.py</summary>

```python
"""Unmodified-kernel timing: batched replay vs per-layer scan; scan(s+p)-scan(s) is an upper bound on fused replay cost."""
import torch, statistics as st, time
from exllamav3.ext import exllamav3_ext as ext
torch.inference_mode().__enter__()
dev = torch.device("cuda:0")
NK, NV, D, F = 16, 48, 128, 2*16*128 + 48*128
def setup(L, rows, dtype, T):
    out = []
    for _ in range(L):
        out.append(((torch.randn((rows*T, F), device=dev)*.25).bfloat16(),
            torch.randn((rows*T, NV), device=dev)*.5-1, torch.sigmoid(torch.randn((rows*T, NV), device=dev)).bfloat16(),
            (torch.randn((2*rows, 1, NV, D, D), device=dev)*.05).to(dtype)))
    return out
def timed(fn, n=60, warm=15):
    g, c = [], []
    for i in range(n+warm):
        a, b = torch.cuda.Event(True), torch.cuda.Event(True)
        torch.cuda.synchronize(); a.record(); t = time.perf_counter(); fn(); t = time.perf_counter()-t; b.record(); b.synchronize()
        if i >= warm: g.append(a.elapsed_time(b)*1e3); c.append(t*1e6)
    g.sort()
    return st.median(g), g[len(g)//10], g[9*len(g)//10], st.median(c)
def rep(Ls, p, half, rows=1):
    jobs = []
    for q, g, b, s in Ls:
        rb = s.stride(0)*s.element_size(); T = q.shape[0]//rows
        for r in range(rows):
            jobs.append(ext.ScanReplayJob(q[r*T].data_ptr(), g[r*T].data_ptr(), b[r*T].data_ptr(), s.data_ptr()+2*r*rb, s.data_ptr()+(2*r+1)*rb, 0, p))
    # one launch group per sequence, as GDNState.rewind does
    L = len(Ls)
    groups = [[jobs[l*rows+r] for l in range(L)] for r in range(rows)]
    return lambda: [ext.batched_scan_replay(g, 0, 0, NK, NV, D, D, half) for g in groups]
def scan(Ls, s, hist, rows=1):
    so = torch.tensor([2*r+(1 if hist else 0) for r in range(rows)], dtype=torch.int32, device=dev)
    si = torch.tensor([2*r for r in range(rows)], dtype=torch.int32, device=dev)
    out = torch.empty((rows, s, NV, D), dtype=torch.bfloat16, device=dev)
    def f():
        for q, g, b, S in Ls:
            ext.cuda_recurrent_gated_delta_rule(q[:rows*s].view(rows, s, F), g[:rows*s].view(rows, s, NV), b[:rows*s].view(rows, s, NV), S, out, NK, NV, D, D, so, hist, si if hist else None)
    return f
for L in (48, 36):
  for dt in (torch.half, torch.float):
    Ls = setup(L, 1, dt, 24); h = dt == torch.half
    print(f"\n== L={L} {dt} bsz=1  (us: median p10 p90 | cpu median)")
    for p in (1, 2, 3, 4, 5, 7, 8, 15): print("  replay p=%2d  %7.1f %7.1f %7.1f | %6.1f" % ((p,)+timed(rep(Ls, p, h))))
    S = {}
    for s in list(range(1, 17))+[20, 23]:
        S[s] = timed(scan(Ls, s, True)); print("  scan_spec s=%2d %7.1f %7.1f %7.1f | %6.1f" % ((s,)+S[s]))
    print("  inplace s=1 %7.1f" % timed(scan(Ls, 1, False))[0])
    for s in (2, 4, 5, 9):
        print("  marginal per extra token from s=%d: " % s + " ".join(f"+{p}:{S[s+p][0]-S[s][0]:.0f}" for p in (1, 2, 3, 4, 5, 7) if s+p in S))
    cs = [torch.zeros((1, F, 12), dtype=torch.bfloat16, device=dev) for _ in range(L)]
    cj = [ext.ConvRewindJob(c.data_ptr()+(12-2-4)*2, c.data_ptr(), F, 4, 12) for c in cs]
    print("  conv rewind %7.1f %7.1f %7.1f | %6.1f" % timed(lambda: ext.batched_conv_rewind(cj, 0)))
    del Ls, cs; torch.cuda.empty_cache()
print("\n== batched, fp16, L=48")
for rows in (2, 4, 8):
    Ls = setup(48, rows, torch.half, 16)
    for p in (1, 3, 5): print(f"  rows={rows} replay p={p} (one launch per seq) %7.1f %7.1f %7.1f | %6.1f" % timed(rep(Ls, p, True, rows), 30, 8))
    r = {s: timed(scan(Ls, s, True, rows), 30, 8)[0] for s in (5, 6, 8, 10)}
    print(f"  rows={rows} scan_spec", {k: round(v) for k, v in r.items()}, "marginal +1/+3/+5:", round(r[6]-r[5]), round(r[8]-r[5]), round(r[10]-r[5]))
    del Ls; torch.cuda.empty_cache()
```
</details>

<details><summary>micro2.py</summary>

```python
"""Same kernels, launches queued behind a GPU-side delay so host launch rate is excluded: pure back-to-back GPU time."""
import torch, sys; sys.path.insert(0, r"C:\tmp\gdn-replay\bench")
import statistics as st
src = open(r"C:\tmp\gdn-replay\bench\micro.py").read().split("for L in (48, 36):")[0]
exec(src)
big = torch.randn((6000, 6000), device=dev)
def q(fn, n=25, warm=5):
    g = []
    for i in range(n+warm):
        a, b = torch.cuda.Event(True), torch.cuda.Event(True)
        torch.cuda.synchronize(); torch.mm(big, big); torch.mm(big, big); a.record(); fn(); queued = not a.query(); b.record(); b.synchronize()
        if i >= warm:
            assert queued, "launches were not fully queued behind the delay"
            g.append(a.elapsed_time(b)*1e3)
    g.sort(); return st.median(g), g[2], g[-3]
for L in (48, 36):
  for dt in (torch.half, torch.float):
    Ls = setup(L, 1, dt, 24); h = dt == torch.half
    R = {p: q(rep(Ls, p, h)) for p in (1,2,3,4,5,7,8,15)}
    S = {s: q(scan(Ls, s, True)) for s in list(range(1, 17))+[20, 23]}
    print(f"\n== L={L} {dt} bsz=1 queued GPU us, median [p10 p90]")
    print("  replay ", "  ".join("p%d:%.0f[%.0f %.0f]" % ((p,)+v) for p, v in R.items()))
    print("  scan   ", "  ".join("s%d:%.0f[%.0f %.0f]" % ((s,)+v) for s, v in S.items()))
    for s in (4, 5, 8, 9):
        print(f"  verify width {s}: " + "  ".join(f"p{p}: replay {R[p][0]:.0f} vs fused<= {S[s+p][0]-S[s][0]:.0f}" for p in (1,2,3,4,5,7,8) if p <= s and s+p in S))
    del Ls; torch.cuda.empty_cache()
for rows in (2, 4, 8):
    Ls = setup(48, rows, torch.half, 20)
    R = {p: q(rep(Ls, p, True, rows), 15, 3) for p in (1,3,4,5)}
    S = {s: q(scan(Ls, s, True, rows), 15, 3) for s in (5,6,8,9,10)}
    print(f"\n== rows={rows} fp16 L=48: replay (one launch/seq)", {p: round(v[0]) for p, v in R.items()}, "scan", {s: round(v[0]) for s, v in S.items()})
    print("   width 5:", {p: (round(R[p][0]), round(S[5+p][0]-S[5][0])) for p in (1,3,4,5)})
    # every sequence's jobs in shared launches
    def merged(p):
        fns = []
        jobs = []
        for qv, g, b, s in Ls:
            rb = s.stride(0)*s.element_size(); T = qv.shape[0]//rows
            jobs += [ext.ScanReplayJob(qv[r*T].data_ptr(), g[r*T].data_ptr(), b[r*T].data_ptr(), s.data_ptr()+2*r*rb, s.data_ptr()+(2*r+1)*rb, 0, p) for r in range(rows)]
        return lambda: ext.batched_scan_replay(jobs, 0, 0, NK, NV, D, D, True)
    print("   all-sequence jobs in one call:", {p: round(q(merged(p), 15, 3)[0]) for p in (1,3,5)})
    del Ls; torch.cuda.empty_cache()
```
</details>

<details><summary>micro3.py</summary>

```python
"""Proxy for a v_split=1 batched replay: one SCAN_SPEC call over L rows (v_split=1 whenever bsz>1) is the same work as an
L-job replay with v_split=1, plus the attention output write. State result is compared bit for bit with batched_scan_replay."""
src = open("C:/tmp/gdn-replay/bench/micro2.py").read().split(chr(10) + "for L in (48, 36):")[0]
exec(src)
import random
def build(L, dtype, T):
    qv = (torch.randn((L, T, F), device=dev)*.25).bfloat16(); g = torch.randn((L, T, NV), device=dev)*.5-1
    b = torch.sigmoid(torch.randn((L, T, NV), device=dev)).bfloat16()
    S = (torch.randn((2*L, 1, NV, D, D), device=dev)*.05).to(dtype); return qv, g, b, S
for L in (48, 36, 12):
  for dt in (torch.half, torch.float):
    qv, g, b, S = build(L, dt, 16); half = dt == torch.half
    rb = S.stride(0)*S.element_size()
    so = torch.arange(L, dtype=torch.int32, device=dev)*2+1; si = so-1
    print(f"\n== L={L} {dt}")
    for p in (1, 2, 3, 4, 5, 8, 15):
        Q, G, B = qv[:, :p].contiguous(), g[:, :p].contiguous(), b[:, :p].contiguous()
        out = torch.empty((L, p, NV, D), dtype=torch.bfloat16, device=dev)
        jobs = [ext.ScanReplayJob(qv[l].data_ptr(), g[l].data_ptr(), b[l].data_ptr(), S.data_ptr()+2*l*rb, S.data_ptr()+(2*l+1)*rb, 0, p) for l in range(L)]
        cur = lambda: ext.batched_scan_replay(jobs, 0, 0, NK, NV, D, D, half)
        alt = lambda: ext.cuda_recurrent_gated_delta_rule(Q, G, B, S, out, NK, NV, D, D, so, True, si)
        cur(); ref = S[1::2].clone(); S[1::2].zero_(); alt(); same = torch.equal(ref, S[1::2])
        # interleaved A/B in random order, 3 rounds
        A, Bv = [], []
        for _ in range(3):
            for k in random.sample((0, 1), 2): (A if k == 0 else Bv).append(q(cur if k == 0 else alt, 20, 4)[0])
        # per-layer (v_split=4, eager launches queued) reference: cost of this many tokens in separate scans
        print("  p=%2d  replay now (v_split=4) %6.0f [%s]   v_split=1 proxy %6.0f [%s]   x%.2f  state bit-equal=%s" % (
            p, st.median(A), " ".join("%.0f" % x for x in A), st.median(Bv), " ".join("%.0f" % x for x in Bv), st.median(A)/st.median(Bv), same))
    del qv, g, b, S; torch.cuda.empty_cache()
```
</details>

<details><summary>ablate.py</summary>

```python
"""Forced-acceptance verify cycle on the real 27B. Dense model: timing does not depend on state contents.
Variants, randomly interleaved per cycle: A as-is; B replay launch no-op (host job building kept); C no replay work at all
(conv rewind kept); D no rewind work at all (parity flip only); F replay launched from memoised jobs (host building removed)."""
import sys, time, random, argparse, statistics as st, torch
from exllamav3 import model_init
from exllamav3.ext import exllamav3_ext as ext
from exllamav3.modules import gated_delta_net as G
p = argparse.ArgumentParser(); model_init.add_args(p, cache=True, add_draft_model_args=True)
a = p.parse_args(["-m", sys.argv[1], "-cs", "8192", "-cq", "8", "-hdt", "15", "-ambs", "1", "-chunk_size", "1024", "-nw"])
model, config, cache, tok, *_ = model_init.init(a, quiet=True, progress=False)
real_layers = G._rewind_layers
MODE = ["A"]; memo = {}
class Proxy:
    def __getattr__(self, k): return getattr(ext, k)
    def batched_scan_replay(self, *x):
        if MODE[0] == "B": return
        ext.batched_scan_replay(*x)
G.ext = Proxy()
def layers(ls, slot, lh, n, sr, ss, br, sc):
    m = MODE[0]
    if m == "D": return
    if m in ("C", "F"):
        cj = [l.rewind_conv_job(slot, lh, n) for l in ls]; ext.batched_conv_rewind(cj, 0)
        if m == "F" and n:
            k = (lh, n, sr, ss, br, sc)
            if k not in memo: memo[k] = [l.replay_job(sr, lh+1-n, ss, br, sc) for l in ls]
            g = next(iter(ls)).scan_geometry(); ext.batched_scan_replay(memo[k], 0, *g)
        return
    real_layers(ls, slot, lh, n, sr, ss, br, sc)
G._rewind_layers = layers
with torch.inference_mode():
    ids = tok.encode("The committee reviewed the proposal in detail and concluded that " * 60)[:, :600]
    s = cache.get_new_state()
    def fwd(x, pos, hist): return model.forward(x, {"attn_mode": "flash_attn", "cache": cache, "batch_shape": (1, 4096), "past_len": pos, "recurrent_states": [s], "recurrent_history": hist, "pinned_staging": True})
    fwd(ids, 0, False); n0 = ids.shape[1]
    toks = {w: torch.randint(100, 2000, (1, w)) for w in (5, 9, 16)}
    for w, rejs in ((5, (4, 3, 2, 1, 0)), (9, (8, 6, 4, 0)), (16, (15, 8, 0))):
        for rj in rejs:
            res = {m: [] for m in "ABCDF"}; cpu = {m: [] for m in "ABCDF"}
            order = [m for m in "ABCDF" for _ in range(90)]; random.Random(1).shuffle(order); order = ["A"]*40 + order
            for i, m in enumerate(order):
                MODE[0] = m
                # one full cycle: verify -> read back -> rewind; the next iteration's forward absorbs the rewind's GPU work
                t0 = time.perf_counter()
                lg = fwd(toks[w], n0, True); lg.argmax(-1).cpu()
                tc = time.perf_counter(); s.rewind(rj); cpu_us = (time.perf_counter()-tc)*1e6
                torch.cuda.synchronize(); t1 = time.perf_counter()
                s.position = n0
                if i >= 40: res[m].append((t1-t0)*1e3); cpu[m].append(cpu_us)
            med = {m: st.median(v) for m, v in res.items()}
            # second arm: back to back so host and GPU rewind work overlap the way the generator runs it
            blk = {m: [] for m in "ABCDF"}
            seq = [m for m in "ABCDF" for _ in range(8)]; random.Random(2).shuffle(seq)
            for m in seq:
                MODE[0] = m
                for k in range(3): fwd(toks[w], n0, True).argmax(-1).cpu(); s.rewind(rj); s.position = n0
                t0 = time.perf_counter()
                for k in range(15): fwd(toks[w], n0, True).argmax(-1).cpu(); s.rewind(rj); s.position = n0
                torch.cuda.synchronize(); blk[m].append((time.perf_counter()-t0)*1e3/15)
            b = {m: st.median(v) for m, v in blk.items()}; sd = {m: st.pstdev(v) for m, v in blk.items()}
            print(f"width {w} kept {w-rj}: isolated cycle ms " + " ".join(f"{m}:{med[m]:.3f}" for m in res) + " | rewind host us " + " ".join(f"{m}:{st.median(cpu[m]):.0f}" for m in res))
            print(f"    back-to-back ms/cycle " + " ".join(f"{m}:{b[m]:.3f}(sd {sd[m]:.3f})" for m in blk) + f" | A-B {1e3*(b['A']-b['B']):.0f}us A-C {1e3*(b['A']-b['C']):.0f}us A-D {1e3*(b['A']-b['D']):.0f}us A-F {1e3*(b['A']-b['F']):.0f}us  ({100*(b['A']-b['C'])/b['A']:.2f}% ceiling if replay were free)")
            sys.stdout.flush()
```
</details>

<details><summary>e2e.py</summary>

```python
"""Unmodified engine, Qwen3.8-27B + MTP as served (Q8 KV, 1 slot). Instruments GDNState.rewind from outside."""
import sys, time, json, argparse, statistics as st, torch
from collections import Counter
from exllamav3 import model_init, Generator, Job, ArgmaxSampler
from exllamav3.ext import exllamav3_ext as ext
from exllamav3.modules import gated_delta_net as G
ap = argparse.ArgumentParser(); model_init.add_args(ap, add_sampling_args=False, cache=True, add_draft_model_args=True) if False else None
MODEL, CS, HIST, NDT = sys.argv[1], int(sys.argv[2]), 8, int(sys.argv[3])
CTXS = [int(x) for x in sys.argv[4].split(",")]
p = argparse.ArgumentParser()
import inspect; sig = inspect.signature(model_init.add_args).parameters
kw = {k: True for k in sig if k in ("cache", "add_draft_model_args", "draft")}
model_init.add_args(p, **kw)
a = p.parse_args(["-m", MODEL, "-cs", str(CS), "-cq", "8", "-mtp", "-ndt", str(NDT), "-hdt", "8", "-ambs", "1", "-chunk_size", "1024"])
model, config, cache, tok, dm, dc, dcache = model_init.init(a, quiet=True, progress=False)
torch.cuda.synchronize()
free, tot = torch.cuda.mem_get_info()
print("VRAM used GiB", round((tot-free)/2**30, 2), "torch alloc", round(torch.cuda.memory_allocated()/2**30, 2))
rl = list(cache.get_all_recurrent_layers().values())
mib = lambda f: round(sum(f(l) for l in rl)/2**20, 2)
sz = lambda t: t.numel()*t.element_size()
print("layers", len(rl), "state dtype", rl[0].recurrent_state.dtype, "state pool MiB", mib(lambda l: sz(l.recurrent_state)), "conv", mib(lambda l: sz(l.conv_state)),
      "spec_conv", mib(lambda l: sz(l.spec_conv)), "spec_beta", mib(lambda l: sz(l.spec_beta)), "spec_g", mib(lambda l: sz(l.spec_g)), "total", mib(lambda l: l.storage_size()), "checkpoint/seq", mib(lambda l: l.get_checkpoint_size()))
draft_rl = list(dcache.get_all_recurrent_layers().values()); print("draft recurrent layers", len(draft_rl))
log = []
orig_replay, orig_conv, orig_rewind = ext.batched_scan_replay, ext.batched_conv_rewind, G.GDNState.rewind
pend = []
class Proxy:
    def __getattr__(self, k): return getattr(ext, k)
    def batched_scan_replay(self, *x):
        e0, e1 = torch.cuda.Event(True), torch.cuda.Event(True)
        e0.record(); orig_replay(*x); e1.record(); pend.append((e0, e1, x[0] and len(x[0])))
TIMED = [True]
G.ext = Proxy()
def rewind(self, n):
    lh = self.last_history; k = len(pend); t = time.perf_counter(); orig_rewind(self, n); t = time.perf_counter()-t
    log.append((lh, n, t*1e6, pend[k] if len(pend) > k else None))
G.GDNState.rewind = rewind
orig_fwd = model.forward
fwd = []
def forward(input_ids, params=None, **k):
    w = input_ids.shape[-1]; t = time.perf_counter(); r = orig_fwd(input_ids=input_ids, params=params, **k) if params is not None else orig_fwd(input_ids, **k)
    fwd.append((w, time.perf_counter()-t)); return r
model.forward = forward
text = open(r"C:\tmp\gdn-replay\pr31669.diff", encoding="utf8").read()
base = tok.encode(text)
PROMPTS = {"code": "Write a complete, well-commented Python implementation of a red-black tree with insert, delete and an in-order iterator, then tests.",
           "prose": "Write a long, vivid short story about a lighthouse keeper who discovers a message in a bottle. Do not use lists.",
           "copy": None}
gen = Generator(model=model, cache=cache, tokenizer=tok, max_batch_size=1, max_chunk_size=1024, draft_model=dm, draft_cache=dcache, num_draft_tokens=NDT,
                dynamic_draft_tokens=True, hybrid_draft_tokens=8, sparse_draft_head=8192, recurrent_cache_size=0)
N = 400
with torch.inference_mode():
  for ctx in CTXS:
    for name, pr in PROMPTS.items():
        pre = tok.decode(base[:, :max(0, ctx-900)])[0] if ctx > 900 else ""
        q = pr or "Repeat the following code exactly, then explain it:\n```\n" + text[4000:7000] + "\n```"
        s = "<|im_start|>user\n" + pre + "\n\n" + q + "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        for run in range(3):
            log.clear(); pend.clear(); fwd.clear()
            job = Job(input_ids=tok.encode(s, encode_special_tokens=True), max_new_tokens=N, sampler=ArgmaxSampler())
            gen.enqueue(job); last = None
            while gen.num_remaining_jobs():
                for r in gen.iterate():
                    if r.get("eos"): last = r
            torch.cuda.synchronize()
            rs = [(lh, n, c, e) for lh, n, c, e in log if lh > 0]
            rep = [(lh+1-n, e[0].elapsed_time(e[1])*1e3, c) for lh, n, c, e in rs if e]
            full = [x for x in rs if x[1] == 0]
            T = last["time_generate"]; nt = last["new_tokens"]; cyc = len([f for f in fwd if f[0] <= 9])
            gpu = sum(x[1] for x in rep)
            if run == 0: continue
            print(json.dumps({"ctx": last["prompt_tokens"], "prompt": name, "run": run, "tok": nt, "tps": round(nt/T, 2), "cycles": cyc, "ms_per_cycle": round(1e3*T/cyc, 2), "acc": last.get("accepted_draft_tokens"), "rej": last.get("rejected_draft_tokens"),
                "spec_cycles": len(rs), "partial": len(rep), "full": len(full), "prefix_hist": dict(sorted(Counter(x[0] for x in rep).items())),
                "width_hist": dict(sorted(Counter(x[0]+1 for x in rs).items())), "replay_us_med_by_prefix": {k: round(st.median([x[1] for x in rep if x[0] == k])) for k in sorted({x[0] for x in rep})},
                "replay_gpu_ms_total": round(gpu/1e3, 2), "replay_pct_of_gen": round(100*gpu/1e6/T, 3), "rewind_cpu_us_med": round(st.median([x[2] for x in rep])) if rep else None, "rewind_cpu_full_us_med": round(st.median([x[2] for x in full])) if full else None}))
            sys.stdout.flush()
```
</details>

<details><summary>e2e4.py</summary>

```python
"""Real decoding, paired A/B in one load. A = engine as is. H = identical GPU work, but rewind's conv/replay job lists are memoised
(host-side only; greedy output must match A token for token). P = H with the replay launch dropped is not run: it would corrupt state."""
import sys, time, json, argparse, random, statistics as st, torch
from exllamav3 import model_init, Generator, Job, ArgmaxSampler
from exllamav3.ext import exllamav3_ext as ext
from exllamav3.modules import gated_delta_net as G
def main():
  MODEL, CS, NDT, CTXS, REPS, EXTRA = sys.argv[1], sys.argv[2], int(sys.argv[3]), [int(x) for x in sys.argv[4].split(",")], int(sys.argv[5]), sys.argv[6:]
  p = argparse.ArgumentParser(); model_init.add_args(p, cache=True, add_draft_model_args=True)
  a = p.parse_args(["-m", MODEL, "-cs", CS, "-mtp", "-ndt", str(NDT), "-hdt", "8", "-ambs", "1"] + EXTRA)
  model, config, cache, tok, dm, dc, dcache = model_init.init(a, quiet=True, progress=False)
  free, tot = torch.cuda.mem_get_info(); print("VRAM used GiB %.2f torch %.2f" % ((tot-free)/2**30, torch.cuda.memory_allocated()/2**30))
  rl = list(cache.get_all_recurrent_layers().values()); print("recurrent", len(rl), [type(x).__name__ for x in rl[:1]], "pool MiB", sum(l.recurrent_state.numel()*l.recurrent_state.element_size() for l in rl if hasattr(l, "recurrent_state"))/2**20)
  real = G._rewind_layers; MODE = ["A"]; mc, mr = {}, {}; acc = []
  def layers(ls, slot, lh, n, sr, ss, br, sc):
      t = time.perf_counter()
      if MODE[0] != "H": real(ls, slot, lh, n, sr, ss, br, sc)
      else:
          gl = [l for l in ls if isinstance(l, G.GDNLayerState)]
          for l in ls:
              if not isinstance(l, G.GDNLayerState): l.rewind(slot, lh, n)
          k = (slot, n)
          if k not in mc: mc[k] = [l.rewind_conv_job(slot, lh, n) for l in gl]
          ext.batched_conv_rewind(mc[k], 0)
          if n:
              k = (lh, n, sr, ss, br, sc)
              if k not in mr: mr[k] = [l.replay_job(sr, lh+1-n, ss, br, sc) for l in gl]
              ext.batched_scan_replay(mr[k], 0, *gl[0].scan_geometry())
      acc.append(time.perf_counter()-t)
  G._rewind_layers = layers
  text = open("C:/tmp/gdn-replay/pr31669.diff", encoding="utf8").read()
  base = tok.encode(text * 3)
  gen = Generator(model=model, cache=cache, tokenizer=tok, max_batch_size=1, max_chunk_size=a.chunk_size, draft_model=dm, draft_cache=dcache, num_draft_tokens=NDT,
                  dynamic_draft_tokens=True, hybrid_draft_tokens=a.hybrid_draft_tokens, sparse_draft_head=8192, recurrent_cache_size=2*1024**3)
  Q = {"code": "Write a complete, well-commented Python implementation of a red-black tree with insert, delete and an in-order iterator, then tests.",
       "prose": "Write a long, vivid short story about a lighthouse keeper who discovers a message in a bottle. Do not use lists."}
  import os; a_names = os.environ.get("NAMES", "code,prose").split(",")
  N = 384
  def run(ids, mode):
      MODE[0] = mode; acc.clear()
      job = Job(input_ids=ids, max_new_tokens=N, sampler=ArgmaxSampler()); gen.enqueue(job); last = None; out = []
      while gen.num_remaining_jobs():
          for r in gen.iterate():
              if r.get("token_ids") is not None: out += r["token_ids"].view(-1).tolist()
              if r.get("eos"): last = r
      return 1e3*last["time_generate"]/max(1, len(acc)), out, last, 1e6*sum(acc)/max(1, len(acc)), len(acc)
  with torch.inference_mode():
    for ctx in CTXS:
      for name, q in Q.items():
          if name not in a_names: continue
          pre = tok.decode(base[:, :max(0, ctx-100)])[0] + "\n\n" if ctx > 200 else ""
          ids = tok.encode("<|im_start|>user\n" + pre + q + "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n", encode_special_tokens=True)
          run(ids, "A"); run(ids, "H")
          T = {"A": [], "H": [], "A2": []}; O = {}; C = {}; ok = 0; tot = 0
          for i in range(REPS):
              for m in random.sample(["A", "H", "A2"], 3):
                  tps, out, last, us, cyc = run(ids, m); T[m].append(tps); C[m] = (us, cyc, last.get("accepted_draft_tokens"), last.get("rejected_draft_tokens"))
                  O.setdefault(m, []).append(out)
          same = sum(x == y for x, y in zip(O["A"], O["H"])); selfsame = sum(x == O["A"][0] for x in O["A"])
          d = [100*(a_/h-1) for a_, h in zip(T["A"], T["H"])]
          print(json.dumps({"ctx": last["prompt_tokens"], "prompt": name, "A_ms_cycle": round(st.median(T["A"]), 2), "A_sd": round(st.pstdev(T["A"]), 2), "H_ms_cycle": round(st.median(T["H"]), 2), "H_sd": round(st.pstdev(T["H"]), 2),
              "median_pair_gain_pct": round(st.median(d), 2), "pair_gains": [round(x, 2) for x in d], "A2_ms_cycle": round(st.median(T["A2"]), 2), "AA_ctrl_gains": [round(100*(x/y-1), 2) for x, y in zip(T["A"], T["A2"])], "distinct_outputs_A_A2_H": [len({tuple(o) for o in O[m]}) for m in ("A", "A2", "H")], "A_eq_A2": sum(x == y for x, y in zip(O["A"], O["A2"])), "outputs_equal_A_H": f"{same}/{REPS}", "A_self_equal": f"{selfsame}/{REPS}", "rewind_us_A": round(C["A"][0]), "rewind_us_H": round(C["H"][0]), "cycles": C["A"][1], "acc_rej": C["A"][2:]})); sys.stdout.flush()
if __name__ == '__main__': main()
```
</details>
