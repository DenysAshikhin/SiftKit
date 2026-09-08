# Grouped MLP prefill: results and remaining Linux block

The Windows target is met: **1,970.31 tok/s median**, against **1,207.77 tok/s**
for the paired ring control, a **63.1% improvement**. All five candidate observations
exceeded 1,750 tok/s. A separate CLI run with default staging sizes and automatic
threshold selection achieved **1,931.05 tok/s**.

The gain comes from actual expert reuse. Attention stays in 4096-token chunks;
several chunks pass through one layer before advancing, and their normalized MLP
inputs share a single expert computation. Normalization and residual updates remain
chunked. Group admission uses live VRAM and tensor dimensions observed during an
ordinary chunk. No expert profile, model/device name, tuned affinity, or pinned
resident weight cache is used by the candidate. The anonymous expert arena remains
the ordinary source of streamed weights.

## Measured Windows acceptance

Same upstream base `c6c45b13f2bb070a2c86fae59f3d7bfe4db9ae94` plus the inherited
native ring/pool prototype and this session's changes. Same model, CPU-offload count,
workload token slices, 32k length accounting and 4096 attention chunk. One load,
five interleaved control/candidate pairs through the integrated `eval/perf.py`
measurement implementation. No simultaneous tests or other agent benchmarks.

| Configuration | Five 32k observations, tok/s | Median |
|---|---|---:|
| Ring control | 1200.03, 1209.20, 1180.63, 1213.51, 1207.77 | 1207.77 |
| Automatic grouping | 1974.99, 1921.96, 1945.17, 1975.43, 1970.31 | 1970.31 |

Candidate peak allocated VRAM was about **22.56 GB**, compared with **21.55 GB**
for the later controls. The weight-staging ring is **18.75 MiB** on the detected
32 MiB L3 domain, plus the existing job/control buffers. The paired run retained
the reference's 64 MiB VRAM slots and explicit threshold 8.

The standalone check used the staging defaults (32 MiB VRAM slots), default worker
count, and no threshold override. The probe measured **26.0 GB/s** and chose **8**.
It achieved 1931.05 tok/s even with diagnostic logging enabled. Decode completed
at all nine tested contexts: mostly 20.7-22.4 tok/s, with 17.23 at context 2048.
These decode numbers are functional/performance observations, not a fresh
pre-change decode-regression comparison.

```text
EXL3_LOAD_ARENA=1 EXL3_MOE_MEMOPS=1 PYTORCH_ALLOC_CONF=backend:native
python eval/perf.py -m <model> -mcs 410 -cs 32768 -chunk_size 4096
                   -ngr -max_length 32768 --grouped_prefill
```

`-mcs 410` is the unchanged benchmark offload configuration; the implementation
does not contain that expert count. The new public API is
`Model.prefill_chunked(input_ids, params, chunk_size)`. Callers must supply the
tokens to be grouped; it cannot look beyond a previously submitted chunk.

## Correctness and scope

Three controls and three four-chunk candidates were compared at 16k prefill with
24 fixed continuation tokens. Control/control mean absolute logit differences were
0.2158-0.2246; control/candidate differences were 0.1961-0.2439. Both comparisons
agreed on 23-24 of 24 top token predictions. Candidate/candidate variation was
similar. Greedy continuations can diverge at close decisions; an earlier candidate
did diverge after token 10, prompting the fixed-continuation comparison. This is
evidence of comparable numerical variation, not bitwise parity.

Final Windows tests: **68 passed, 8 subtests passed**. Linux: **43 passed**, including
the native CPU pool, plus the new shutdown regression separately. Existing
`torch.jit` deprecation warnings remain. `npm run typecheck` and `npm run lint`
passed in the enclosing workspace. The additional upstream `test_dsv4_state.py`
could not collect because `compare_deepseek_v4_hf_` is absent; it was not weakened.
Independent review found no remaining concrete issue in the reviewed fixes.

The grouped API currently supports one local rectangular causal text prompt.
Recurrent state types explicitly opt into layer-major execution. TP, paged batches,
multimodal input, recurrent history, state export, and the existing paged generator
are outside this prototype. Other models and CPUs have not received full-model
validation. A previous allocator peak can conservatively reduce admitted group size.

## Requested steps

1. Previous-chunk prefetch was implemented, byte-verified and measured. It failed
   the speed target even when timeline measurements confirmed overlap. Independent
   CPU-tail scheduling also failed. Both were archived and removed from the retained
   candidate. Grouped MLP execution is the successful alternative.
2. The pinned ring now derives its actual allocation from detected L3 and expert
   geometry, rather than reserving the former larger unused staging allocation.
3. The bandwidth probe completes its warmup window and retries for stable peak
   readings. Slow stable links are accepted; no machine bandwidth is assumed.
4. WSL built and passed the tests above. **Full-model Linux throughput remains
   blocked during loading**, for both the ring and the 10 GB resident mechanism
   control. No Linux tok/s result is claimed.
5. The final patch and experiment archive are accompanied by a verified artifact
   manifest and a reference-branch snapshot. The working implementation remains
   uncommitted. See the artifact record for hashes and counts.

## Linux capacity evidence

All failed loads stopped near layer 44, before ring startup or grouped prefill.
One sampled failure had Windows commit **144.13 / 144.63 GB**, with **4.93 GB VRAM
still free**. Later runs observed delayed pagefile expansion, but the allocation
still failed before enough stable headroom became available. The commit limit
contracted again after cleanup. Ring attempts and the 10 GB resident attempt are
all retained, including exception-side CUDA allocation statistics.

The configured pagefile is `D:\pagefile.sys`, initial **16 MB**, maximum **64,000 MB**.
No pagefile, host memory, driver or THP settings were changed. Approval was requested
to raise the initial size to 32,768 MB while retaining the maximum; that request
remains pending. Microsoft documents allocation failures from delayed pagefile
growth, consistent with this observation, though successful validation after adding
headroom is still needed to confirm the diagnosis.
[Microsoft guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/slow-page-file-growth-memory-allocation-errors).

The separate Linux checkout is `/opt/exllamav3-online-20260907`; the two earlier
checkouts and distro disk are preserved. Linux extension SHA256:
`324202855778cfca89d6e02425d705ae4f57005626ffcf30cdecc8509fb6bcfd`.
The existing Windows extension was not rebuilt in this session; SHA256:
`434034d7eb41dcdfbc5c195bc61110fda7d9e7477a0d3dfb29dcb5dbf076a442`.

## Reproducible artifacts

- [Complete upstream patch](2026-09-07-grouped-prefill-c6c45b1.patch)
- [Artifact manifest](2026-09-07-grouped-prefill-artifacts.json)
- [Full experiment archive](staging-after-grouped-prefill-20260907.zip)
- [Detailed chronological worklog](2026-09-07-online-prefetch-worklog.md)
- [API and limitations](../../pristine_exle/exllamav3-upstream/docs/grouped-prefill.md)

Reference snapshot: `staging-ring-artifacts` at
`bca2342a71470ccea2a42f7d169f9c27f6f7a965`. The branch's archive and patch hashes
match the verified artifacts. The main branch and its staging entries were preserved.
Scratch runners are retained for the capacity-blocked Linux continuation.

After commit headroom is resolved, repeat the Linux ring and resident measurements,
add the automatic candidate and numerical/decode checks, then update this record.
