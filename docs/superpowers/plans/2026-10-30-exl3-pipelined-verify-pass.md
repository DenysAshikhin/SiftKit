# EXL3 Pipelined Verify Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the graph-captured verify pass into G row groups interleaved layer by layer so the CPU-expert worker always has the next group's job queued while the GPU computes, turning the serial GPU→CPU→GPU chain into a CPU-bound pipeline (spec: `docs/superpowers/specs/2026-10-30-exl3-pipelined-verify-pass-design.md`).

**Architecture:** `TransformerBlock` and `BlockSparseMLP` get `forward_issue`/`forward_combine` halves (`forward` = combine(issue)). `Model.forward_pipelined(input_ids, params, groups, streams=None)` runs the pre-block modules on the full batch, then the lagged schedule `issue(g, L+1)` right after `combine(g, L)` per group on one stream (variant A/C) or one stream per group with events (variant B), concatenates the groups before the final mixer and head. GDN groups after the first stage their scan inputs at an offset and continue scratch→scratch with the conv kernel's incremental mode; PLE groups after the first read the previous group's trailing conv columns and write at an offset. `GraphPass` captures the pipelined forward when `EXL3_GRAPH_GROUPS > 1`.

**Tech Stack:** Python/PyTorch (exllamav3 at `C:\AI\exl3\dev-20261011\src`, branch `exp/graph-pass`), CUDA/C++ extension (in-place build `C:\tmp\exl3-match\build-inplace.cmd`, ~5 min), pytest (`C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest -q -p no:cacheprovider`, run from the repo root with the in-place `.pyd`). Implementation by headless `claude -p --model claude-opus-5-5` (Read/Edit/Write/Grep/Glob only); the primary agent builds, runs tests, and commits. The e2e drivers live in `C:\tmp\exl3-match` (`e2e.py`, `e2e_check.py`, `e2e_nan.py`, `e2e_prof2.py`); the stack on :4765/:8098 must be stopped for any GPU run (`taskkill //PID <node start-dev.ts> //T //F`) and restarted afterwards with a clean environment (`env -u PYTHONPATH ... powershell -NoProfile -Command "Start-Process -FilePath node -ArgumentList '.\scripts\start-dev.ts' -WorkingDirectory 'C:\Users\denys\Documents\GitHub\SiftKit' -WindowStyle Minimized"`).

---

## File structure

| File | Responsibility in this plan |
|---|---|
| `exllamav3/modules/module.py` | Default `forward_issue` (= forward) / `forward_combine` (identity) on `Module`. |
| `exllamav3/modules/transformer.py` | `TransformerBlock.forward_issue` / `forward_combine`; `forward` = combine(issue). |
| `exllamav3/modules/block_sparse_mlp.py` | `BlockSparseMLP.forward_issue` / `forward_combine` around `cpu_split_combine`. |
| `exllamav3/modules/gated_delta_net.py` | `GDNLayerState.staged_views(bsz, seqlen, offset)`; continuation (`recurrent_spec_cont`, `recurrent_spec_offset`) through the torch and BC paths. |
| `exllamav3/exllamav3_ext/libtorch/gated_delta_net.{h,cpp}`, `gated_delta_net_bc.h` | `incremental` continuation slots in `BC_GatedDeltaNetSplit` (third slot table, conv kernel incremental mode). |
| `exllamav3/cache/recurrent_util.py` | `recurrent_spec_cont`: scan input rows = scratch rows. |
| `exllamav3/modules/ple.py` | Continuation groups: conv state from the trailing columns, history writes at an offset. |
| `exllamav3/model/model_ls.py` | `Model.forward_pipelined` driver (groups, optional streams). |
| `exllamav3/generator/graph_pass.py` | `EXL3_GRAPH_GROUPS` / `EXL3_GRAPH_STREAMS`, per-group pinned `cache_seqlens`, graph key, capture of the pipelined forward. |
| `exllamav3/exllamav3_ext/routing.cu`, `cpu/moe_handoff.{h,cu}`, `model/moe_cpu_host.py` | Variant B: ring entries claimed atomically, worker waits on per-entry tags. |
| Tests | `tests/kernels/recurrent/test_causal_conv1d_update_cuda.py` (incremental multi-token), `tests/kernels/recurrent/test_gated_delta_rule.py` (scratch→scratch continuation), `tests/kernels/ple/test_ple_kernels.py` (segment continuation), `tests/modules/test_issue_combine.py` (new), `tests/generator/test_pipelined_pass.py` (new, model-gated), `tests/kernels/moe/test_moe_split.py` (ring tags). |

Facts the implementer needs (all on the branch today):
- `Model.forward` (model.py:~300) = `prepare_inputs` → prefetch layers → `forward_ls` (model_ls.py:488, calls `h.begin_pass()` on every CPU-MoE host, loops `self.fwd_modules` as `(module, instance, idx)`, sets `params["layer_instance"]`, `params["resid_defer"]`, pops `resid_pending`) → `advance_recurrent_states`.
- Module order for Qwen3.8-Flash-Next (architecture/qwen4_exp.py:233-303): `Embedding`, `ExpandStreams`, then per layer an optional `PLELayer` followed by a `TransformerBlock`, then `GatedResidual` (final mixer), `Linear` lm_head (`model.logit_layer_idx`).
- `TransformerBlock.forward` (transformer.py) = input norm (with `resid_pending` fusion) → attn → attn residual / hyper-connection → MLP norm → `self.mlp.forward(y, params)` → MLP residual / hc / `resid_defer` → export_state append → layer scalar → `to2`.
- `BlockSparseMLP.forward` (block_sparse_mlp.py:1047) = routing → `cpu_split_submit` (returns `cpu_partial, cpu_pending`) → resident path (`bc.run_bszN` for decode) → shared experts (`shared_hidden_states`) → `cpu_split_combine(final_hidden_states, cpu_partial, cpu_pending, eshape)` → latent_out → TP/post norms → shared-expert merge → output reduction → dtype.
- GDN speculative pass: `GDNLayerState.staged_views(bsz, seqlen)` (gated_delta_net.py:402) stages rows [0, bsz*seqlen) and records `spec_shape = (bsz, seqlen, 1)`; `prepare_for_recurrence` (recurrent_util.py) sets `recurrent_slots` (conv rings), `recurrent_slots_scan` (scratch rows), `recurrent_slots_scan_in` (base rows); `recurrent_spec_step` is the one-token continuation (no `scan_in`, conv `incremental=True`, token-major staging). The CUDA conv kernel's INCREMENTAL mode (gdn.cu:1556) reads the window from the ring's tail, shifts the row left by `seqlen` and appends, for any `seqlen`. `BC_GatedDeltaNetSplit` (libtorch/gated_delta_net.{h,cpp}) keys slots by `(bsz, seqlen, history)` in `slots`/`slots_hist`, calls `cuda_causal_conv1d_update_gr(..., history, graph)` with the default `incremental=false`, and patches `slots_in` into the captured graph when `history`.
- PLE speculative pass (ple.py:650-666): input conv state `cs = conv_state[s, :, :win]`; with `save_history` the stream is written `conv_state[s, :, -w:]` (w = min(len, stream width)) and the ids `id_state[s, -wi:]` (host tensor; a captured pass does not replay this write, `GraphPass._record_ple_ids` books it). `params["ple_emb"]` (rows for the whole window, gathered by `PLELayer.lookup_rows`) replaces the embedding lookup.
- Attention reads `cache_seqlens`/`positions` from params through `get_for_device` (uploads a host tensor once per params dict, keyed by tensor identity); the QSA indexer also reads the HOST `cache_seqlens` (`get_for_device(params, "cache_seqlens", "cpu")`), so per-group `cache_seqlens` must stay host (pinned) tensors.
- `GraphPass._capture` (graph_pass.py:~300) body: `p = dict(params); p["dev_cache"] = dict(arena_cache); ... logits = self.model.forward(input_ids = batch_ids, params = p)`; `run_verify` refills pinned inputs (randoms, stop ids, host embedding, PLE rows) before `graph.replay()`.
- CPU-MoE handoff: `submit_issue_fused` takes `k = self.pass_jobs` (host order), slot `k % num_slots` (`num_slots` = `EXL3_MOE_CPU_SLOTS`, default 4); the issue kernel (routing.cu:1270-1290) reads `jobs_tail`, writes `ring[tail % MOE_JOB_RING]`, bumps `jobs_tail`, publishes `data_ready`; the worker (cpu/moe_handoff.cu:414-426) spins on `jobs_tail != head` and takes `jobs[head % MOE_JOB_RING]`.

---

### Task 1: issue/combine halves on Module, TransformerBlock and BlockSparseMLP

**Files:**
- Modify: `exllamav3/modules/module.py` (class `Module`)
- Modify: `exllamav3/modules/transformer.py` (`TransformerBlock.forward`)
- Modify: `exllamav3/modules/block_sparse_mlp.py` (`BlockSparseMLP.forward`, lines ~1047-1690)
- Test: `tests/modules/test_issue_combine.py` (new; create `tests/modules/__init__.py` empty if the directory is new)

- [ ] **Step 1: Write the failing test**

```python
"""
Module.forward_issue / forward_combine: the default split is (full forward, identity), and every module class with
its own split must satisfy forward(x, p) == forward_combine(forward_issue(x, p), p). Checked structurally here
(no model); the model-level equivalence is tests/generator/test_pipelined_pass.py.
"""
import pytest
import torch

from exllamav3.modules.module import Module
from exllamav3.modules.transformer import TransformerBlock
from exllamav3.modules.block_sparse_mlp import BlockSparseMLP


class _Plain(Module):
    def __init__(self):
        Module.__init__(self, config = None, key = "plain", qmap = None)
        self.device = "cpu"

    def forward(self, x, params, out_dtype = None):
        return x * 2


@pytest.mark.nogpu
def test_default_split_is_forward_then_identity():
    m = _Plain()
    x = torch.ones(3)
    pending = m.forward_issue(x, {})
    assert torch.equal(pending, x * 2)
    assert m.forward_combine(pending, {}) is pending


@pytest.mark.nogpu
def test_split_classes_define_both_halves():
    for cls in (TransformerBlock, BlockSparseMLP):
        assert cls.forward_issue is not Module.forward_issue
        assert cls.forward_combine is not Module.forward_combine
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest -q -p no:cacheprovider tests/modules/test_issue_combine.py`
Expected: FAIL with `AttributeError: ... has no attribute 'forward_issue'`

- [ ] **Step 3: Default halves on Module**

In `exllamav3/modules/module.py`, inside `class Module`, after `forward` (keep the signature style of the file):

```python
    def forward_issue(self, x: torch.Tensor, params: dict, out_dtype: torch.dtype | None = None):
        """First half of a split forward (Model.forward_pipelined): modules without a CPU-expert handoff run whole
        here and hand their output through as the pending record"""
        return self.forward(x, params, out_dtype = out_dtype)

    def forward_combine(self, pending, params: dict):
        """Second half of a split forward: the default has nothing left to do"""
        return pending
```

(If `Module.forward` does not take `out_dtype`, drop that parameter from `forward_issue` and the call.)

- [ ] **Step 4: Split BlockSparseMLP.forward**

Rename the existing `forward` body into `forward_issue` up to and including the shared-experts line, returning a pending tuple, and move the rest into `forward_combine`. Exact cut: everything from the start of `forward` through

```python
        shared_hidden_states = None
        if cpu_pending is not None and bsz <= MAX_BSZN and self.shared_experts and not bc_sh_exp:
            shared_hidden_states = self.shared_experts.forward(x, params)
```

stays in `forward_issue`, which then ends with

```python
        return (x, bsz, eshape, final_hidden_states, cpu_partial, cpu_pending, shared_hidden_states, bc_sh_exp, out_dtype)
```

`forward_combine` starts with

```python
    def forward_combine(self, pending, params: dict):
        x, bsz, eshape, final_hidden_states, cpu_partial, cpu_pending, shared_hidden_states, bc_sh_exp, out_dtype = pending
        # CPU tail partial folds in before the post norms (nonlinear: they must see the
        # complete routed sum)
        final_hidden_states = self.cpu_split_combine(final_hidden_states, cpu_partial, cpu_pending, eshape)
```

followed, unchanged, by the latent projection, `pre_norm_reduce`, routed post norm, shared-expert merge, output reduction and the final dtype conversion/return. Every local the tail used (`x`, `bsz`, `eshape`, `bc_sh_exp`, `shared_hidden_states`, `out_dtype`) comes from the tuple; check the tail for any other local (e.g. `y` is reassigned inside the tail from `shared_hidden_states`, that is fine). Then:

```python
    def forward(self, x: torch.Tensor, params: dict, out_dtype: torch.dtype | None = None) -> torch.Tensor:
        return self.forward_combine(self.forward_issue(x, params, out_dtype), params)
```

Early-return branches inside the old forward that returned before the combine (e.g. `cpu_offload` whole-layer path, calibration capture, `autosplit_measure`) must keep returning a finished tensor: make `forward_issue` return `("done", tensor)` for them and have `forward_combine` start with `if isinstance(pending, tuple) and pending[0] == "done": return pending[1]`. Read the whole function to find them.

- [ ] **Step 5: Split TransformerBlock.forward**

`forward_issue(self, x, params, out_dtype=None)`: the current body through the MLP norm, then `mlp_pending = self.mlp.forward_issue(y, params)` instead of `y = self.mlp.forward(y, params)`, returning

```python
        return (x, mlp_pending, hc_post, hc_comb, export_state, out_dtype)
```

where `hc_post`/`hc_comb` are the MLP hyper-connection handles (`None` when `self.mlp_hc` is None). Blocks without an MLP (`self.mlp` is None) return `("done", to2(x, out_dtype, self.out_dtype))` after running the export/layer-scalar tail themselves (reuse the tail by calling `self._finish(x, None, ...)`, see below).

`forward_combine(self, pending, params)`:

```python
    def forward_combine(self, pending, params: dict):
        if pending[0] == "done":
            return pending[1]
        x, mlp_pending, hc_post, hc_comb, export_state, out_dtype = pending
        y = self.mlp.forward_combine(mlp_pending, params)
        if self.mlp_resid_scalar is not None:
            y *= self.mlp_resid_scalar
        if self.mlp_hc:
            x = self.mlp_hc.apply_(x, y, hc_post, hc_comb, params)
        elif self.mlp_post_norm:
            self.mlp_post_norm.forward(y, params, residual = x)
        elif (
            params.get("resid_defer") and not export_state and self.layer_scalar_f is None and
            (out_dtype or self.out_dtype) in (None, x.dtype)
        ):
            params["resid_pending"] = y
            return x
        else:
            x += y
        return self._finish(x, export_state, params, out_dtype)
```

with `_finish` holding today's export-state append, `layer_scalar_f` multiply and `to2` (moved verbatim from the end of `forward`). The `prefill` early return (`if params.get("prefill") and not export_state: return x`) inside the attention part becomes `return ("done", x)` in `forward_issue`. Then `forward` = `self.forward_combine(self.forward_issue(x, params, out_dtype), params)`.

- [ ] **Step 6: Run the test and the existing suites that exercise these forwards**

Run: `python -m pytest -q -p no:cacheprovider tests/modules/test_issue_combine.py tests/kernels/moe tests/moe_cpu -x -q`
Expected: the new tests pass; the MoE suites show only the known pre-existing failures (`test_shm_capacity` x2, `test_split_defer_guard[None-True]`, `test_swap_sweep_inference_mode`).

- [ ] **Step 7: Commit (primary agent)**

```bash
git add exllamav3/modules/module.py exllamav3/modules/transformer.py exllamav3/modules/block_sparse_mlp.py tests/modules
git commit -m "modules: TransformerBlock and BlockSparseMLP forwards split into issue and combine halves"
```

---

### Task 2: GDN continuation groups (staging offset, scratch→scratch scan, incremental conv) incl. the BC slot

**Files:**
- Modify: `exllamav3/modules/gated_delta_net.py` (`GDNLayerState.staged_views`, module `forward` decode path ~1267-1500, `_bc_configure_slot`, `_bc_configure_slot_kda`)
- Modify: `exllamav3/cache/recurrent_util.py` (`prepare_for_recurrence`)
- Modify: `exllamav3/exllamav3_ext/libtorch/gated_delta_net.h`, `gated_delta_net.cpp`, `gated_delta_net_bc.h`
- Test: `tests/kernels/recurrent/test_causal_conv1d_update_cuda.py`, `tests/kernels/recurrent/test_gated_delta_rule.py`

- [ ] **Step 1: Failing kernel tests**

Append to `tests/kernels/recurrent/test_causal_conv1d_update_cuda.py` (reuse its `reference`, fixtures and `assert_conv_out`):

```python
@pytest.mark.parametrize("a, b", [(2, 2), (3, 1), (1, 4)])
@torch.inference_mode()
def test_incremental_continuation_matches_one_history_pass(device, a, b):
    """A history pass of a tokens followed by an incremental pass of b tokens leaves the ring's tail and the
    outputs exactly as one history pass of a + b tokens (the pipelined verify pass's second row group)"""
    dim, K, state_size = 64, 4, 12
    g = torch.Generator().manual_seed(a * 10 + b)
    weight = torch.randn((dim, K), generator = g).bfloat16().to(device)
    x = torch.randn((1, dim, a + b), generator = g).bfloat16().to(device)
    state0 = torch.randn((1, dim, state_size), generator = g).bfloat16().to(device)
    slots = torch.zeros((1,), dtype = torch.int32, device = device)
    # one pass
    ref_state = state0.clone()
    ref_out = torch.empty((1, a + b, dim), dtype = torch.bfloat16, device = device)
    ext.cuda_causal_conv1d_update(x, ref_state, slots, weight, None, ref_out, True, True)
    # a then b (incremental)
    st = state0.clone()
    out_a = torch.empty((1, a, dim), dtype = torch.bfloat16, device = device)
    out_b = torch.empty((1, b, dim), dtype = torch.bfloat16, device = device)
    ext.cuda_causal_conv1d_update(x[:, :, :a].contiguous(), st, slots, weight, None, out_a, True, True)
    ext.cuda_causal_conv1d_update(x[:, :, a:].contiguous(), st, slots, weight, None, out_b, True, True, True)
    torch.cuda.synchronize(device)
    assert torch.equal(torch.cat([out_a, out_b], dim = 1), ref_out)
    n = min(state_size, K + a + b)
    assert torch.equal(st[:, :, -n:], ref_state[:, :, -n:])
```

Append to `tests/kernels/recurrent/test_gated_delta_rule.py`, following that file's way of calling the recurrent kernel with `slots`/`slots_in` (read it first and use its helper for building inputs):

```python
@pytest.mark.parametrize("a, b", [(2, 2), (3, 1)])
@torch.inference_mode()
def test_scan_scratch_continuation(device, a, b):
    """Scan a tokens base->scratch, then b tokens scratch->scratch in place: the scratch row equals one scan of
    a + b tokens base->scratch, and the per-token outputs match"""
    # build mixed_qkv (1, a+b, ...), g, beta as the file's other tests do; state pool with rows 0 (base), 1 (scratch)
    ...
    # single pass: slots_scan = [1], slots_in = [0]
    # split: first a tokens with slots_scan = [1], slots_in = [0]; then b tokens with slots_scan = [1], slots_in = [1]
    assert torch.equal(out_split, out_single)
    assert torch.equal(state_split[1], state_single[1])
```

Fill the `...` with the same construction the file's existing `slots_in` test uses (search for `slots_in` in that file); the only new thing is the second call with `slots_in = slots_scan`.

- [ ] **Step 2: Run the tests to verify they fail or pass**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/recurrent/test_causal_conv1d_update_cuda.py tests/kernels/recurrent/test_gated_delta_rule.py -k "continuation"`
Expected: both PASS already (the kernels support these modes); if either fails, that is a kernel bug to report before continuing (do not change the kernels). Keep the tests as the contract.

- [ ] **Step 3: Staging offset on `GDNLayerState.staged_views`**

```python
    def staged_views(self, bsz: int, seqlen: int, offset: int = 0):
        """The (bsz, seqlen, ...) conv output, beta and g buffers a speculative pass of that shape writes its scan
        inputs into (contiguous views over the staging rows), and the record of that shape for the rewind. A
        continuation group of a pipelined pass (bsz 1) stages at `offset` rows after the groups before it; the
        recorded shape then spans the whole pass"""
        assert offset == 0 or bsz == 1, "staged offset needs a single sequence"
        assert offset + seqlen <= self.max_history + 1 and bsz <= self.max_batch_size, \
            f"speculative pass of {offset + seqlen} tokens x {bsz} rows exceeds the cache's max_history {self.max_history} / max_batch_size {self.max_batch_size}"
        n = bsz * seqlen
        self.spec_shape = (bsz, offset + seqlen, 1)
        a = offset
        return (
            self.spec_conv[a:a + n].view(bsz, seqlen, -1),
            self.spec_beta[a:a + n].view(bsz, seqlen, -1),
            self.spec_g[a:a + n].view(bsz, seqlen, -1),
        )
```

Apply the same `offset` parameter to `Mamba2LayerState.staged_views` if that class has one with the same body (grep `def staged_views`); otherwise leave Mamba2 alone.

- [ ] **Step 4: `prepare_for_recurrence`: continuation groups read the scratch row**

In `exllamav3/cache/recurrent_util.py`, in the `if history:` block:

```python
        if history:
            scratch = _get_slot_tensor(tuple(2 * r.slot + 1 - getattr(r, "parity", 0) for r in rs))
            params["recurrent_slots_scan"] = scratch
            if step:
                params.pop("recurrent_slots_scan_in", None)
            elif params.get("recurrent_spec_cont"):
                # A continuation group of a pipelined pass starts from the scratch row the groups before it wrote
                params["recurrent_slots_scan_in"] = scratch
            else:
                params["recurrent_slots_scan_in"] = _get_slot_tensor(base)
```

- [ ] **Step 5: GDN module forward: continuation through the torch path**

In `GatedDeltaNet.forward` (gated_delta_net.py ~1267):

```python
        spec_step = params.get("recurrent_spec_step") if save_history else None
        # A continuation group of a pipelined pass (Model.forward_pipelined): multi-token, row-major, continues the
        # scratch row in place and the conv ring from its tail, staged after the groups before it
        spec_cont = bool(params.get("recurrent_spec_cont")) if save_history else False
        spec_offset = int(params.get("recurrent_spec_offset", 0)) if save_history else 0
        scan_history = save_history and not spec_step
```

`stage()` becomes:

```python
        def stage(bsz, seqlen):
            if spec_step is not None:
                return rsl.staged_step_views(bsz, spec_step)
            return rsl.staged_views(bsz, seqlen, spec_offset)
```

In the `causal_conv1d_update(...)` call: `incremental = bool(spec_step) or spec_cont`. The scan call already takes `slots_in = slots_scan_in` (now the scratch rows for a continuation group from Task 2 step 4) and `history = scan_history` (still True). In the `else` branch that clears the recurrence variables (`rsl = None`), also set `spec_cont = False; spec_offset = 0`.

- [ ] **Step 6: BC fused path: `incremental` continuation slots (C++)**

`exllamav3/exllamav3_ext/libtorch/gated_delta_net.h`, class `BC_GatedDeltaNetSplit`:
- add `std::vector<Slot> slots_cont;   // history == true, incremental conv (continuation groups)` next to `slots_hist`, resized in both constructors like `slots_hist`;
- `Slot& slot(int bsz, int seqlen, bool history, bool incremental = false)` selects `slots_cont` when `incremental` (requires `history`);
- `needs_configure(int bsz, int seqlen, bool history, int64_t stage_key = 0, bool incremental = false)`, `set_stage_key(..., bool incremental = false)`, `configure_slot(..., bool incremental = false)` (last parameter), `configure_slot_kda` likewise, `run_bszN_gr(..., Slot& s, Graph* graph, bool incremental)` and `run_bszN(..., const c10::optional<at::Tensor>& slots_in, bool incremental = false)`.

`gated_delta_net.cpp`: thread `incremental` through: `needs_configure`/`configure_slot*`/`run_bszN` look the slot up with it; `run_bszN_gr` passes it to `cuda_causal_conv1d_update_gr(s.mixed_qkv, conv_state, slots, conv1d_weight, conv1d_bias, s.conv_out, true, history, graph, incremental)`; `run_bszN` forwards it on all three `run_bszN_gr` calls. `TORCH_CHECK(!incremental || history, "BC_GatedDeltaNetSplit: incremental slots are history slots")` in `run_bszN` and `configure_slot`.

`gated_delta_net_bc.h`: add `py::arg("incremental") = false` as the last argument of `needs_configure`, `set_stage_key` (give it explicit `py::arg`s), `configure_slot`, `configure_slot_kda`, `run_bszN` for `BC_GatedDeltaNetSplit`. Leave `BC_Mamba2` unchanged.

- [ ] **Step 7: BC fused path: Python side**

`_bc_configure_slot(self, bsz, seqlen, history, rsl = None, offset = 0, incremental = False)`: `conv_out, beta, g = rsl.staged_views(bsz, seqlen, offset)` when `history`; pass `incremental` to `self.bc.configure_slot(...)` and `self.bc.set_stage_key(bsz, seqlen, True, id(rsl) * 64 + offset, incremental)`. Same for `_bc_configure_slot_kda`. In `forward`, the BC branch condition keeps `not spec_step` (a continuation group is allowed), and:

```python
            stage_key = (id(rsl) * 64 + spec_offset) if save_history else 0
            if self.bc.needs_configure(bsz, seqlen, save_history, stage_key, spec_cont):
                if self.kda:
                    self._bc_configure_slot_kda(bsz, seqlen, save_history, rsl, spec_offset, spec_cont)
                else:
                    self._bc_configure_slot(bsz, seqlen, save_history, rsl, spec_offset, spec_cont)
            if save_history:
                stage(bsz, seqlen)
            y = torch.empty_like(x, dtype = self.out_dtype or torch.half)
            self.bc.run_bszN(x, y, conv_state, recurrent_state, recurrent_slots, slots_scan, save_history, slots_scan_in, spec_cont)
```

- [ ] **Step 8: Build and run the recurrent suites (primary agent)**

Run: `cmd //c C:\tmp\exl3-match\build-inplace.cmd` then `python -m pytest -q -p no:cacheprovider tests/kernels/recurrent tests/kernels/graph`
Expected: all pass except the 6 pre-existing `test_fla_vendored` tolerance failures.

- [ ] **Step 9: Commit**

```bash
git add exllamav3/modules/gated_delta_net.py exllamav3/cache/recurrent_util.py exllamav3/exllamav3_ext/libtorch/gated_delta_net.h exllamav3/exllamav3_ext/libtorch/gated_delta_net.cpp exllamav3/exllamav3_ext/libtorch/gated_delta_net_bc.h tests/kernels/recurrent
git commit -m "gdn: continuation groups stage at an offset, scan scratch->scratch and run the conv incrementally (BC slot variant)"
```

---

### Task 3: PLE continuation groups

**Files:**
- Modify: `exllamav3/modules/ple.py` (`PLELayer.forward`, lines ~648-668)
- Test: `tests/kernels/ple/test_ple_kernels.py`

- [ ] **Step 1: Failing test**

Append to `tests/kernels/ple/test_ple_kernels.py`, using the file's existing random-input builder for `ple_forward_streams` (read the file's `test_ple_forward_streams*` tests and reuse their tensor construction and shapes):

```python
@pytest.mark.parametrize("a, b", [(2, 2), (3, 1)])
@torch.inference_mode()
def test_forward_streams_segment_continuation(device, a, b):
    """Running the window as two segments, the second fed the first's trailing conv columns, gives the same delta
    and the same trailing conv_stream columns as one call over a + b tokens"""
    # inputs for seq = a + b exactly as the single-call test builds them (streams, emb, weights, conv_state)
    ...
    delta_all = torch.empty((1, a + b, H, D), dtype = torch.float, device = device)
    stream_all = torch.empty((1, H * D, state_len + a + b), dtype = torch.half, device = device)
    ext.ple_forward_streams(streams.clone(), emb, key_w, value_w, nk, nq, nc, conv_w, cs, eps, gate_scale, dilation, delta_all, stream_all)
    s2 = streams.clone()
    delta_a = torch.empty((1, a, H, D), dtype = torch.float, device = device)
    stream_a = torch.empty((1, H * D, state_len + a), dtype = torch.half, device = device)
    ext.ple_forward_streams(s2[:, :a], emb[:, :a], key_w, value_w, nk, nq, nc, conv_w, cs, eps, gate_scale, dilation, delta_a, stream_a)
    cs_b = stream_a[:, :, -state_len:].contiguous()
    delta_b = torch.empty((1, b, H, D), dtype = torch.float, device = device)
    stream_b = torch.empty((1, H * D, state_len + b), dtype = torch.half, device = device)
    ext.ple_forward_streams(s2[:, a:], emb[:, a:], key_w, value_w, nk, nq, nc, conv_w, cs_b, eps, gate_scale, dilation, delta_b, stream_b)
    torch.cuda.synchronize(device)
    assert torch.equal(torch.cat([delta_a, delta_b], dim = 1), delta_all)
    assert torch.equal(stream_b[:, :, -(state_len + b):], stream_all[:, :, -(state_len + b):])
```

(`streams[:, :a]` must be contiguous: bsz 1 slices along dim 1 are; if the kernel checks contiguity, pass `.contiguous()` and compare on copies.)

- [ ] **Step 2: Run it**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/ple/test_ple_kernels.py -k continuation`
Expected: PASS (the kernel is per-row; this pins the contract). If the deltas differ beyond bitwise, report the max difference; the plan accepts fp16-level differences only if the kernel reduces differently per call (it should not).

- [ ] **Step 3: Continuation in `PLELayer.forward`**

Replace the state handling block (from `history, rsl, slots = self._state_history(ids, params)` to the end of the `for i, s in enumerate(slots)` loop) with:

```python
        history, rsl, slots = self._state_history(ids, params)
        if rsl is not None:
            conv_state, id_state = rsl.get_state_tensors()
            # Pipelined pass (Model.forward_pipelined): a continuation group reads the trailing conv columns the
            # groups before it wrote (not the live window) and every group writes its stream `after` columns
            # before the end, so the trailing history equals one pass over the whole window
            cont = bool(params.get("recurrent_spec_cont")) and save_history
            after = int(params.get("ple_hist_after", 0)) if save_history else 0
            if win:
                if cont:
                    end = conv_state.shape[-1] - (seq + after)
                    cs = torch.stack([conv_state[s, :, end - win : end] for s in slots]).to(x.device)
                else:
                    cs = torch.stack([conv_state[s, :, :win] for s in slots]).to(x.device)
            else:
                cs = None
            delta, conv_stream = self.forward_streams(x, history, params, conv_state = cs)
            for i, s in enumerate(slots):
                if save_history:
                    if conv_stream is not None:
                        w = min(conv_state.shape[-1] - after, conv_stream.shape[-1])
                        end = conv_state.shape[-1] - after
                        conv_state[s, :, end - w : end].copy_(conv_stream[i, :, -w:])
                    wi = min(id_state.shape[-1] - after, history.shape[-1])
                    end = id_state.shape[-1] - after
                    id_state[s, end - wi : end].copy_(history[i, -wi:])
                else:
                    if conv_stream is not None:
                        conv_state[s, :, :win].copy_(conv_stream[i, :, -win:])
                    id_state[s, :ctx].copy_(history[i, -ctx:])
```

(`after = 0` and `cont = False` reproduce today's code exactly.) The history ids of a continuation group come from `_state_history`, which prepends the live `id_state[s, :ctx]`; inside a captured pass this only feeds the embedding lookup that `params["ple_emb"]` already replaces and the id write that `GraphPass._record_ple_ids` books, so it is left as is; `forward_pipelined` passes each group its `ple_emb` slice and its `input_ids` slice.

- [ ] **Step 4: Run the PLE suites**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/ple`
Expected: PASS (the injection tests skip without the stub model).

- [ ] **Step 5: Commit**

```bash
git add exllamav3/modules/ple.py tests/kernels/ple/test_ple_kernels.py
git commit -m "ple: continuation groups read the trailing conv columns and write their history at an offset"
```

---

### Task 4: `Model.forward_pipelined` and the GraphPass integration (variants A and C)

**Files:**
- Modify: `exllamav3/model/model_ls.py` (after `forward_ls`)
- Modify: `exllamav3/model/model.py` (`Model.forward` stays; add nothing but an import if needed)
- Modify: `exllamav3/generator/graph_pass.py` (`__init__`, `run_verify`, `_capture`)
- Test: `tests/generator/test_pipelined_pass.py` (new, model-gated)

- [ ] **Step 1: Failing test**

```python
"""
Model.forward_pipelined(groups) against Model.forward on the verify step of a real speculative decode: the captured
pass with EXL3_GRAPH_GROUPS=2 and =rows produces the same tokens as the single-group graph pass at a >= 97% agreement
(kernel-level accumulation differences are accepted) and never NaN. Needs EXL3_TEST_MODEL (see test_graph_pass.py).
"""
import json, os, subprocess, sys
import pytest
from .test_graph_pass import MODEL, SCRIPT   # same subprocess driver and env handling

pytestmark = pytest.mark.skipif(not MODEL, reason = "EXL3_TEST_MODEL not set")


def _run(groups: str):
    env = dict(os.environ, EXL3_GRAPH_PASS = "1", EXL3_MOE_PINNED_ARENA = "1", EXL3_GRAPH_GROUPS = groups)
    p = subprocess.run([sys.executable, "-c", SCRIPT, MODEL, os.environ.get("EXL3_TEST_MODEL_ARGS", "")],
                       env = env, capture_output = True, text = True, timeout = 1800)
    assert p.returncode == 0, p.stderr[-4000:]
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_pipelined_groups_agree_with_single_group():
    base = _run("1")
    for g in ("2", "rows"):
        r = _run(g)
        assert r["replays"] > 0
        n = min(len(base["tokens"]), len(r["tokens"]))
        agree = sum(a == b for a, b in zip(base["tokens"][:n], r["tokens"][:n])) / n
        assert n >= 250 and agree >= 0.97, (g, agree)
```

(`SCRIPT` in test_graph_pass.py prints `{"tokens", "replays", "tps"}`; import it rather than copying it.)

- [ ] **Step 2: The driver**

Add to `exllamav3/model/model_ls.py` (methods of the layer-split mixin, next to `forward_ls`; imports at the top of the file as needed: `torch`, `TransformerBlock`, `PLELayer`, `advance_recurrent_states` from `..cache.recurrent_util`):

```python
    def forward_pipelined(self, input_ids: torch.Tensor, params: dict, groups: int, streams: list | None = None):
        """
        The verify forward of one sequence as `groups` contiguous row groups interleaved layer by layer, so the
        CPU-expert worker always has the next group's job while the GPU computes (see
        docs: pipelined verify pass). Pre-block modules and the final mixer/head run on the whole batch; each
        group carries its own params (cache positions offset by the rows before it, its own deferred residuals and
        export states). With `streams` (one per group) the groups run on separate streams; group g waits for group
        g-1's writes of the same module before its own, and all join before the head.
        """
        from ..modules.transformer import TransformerBlock
        from ..modules.ple import PLELayer
        bsz, rows = input_ids.shape
        assert bsz == 1 and not self.loaded_tp, "forward_pipelined: one sequence, layer-split only"
        groups = max(1, min(groups, rows))
        x = self.prepare_inputs(input_ids, params)
        for m in self._get_prefetch_layers:
            m.prefetch(x, params)
        hosts = list(getattr(self.config, "moe_cpu_hosts", {}).values())
        for h in hosts:
            h.begin_pass()
            assert h.num_slots >= groups, "forward_pipelined: EXL3_MOE_CPU_SLOTS must cover every group in flight"
        mods = self.fwd_modules
        first = next(i for i, (m, _, _) in enumerate(mods) if isinstance(m, (TransformerBlock, PLELayer)))
        last = max(i for i, (m, _, _) in enumerate(mods) if isinstance(m, (TransformerBlock, PLELayer)))
        body = mods[first:last + 1]

        # Pre-block modules on the whole batch (embedding, stream expansion)
        for module, instance, idx in mods[:first]:
            params["layer_instance"] = instance
            x = module.prepare_for_device(x, params)
            x = module.forward(x, params)

        # Groups: contiguous row ranges, the first ceil(rows / groups) wide
        bounds = []
        a = 0
        for g in range(groups):
            b = a + (rows - a + (groups - g) - 1) // (groups - g)
            bounds.append((a, b))
            a = b
        gparams = [self._group_params(params, input_ids, s, e, rows) for s, e in bounds]
        xs = [x[:, s:e] for s, e in bounds]
        pend = [None] * groups
        cur = torch.cuda.current_stream(x.device)
        evs = [None] * groups

        def issue(g, j):
            module, instance, idx = body[j]
            p = gparams[g]
            p["layer_instance"] = instance
            nxt = body[j + 1][0] if j + 1 < len(body) else None
            p["resid_defer"] = (
                type(module) is TransformerBlock and type(nxt) is TransformerBlock and nxt.device == module.device
            )
            if streams is not None and g > 0 and evs[g - 1] is not None:
                streams[g].wait_event(evs[g - 1])          # the previous group's writes of this module
            with torch.cuda.stream(streams[g]) if streams is not None else _nullcontext():
                xg = module.prepare_for_device(xs[g], p)
                pend[g] = module.forward_issue(xg, p)
                if streams is not None:
                    evs[g] = torch.cuda.Event()
                    evs[g].record(streams[g])

        def combine(g, j):
            module = body[j][0]
            with torch.cuda.stream(streams[g]) if streams is not None else _nullcontext():
                xs[g] = module.forward_combine(pend[g], gparams[g])

        if streams is not None:
            for s in streams:
                s.wait_stream(cur)
        for g in range(groups):
            issue(g, 0)
        for j in range(len(body)):
            for g in range(groups):
                combine(g, j)
                if j + 1 < len(body):
                    issue(g, j + 1)
        for g in range(groups):
            p = gparams[g]
            p.pop("resid_defer", None)
            pending = p.pop("resid_pending", None)
            if pending is not None:
                with torch.cuda.stream(streams[g]) if streams is not None else _nullcontext():
                    xs[g] += pending
        if streams is not None:
            for s in streams:
                cur.wait_stream(s)

        x = torch.cat(xs, dim = 1)
        exp = [p.get("export_states") for p in gparams]
        if exp[0]:
            params["export_states"] = [torch.cat([e[l] for e in exp], dim = 1) for l in range(len(exp[0]))]
        for module, instance, idx in mods[last + 1:]:
            params["layer_instance"] = instance
            x = module.prepare_for_device(x, params)
            x = module.forward(x, params)
        advance_recurrent_states(input_ids, params, self)
        return x

    def _group_params(self, params: dict, input_ids: torch.Tensor, s: int, e: int, rows: int) -> dict:
        """Params of one row group: the batch's tables, positions offset by the rows before the group (pinned host
        tensors the generator refills every step, params["pipeline_seqlens"][group]), the group's ids and PLE rows,
        its own deferred residuals, hyper-connection pending and export list; GDN/PLE continuation flags"""
        p = dict(params)
        p["dev_cache"] = dict(params["dev_cache"])
        p.pop("resid_pending", None)
        p.pop("hc_pending", None)
        p.pop("export_states", None)
        p["input_ids"] = input_ids[:, s:e]
        g = (s, e)
        p["cache_seqlens"] = params["pipeline_seqlens"][g]
        p["positions"] = p["cache_seqlens"] if params.get("positions") is params.get("cache_seqlens") \
            else params["pipeline_positions"][g]
        if "ple_emb" in params:
            p["ple_emb"] = params["ple_emb"][:, s:e]
        p["recurrent_spec_cont"] = s > 0
        p["recurrent_spec_offset"] = s
        p["ple_hist_after"] = rows - e
        if s > 0:
            p["recurrent_slots_scan_in"] = params["recurrent_slots_scan"]
        return p
```

Define `_nullcontext = contextlib.nullcontext` at module level and add `advance_recurrent_states` to the `..cache.recurrent_util` import at the top of model_ls.py (`_get_prefetch_layers` is a property on `Model`, used without parentheses as in `Model.forward`). `params["pipeline_seqlens"]` / `["pipeline_positions"]` are dicts `{(s, e): pinned int32 (1,) tensor}` the generator provides (next step); a missing group is a KeyError, which is the intended loud failure.

- [ ] **Step 3: GraphPass integration**

In `exllamav3/generator/graph_pass.py`:

```python
GROUPS = os.environ.get("EXL3_GRAPH_GROUPS", "1")          # "1", "2", ... or "rows"
STREAMS = os.environ.get("EXL3_GRAPH_STREAMS", "0") != "0" # variant B: one stream per group
```

In `__init__`: `self.group_seqlens = {}` (pinned buffers keyed by `(start, end, "seq"|"pos")`), `self.group_streams = {}`.

Add:

```python
    def _groups(self, rows: int) -> int:
        g = rows if GROUPS == "rows" else int(GROUPS)
        return max(1, min(g, rows))

    def _group_bounds(self, rows: int, groups: int) -> list:
        bounds, a = [], 0
        for g in range(groups):
            b = a + (rows - a + (groups - g) - 1) // (groups - g)
            bounds.append((a, b))
            a = b
        return bounds

    def _stage_groups(self, params: dict, rows: int, groups: int):
        """Per-group cache positions as pinned host tensors (refilled every step; the captured uploads read them)"""
        seqlens, positions = params["cache_seqlens"], params.get("positions")
        ps, pp = {}, {}
        for s, e in self._group_bounds(rows, groups):
            buf = self.group_seqlens.get((s, e, "seq"))
            if buf is None:
                buf = self.group_seqlens[(s, e, "seq")] = torch.empty_like(seqlens, pin_memory = True)
            torch.add(seqlens, s, out = buf)
            ps[(s, e)] = buf
            if positions is not None and positions is not seqlens:
                pb = self.group_seqlens.get((s, e, "pos"))
                if pb is None:
                    pb = self.group_seqlens[(s, e, "pos")] = torch.empty_like(positions, pin_memory = True)
                torch.add(positions, s, out = pb)
                pp[(s, e)] = pb
        params["pipeline_seqlens"] = ps
        params["pipeline_positions"] = pp
```

In `run_verify`, after the PLE rows are staged and before `key = tuple(key)`:

```python
            groups = self._groups(rows)
            if groups > 1:
                self._stage_groups(params, rows, groups)
            key.append(groups)
```

In `_capture`'s `body()`:

```python
            groups = self._groups(rows)
            if groups > 1:
                streams = None
                if STREAMS:
                    streams = self.group_streams.get(groups)
                    if streams is None:
                        streams = self.group_streams[groups] = [torch.cuda.Stream(device = self.device) for _ in range(groups)]
                logits = self.model.forward_pipelined(batch_ids, p, groups, streams)
            else:
                logits = self.model.forward(input_ids = batch_ids, params = p)      # (1, rows, vocab)
```

The pinned group buffers are inputs the captured memcpy nodes read, so they belong in `static["keep"]` (add `list(self.group_seqlens.values())` to `keep` in `run_verify`) and their addresses in the key (`key.append(tuple(sorted((k, v.data_ptr()) for k, v in self.group_seqlens.items())))`).

- [ ] **Step 4: Build-free check, then the model test (primary agent)**

Run: `python -m pytest -q -p no:cacheprovider tests/modules tests/moe_cpu/test_promote_step.py` (import sanity), then with the stack stopped: `EXL3_TEST_MODEL=D:\personal\models\elx3\Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6 EXL3_TEST_MODEL_ARGS="-mcs 64 -mcpa -ngr" python -m pytest -q -p no:cacheprovider tests/generator/test_pipelined_pass.py`
Expected: PASS (agreement >= 0.97 for groups 2 and rows).

- [ ] **Step 5: Scratch validation (primary agent)**

With the stack stopped: `EXL3_GRAPH_GROUPS=2 python C:\tmp\exl3-match\e2e_nan.py 300 32768` (clean), `EXL3_GRAPH_GROUPS=2 python C:\tmp\exl3-match\e2e_check.py 200 32768` (reports mismatch count; expected a few percent at most, logits-level differences), then `e2e_prof2.py` and `e2e.py` for `EXL3_GRAPH_GROUPS` in `1`, `2`, `rows` at draft `3:5:1` and `1:0:0` (`E2E_DRAFT/E2E_HYBRID/E2E_DYN`), and the worker profiler (`EXL3_MOE_HANDOFF_PROF=1`) for distinct experts per job. Record step time, `v_stream_sync`, tok/s.

- [ ] **Step 6: Commit**

```bash
git add exllamav3/model/model_ls.py exllamav3/generator/graph_pass.py tests/generator/test_pipelined_pass.py
git commit -m "generator: verify pass runs as interleaved row groups (EXL3_GRAPH_GROUPS) inside the captured graph"
```

---

### Task 5: Variant B, two streams: ring entries claimed atomically, worker waits per entry

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.h` (ctrl layout), `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` (worker loop), `exllamav3/exllamav3_ext/routing.cu` (issue kernel), `exllamav3/model/moe_cpu_host.py` (ctrl mirror), `tests/testlib/moe_handoff.py`
- Test: `tests/kernels/moe/test_moe_split.py`

- [ ] **Step 1: Failing test**

Append to `tests/kernels/moe/test_moe_split.py`, modelled on `test_moe_split_issue_writes_descriptor` (same `_issue_case`, `_Slot`, `_Ring`, `flags` fixture). `_Ring` grows the tag region: its pinned block must cover `MOE_RING_TAGS_OFFSET + MOE_JOB_RING * 4` bytes, and it gets `def tag(self, i): return int(self.t[(MOE_RING_TAGS_OFFSET + (i % self.n) * 4) // 4])`.

```python
def test_moe_split_issue_two_streams_claim_distinct_entries(device, flags):
    """Two issue kernels on different streams (variant B of the pipelined pass) each claim their own ring entry
    and tag it; whichever ran first, both jobs are in the ring exactly once"""
    rows, topk, h_, hi, E, first = FLAG_CASE
    sel, y, w = _issue_case(rows, topk, h_, hi, E, first, True, 23, device)
    slots = [_Slot(rows, topk, hi, hi, True, device) for _ in range(2)]
    dev_count = torch.zeros((4,), dtype = torch.int32, device = device)
    ring = _Ring()
    ring.set_pass_base(100)
    flags.set(FLAG_WAIT, 0x7FFFFFFF if FLAG_BITS == 32 else 1 << 62)      # no tenant to wait out
    streams = [torch.cuda.Stream(device = device) for _ in range(2)]
    for k, (s, slot) in enumerate(zip(streams, slots)):
        with torch.cuda.stream(s):
            ext.moe_split_issue(sel.view(-1), None, None, y, w, slot.ptr(slot.sel), slot.ptr(slot.x), slot.ptr(slot.w),
                                dev_count, k, hi, first,
                                ring = ring.ring, jobs_tail = ring.tail, pass_base = ring.pass_base, k = k,
                                layer = 7 + k, topk = topk, data_ready = flags.addr(FLAG_POST),
                                consumed = flags.addr(FLAG_WAIT), abort_flag = flags.addr(FLAG_ABORT))
    torch.cuda.synchronize(device)
    assert ring.get_tail() == 2
    jobs = sorted((ring.job(i)["layer"], ring.job(i)["seq"]) for i in range(2))
    assert jobs == [(7, 101), (8, 102)]
    assert ring.tag(0) == 1 and ring.tag(1) == 1        # first lap
```

(If the issue kernel waits out the slot's previous tenant through `consumed`, check how `test_moe_split_issue_writes_descriptor` satisfies that wait and do the same; `_held`/`flags` in that file show the pattern.) Existing descriptor tests gain `assert ring.tag(<index>) == <lap>` where they check `job(...)`.

- [ ] **Step 2: Ring tags**

`moe_handoff.h`: add `#define MOE_RING_TAGS_OFFSET <next free offset in the ctrl block>` holding `MOE_JOB_RING` `uint32_t` tags (grow `MOE_CTRL_SIZE` if needed, and mirror the constant in `moe_cpu_host.py` and `tests/testlib/moe_handoff.py`). Tag value for ring index `i` = `i / MOE_JOB_RING + 1` (lap number), written after the descriptor.

`routing.cu` issue kernel, thread 0:

```cuda
        if (ring)
        {
            // Claim the entry atomically (groups of a pipelined pass may issue from different streams), write the
            // descriptor, then tag it: the worker takes entries in index order as their tags appear
            const uint32_t idx = atomicAdd_system(jobs_tail, 1u);
            MoeJob* job = ring + (idx % MOE_JOB_RING);
            job->seq = (uint32_t) s_seq; job->seq_hi = 0; job->layer = (uint32_t) layer; job->rows = (uint32_t) rows;
            job->topk = (uint32_t) topk; job->slot = (uint32_t) slot_idx; job->kind = MOE_JOB_KIND_COMPUTE_GATED;
            __threadfence_system();
            stg_release_sys_u32(ring_tags + (idx % MOE_JOB_RING), idx / MOE_JOB_RING + 1u);
        }
```

(`ring_tags` = `reinterpret_cast<uint32_t*>(ctrl + MOE_RING_TAGS_OFFSET)`, derived from `ring` and the layout; pass it as one more kernel argument from the launcher, which computes it from the ring pointer.)

`moe_handoff.cu` worker loop: replace the `jobs_tail != head` poll with a tag poll:

```cpp
        if (load_acquire_u32(ring_tags + (head % MOE_JOB_RING)) != head / MOE_JOB_RING + 1u)
        {
            if (++idle < 65536) { cpu_pause_(); continue; }
            std::this_thread::sleep_for(std::chrono::microseconds(50));
            continue;
        }
```

`jobs_tail` keeps counting claims (host diagnostics and the stage ring are unchanged). The host-written stage path (ROCm / prefill descriptors written by the host) must also write the tag after its descriptor: find every host-side ring write in `moe_cpu_host.py` (`v_jobs_tail`, `MOE_CTRL_JOBS_OFFSET`) and tag the entry it writes the same way. The worker's startup reads `head = jobs_head`; tags of a fresh ctrl block are zero, so the first lap's tag is 1.

- [ ] **Step 3: Build and run the handoff suites (primary agent)**

Run: build, then `python -m pytest -q -p no:cacheprovider tests/kernels/moe tests/moe_cpu/test_graph_handoff.py tests/kernels/moe_cpu_host`
Expected: PASS (plus the known moe_cpu failures if that directory is included).

- [ ] **Step 4: Benchmark variant B (primary agent)**

`EXL3_GRAPH_STREAMS=1 EXL3_GRAPH_GROUPS=2` through `e2e_nan.py`, `e2e_prof2.py`, `e2e.py` at both draft settings; compare against Task 4's numbers.

- [ ] **Step 5: Commit**

```bash
git add exllamav3/exllamav3_ext/cpu/moe_handoff.h exllamav3/exllamav3_ext/cpu/moe_handoff.cu exllamav3/exllamav3_ext/routing.cu exllamav3/model/moe_cpu_host.py tests/testlib/moe_handoff.py tests/kernels/moe/test_moe_split.py
git commit -m "moe_cpu: ring entries claimed atomically and tagged, so issue kernels may run on several streams"
```

---

### Task 6: Validation and write-up (primary agent)

- [ ] **Step 1: Suites**: `python -m pytest -q -p no:cacheprovider tests/modules tests/kernels/moe tests/moe_cpu tests/kernels/moe_cpu_host tests/kernels/sampling tests/kernels/recurrent tests/kernels/draft tests/kernels/ple tests/kernels/graph tests/kernels/attention` — only the known failures.
- [ ] **Step 2: Benchmark matrix** (300 tokens, 32k): `EXL3_GRAPH_GROUPS` in {1, 2, rows} x draft {3:5:1, 1:0:0} x `EXL3_GRAPH_STREAMS` {0, 1}; steady-state step, `v_stream_sync`, tok/s, worker distinct experts/job. Success: at 3:5:1, groups 2 gives `v_stream_sync` <= 22 ms and >= 15% tok/s over groups 1.
- [ ] **Step 3: Harness** on the best configuration: ctx-trial short/24k/64k, prefill >= 1.5k, KLD spot check at 24k.
- [ ] **Step 4: Doc**: add a "Pipelined verify pass" section to `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` with the matrix, the byte increase, and the per-step budget after the change.

---

## Self-review

- Spec coverage: architecture/driver (Task 4), issue/combine halves (Task 1), GDN continuation incl. BC slot (Task 2), PLE continuation (Task 3), handoff order (Task 4 assert; Task 5 for streams), variant B (Task 5), outputs concatenated and `export_states` merged (Task 4), error handling asserts (Task 4), testing and benchmark matrix (Tasks 1-6).
- Placeholders: Task 2 step 1's scan test and Task 3 step 1's input construction defer to the existing tests in the same files for tensor construction (named: the `slots_in` test in test_gated_delta_rule.py, the single-call `ple_forward_streams` test); the implementer copies those lines. No other open ends.
- Names used consistently: `forward_issue`/`forward_combine`, `recurrent_spec_cont`, `recurrent_spec_offset`, `ple_hist_after`, `pipeline_seqlens`/`pipeline_positions` (dicts keyed `(start, end)`), `staged_views(bsz, seqlen, offset)`, `run_bszN(..., incremental)`, `EXL3_GRAPH_GROUPS`, `EXL3_GRAPH_STREAMS`, `MOE_RING_TAGS_OFFSET`.
