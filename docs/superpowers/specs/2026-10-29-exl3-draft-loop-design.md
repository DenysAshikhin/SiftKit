# EXL3 draft-loop speedup (Qwen3.8-Flash-Next, MTP 3 + hybrid 5)

Status: design approved section by section on 2026-10-29. Supersedes the "graph-captured verify pass" idea.
Evidence: `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`, section "Where the EXL3 step goes by phase".

## Problem

An nsys trace of 180 decode steps (groxaxo 3.50 HQ, 200k context, `NcpuMoe` 399, pinned arena) splits each step into two parts:

| Part | ms/step | GPU busy | Blocked on CPU | Host-bound |
| --- | --- | --- | --- | --- |
| Verify pass | ~25.5 | 12.8 | 11.5 | 1.2 |
| Draft loop | ~22.4 | 5.7 | 8.1 | 8.6 |

- The draft loop alone takes as long as Strata's whole step.
- Each of the ~3.4 MTP draft passes per step waits about 1,055 µs on the CPU MoE worker. The MTP head shares the main config, so `moe_cpu_split` also splits `mtp.layers.0.mlp`.
- syncprof counted about 31 host syncs per step:
  - ~22 at `block_sparse_mlp_cpu.py:281` (`_split_promote_step`: map updates through pageable `torch.tensor(list, device=…)`)
  - 3 per draft pass:
    - `qwen4_exp_mtp.py:160`: the embedding is computed on the CPU and then sent to the GPU with `to_device`
    - `generator.py:1304`: draft ids are copied to the embedding device
    - `generator.py:1310`: `draft_conf.float().cpu()` for the early stop
  - about 4 at the end of each step
- Graph-capturing the verify pass is not worth it: it has only 1.2 ms of host-bound time.

## Goal

Cut the draft-loop time per step without changing output. The work is in three phases, applied in order. Each phase is measured on its own and kept only if it passes its gate.

## Phase A: MTP layer fully on the GPU

**exllamav3:**
- New setting `infer_params.draft_moe_cpu_split` (named after the existing `draft_moe_cpu_offload`), default `None` (the MTP layer follows `moe_cpu_split`, as today). `0` keeps every MTP expert on the GPU.
- `cpu_maybe_split_load` (`block_sparse_mlp_cpu.py`, ~line 466) reads it when `infer_params.moe_cpu_component == "mtp"`.
- With no split module in the MTP layer, draft passes never call the CPU worker.
- If the extra VRAM doesn't fit, the load fails with the normal out-of-memory error; there is no silent fallback.

**TabbyAPI:**
- New model option `cpu_moe_split_mtp_experts`, next to `cpu_moe_split_experts` (`backends/exllamav3/model.py`, ~line 344).
- It is set on the config that the MTP draft model is built from (~line 447).

**SiftKit:**
- New boolean preset field `MtpExpertsOnGpu`, defined in the schema with tests. It sends `0` when set, otherwise `NcpuMoe`. The only useful values are "follow" and 0.
- The production preset sets `MtpExpertsOnGpu=true` and `NcpuMoe=409`.

**VRAM:**
- The MTP tail experts need 399 × 2.36 MiB ≈ 942 MiB.
- Raising `NcpuMoe` from 399 to 409 frees about 990 MiB.
- Peak headroom at 200k is about 0.6 GB.

**Expected:**
- About −3.5 ms per step from removing the CPU wait in each draft pass.
- Partly offset by fewer GPU slots per main layer (103 instead of 113).
- Sweep: 399 with the MTP layer split, 409 with MTP on GPU, 419 with MTP on GPU.

## Phase B: sync-free draft loop and promote step

**B1. Promote-step map updates (~22 syncs per step):**
- Write every `(module, router id, new value)` entry for the step into one pinned staging buffer.
- Upload it with one non-blocking copy, then apply per-device index-puts from views of that buffer.
- Expert placement and output are unchanged.

**B2. Embedding round trip (2 syncs per draft pass):**
- Page-lock and map the host embedding table.
- Gather the rows for the drafted ids, which are on the GPU, with a small zero-copy kernel: one ~4 KB row over PCIe, no sync, no extra VRAM.
- Tables that can't be page-locked keep the current path; the choice is logged once at load.
- Output is identical.

**B3. Draft-confidence early stop (1 sync per draft pass):**
- Copy each draft step's confidence to pinned memory asynchronously and record an event.
- Decide whether to stop one step later.
- If the previous step should have been the last, drop the extra draft before verify.
- Cost: at most one wasted draft forward on rounds that stop early. The drafts actually verified, and the output, are unchanged.

**Out of scope:** the ~4 once-per-step syncs at step end (accept/sampling, the ngram `row_table._stage` event, `generator.py:1932`).

## Phase C: graph-captured MTP draft pass

**What already exists:** EXL3 captures individual blocks as native graphs:
- the attention block (`bc_attn_step`, `attn.py:956`)
- sparse MLP, gated-delta and MLP slots (`exllamav3_ext/graph.cu`)

The gaps between those graphs (embedding, norms and fc, head, sampling, Python dispatch) are still host-bound.

**C0. Gate before building:**
- After A and B, rerun nsys.
- If the draft loop's host-bound time is under 1 ms per step, skip Phase C and record the numbers.
- Also check one technical unknown: can an existing native graph be launched inside an outer torch capture on CUDA 13.2?
  - If yes, the block graphs become child nodes.
  - If no, the block graphs run as their eager kernels during the outer capture (fixed shape, so they capture fine).

**C1. Capture:**
- One `torch.cuda.CUDAGraph` per MTP head, for the fixed shape (1 row, 1 token), covering token id to (draft id, confidence).
- Static inputs are the id, position, `cache_seqlens` and block table. Before each replay they are refreshed from pinned memory with non-blocking copies.
- Draft sampling must run on the GPU. Greedy argmax plus confidence is graph-safe. A random draft sampler would need a registered generator; if the draft sampler is greedy, that is not built.
- The B3 lagged stop stays outside the graph, with one replay per draft step.
- The graph is captured lazily on the first eligible draft step after warmup.
- Ineligible passes (shape, dtype, cache type, `sim_kvq`) take the eager path; this is logged once.
- The graph is recaptured if a cache or buffer address changes. With Phase A the MTP experts are fixed on the GPU, so this isn't expected during decode.

## Testing

**Unit tests (TDD):**
- Phase A: the MTP split override applies only to the MTP component, and `None` keeps today's behaviour.
- Phase A, SiftKit: the `MtpExpertsOnGpu` schema and that it is passed through.
- B1: the staged update leaves the same maps as the per-module path.
- B2: the zero-copy gather equals the CPU lookup.
- B3: the lagged stop gives the same draft window as the immediate stop.
- C: a graph replay gives the same logits as the eager pass, within fp16 tolerance.

**End-to-end:** a greedy run of 600 tokens on a fixed prompt produces identical text with each phase on and off.

**Integrity:**
- prod-verify (arena) stays at 0 failures.
- syncprof is re-counted after B and should drop by about 22 plus 3 × drafts per step.

## Measurement and gates

- Run A B B A for each phase against the previous state, on the groxaxo 3.50 HQ preset at 200k with the same `ctx-trial` prompts.
- Record decode tok/s, plus draft-loop ms per step and draft-pass CPU wait (nsys, `passes.py`/`gapkinds.py`).
- Keep a phase only if decode beats run-to-run noise by at least 3% and output is identical. Otherwise revert it, as with the adaptive tier.
- Each phase sits behind an env flag until it passes. Then the flag is removed and the new path becomes the only one.

## Delivery

- Local branch on top of `production-dev-20261029b`, built and promoted with the SiftKit wheel scripts.
- Nothing is committed, pushed or opened as a PR without the user's go-ahead.
- Phase A (`draft_moe_cpu_split`), and possibly B1, are candidates for upstream PRs; ask before opening any.
