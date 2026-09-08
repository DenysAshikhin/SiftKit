# Online expert prefetch implementation and experiment plan

> Execute inline using executing-plans and TDD. User authorization: carry out steps 1–5 and explore alternatives until a constrained >=1,750 tok/s result is established. No SiftKit, worktrees, or commits. Native engine languages explicitly approved.

**Goal:** Measure >=1,750 tok/s on the existing Windows 32k/4096 workload without large pinned residency or model/device-specific tuning.

**Architecture:** Predict only from runtime history. Before a transformer block's attention, enqueue a bounded prefix of that layer's previous streamed experts through the existing piece ring into retained raw VRAM. Route normally. Compute confirmed predictions as their per-batch events become ready while later predictions continue copying; stage misses normally. One retained raw buffer per device is reused only after a recorded consumer event. Do not serialize all compute behind completion of the full prediction set.

**Tech stack:** Existing Python/PyTorch, native C++/CUDA worker. Pure Python policy tests and real CUDA byte/E2E verification.

**Spec/context:** `docs/analysis/2026-09-07-online-prefetch-worklog.md` (authoritative constraints and prior experiment evidence).

## Task 1: Bounded previous-chunk prediction and lifetime

Files: create `pristine_exle/exllamav3-upstream/exllamav3/model/moe_prefetch.py`; test `pristine_exle/exllamav3-upstream/tests/test_moe_prefetch.py`.

- [ ] Write tests against `ExpertHistory`: `begin_pass(continuation)` advances generation, `record(layer, experts)` stores unique ordered IDs, `predict(layer, capacity)` returns only preceding generation's bounded IDs; `invalidate(layer)` removes old identity after swaps. First pass/missing layer/reset predict empty. Negative capacity/duplicate IDs fail explicitly. Changed chunk sizes affect efficiency only, never routing.
- [ ] Run pytest and observe missing behavior fail; implement minimal state class; rerun.
- [ ] Test `partition_predictions(streamed, predicted, batch_size)`: return batches of confirmed predictions in storage order and demand misses in original order; no dropped or duplicated required expert; full miss/full hit/empty/partial and invalid batch sizes. Implementation does not compute unselected predictions.

## Task 2: Shared transport and early hook

Files: `exllamav3/model/moe_cpu_host.py`, `exllamav3/modules/transformer.py`; CUDA tests in `tests/test_moe_prefetch.py` or model-free transport test.

- [ ] Preserve source/archive first; capture fresh ring control with all cache/resident knobs off and threshold fixed 8.
- [ ] Extract current batch staging/DMA into `_stage_experts(layer_idx, batch, spec, st, target, ws)` retaining cache/resident behavior, global piece counters, abort handling and existing profiling. Keep un-swizzle/compute in the consumer.
- [ ] Add `prefetch_layer(layer_idx, device, rows)` called before attention only for a loaded CPU-host MLP, nonterminal prefill, not autosplit measurement/decode. History is host-owned; update in actual routing path, clear on request reset and expert install. Layer-map instances may share an imperfect prediction without affecting output; missing history means demand fetch.
- [ ] Allocate retained raw storage within an explicit bounded VRAM budget and available capacity; report allocated bytes. Store per-expert offset and per-batch ready event. Reuse buffer after consumer event; preserve data across nonstreaming calls and expert swaps safely.
- [ ] Demand path uses shared staging for misses and reads confirmed predictions on compute stream after the appropriate ready event. Copy contiguous ranges into existing raw slot, un-swizzle, compute. Slot events prevent concurrent reuse by demand-copy stream. No dependency from speculative copy to future compute that creates a cycle.
- [ ] Real CUDA byte tests exercise early consumption, changing predictions, buffer reuse and partial/all misses. E2E verify mode restages confirmed predictions and compares raw bytes before use. No throughput claim from verification mode.

## Task 3: Measurement and alternative hypotheses

Files: scripts/logs under `.scratch-staging/online-*`; durable evidence in worklog.

- [ ] Existing perf command, identical workload/offload/chunk/threshold. Interleave controls/candidates, log exits, load time, throughput, peak CUDA and host commit. Five-run medians for final target, not best-run selection.
- [ ] Profile a short diagnostic separately: transferred/wasted/confirmed bytes; event readiness and compute stall; staging idle/copy/gate. Compare arithmetic with observed results.
- [ ] If miss target, inspect limiting segment and document next distinct hypothesis before each experiment. Candidate alternatives: earlier cross-layer scheduling with bounded retention, fewer host/GPU handshakes, or online compute/transfer partitioning. Exclude prior no-gain knob sweeps, huge pinning, model profiles and benchmark changes.

## Task 4: Generic configuration robustness

### Evidence-driven addition: independent CPU-tail stream

Ring-only profiler measured4.106s GPU time in `_issue_compute` (inline collect), versus0.19s final tail collection. Threshold32 cuts bytes but halves throughput, so unchanged current-stream tail scheduling prevents safe exploitation of spare CPU work. Test a complete issue+collect tail branch on an independent CUDA stream. Inputs wait on main stream; output merge waits on tail-ready event; existing bounded CPU slots and error flags unchanged. No additional pinned weights or model/device constants.

- [ ] Reproduce main-stream serialization with delayed external worker, real CUDA mapped flag and output checks (`test_tail_worker_does_not_block_main_stream_and_result_is_ordered`).
- [ ] Add `_issue_tail(layer_idx,y,selected,weights,spec,st)` using existing issue/collect functions; branch stream waits on inputs, output gets ready event. Capture event timings on correct stream.
- [ ] Run GPU regression, full-model logits control/control/candidate, and same-load throughput threshold8/16/32 diagnostics. Candidate is ring-only initially. Remove old serialized branch from final implementation if replacement succeeds; retain a temporary experiment toggle only while A/B measurement needs it.
- [ ] Profile attention/MLP and tail span if target still missed; select next hypothesis from measured unaccounted time.

Files: `exllamav3/model/moe_prefetch.py` or focused `moe_staging.py`, `moe_cpu_host.py`, policy tests; native binding only if required for reliable topology.

- [ ] Failing tests for ring geometry from per-domain L3 and expert byte size, insufficient/absent topology and invalid IO. Use Windows topology API / Linux sysfs, explicit validation. Compute bounded ring bytes independently from compute batch size; actually reduce pinned allocation, not only touched bytes.
- [ ] Failing tests for bandwidth sample convergence and slow stable links. Fix existing warm-up's premature iteration cap; bounded repeated windows handle sleeping links without assuming a 26.7GB/s device. Preserve explicit threshold override and report measurement.
- [ ] GPU regression: auto config vs matched control, demand-only and predictive modes; decode/load unaffected within measured variance.

## Task 5: Cross-platform and closeout

- [ ] Separate WSL experiment checkout at c6c45b1, apply verified patch, build with existing compiler/toolkit. Preserve `/opt/exllamav3` and `/opt/exllamav3-zc`. No distro/host policy changes.
- [ ] WSL ring, small resident control, candidate: throughput/correctness, load/decode, THP and shared-memory cleanup. Stop distro afterward.
- [ ] Relevant engine suites and broader affected module tests; independently inspect diff and ownership/error paths. Run outer `npm run typecheck` and `npm run lint`, redirect logs and report unrelated failures.
- [ ] Update worklog after every material result and before compaction. Verified ZIP archive of prior/final artifacts, manifest/hash; retain source patch/tests/results durably. Delete only session-created temporary files after archive validation, preserve historical evidence/distro. No commits.

## Task 3c: Layer-major prefill with bounded per-chunk workspaces

Selected after measured prefetch/async-tail failures. Receive actual future input tokens through a real API; preserve physical attention chunk size and causality. Group only the MLP rows to reuse expert transfers; keep normalization, residual mixing, attention and state updates chunked. Do not change workload/timing accounting to claim a win.

- [x] Native grouped entrypoint, per-layer execution, state capability checks, uneven chunks/final-layer skip and causal equivalence regression tests.
- [x] Prepared-params, noncausal/cache-extent and activation-lifetime regression fixes.
- [x] Extract shared MLP preparation/completion; grouping retains only normalized inputs and necessary residual context, not enlarged normalization workspace.
- [ ] Measure bounded2/3/4 chunks, full-model paired logits and decode; >=1750 requires repeat medians, not peak result.
- [ ] Automatic memory admission based on observed tensor geometry/live device capacity. No device/model names, stored profiles or empirically chosen group count. Integrate into usable entrypoint/caller and document scheduling tradeoffs.
- [ ] Archive failed speculative/tail prototypes, remove failed paths from final candidate after replacement validation.
- [ ] Repeat final candidate/control on Windows and WSL, complete Task5.
