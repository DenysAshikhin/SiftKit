# EXL3 Draft Loop B2 (Sparse Draft Head) and B3 (Lagged Early Stop) Implementation Plan

> **Status (2026-10-29):** Tasks 1-3 done and committed: TabbyAPI `exp/sparse-draft-head` (aa9e22f), exllamav3 `exp/b3-lagged-draft-stop` (69757cc3, 21 new tests pass), plus exllamav3 `exp/draft-loop-all` (B1 + B3 merged; 123 passed + the 4 pre-existing failures). Model tests and measurement wait for the GPU: `bash /c/tmp/exl3-match/phase-abba.sh "base b2 b2 base"`, `"base b3 b3 base"`, `"base all all base"`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare B2 and B3 on separate local branches, each with tests, so they can be swapped in and measured later.
- **B2** removes the per-draft-pass embedding round trip.
- **B3** removes the per-draft-pass confidence readback sync.

**Architecture:**
- **B2:** exllamav3 already has the mechanism. `Generator(sparse_draft_head = N)` drafts through a dynamic sparse LM head of N vocabulary columns. For MTP it mirrors the subset's embedding rows on the GPU and hands the drafted token's row back, so the drafting loop never sends ids to the CPU-resident embedding table.
  - It also skips the full-vocabulary projection in every draft pass.
  - Verification keeps the full head, and upstream's e2e test (`tests/e2e/test_speculative.py::test_sparse_head_drafting_is_lossless`) asserts lossless drafting.
  - Production doesn't use it because TabbyAPI never passes the argument. B2 is therefore a TabbyAPI option, `sparse_draft_head`, with no exllamav3 change. The design's zero-copy gather kernel isn't needed.
- **B3:** a `LaggedDraftStop` helper in `exllamav3/generator/draft_confidence.py`.
  - It copies each draft step's confidence to pinned memory with a non-blocking copy, and decides the stop from the previous step's value. That one has finished on the GPU by then, while this step's work is already queued.
  - If the window should have ended at the previous step, the loop drops the step it just drafted. The window and drafted ids are exactly those of the immediate test.
  - `iterate_draftmodel_mtp_gen` uses the helper instead of `draft_conf.float().cpu()`.

**Tech Stack:** Python 3.14, torch 2.14 (cu132), pytest 9 (exllamav3); TabbyAPI (pydantic config).

**Context:**
- The untraced timing puts the draft loop at ~5 ms of a ~45 ms step, so B2 + B3 together are capped near ~10%. See `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`, "Untraced step split".
- The user asked for every phase to be prepared on its own branch while the GPU is busy. Branches are local commits only; nothing is pushed.
- Model-level tests and measurements wait until the user frees the GPU.

**Rules:**
- Implementation goes to headless `claude -p` (non-Fable model). The primary agent runs every test.
- Branch bases:
  - exllamav3 `production-dev-20261029b` (37801428)
  - TabbyAPI `production-upstream` (564f8fb)
- exllamav3 test command:

```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider <tests>
```

---

### Task 1 (B2): TabbyAPI `sparse_draft_head` option

**Branch:** TabbyAPI `exp/sparse-draft-head` from `production-upstream`.

**Files (TabbyAPI repo `C:\Users\denys\Documents\GitHub\TabbyAPI`):**
- Modify: `backends/exllamav3/model.py` (class field near line 265, draft args near line 433, log near line 471, `AsyncGenerator(...)` kwargs near line 1236)
- Modify: `common/config_models.py` (after the `hybrid_draft_tokens` Field, ~line 718)
- Modify: `endpoints/core/types/model.py` (after `hybrid_draft_tokens: Optional[int] = None`, line 119)
- Modify: `config_sample.yml` (after `hybrid_draft_tokens: 0`, line 417)
- Modify: `docs/02.-Server-options.md` (after the `hybrid_draft_tokens` row, line 132)

- [ ] **Step 1: Class field.** In `backends/exllamav3/model.py`, after `    hybrid_draft_tokens: int = 0`:

```python
    sparse_draft_head: int = 0
```

- [ ] **Step 2: Read and validate the option.** Directly after:

```python
        if self.hybrid_draft_tokens < 0:
            raise ValueError("hybrid_draft_tokens must be 0 (off) or greater")
```

insert:

```python

        # MTP/DFlash drafting through a dynamic sparse LM head of this many
        # vocabulary columns; verification keeps the full head, so output is
        # unaffected, and an MTP drafter gets the token's embedding row on the GPU
        self.sparse_draft_head = unwrap(draft_args.get("sparse_draft_head"), 0)
        if self.sparse_draft_head < 0:
            raise ValueError("sparse_draft_head must be 0 (off) or greater")
```

- [ ] **Step 3: Log it.** Directly after the hybrid-drafting log block:

```python
        if self.hybrid_draft_tokens:
            xlogger.info(
                f"Using hybrid drafting: {self.hybrid_draft_tokens} tokens drafted from a "
                "matching earlier passage of the context."
            )
```

insert:

```python
        if self.sparse_draft_head and self.use_draft_model:
            xlogger.info(
                f"Drafting through a sparse LM head of {self.sparse_draft_head} vocabulary columns."
            )
```

- [ ] **Step 4: Pass it to the generator.** In the `AsyncGenerator(...)` call, after `                hybrid_draft_tokens=self.hybrid_draft_tokens,`:

```python
                sparse_draft_head=self.sparse_draft_head,
```

- [ ] **Step 5: Config field.** In `common/config_models.py`, directly after the `hybrid_draft_tokens` Field (which ends with `        ge=0,\n    )`):

```python
    sparse_draft_head: Optional[int] = Field(
        0,
        description=(
            "MTP/DFlash drafting through a dynamic sparse LM head of this many vocabulary\n"
            "columns, chosen from the tokens seen so far (default: 0, full head).\n"
            "Verification always uses the full head, so output is unaffected. With MTP,\n"
            "the drafted token's embedding row also stays on the GPU."
        ),
        ge=0,
    )
```

- [ ] **Step 6: Load-request field.** In `endpoints/core/types/model.py`, after `    hybrid_draft_tokens: Optional[int] = None`:

```python
    sparse_draft_head: Optional[int] = None
```

- [ ] **Step 7: Sample config and docs.** In `config_sample.yml`, after the line `  hybrid_draft_tokens: 0`:

```yaml

  # MTP/DFlash drafting through a dynamic sparse LM head of this many vocabulary columns,
  # chosen from the tokens seen so far (default: 0, full head). Verification always uses the
  # full head, so output is unaffected. With MTP, the drafted token's embedding row also stays
  # on the GPU.
  sparse_draft_head: 0
```

In `docs/02.-Server-options.md`, after the `hybrid_draft_tokens` row:

```markdown
| sparse_draft_head | Integer (0)    | MTP/DFlash drafting through a dynamic sparse LM head of this many vocabulary columns, chosen from the tokens seen so far; 0 uses the full head. Verification always uses the full head, so output is unaffected. With MTP, the drafted token's embedding row also stays on the GPU. |
```

- [ ] **Step 8: Validate (primary agent)**

```bash
cd /c/Users/denys/Documents/GitHub/TabbyAPI && /c/AI/exl3/prod-20260924/venv-runtime/Scripts/python.exe -c "
from common.config_models import DraftModelConfig
from endpoints.core.types.model import DraftModelLoadRequest
print(DraftModelConfig().sparse_draft_head, DraftModelLoadRequest().sparse_draft_head)
try:
    DraftModelConfig(sparse_draft_head=-1); print('NO ERROR')
except Exception as e: print('rejects -1:', type(e).__name__)"
```

Expected: `0 None` and `rejects -1: ValidationError`. If the class names differ, use the classes that hold `hybrid_draft_tokens` in each file.

- [ ] **Step 9: Commit (primary agent)** on `exp/sparse-draft-head`. The message names the option and says the branch is experimental and pending measurement.

Deferred until the GPU is free: trial with `TABBY_DRAFT_MODEL_SPARSE_DRAFT_HEAD=4096` (load log shows the sparse-head line, decode runs), then A B B A against base.

---

### Task 2 (B3): `LaggedDraftStop` helper

**Branch:** exllamav3 `exp/b3-lagged-draft-stop` from `production-dev-20261029b`.

**Files:**
- Modify: `C:\AI\exl3\dev-20261011\src\exllamav3\generator\draft_confidence.py` (append a class)
- Create: `C:\AI\exl3\dev-20261011\src\tests\generator\test_lagged_draft_stop.py`

- [ ] **Step 1: Write the failing test**

```python
"""
Dynamic drafting stops the MTP loop once the running product of estimated acceptance probabilities falls below
the target. Reading each step's confidence back immediately drains the stream once per draft pass;
LaggedDraftStop reads the previous step's value instead and the loop drops the one extra step it drafted. The
window it settles on, and the confidences it collects, must match the immediate test exactly.
"""

import pytest
import torch

from exllamav3.generator.draft_confidence import LaggedDraftStop


class _Cal:
    """Calibrator stand-in: the estimate is the score itself"""
    confidence = 0.5
    def estimate(self, score):
        return score


def _immediate(confs, window, cal):
    # Reference: the loop as written before, deciding right after each step
    reach = None
    for idx, c in enumerate(confs[:window]):
        est = [cal.estimate(v) for v in c]
        reach = est if reach is None else [r * e for r, e in zip(reach, est)]
        if idx + 1 < window and max(reach) < cal.confidence:
            return idx + 1
    return window


def _lagged(confs, window, cal, device):
    stop = LaggedDraftStop(cal)
    drafted = []
    for idx in range(window):
        drafted.append(idx)
        if stop.push(torch.tensor(confs[idx], device = device, dtype = torch.half)):
            stop.discard()
            drafted.pop()
            window = idx
            break
    stop.finish()
    return window, drafted, [c.view(-1).tolist() for c in stop.cols]


# Values are exact in fp16, so the float reference and the fp16 confidences agree to the bit
@pytest.mark.parametrize("confs", [
    [[0.875]] * 4,                                                # never stops (0.875^4 = 0.586)
    [[0.875], [0.375], [0.875], [0.875]],                         # stops after step 1 (reach 0.328)
    [[0.25], [0.875], [0.875], [0.875]],                          # stops after step 0
    [[0.875], [0.75], [0.625], [0.875]],                          # stops after step 2 (0.656, then 0.410)
    [[0.875, 0.25], [0.625, 0.875], [0.875, 0.875], [0.875, 0.875]],  # two rows: max over rows (0.547, then 0.479)
])
@pytest.mark.parametrize("window", [1, 2, 3, 4])
def test_lagged_stop_matches_immediate(confs, window, device):
    cal = _Cal()
    window = min(window, len(confs))
    ref = _immediate(confs, window, cal)
    got, drafted, cols = _lagged(confs, window, cal, device)
    assert got == ref
    assert drafted == list(range(ref))
    half = [torch.tensor(c, dtype = torch.half).float().tolist() for c in confs[:ref]]
    assert cols == half


def test_push_does_not_sync(device):
    stop = LaggedDraftStop(_Cal())
    conf = torch.full((1,), 0.9, device = device, dtype = torch.half)
    torch.cuda.set_sync_debug_mode("error")
    try:
        stop.push(conf)                           # first step: nothing to decide
    finally:
        torch.cuda.set_sync_debug_mode(0)
    stop.finish()
    assert [c.tolist() for c in stop.cols] == [[pytest.approx(0.9, abs = 1e-3)]]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/generator/test_lagged_draft_stop.py`
Expected: collection error, `ImportError: cannot import name 'LaggedDraftStop'`.

- [ ] **Step 3: Implement.** Append to `exllamav3/generator/draft_confidence.py`:

```python


class LaggedDraftStop:
    """
    Dynamic-draft early stop decided one drafting step late. Each step's confidence goes to pinned memory with a
    non-blocking copy, and the stop test reads the previous step's, which the GPU finished while this step's
    work was being queued, so the readback never drains the stream. When the test says the window should have
    ended at the previous step, the caller drops the step it just drafted (discard()), which leaves exactly the
    window and drafted ids of the immediate test, at the cost of one wasted draft forward.
    """

    def __init__(self, cal: DraftConfidenceCalibrator):
        self.cal = cal
        self.reach = None
        self.cols = []          # host confidences of the consumed steps, in order
        self.pending = None     # (host tensor, event) of the newest step

    def push(self, conf) -> bool:
        """Queue this step's confidence; True when the window should have ended at the previous step"""
        import torch
        host = torch.empty(conf.shape, dtype = torch.float, pin_memory = True)
        host.copy_(conf.float(), non_blocking = True)
        ev = torch.cuda.Event()
        ev.record()
        prev, self.pending = self.pending, (host, ev)
        return prev is not None and self._consume(prev)

    def discard(self):
        """Drop the newest step (the window ended before it)"""
        self.pending = None

    def finish(self):
        """Consume the newest step; the window ends with it"""
        if self.pending is not None:
            self._consume(self.pending)
            self.pending = None

    def _consume(self, entry) -> bool:
        host, ev = entry
        ev.synchronize()
        self.cols.append(host)
        est = [self.cal.estimate(v) for v in host.view(-1).tolist()]
        self.reach = est if self.reach is None else [r * e for r, e in zip(self.reach, est)]
        return max(self.reach) < self.cal.confidence
```

- [ ] **Step 4: Run the tests (primary agent)**

Same command as Step 2. Expected: all pass (5 confs × 4 windows + 1 = 21 tests).

---

### Task 3 (B3): Use the helper in the MTP drafting loop

**Branch:** same `exp/b3-lagged-draft-stop`.

**Files:**
- Modify: `C:\AI\exl3\dev-20261011\src\exllamav3\generator\generator.py` (`iterate_draftmodel_mtp_gen`, lines ~1259-1324, and the import of `DraftConfidenceCalibrator`)

- [ ] **Step 1: Import.** Where `generator.py` imports `DraftConfidenceCalibrator` from `.draft_confidence`, import `LaggedDraftStop` in the same statement.

- [ ] **Step 2: Replace the state set-up.** In `iterate_draftmodel_mtp_gen`, replace:

```python
        cal = self.draft_calibrator
        conf_cols = []
        reach = None
```

with:

```python
        cal = self.draft_calibrator
        # The stop test runs one step late on a non-blocking readback (LaggedDraftStop), so the loop never
        # drains the stream; the extra step it drafts on a stopping round is dropped again
        stop = LaggedDraftStop(cal) if cal is not None else None
```

- [ ] **Step 3: Replace the per-step test.** Replace:

```python
            draft_conf = params.get("draft_conf")
            if cal is not None and draft_conf is not None:
                c = draft_conf.float().cpu()
                conf_cols.append(c)
                est = [cal.estimate(v) for v in c.view(-1).tolist()]
                reach = est if reach is None else [r * e for r, e in zip(reach, est)]
                if idx + 1 < window and max(reach) < cal.confidence:
                    window = idx + 1
                    break
        self.draft_ids_pinned[:batch_size, :window].copy_(torch.cat(draft_cols, dim = 1))

        if conf_cols and len(conf_cols) == window:
```

with:

```python
            draft_conf = params.get("draft_conf")
            if stop is not None and draft_conf is not None and stop.push(draft_conf):
                stop.discard()
                draft_cols.pop()
                window = idx
                break
        if stop is not None:
            stop.finish()
        conf_cols = stop.cols if stop is not None else []
        self.draft_ids_pinned[:batch_size, :window].copy_(torch.cat(draft_cols, dim = 1))

        if conf_cols and len(conf_cols) == window:
```

- [ ] **Step 4: Validate (primary agent)**

```bash
cd /c/AI/exl3/dev-20261011/src && grep -n "conf_cols\|reach\|LaggedDraftStop\|stop\." exllamav3/generator/generator.py | sed -n 1,30p
/c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/generator/test_lagged_draft_stop.py tests/moe_cpu 2>&1 | tail -6
/c/AI/exl3/prod-20260924/venv/Scripts/python.exe -c "import torch, exllamav3.generator.generator"
```

Expected:
- No `reach` or `conf_cols` left in `iterate_draftmodel_mtp_gen` other than the new lines. The other drafting functions keep theirs.
- The new tests pass.
- moe_cpu matches its baseline: 101 passed, 60 skipped, and the 4 pre-existing failures.
- The import succeeds.

- [ ] **Step 5: Commit (primary agent)** on `exp/b3-lagged-draft-stop`.

Deferred until the GPU is free:
- `tests/e2e/test_speculative.py`: the MTP and dynamic-draft cases, if the registry has an MTP model.
- A trial with `dynamic_draft` on (the production preset has it).
- A B B A against base.

---

## Phase C

Not prepared. The draft loop is ~5 ms of a ~45 ms step untraced, and B2 + B3 already target its syncs and the embedding round trip. A graph-captured draft pass can only save what's left after them. Decide on C after B2/B3 are measured.
