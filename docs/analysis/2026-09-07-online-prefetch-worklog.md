# Generic MoE streaming: active worklog and compaction checkpoint

## Current result and resume point (01:39 local)

**Windows target achieved:** automatic grouped MLP prefill median **1970.31 tok/s**
versus paired ring median **1207.77**, five interleaved observations each. Standalone
CLI with default staging sizes and automatic threshold: **1931.05 tok/s**, decode
completed. No resident weight cache or model/device profile. Failed speculative
prefetch and async-tail paths were archived and removed from the candidate.

Fresh Windows validation: **68 tests + 8 subtests passed**; WSL **43 tests passed**
plus the shutdown regression separately. Npm typecheck/lint passed. The complete
patch applies to pristine c6c45b1 and reproduces all **19** changed/new source files.
The final archive independently verifies **641 scratch files**, candidate source,
and the patch (**661 data entries**). Artifact-only reference snapshot is the
explicitly requested step 5; no implementation commit is authorized.

**Only full-model WSL validation remains blocked.** Three ring loads and one 10 GB
resident load failed near layer44 at the Windows commit ceiling, before benchmarks.
One failure had144.13/144.63GB commit but4.93GBfreeVRAM. Pagefile growth arrived late
and contracted after cleanup; the later retry also failed. No host settings changed.
User approval to raise D: pagefile initial16MB to32768MB (max64000 unchanged) is
pending; do not apply or reboot without a reply. Alternatively the user can free
commit headroom. Distro stopped, GPU idle. Preserve scratch runners for this blocked
continuation; archive precedes any future pruning.

Read [the concise results](2026-09-07-grouped-prefill-results.md) and
[artifact record](2026-09-07-grouped-prefill-artifacts.json) first. Earlier pending
notes below are historical. After capacity is resolved, use the retained WSL
checkout/scripts for ring, resident and automatic candidate measurements plus
numerical/decode checks, then update records/snapshot and prune temporary artifacts.

## Task and authority

User authorized completing the five steps discussed in chat: inspect/preserve state; resolve bounded prefetch storage/scheduling; prototype previous-chunk prefetch on the ring; correctness and controlled performance measurement; auto L3 sizing, robust probe, WSL/decode/load validation and artifact preservation. Required target: at least 1,750 tok/s at the existing Windows 32k/4096 benchmark. If prefetch falls short, investigate and test other generic approaches. Do not stop at the first failed hypothesis.

No SiftKit commands. No worktrees. No implementation commits, pushes or PR writes. User step5 explicitly authorizes an artifact-only reference-branch snapshot. Preserve all pre-existing changes and artifacts. User explicitly permits native Python/C++/CUDA; TypeScript only when JS is appropriate. Use one existing scratch directory, `.scratch-staging`, for new transient scripts/logs. The pristine checkouts are authorized experimental workspaces. Never delete `.scratch-performance-followup/wsl` (retained distro disk).

Constraints: no persisted model hotness profiles, expert IDs or device-specific constants in implementation; no hand-tuned CPU affinity; anonymous expert arena/load/THP behavior should remain intact; bounded small host staging, no large pinned residency used to meet target. No duplicate host cache above 2 GB, pagefile/kernel-policy changes, or production-checkout edits. Existing benchmark arguments are controls, not implementation defaults. Additional VRAM must be reported and bounded. Correct routing/output is mandatory. A projected rate is not success.

## Reviewed sources and historical findings

- `docs/analysis/2026-09-06-zero-copy-middle-ground-direction.md`, sections 1–9: primary experiment record.
- `docs/analysis/2026-09-06-zero-copy-pr-validation.md`: PR mechanism, platform checks, equivalence methodology.
- `docs/analysis/2026-09-06-pr341-hardening-gpu-validation.md`: five-run Windows/WSL medians, profiler cadence caveat, nondeterminism.
- `docs/analysis/2026-09-05-qwen38-flash-next-engine.md`: earlier controls and abandoned knobs.
- `docs/exl3-wsl-environment.md`: retained distro, paths, build environment, lifecycle protections.

Windows reference (same model, 32k context, 4096 chunks): upstream 1,019; piece ring ~1,368 median; 470 MB/1.25 GB pinned FIFO 986/1,111; 2 GB duplicate fill cache 1,407 at 8% hits; 10/20/40 GB resident subset 1,476/1,512/1,748; PR341 1,754 five-run median. Forty-GB residency reproduces the PR mechanism and costs; do not pursue it as the solution.

Ring stage copy ~20 GB/s; per piece wall/copy/DMA 0.69/0.55/0.52 ms. GPU batch compute ~1.2 ms then wait ~1.3 ms. Stager idle ~50%, DMA idle ~62% of aggregate submission span. Thread counts, affinity, extra small VRAM slots and piece geometry did not move the sustained plateau. Whole-layer fetch-after-routing schedule is limited on this setup; this is not a universal hardware throughput ceiling.

Trace: each chunk sweeps ~28 GB once, no intra-chunk expert reuse. Previous-chunk set overlap 82–91%, wasted prefetch 9–17% in analyzed segments. Prior simulator has benchmark-specific grouping; independently check trace boundaries before relying on its labels. Prior estimate of ring nearing PR / residency reaching 2,100–2,300 is untested. Crucial cost in section 9f: retain roughly a layer's hot set twice (~1.2 GB VRAM), not just current 2×64 MB slots. Need prove useful overlap with actual retention and stream synchronization.

Correctness floor: engine already has floating-point nondeterminism; greedy token agreement alone is weak. Existing byte verification got 0/13,273 mismatches (fill cache) and 0/2,543 (resident). Add byte checks for speculative weights and deterministic synthetic scheduler tests, plus repeated-control logits comparison.

Variance: prior batch-wide slow mode unattributed, cool idle GPU. Pin `EXL3_MOE_STREAM_T=8` during controlled comparisons. Probe sometimes reports 6.8 instead of 26.7 GB/s. Do not discard slow runs selectively; use interleaved controls and medians. Load/decode/Linux/non-AMD/model portability of section 9 remains unverified.

## State verified this session before implementation

- Outer SiftKit branch **main**, differs from handoff's engine-zero-copy. Dirty: `.gitignore`, `docs/exl3-wsl-environment.md`; untracked three Sept 6 analysis records and `exllamav3-pr341-implementation-plan.md`. Preserve.
- `pristine_exle/exllamav3-upstream`: HEAD `c6c45b13f2bb070a2c86fae59f3d7bfe4db9ae94`. Modified `exllamav3/exllamav3_ext/cpu/moe_handoff.{cu,h}`, `moe_mul1.{cpp,h}`, `exllamav3/model/moe_cpu_host.py`. Untracked in-place `.pyd` and eval workload cache. These are prior changes.
- Initial GPU: RTX4090, 0 MiB, 0% utilization.
- Windows Python: `C:/envs/rl313-turbo/Scripts/python.exe`.
- Model: `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`.
- Existing runner `.scratch-staging/run_upstream.sh`; builder `.scratch-staging/build_upstream.bat`; existing combined patch `.scratch-staging/piece_ring_pool_cache.patch`.
- Existing control knobs: `EXL3_LOAD_ARENA=1 EXL3_MOE_MEMOPS=1 EXL3_MOE_STREAM_T=8 EXL3_MOE_CPU_WSLOT_MB=64 EXL3_MOE_STREAM_BATCH_EXPERTS=24 EXL3_MOE_CPU_PIECE_EXPERTS=5 EXL3_MOE_CPU_PIECES=2 EXL3_MOE_CPU_STAGE_THREADS=4 PYTORCH_ALLOC_CONF=backend:native`; cache/resident/profile/affinity off unless diagnostic.
- Benchmark args: `-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 32768 -sg`; remove `-sg` for decode checks. Existing runner also emits env/status/stderr files.
- WSL `SiftKit-EXL3-Perf-20260905`; `/opt/exl3/bin/python`, `/opt/exllamav3` upstream c93f3c6, `/opt/exllamav3-zc` PR ba5473b. Need separate upstream c6c45b1 experiment source/build; keep existing references intact. Toolkit `/usr/local/cuda-13.2`; model under `/mnt/d`. Distro memory 108GB, swap 0. Terminate distro after use, never unregister.

## Design and execution checklist

This is an experimental scheduling change within the user's approved five-step direction. Execute inline, TDD for retained behavior, no redundant approval gates. Skills read: using-superpowers, brainstorming, writing-plans, executing-plans, test-driven-development. User's no-SiftKit/no-worktree/no-commit and continued execution instructions override conflicting skill defaults.

- [x] Read prior records and verify checkout identity; write this checkpoint before code changes.
- [ ] Preserve current source and scratch evidence in a verified archive without committing. Record manifest/hash before any pruning. Keep original artifacts during investigation.
- [ ] Inspect model forward boundaries and GPU capacity; formulate exact bounded prefetch interfaces and tests in the implementation plan.
- [ ] Red/green scheduler tests: first chunk, previous chunk only, bounded admission, all/partial/no prediction hits, layer/weight invalidation, slot lifetime, missing experts always fetched.
- [ ] Prototype early transfers through the existing host piece ring into bounded VRAM retention; routing reconciliation reuses confirmed experts and fetches misses; shared staging implementation, no copy-pasted parallel transport.
- [ ] GPU byte verification and E2E logits/noise controls; abort/error propagation. Establish baseline and candidate within a batch. At least five candidate/control observations for acceptance median; log all outcomes and resource costs.
- [ ] If <1,750, profile why and test distinct generic hypotheses. Candidate directions are scheduling farther ahead within bounded capacity, reducing transfer/handshake work, or better generic division of CPU/GPU work. Choose from evidence, not arbitrary sweeps or large pinning.
- [ ] Auto-size ring from detected usable L3/cache domain and expert geometry; no 7900X/model constants. Cover absent/malformed topology and impossible geometry explicitly.
- [ ] Probe robustness: correct warm-up duration, repeat unstable/low samples based on measured convergence or detected link capability; preserve actual slow links and explicit threshold override. Unit/GPU validation.
- [ ] Repeat ring and a small resident mechanism control in WSL2, plus winning configuration; validate load/decode and report THP/resource behavior. Resident control is not target evidence.
- [ ] Independent review, applicable engine tests, `npm run typecheck`, `npm run lint` (log only, no SiftKit); preserve unrelated failures. Durable result table, tested scope and remaining limits. Archive final artifacts before deleting only this session's temporary files. No branch commits without explicit request.

## Latest progress / resume here

Implementation underway. Plan: `docs/superpowers/plans/2026-09-07-online-prefetch.md`.

Preserved original 432 scratch files (14.5 MB) in `docs/analysis/staging-before-online-prefetch-20260907.zip`, SHA256 `D9960F7082CFF592537F684E15938905C69AC762C0168ABFD493961A8E2ABE6A`. Archive contents not yet independently compared. Baseline source copy `.scratch-staging/pre-online-moe_cpu_host.py`, model loop `.scratch-staging/pre-online-model_ls.py`, complete original diff `.scratch-staging/pre-online-prefetch.patch`. No originals deleted.

New native Python files: `model/moe_prefetch.py` (ExpertHistory/partition_predictions/copy_predictions); `model/moe_staging.py` (validated Windows cache records/Linux sysfs, geometry, probe convergence); tests `test_moe_prefetch.py`, `test_moe_staging.py`. Modified `moe_cpu_host.py`, `model_ls.py`, `modules/transformer.py`; previous C++/CUDA edits untouched. Scratch appliers `online-implement.py` and `online-staging-integrate.py` are one-time scripts, do not rerun.

Prototype: early TransformerBlock hook before attention (skip final prefill block, autosplit, decode); begin_pass advances history from previous runtime pass only when past_len>0. One bounded raw VRAM buffer per device, budget `EXL3_MOE_PREFETCH_MB`; consumers copy confirmed predictions on compute stream after per-batch ready events, so they overlap remaining producer traffic; demand uses same extracted `_stage_experts`. Buffer overwritten only after consumed event. `install_expert` invalidates history/current map. `EXL3_MOE_PREFETCH_VERIFY=1` restages hit bytes for comparison. Existing shutdown labels this counter `pin cache verify` even for prefetch. Read-only reviewer `/root/prefetch_review` auditing event ordering/lifetime/portability.

Tests: red missing policy ->8pass; red delayed CUDA copy ->9pass; red missing staging policy ->13pass. Broader staging/optimizer/model-TP-signals:18pass. Dependency emits14 existing torch jit deprecations. Live Windows detect_l3=33554432. Auto piece setting defaults `auto`, explicit numeric experiment knobs preserved; geometry cache/(depth+1)/expert bytes gives4 experts×2 here. Pinned allocation now physically equals active piece ring, previously128MiB reserved despite24MiB touched. New bandwidth warmup runs full0.25s windows (old max256 iterations could stop early), repeats stable peak windows up to3; actual slow links accepted.

| Current run | 32k tok/s | Status / notes |
|---|---:|---|
| online-control-01 |1211.45|Original source, ring5×2, pool4, threshold8, exit0. Today's lower mode; retain.|
| online-prefetch-verify-01 |8k1106.70|512MiB buffer, 0/8234 byte mismatches, exit0. Not speed evidence. Predicted25.16GB/hits20.24GB/demand203.85GB over whole perf run.|
| online-prefetch-512-01 |1269.20|First uninstrumented512MiB. Predicted171.71GB/hits148.40GB/demand234.78GB. Below target; geometry/probe still prior behavior in this process.|
| online-prefetch-1024-prof |pending|Currently running, exec session59741. Budget1024MiB capped to full max layer bytes, ring5×2, pool4, threshold8, stream/stager profiling. Includes smaller physical pinned allocation +new probe.|

All runs scripts `.scratch-staging/run_upstream.sh NAME 'env knobs' -mcs410 -mct12 -cs32768 -chunk_size4096 -ngr -max_length32768 -sg` (space between flags and values in actual invocation). Shell needs `C:/personal/Git/usr/bin` added PATH for env/date. Launch via tools.exec_command gives session ID; logs NAME.txt/NAME-stderr.txt/NAME-status.txt, no SiftKit. GPU benchmark loads take several minutes. Do not overlap GPU workloads; small CPU policy tests were run only during loading, not timed prefill.

### Subsequent results and current frontier (23:12 local)

Archive independently byte-hash compared: all **434 files** match originals (432 was top-level count). Verified ZIP safe; still nothing deleted.

1GB (actual960.9MiB=max layer weights) profile:32k1175.98; predicted201.87GB/hits174.43GB/demand208.66GB; prediction wait/copy0.365s, host prefetch enqueue1.096s; wready stall8.56s, streamed compute8.16s, final tail collect0.17s, span50.72s. Stagercopy22.69s at18.1GB/s/gate6.39s/idle23.77s. This did NOT achieve projected overlap improvement.

Added earlier-next-layer experiment: `prefetch_successors(fwd_modules, terminal)` follows actual execution order, including relayered/repeated layers, excludes terminal MLP. `model_ls.prefill_ls` passes successor through params; TransformerBlock records it on host; current `_submit_prefill_streamed` enqueues successor after its own consumer operations (before GPU-resident experts run). Pass generation avoids re-enqueue at attention hook. `EXL3_MOE_PREFETCH_EARLY=0` selects attention-only comparison; default1. Early8k byte verify:0/10,826, exit0, 938tok/s instrumentation excluded. Tests now23pass (including actual delayedCUDA copy and relayer order). Corrected an unlaunched patch misplacement in install_expert immediately upon inspecting diff; current install invalidates map and layer identity.

Same-load interleaving `.scratch-staging/online-batch.py` + `online-run-batch.ps1`: one load, upstream perf.measure_prefill unchanged, own warmup before each case, same tokens/context, logs+JSON. Cases control/attention/early mutate only prototype knob; threshold8 fixed. Controls retain allocated prefetch buffer after first candidate, so capacity equal for subsequent comparisons. `online-batch-01`: control1246.85, attention1257.32, early1177.25, control1268.96, early1152.42. Auto ring4×2 (18.75MiB actual host staging), probe updated, peak allocated control21.499GB initially/candidate22.507GB. No target. Early schedule is worse; don't keep pursuing it without new evidence.

Current running batch: `online-threshold-batch-01`, exec session79791, cases control8/control32/early32/control8, generated by online-run-batch.ps1 `-Thresholds '8,32,32,8'`. First control1240.07, next cases pending. This is diagnostic CPU/GPU division, not a final hardcoded cutoff. Offline trace extraction `online-threshold-analysis.py`: changing8->32 removes32.4% of weight bytes for4.3% of streamed assignments moved CPU;48 removes43%bytes for7.4%assignments. Only whole4096 rows examined; not a policy/profile file.

**Important new code finding to measure next:** `_issue_compute` issues the cold CPU tail on the CURRENT compute stream and inline-collects jobs beyond4-slot capacity before enqueuing ANY streamed-expert GPU compute. Historical `tail_s` only counted final4 jobs' collection, so claim 'tail off critical path' is not established! Just added `tail_issue_events` and compressed row count under EXL3_MOE_STREAM_PROF to measure time before GPU streaming. Next run a ring-only profiled32k with these metrics; if material, prototype separate tail CUDA stream (input-ready wait; issue+collect all tail there; main waits only before final output merge), preserving real correctness. This is primary's next hypothesis; reviewer notified. No tail-stream implementation yet.

Review agent `/root/prefetch_review` still running; no findings received yet. New scripts are in same scratch directory. WSL, full logits/noise pairs, final medians, npm checks, final archive/cleanup remain. Memory headroom tight but1GB buffer fit; Windows automatically expanded commit limit during run (no pagefile settings changed by agent). Do not stop at failed prefetch; user explicitly requested alternatives.

### Current checkpoint (23:39 local; supersedes pending notes above)

Threshold batch completed:8/32/early32/8 =>1240.07/651.79/625.49/1285.71. Raising CPU cutoff is bad here, not a solution.

Reviewer finished: identified decode eligibility, oversized-expert range step0, no free-VRAM bound, stale successor, and host-side staging backpressure. First four fixed with failing then passing tests: host.begin_pass(continuation,prefill=False) explicitly excludes decode and resets successor; prefill_ls sets prefill=True; history only records prefill; oversized experts skip prediction; prefetch_capacity limits by budget/layer/half free VRAM and whole expert geometry; terminal hook clears successor. Host ring backpressure remains measured prototype issue, not correctness failure. Reviewer then independently reviewed `_issue_tail`: no blocking CUDA lifetime/dependency race; noted rare host ring-full backpressure.

New independent-tail prototype (`EXL3_MOE_TAIL_ASYNC`, default1 currently, MUST explicitly0 for old control): `_issue_tail` waits tail_stream on input-ready main, records input/output allocator lifetimes, issues+collects CPU jobs on tail stream, returns ready event; main waits only before out merge. Real mapped CUDA flag + delayed external worker regression failed under serialized method, then passed after side-stream change. Initial worker stand-in allocated CUDA temporaries AFTER blocked flag and itself caused cudaMalloc global sync; corrected to allocation-free external-worker copy, which is the real boundary being tested. All30 policy/CUDA tests pass. Existing14 torch jit warnings.

Full-model correctness `online-tail-logits-01`, same load, serialized/serialized/async,2×4096 prefills+24decode:all24tokens identical. Control-control max/mean logits1.035156/.126861; control0-async.630859/.082118; control1-async.718750/.114567. Exit0. Script online-compare.py and comparison.txt retain exact values.

Independent tail PERFORMANCE FAILED: `online-tail-batch-01` same load:

| config |32k tok/s|
|---|---:|
|serialized tail,T8,ring|1266.15|
|async tail,T8,ring|1178.62|
|async tail,T16,ring|963.56|
|async tail,T32,ring|662.06|
|async tail,T8,early-prefetch|1154.38|
|serialized tail,T8,ring repeat|1280.54|

No target met. Do not retain failing speculative/async paths as final production complexity; archive experiments before eventual cleanup/replacement.

Profile `online-tail-issue-prof` (serialized,1216.43):tail issue4.106s/185468 compressed rows vs finalcollect.19s. Expanded full-block profile `online-block-prof` (serialized,1266.27) finished:attention7.487s, MLP44.628s across847blocks; tailissue3.812s, wready13.90s, streamedcompute8.34s, span48.21s. Stagercopy21.76s (17.6GB/s), gate6.51s, idle21.50s. Profiling totals include warmup+all lengths, not isolated32k. ~18.6s of MLP time remains outside tail issue+streamed waits/compute; likely resident GPU experts/other setup, needs precise timeline rather than assuming all stager idle is attention.

**Current root direction:** investigate exact early-prefetch overlap with block timeline (add timed copy-span events linked by pass/layer if needed). Also exploring layer-major multi-chunk prefill to get REAL within-layer weight reuse: keep attention physical chunks4096, retain intermediate activations and one layer's streamed weights in bounded VRAM, process all chunks of a layer before advancing. This would require a real grouped-prefill engine API and caller integration; existing external `perf.py` loop only supplies4096tokens per call, so cannot secretly look ahead or just relabel chunk_size. No code for layer-major yet. Any benchmark adaptation must preserve input tokens, causal cache/state semantics, physical attention chunk4096, all time/memory accounting and baseline comparison, and be disclosed.

Facts for layer-major exploration: model architecture is `qwen4_exp` (detected config, never hardcode). Qwen4ExpModel.prepare_inputs = prepare_for_attn + prepare_for_recurrence; GDNState.post_advance is pass; recurrence tensors are separate per layer-instance, modules don't use global state.position for their math (prepare_for_recurrence validates it once). PLE module has independent recurrent conv and token-ID history per layer, stored in CPU/GPU state; layer-major must preserve per-layer chunk order. `prepare_flash_attn` at modules/attn.py:93 regenerates cache_seqlens/position/block_table per chunk when past_len supplied. Params must be separate per chunk and dev_cache not shared stale. Model has hyperconnection stream stack, so activation retention can be much larger than simple hidden_size*2 (derive actual tensor bytes). NGramEmbedding already has queued prefetch entries, but PLE carried-token history must match each chunk, so prefetching all upfront is not automatically correct. Final MLP is skipped during model.prefill; preserve it.

No GPU workload currently running after online-block-prof completion (verify before next launch). Latest process IDs are old exec sessions; files/status are authoritative. WSL steps, npm typecheck/lint, final experimental artifact archive/cleanup still pending. Keep going toward user's target via genuinely different generic mechanisms. No SiftKit, commits, worktrees, production checkout edits, or host settings changes.

### Grouped MLP frontier (00:16 local; supersedes pending notes)

Early timeline confirms overlap really occurs: online-early-timeline 1142.35 tok/s; last chunk3698ms, average prefetch40.35ms overlaps previous MLP39.47ms;1855ms total overlap, only28ms beyond next attention (first layer). Failed speed despite overlap; contention is plausible but not proven. Stop pursuing speculative transfer as the speed candidate.

Implemented experimental native `Model.prefill_chunked(input_ids, params, chunk_size)`: receives actual supplied token group, preserves attention chunks and causal order per layer, combines MLP rows so expert weights are reused. `model_ls.prefill_ls_chunked` executes layer-major; TransformerBlock shares extracted attention/MLP logic. GDN/ShortConv state classes advertise supports_layer_major; other recurrence rejected (some read global position during forward). Current API supports single rectangular local cached causal text prompt, no TP/history/export/multimodal. Caller supplies group size; generic automatic admission and ordinary caller integration still pending. No architecture/device names used in policy.

Benchmark adapter `online-batch.py` measure_grouped duplicates upstream incremental256..32768 timing and exact per-chunk workload tokens, but calls actual grouped API; attention chunk remains4096. All concatenation/compute is timed. It is explicitly a changed scheduler quantum/API, not unchanged perf.py. Default tail prototype still1: always pass TailModes0 for controls/grouped.

Grouped correctness `online-grouped-logits-01`:control/control/group2,8k prefill+24decode;all24tokens identical. Control-control max/mean logits .84375/.129898; ctl0-group .972656/.146652; ctl1-group .808594/.123062. Similar noise but need repeat after memory edits.

`online-grouped-batch-01`:control1218.81,group2 1700.39 (peak allocated22.239GB,reserved23.721GB),group4 1210.04 (allocated24.301GB,reserved27.076GB),finalcontrol1193.84. Four chunks exceed physical VRAM and slow down; OOM alone cannot guard WDDM paging.

Five same-load interleaved pairs `online-grouped-repeat-01`, exit0:
- control 1182.85,1169.31,1170.93,1188.69,1209.85; median1182.85.
- group2 1690.83,1711.89,1716.52,1709.09,1725.81; median1711.89. **Target1750 NOT yet met.**

Reviewer identified grouped API losing arbitrary prepare_inputs params, accepting noncausal preparation, and missing rectangular cache extent validation. Four regression tests failed first, then fixed (plus activation lifetime). Latest policy/CUDA/grouped run40pass,14existing torch.jit warnings. `prefill_chunked` now copies prepared metadata after hook, rejects noncausal/spans, checks cache extent before attention/state work.

Memory improvement now under test: forward_chunked joins input adjacent views before attention, consumes owned chunks list, copies each fresh attention output back into group immediately (or new correctly typed/shaped group), releases each temp before next chunk, accumulates residual-fusion workspace directly. Avoids retaining original+all attention results+concat simultaneously. Lifetime regression checks separate original chunk allocations released before MLP. CPU causal equivalence passed.

Currently running `online-grouped-memory-logits`, exec45424, control/control/group2, tail0,8k+24decode. Next inspect correctness, then measure2/3/4 chunks with improved memory. Generic memory admission required before final acceptance: derive from real activation shapes/live memory, no hardcoded group2 based on this hardware. Full WSL ring/resident/winner repeats, native broader tests, npm validation, final archive+cleanup still pending. No C++ changes/build in this session yet. Reviewer /root/prefetch_review can review fixes. No commits/worktrees/SiftKit. Original434 artifacts remain hash-verified in archive, not deleted.

### 00:35 checkpoint: first target result, automatic admission running

`online-grouped-bounded-01`, exit0, serializedtail, autoL3ring:control1171.08,group2 1699.91 peak21.851GB,group3 1737.42 peak22.188GB,group4 **1930.98** peak22.540GB,reserved23.572GB. Target first crossed in a diagnostic fixed4 group; repeat+automatic admission needed before acceptance. Inputs/attention4096 unchanged, combined MLP only. `_prepare_mlp` and `_finish_mlp` shared by normal and grouped paths, normalization/HC mixing remains chunked. New TDD norm boundary test failed [5] vs [3,2], then passed.

Correctness: `online-grouped-bounded-logits`16k+24greedydecode:control/control matched24;group4 divergedaftertoken10,13/24match. Firstlogitsctlctl max1.639160 mean.205919;ctl0group1.345215/.203030;ctl1group1.836426/.244139. Investigated rather than assuming pass.

`online-grouped-teacher-01`3controls/3group4 interleaved,16k+24 fixed continuation tokens, all24logits retained. Control-control meanabs.215819-.224561,max2.4883-3.4512,top1[24,23,23]/24. Control-group9pairs mean.196053-.243947,max2.1543-4.1445,top123-24/24. Group-group mean.201651-.226029,max3.0635-3.9063,top123-24/24. Distributions overlap; consistent with existing numerical variation, not exact parity proof. `.scratch-staging/online-teacher-comparison.json` includes perstep metrics. No independent state-ordering race found in reviewer causal path.

Added generic online `prefill_budget.py`: observes normal fullchunk peak-minus-idle workspace and actual per-row activation shape, uses live free+reclaimable reservation capped to physical capacity (WDDM oversubscription otherwise misleading). Extra group growth estimated from actual MLP hidden/intermediate/routing dimensions with explicit tensor-buffer accounting; attention/norm workspace doesn't scale. Unknown MLP uses conservative full-observed-workspace growth. No machine/model names, hotness files, or tuned groupcount. `prefill_chunked` now admits groups automatically, runs one real physical chunk to establish observation when needed; does not reset global allocator peak counters. Explicit auto_group=False kept only diagnostic option. Whole-request cache geometry/state support validated first; recurrent state propagated across admitted groups.

`online-auto-01` currently running exec18245,control/auto/auto/control,nominal inputgroup8 (actual <=remaining16k plus automatic admission). New code printed prefill_memory in JSON, actual speed pending. CPU-only pytest regression was accidentally run during first control's early lengths; exclude that observation from final acceptance and rerun clean medians. Do not overlap any further tests with speed runs.

Reviewer confirmed two API issues: cache_seqlens withoutpast_len silently starts0; single-device load has emptyactive_devices bypassing admission. Both regression tests failed, fixes written (explicitposition requirement, discoverCUDAdevices from actual fwd_modules); **green rerun pending benchmark completion**. Reviewer also claimed splitviews noncontiguous but APIbatch1 makes them contiguous; supplied CPU regression passes and actual fullmodelgroupedruns prove no view error. Asked reviewer to correct this and inspect latest memory admission.

Latest complete relevant test run before two review fixes49pass (14existingtorch.jit warnings). Failed testexec9720 completed output2fail/12pass; may need harvest sessionexit. Auto benchmark already imported pre-review-fix code; autosplitdevicesnonempty used here so admission still exercised. Reviewer /root/prefetch_review active. WSL build/repeats, ordinary caller integration, finalclean medians, broader native/npm checks, failedprototype cleanup and finalarchive remain. No SiftKit/commits/worktrees/nativebuilds yet.

### 00:50 checkpoint: cleaned candidate, WSL running

Automatic Windows diagnostic `online-auto-01` exited0: control1190.52,auto1946.86,auto1947.85,control1202.03. Candidate peak22.524/22.561GB. Admission observation on this workload:workspace1300668416 bytes,onechunkactivation167772160,growth740818944; selected actual groups from live capacity, not diagnostic supplied upperbound8. First control had incidental CPU-only pytest overlap at early lengths, so these are diagnostics, not final clean5pair acceptance.

Cleaned failed source paths: `.scratch-staging/online-prototypes-before-cleanup.zip` contains17 source/test files, all independently hash-compared; archiveSHA256 `c39e6e7e05c1426735c2f023d91e61c86d482f472c3866daa00e605ec12f13a7`. Restored pre-session host patch then reapplied only autoL3 ring allocation+robustprobe. Removed this session's `moe_prefetch.py` and its test file (archived); removed speculative/tail/blockprof hooks and restored normal model_ls loops. Original cache/resident/native prototype changes preserved. `online-clean-candidate.py` and `online-final-stage.py` are one-time appliers; do not rerun.

Added native `eval/perf.py --grouped_prefill`, using real model API and exact original per-chunk token slices. TDD wraparound workload regression failed before implementation, passed after. Scratch adapter's auto case now calls THIS actual CLI measure_prefill for warmup and timed runs, no duplicated measurement implementation. Explicit diagnostic grouped case still exists for experiments. `docs/grouped-prefill.md` documents API, scheduling/memory tradeoffs and unsupported paged-generator integration.

Reviewer API findings fixed with red-green tests: cache_seqlens-only missingpast_len rejected; actual fwd CUDAdevices used even load(device) leaves active_devices empty; implicitCudaindex resolved; string/int moduledevice representation normalized; modules after KVterminal excluded. Nonintegerchunk_size rejected before preparation. Reviewer withdrew batch-one splitcontiguity findings (CPU regression and real GPU runs prove contiguous). Lifetimepeak overestimate is an acknowledged conservative admission limitation, deliberately no globalpeak resets.

Windows broader suite `online-native-tests-green.txt`:67passed +8subtests,14existingtorch.jit warnings. Initial broader attempt included test_dsv4_state.py but collection failed because upstream fixture module compare_deepseek_v4_hf_ is absent (rg confirmed no file). That suite remains unverified, not weakened. `npm run typecheck` and `npm run lint` both exit0 (logs online-typecheck/lint.txt).

WSL new independent clone `/opt/exllamav3-online-20260907`, detachedc6c45b1, source copied from current candidate. Existing/opt/exllamav3 and/opt/exllamav3-zc preserved. BuildCUDA13.2,detectedarch8.9,MAX_JOBS12. Extension built/imported, SHA256 `324202855778cfca89d6e02425d705ae4f57005626ffcf30cdecc8509fb6bcfd`. Setup PowerShell wrapper reported1 after stderr clone progress despite reaching import/hash; independent validation command exited0. A separate inlinepython-c attempt failed due PowerShell quoting; switched back to script files. No actual compilation failure.

WSL validation script currentmodel.py/test_chunked copied after API fixes:43tests passed including nativeCPU pool,14existingwarnings,52.37s. ActualLinux detectL3=33554432. `online-wsl-validate.txt` explicitexit0. `/dev/shm` transiently remounted100G per existing benchmark prerequisite; no host/globalTHP policy changed. LinuxTHP enabledalways,defragmadvise.

Currently `online-wsl-pairs-01`, exec80570, control/auto x3, resident0, same32k4096,T8,ringauto,tailserialized. Started00:47; at00:50 loadinglayer34, parentRSS~42GB/worker8GB earlier, MemAvailable60GB, no stall/errors. Logs/status in scratch. Run through `online-wsl-run.sh`. WSLscript budgetthirdarg GB converts to EXL3_MOE_CPU_PIN_RESIDENT_MB; intended next10GBresident mechanism control (directno duplicate memory) + decode/correctness, then stop distro. Final cleanWindows5pair CLI medians and no-overrideprobe/decode check still pending. Do not run tests or heavy CPU work alongside timed benchmarks.

All experimental scratch remains archived-before-any-source-pruning; final archive/reference-branch snapshot and temporary cleanup still pending. User's step5 explicitly requests a reference branch snapshot; treat that as authorization for artifact-only reference snapshot, not implementation commits. Working branch main and unrelated dirtyfiles must stay intact. No SiftKit/worktrees/pushes used.

### 01:09 checkpoint: Windows final pairs active; WSL needs host commit headroom

WSL pairs failed during model load atlayer44 before any benchmark. First run online-wsl-pairs-01 exit1 CUDA driver unknownerror at FLA chunk_fwd_o torch.empty_like; secondary shutdown AttributeError verify_bad. That inherited prototype cleanup bug reproduced with MoeCpuHost constructor->shutdown twice; moved verify_bad initialization into constructor, regression nowpasses. Does not fix primary allocation failure.

Instrumented retry `online-wsl-pairs-retry` repeated sameprimaryfailure. LastWindows hostsample:commit144127393792/limit144630603776bytes,physicalavailable22895747072,GPUused16786MiB. Exception-sideCUDAstats:allocated19019972608,reserved19063111680,peak19019972608,free4930404352,total25756696576. Thus repeat correlateswith hostcommitceiling while4.9GBVRAMremains. No OOM/TDR System eventsfound in20minwindow; guestkernel had no loggedOOM and processescleanedup. This is a capacity diagnosis pending a headroom experiment, not an executionparityfailure. Monitor wrapper originallyprintedblankExitCode/returned0; authoritative bashstatusfilesboth1. Wrapper fixed toparsewrittenexitcodebeforefutureuse.

Hostpagefile read-onlyinventory:D:/pagefile.sys,InitialSize16MB,MaximumSize64000MB,AutomaticManagedPagefileFalse,currentallocated7722MB,currentusage617MB,peak9295MB. D:free121533001728bytes. No settingschanged. Microsoft documents allocation failures duepagefilegrowth latency: https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/slow-page-file-growth-memory-allocation-errors . NVIDIAWSLguide noteslimitedpinnedmemory but failurehere precedes ringstartup; do NOT attribute itto pinning without evidence: https://docs.nvidia.com/cuda/wsl-user-guide/index.html .

Asked user asynchronously for approval to raisepagefileinitial16->32768MB whilekeepingmax64000, becauseWindowssettingsareoutsideengineexperiments; possible rebootwouldrequireuserinvolvement. Alternativeskeepcapacityblockoruserfreescommit. **Answer pending. Do not change settings/reboot withoutreply.** ContinueindependentWindowswork. It may stillbe usefultoattemptrequested10GBresidentWSLmechanismcontrol (no duplicateweights) afterWindowsfinishesifcapacityallows; ring fullmodelbenchmark remainsunmeasured onLinux.

WSLstoppedexplicitly, GPU0MiB26C beforefinalWindowslaunch. `online-final-windows-pairs`, exec37535,cleancontrol/auto x5 via actualintegratedeval/perf.measure_prefill, fixedT8,autoL3ring,noresidentcache. Firstcontrol1200.03, remaininginprogress. No heavytests alongside timedrun. Currentcodeincludesallreviewfixes plusconstructorcounterfix. Afterpairs: standaloneCLI --grouped_prefill withoutthresholdoverride +decode(probeconvergenceactual), thenfinalartifacts/sourcepatch/referencebranchsnapshot+cleanup. Userstep5authorizesartifactonlyreferencecommit; noimplementationcommits/worktrees/pushes.

Latestteststatus67Windowsbroaderpass+8subtests,43WSLpass(poolincluded),newshutdownregression1pass; need include shutdown in finalsmalltestbatchifothernewcodechanges. WSLsourcehost andmodel.py copiedcurrent before retry. Docs/grouped-prefill.md addedto upstream afterclone (copywithfinalsourcepackage later). Npmtypecheck/lintpassed. Currenttrackedupstreamdiff11files817insertions66deletionsincludespreexistingnative/hostpatch, notonlysessiondelta. Newpolicy/tests/docsuntracked mustbeincludedinfinalportablepatch/archive. NativeLinux.so SHA324202855778cfca89d6e02425d705ae4f57005626ffcf30cdecc8509fb6bcfd remainsvalid;noC++changes thissession.

### Final verification and snapshot preparation

Windows final CLI paired candidates:1974.991160,1921.957868,1945.167670,1975.428175,1970.308462;median1970.308462. Controls1200.033720,1209.195902,1180.631475,1213.514232,1207.769421;median1207.769421. Standalone default32MiBVRAMslot/noT override measured1931.05, probe26.0GB/s->T8; generation20.67-22.37tok/s exceptctx2048=17.23;exit0. No decode-regression comparison claimed.

ResidentLinuxattempt online-wsl-resident-10 exit1 atlayer44, allocated18.970GB,reserved19.000GB,free4.993GB VRAM. Hostcommit144.45/145.71GB nearfailure;limitgrew153.28GBafterfailurethencontracted144.63GB. Further ringattempt online-wsl-headroom-pairs alsoexit1 (allocated19.020GB,free4.930GB) despitelowerinitialcommit;sample151.01/152.20GB nearfailure. No furtheridenticalretries untilcapacitychanges. Allprocessesendedanddistroterminated. Settingsproposalnotapplied, userreplypending.

FinalnativeWindows68pass+8subtests; Linuxshutdown1pass afterprior43pass; reviewerconfirmedallconcretefixes. Packageapplies topristinebase andmatches19files. Firstgeneratedpatchincludedline-endingnoise duecore.autocrlf override; regeneratedusingnormalGitdiff, reverifiedeverything. RetainedpatchSHA256 f664fec7ea6a2b7b2dd2a438230c976ab575b5912d78f61ee3ff95ff272ad787. FinalZIP SHA256 ee4d14adad5654234b5036159a7bd0fc6aeaae4f0140381c8ca260d76d6ed58d,95486368bytes,641scratchfiles+19sourcefiles+patch=661hashedentries (plusmanifest). No source/data pruned duringregeneration; onlythefirstderivedZIPreplacedaftercheckingitsrecordedhash. Referencebranchsnapshotnext; scratchrunnersneededforblockedLinuxcontinuation.

Reference snapshot completed: `staging-ring-artifacts` now points to
`bca2342a71470ccea2a42f7d169f9c27f6f7a965` (parent
`894dfee9fbfae85ebb91ad6b28d752f866f776d2`). The committed archive and patch hashes
were independently compared with the verified files. Working branch `main`, its
HEAD and normal staging entries were preserved. This is an artifact-only snapshot;
no implementation commit or push occurred. Scratch runners remain because Linux
validation is blocked on external commit headroom; they are safe to prune after
that continuation is resolved, using the verified snapshot for restoration.
