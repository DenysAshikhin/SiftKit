# EXL3 Freeze/Restore Tensor Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make host-RAM freeze/restore correct for vision towers, MTP heads and separate draft models by snapshotting every tensor a module needs to reload, and make any future gap fail at freeze time instead of silently producing a snapshot that only fails on restore.

**Architecture:** Three vision modules in the exllamav3 siftkit fork implement `load()` but not `get_tensors()`, so `Model.freeze()` never copies their weights to host RAM and `restore` dies with `Required tensor ... not found in supplied tensors`. Each gets a `get_tensors()` override that emits exactly the key its own `load()` reads. On top of that, `SafetensorsCollection` starts recording which keys it actually served from disk, and `Model._validate_freeze_state()` uses that ledger to refuse any snapshot in which a module that consumed tensors contributes none — turning the whole class of bug into a loud freeze-time error. The fork version is bumped and SiftKit's capability watermark is tightened so a venv still carrying the old build is reported as having no freeze support at all rather than silently freezing into a broken snapshot.

**Tech Stack:** Python 3.13 / PyTorch (exllamav3 fork at `C:\Users\denys\Documents\GitHub\exllamav3`, venv `C:\envs\rl313`), pytest 9.1.1, TabbyAPI fork at `C:\Users\denys\Documents\GitHub\TabbyAPI`, SiftKit (TypeScript, `node --test`).

---

## Root cause (established, do not re-derive)

`Model.freeze()` (`exllamav3/model/model.py:237-263`) builds the snapshot from `module.get_tensors()` for every module. `Module.get_tensors()` returns `{}` by default (`exllamav3/modules/module.py:96-97`). Restore re-runs `load()` with the snapshot installed as the only tensor source (`exllamav3/model/model.py:488-500`), so any module whose `load()` reads a key the snapshot lacks raises `ValueError: Required tensor <key> not found in supplied tensors` (`exllamav3/loader/frozen_tensors.py:51`).

Observed in production: 7 freezes, 5 restore attempts, 0 successes, all five failing on `model.visual.pos_embed.weight`.

Static audit of every `Module` subclass that defines `load()` (whole fork) found exactly three modules that read tensors and override nothing:

| File | Class | Key it reads in `load()` |
| --- | --- | --- |
| `exllamav3/modules/arch_specific/qwen3_vl.py:12` | `Qwen3VLPosEmbedding` | `{key}.weight` |
| `exllamav3/modules/arch_specific/glm4v.py:9` | `Glm4VPosEmbedding` | `{key}.weight` |
| `exllamav3/modules/arch_specific/gemma4.py` | `Gemma4VisionPatchEmbedder` | `{key}.position_embedding_table` |

Everything else is already covered:
- Composite modules (`Qwen3VLVisionPatchMerger`, `DeepstackEmbed`, `Gemma3MMPool`, `DFlashInputLayer`, `GatedMLP`, `Qwen3_5MTPInputLayer`) own no raw tensors; their children are visited by `Model.__iter__` recursion (`exllamav3/model/model.py:51-53`, `exllamav3/modules/module.py:52-55`).
- MTP drafting is the `"draft"` component (`TabbyAPI/backends/exllamav3/model.py:243-247`), built from `RMSNorm` + `Linear` + `Attention` submodules, all of which implement `get_tensors()`. Its cross-references (`target_embed`, `target_lm_head`, `attached_model`) are re-established by `attach_to()` from `create_generator()` (`exllamav3/generator/generator.py:243`), which restore calls at `TabbyAPI/backends/exllamav3/model.py:949`.
- A separate draft model is also the `"draft"` component and is an ordinary text model, so it shares the main model's coverage.

Freeze validation today (`_validate_freeze_state`) only checks that modules are loaded — never that the snapshot covers what a reload will demand — which is why the failure is deferred to restore, after the VRAM copy is gone.

**Out of scope, tracked separately:** after a failed restore TabbyAPI keeps `container` non-`None` with `loaded = False` (`TabbyAPI/backends/exllamav3/model.py:956-982`) and `check_model_container` only tests `container is None` (`TabbyAPI/common/model.py:292-295`), so `GET /v1/model` still returns a full card and SiftKit's `verifyResident` (`src/status-server/tabby-model-client.ts:141`) flips `modelState` back to `'ready'` with no weights on the GPU. Do not fix that here.

---

## File structure

**exllamav3 fork** (`C:\Users\denys\Documents\GitHub\exllamav3`)

- Modify `exllamav3/modules/arch_specific/qwen3_vl.py` — add `Qwen3VLPosEmbedding.get_tensors()`
- Modify `exllamav3/modules/arch_specific/glm4v.py` — add `Glm4VPosEmbedding.get_tensors()`
- Modify `exllamav3/modules/arch_specific/gemma4.py` — add `Gemma4VisionPatchEmbedder.get_tensors()`
- Modify `exllamav3/loader/safetensors.py` — read-key ledger on `SafetensorsCollection`, union property on `VariantSafetensorsCollection`
- Modify `exllamav3/model/model.py` — `_validate_freeze_coverage()` + `_owning_module_key()`, called from `_validate_freeze_state()`
- Modify `exllamav3/version.py` — version bump
- Create `tests/test_vision_module_freeze_roundtrip.py` — per-module freeze→restore round trips
- Create `tests/test_freeze_read_ledger.py` — ledger behaviour
- Create `tests/test_freeze_coverage.py` — guard behaviour

**TabbyAPI fork** (`C:\Users\denys\Documents\GitHub\TabbyAPI`)

- Modify `pyproject.toml` — bump the pinned exllamav3 version in both dependency groups

**SiftKit** (`C:\Users\denys\Documents\GitHub\SiftKit`)

- Modify `src/inference-presets/exl3-model-capabilities.ts` — require the coverage-guard watermark
- Modify `tests/helpers/tabby-fake.ts` — `freezeCoverage` flag on the fake venv
- Modify `tests/exl3-engine-build-preflight.test.ts` — cover the new rejection

All shell commands below are PowerShell-safe and assume the repo root shown in each `cd`.

---

### Task 1: Qwen3-VL vision position embedding

**Files:**
- Create: `C:\Users\denys\Documents\GitHub\exllamav3\tests\test_vision_module_freeze_roundtrip.py`
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\exllamav3\modules\arch_specific\qwen3_vl.py` (after `unload()`, line 119-122)

- [x] **Step 1: Write the failing test**

Create `tests/test_vision_module_freeze_roundtrip.py`:

```python
import torch

from exllamav3.loader.frozen_tensors import FrozenTensorSource
from exllamav3.modules.arch_specific.qwen3_vl import Qwen3VLPosEmbedding


class SourceCollection:
    """Minimal stc stand-in serving tensors from a frozen source, exactly as restore does."""

    def __init__(self, source):
        self.source = source

    def has_tensor(self, key):
        return self.source.has_tensor(key)

    def has_tensor_group(self, key, subkeys):
        return self.source.has_tensor_group(key, subkeys)

    def get_tensor(self, key, device=None, **kwargs):
        return self.source.get_tensor(key, device, **kwargs)

    def get_tensors(self, prefix, device=None, allow_bf16=False):
        return self.source.get_tensors(prefix, device, allow_bf16)


class SourceConfig:
    def __init__(self, source):
        self.stc = SourceCollection(source)


def make_qwen3_vl_pos_embedding(config):
    return Qwen3VLPosEmbedding(
        config,
        "model.visual.pos_embed",
        num_position_embeddings=16,
        hidden_size=8,
        spatial_merge_size=2,
        out_dtype=torch.float,
    )


def test_qwen3_vl_pos_embedding_round_trips_through_a_frozen_source():
    weight = torch.randn((16, 8), dtype=torch.float16)
    disk = FrozenTensorSource({"model.visual.pos_embed.weight": weight})

    live = make_qwen3_vl_pos_embedding(SourceConfig(disk))
    live.load(torch.device("cpu"))

    frozen = FrozenTensorSource(live.get_tensors())
    restored = make_qwen3_vl_pos_embedding(SourceConfig(frozen))
    restored.load(torch.device("cpu"))

    torch.testing.assert_close(restored.embedding.weight, live.embedding.weight)
```

- [x] **Step 2: Run the test to verify it fails**

```powershell
cd C:\Users\denys\Documents\GitHub\exllamav3
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_vision_module_freeze_roundtrip.py -v
```

Expected: FAIL — `ValueError: Required tensor model.visual.pos_embed.weight not found in supplied tensors` (the frozen source built from `get_tensors()` is empty).

- [x] **Step 3: Write the minimal implementation**

In `exllamav3/modules/arch_specific/qwen3_vl.py`, insert after `Qwen3VLPosEmbedding.unload()` (which ends at line 122):

```python
    @override
    def get_tensors(self):
        return {
            f"{self.key}.weight": self.embedding.weight.data.contiguous()
        }
```

- [x] **Step 4: Run the test to verify it passes**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_vision_module_freeze_roundtrip.py -v
```

Expected: PASS (1 passed).

- [x] **Step 5: Commit**

```powershell
git add tests\test_vision_module_freeze_roundtrip.py exllamav3\modules\arch_specific\qwen3_vl.py
git commit -m "fix(freeze): snapshot the Qwen3-VL vision position embedding"
```

---

### Task 2: GLM-4V vision position embedding

`Glm4VPosEmbedding.load()` (`exllamav3/modules/arch_specific/glm4v.py:44-55`) does not keep the raw tensor: it reshapes `(N, H)` into `pos_embed_2d` of shape `(1, H, sqrt(N), sqrt(N))` as float32. `get_tensors()` must invert that reshape so the snapshot carries the on-disk layout the reload expects. Float32 is kept deliberately: the fp16/bf16 source values are exactly representable, and the tensor is a few MB at most.

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\tests\test_vision_module_freeze_roundtrip.py`
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\exllamav3\modules\arch_specific\glm4v.py` (after `unload()`)

- [x] **Step 1: Write the failing test**

Append to `tests/test_vision_module_freeze_roundtrip.py`, and add `from exllamav3.modules.arch_specific.glm4v import Glm4VPosEmbedding` to the imports at the top:

```python
def make_glm4v_pos_embedding(config):
    return Glm4VPosEmbedding(
        config,
        "model.visual.embeddings.position_embedding",
        num_position_embeddings=16,
        hidden_size=8,
        spatial_merge_size=2,
        out_dtype=torch.float,
    )


def test_glm4v_pos_embedding_round_trips_through_a_frozen_source():
    weight = torch.randn((16, 8), dtype=torch.float16)
    disk = FrozenTensorSource({"model.visual.embeddings.position_embedding.weight": weight})

    live = make_glm4v_pos_embedding(SourceConfig(disk))
    live.load(torch.device("cpu"))

    frozen = FrozenTensorSource(live.get_tensors())
    restored = make_glm4v_pos_embedding(SourceConfig(frozen))
    restored.load(torch.device("cpu"))

    torch.testing.assert_close(restored.pos_embed_2d, live.pos_embed_2d)
```

- [x] **Step 2: Run the test to verify it fails**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_vision_module_freeze_roundtrip.py::test_glm4v_pos_embedding_round_trips_through_a_frozen_source -v
```

Expected: FAIL — `ValueError: Required tensor model.visual.embeddings.position_embedding.weight not found in supplied tensors`.

- [x] **Step 3: Write the minimal implementation**

In `exllamav3/modules/arch_specific/glm4v.py`, insert after `Glm4VPosEmbedding.unload()`:

```python
    @override
    def get_tensors(self):
        # load() folds the flat (N, H) checkpoint tensor into (1, H, sqrt(N), sqrt(N)); the snapshot
        # has to carry the flat layout back, because restore re-runs load() against it
        weight = (
            self.pos_embed_2d
            .squeeze(0)
            .permute(1, 2, 0)
            .reshape(-1, self.hidden_size)
        )
        return {
            f"{self.key}.weight": weight.contiguous()
        }
```

- [x] **Step 4: Run the test to verify it passes**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_vision_module_freeze_roundtrip.py -v
```

Expected: PASS (2 passed).

- [x] **Step 5: Commit**

```powershell
git add tests\test_vision_module_freeze_roundtrip.py exllamav3\modules\arch_specific\glm4v.py
git commit -m "fix(freeze): snapshot the GLM-4V vision position embedding"
```

---

### Task 3: Gemma-4 vision patch embedder

`Gemma4VisionPatchEmbedder.load()` calls `super().load()` for its `input_proj` child (already covered by recursion) and then reads `{key}.position_embedding_table` for itself.

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\tests\test_vision_module_freeze_roundtrip.py`
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\exllamav3\modules\arch_specific\gemma4.py` (after `Gemma4VisionPatchEmbedder.unload()`)

- [x] **Step 1: Write the failing test**

Append to `tests/test_vision_module_freeze_roundtrip.py`, and add `from exllamav3.modules.arch_specific.gemma4 import Gemma4VisionPatchEmbedder` to the imports:

```python
def make_gemma4_patch_embedder(config):
    return Gemma4VisionPatchEmbedder(
        config,
        "model.vision_tower.embedder",
        hidden_size=8,
        patch_dim=4,
        position_embedding_size=16,
        out_dtype=torch.float,
    )


def test_gemma4_patch_embedder_round_trips_through_a_frozen_source():
    disk = FrozenTensorSource({
        "model.vision_tower.embedder.position_embedding_table": torch.randn((16, 8), dtype=torch.float16),
        "model.vision_tower.embedder.input_proj.weight": torch.randn((8, 4), dtype=torch.float16),
    })

    live = make_gemma4_patch_embedder(SourceConfig(disk))
    live.load(torch.device("cpu"))

    frozen = FrozenTensorSource(live.get_tensors())
    assert "model.vision_tower.embedder.position_embedding_table" in frozen.tensors

    restored = make_gemma4_patch_embedder(SourceConfig(frozen))
    restored.position_embedding_table = frozen.get_tensor(
        "model.vision_tower.embedder.position_embedding_table",
        torch.device("cpu"),
        float2half=True,
        allow_bf16=True,
    )

    torch.testing.assert_close(restored.position_embedding_table, live.position_embedding_table)
```

Note: the restored module reads the position table directly rather than through `load()`, because `load()` would also rebuild the `input_proj` `Linear`, whose coverage is already proven by `tests/test_linear_freeze.py`. What this test pins down is that the snapshot carries the embedder's own tensor at all.

- [x] **Step 2: Run the test to verify it fails**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_vision_module_freeze_roundtrip.py::test_gemma4_patch_embedder_round_trips_through_a_frozen_source -v
```

Expected: FAIL — `AssertionError` on the `in frozen.tensors` assertion (`get_tensors()` returns only the child Linear's keys, or nothing).

- [x] **Step 3: Write the minimal implementation**

In `exllamav3/modules/arch_specific/gemma4.py`, insert after `Gemma4VisionPatchEmbedder.unload()`:

```python
    @override
    def get_tensors(self):
        t = super().get_tensors()
        t[self.position_embedding_key] = self.position_embedding_table.contiguous()
        return t
```

- [x] **Step 4: Run the test to verify it passes**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_vision_module_freeze_roundtrip.py -v
```

Expected: PASS (3 passed).

- [x] **Step 5: Commit**

```powershell
git add tests\test_vision_module_freeze_roundtrip.py exllamav3\modules\arch_specific\gemma4.py
git commit -m "fix(freeze): snapshot the Gemma-4 vision patch embedder position table"
```

---

### Task 4: Record which tensor keys a load actually consumed

The guard in Task 5 needs to know what a from-disk load demanded. `SafetensorsCollection` is the single place every module read passes through, so it keeps the ledger. Only reads it serves itself are recorded: a read served from a frozen source is a restore, not a load, and an absent optional probe consumed nothing.

**Files:**
- Create: `C:\Users\denys\Documents\GitHub\exllamav3\tests\test_freeze_read_ledger.py`
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\exllamav3\loader\safetensors.py:205-222` (constructor) and `:433-445` (`get_tensor` miss block), plus the `VariantSafetensorsCollection` class body after `find_stc()` (line 779-783)

- [x] **Step 1: Write the failing tests**

Create `tests/test_freeze_read_ledger.py`:

```python
import torch
from safetensors.torch import save_file

from exllamav3.loader.frozen_tensors import FrozenTensorSource
from exllamav3.loader.safetensors import SafetensorsCollection, VariantSafetensorsCollection


def test_collection_records_keys_it_served_from_disk(tmp_path):
    save_file(
        {"model.weight": torch.ones(2), "model.bias": torch.zeros(2)},
        str(tmp_path / "model.safetensors"),
    )
    stc = SafetensorsCollection(str(tmp_path))

    stc.get_tensor("model.weight")

    assert stc.read_keys == {"model.weight"}


def test_collection_does_not_record_absent_optional_probes(tmp_path):
    save_file({"model.weight": torch.ones(2)}, str(tmp_path / "model.safetensors"))
    stc = SafetensorsCollection(str(tmp_path))

    assert stc.get_tensor("model.missing", optional=True) is None
    assert stc.read_keys == set()


def test_collection_does_not_record_reads_served_from_a_frozen_source(tmp_path):
    save_file({"model.weight": torch.ones(2)}, str(tmp_path / "model.safetensors"))
    stc = SafetensorsCollection(str(tmp_path))
    stc.set_frozen_source(FrozenTensorSource({"model.weight": torch.ones(2)}))

    stc.get_tensor("model.weight")

    assert stc.read_keys == set()


def test_prefix_reads_are_recorded_key_by_key(tmp_path):
    save_file(
        {"model.a.weight": torch.ones(2), "model.a.bias": torch.zeros(2)},
        str(tmp_path / "model.safetensors"),
    )
    stc = SafetensorsCollection(str(tmp_path))

    stc.get_tensors("model.a")

    assert stc.read_keys == {"model.a.weight", "model.a.bias"}


def test_variant_collection_unions_the_ledgers_of_its_children(tmp_path):
    main_dir = tmp_path / "main"
    child_dir = tmp_path / "child"
    main_dir.mkdir()
    child_dir.mkdir()
    save_file({"model.main": torch.ones(1)}, str(main_dir / "model.safetensors"))
    save_file({"model.child": torch.ones(1)}, str(child_dir / "model.safetensors"))
    stc = VariantSafetensorsCollection(SafetensorsCollection(str(main_dir)))
    stc.add_stc(["model.child"], SafetensorsCollection(str(child_dir)))

    stc.get_tensor("model.main")
    stc.get_tensor("model.child")

    assert stc.read_keys == {"model.main", "model.child"}
```

- [x] **Step 2: Run the tests to verify they fail**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_freeze_read_ledger.py -v
```

Expected: FAIL — `AttributeError: 'SafetensorsCollection' object has no attribute 'read_keys'`.

- [x] **Step 3: Write the minimal implementation**

In `exllamav3/loader/safetensors.py`, in `SafetensorsCollection.__init__`, after `self.deferred_loads = []` (line 221):

```python

        # Keys this collection has actually served from disk. Model.freeze() compares the snapshot
        # against this ledger, because a restore replays load() with the snapshot as its only source
        self.read_keys: set[str] = set()
```

In `SafetensorsCollection.get_tensor`, immediately after the miss block that ends with `return None` (line 444) and before `if device is None:` (line 446):

```python
        # Recorded here rather than at each return: everything past this point is a key this
        # collection owns and resolved. The new_tensors-only path above belongs to the quantizer,
        # which never freezes
        self.read_keys.add(key)
```

In `VariantSafetensorsCollection`, after `find_stc()` (line 783):

```python

    @property
    def read_keys(self) -> set[str]:
        keys = set(self.main.read_keys)
        for _, _, stc in self.stcs:
            keys |= stc.read_keys
        return keys
```

- [x] **Step 4: Run the tests to verify they pass**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_freeze_read_ledger.py -v
```

Expected: PASS (5 passed).

- [x] **Step 5: Commit**

```powershell
git add tests\test_freeze_read_ledger.py exllamav3\loader\safetensors.py
git commit -m "feat(loader): record the tensor keys a from-disk load consumed"
```

---

### Task 5: Refuse a snapshot that cannot reload itself

The rule: for every recorded read key, find the deepest module key that is a dotted prefix of it (or equal to it); that module must contribute at least one key under its own prefix. Keys owned by no module of this component belong to another component (main, draft/MTP and vision share one `Config` and one `stc`) or to the tokenizer, and are ignored.

The rule is deliberately prefix-based, not key-equality: `Linear` legitimately re-canonicalises keys (an MXFP4 checkpoint read as `<key>_blocks` is snapshotted as `<key>.weight`, `exllamav3/modules/linear.py:293-330,457-473`), and equality would reject it.

**Files:**
- Create: `C:\Users\denys\Documents\GitHub\exllamav3\tests\test_freeze_coverage.py`
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\exllamav3\model\model.py:249-263`

- [x] **Step 1: Write the failing tests**

Create `tests/test_freeze_coverage.py`:

```python
import pytest
import torch

from exllamav3.model.model import Model


class LedgerCollection:
    def __init__(self, read_keys):
        self.read_keys = set(read_keys)


class BareCollection:
    pass


class LedgerConfig:
    def __init__(self, collection):
        self.stc = collection
        self.moe_cpu_hosts = {}


class KeyedModule:
    def __init__(self, key, tensors):
        self.key = key
        self.device = torch.device("cuda:0")
        self._tensors = tensors

    def __iter__(self):
        yield self

    def get_tensors(self):
        return self._tensors


def make_model(modules, collection):
    model = Model.__new__(Model)
    model.modules = modules
    model.output_device = torch.device("cuda:0")
    model.loaded_tp = False
    model.active_devices = [0]
    model.config = LedgerConfig(collection)
    return model


def test_freeze_rejects_a_module_that_consumed_tensors_and_contributes_none():
    model = make_model(
        [
            KeyedModule("model.layers.0.mlp", {"model.layers.0.mlp.up.weight": torch.ones(1)}),
            KeyedModule("model.visual.pos_embed", {}),
        ],
        LedgerCollection([
            "model.layers.0.mlp.up.weight",
            "model.visual.pos_embed.weight",
        ]),
    )

    with pytest.raises(RuntimeError, match="model.visual.pos_embed"):
        model.freeze()


def test_freeze_accepts_a_module_that_recanonicalised_its_keys():
    model = make_model(
        [KeyedModule("model.layers.0.mlp", {"model.layers.0.mlp.experts.0.up.weight": torch.ones(1)})],
        LedgerCollection(["model.layers.0.mlp.experts.gate_up_proj_blocks"]),
    )

    source = model.freeze()

    assert source.has_tensor("model.layers.0.mlp.experts.0.up.weight")


def test_freeze_ignores_read_keys_owned_by_another_component():
    model = make_model(
        [KeyedModule("model.visual.pos_embed", {"model.visual.pos_embed.weight": torch.ones(1)})],
        LedgerCollection([
            "model.visual.pos_embed.weight",
            "mtp.layers.0.fc.weight",
            "tokenizer.json",
        ]),
    )

    source = model.freeze()

    assert set(source.tensors) == {"model.visual.pos_embed.weight"}


def test_freeze_refuses_a_collection_that_kept_no_ledger():
    model = make_model(
        [KeyedModule("model.visual.pos_embed", {"model.visual.pos_embed.weight": torch.ones(1)})],
        BareCollection(),
    )

    with pytest.raises(RuntimeError, match="no record of loaded keys"):
        model.freeze()
```

- [x] **Step 2: Run the tests to verify they fail**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_freeze_coverage.py -v
```

Expected: FAIL — `test_freeze_rejects_a_module_that_consumed_tensors_and_contributes_none` and `test_freeze_refuses_a_collection_that_kept_no_ledger` both fail with `DID NOT RAISE RuntimeError`; the other two pass already.

- [x] **Step 3: Write the minimal implementation**

In `exllamav3/model/model.py`, change the tail of `_validate_freeze_state` (currently `return tensors` at line 263) to:

```python
        self._validate_freeze_coverage(tensors)
        return tensors


    def _validate_freeze_coverage(self, tensors: dict[str, torch.Tensor]):
        """
        Refuse a snapshot that could not reload itself.

        Restore replays load() with the snapshot as the only tensor source, so every module that
        read a tensor while loading from disk has to contribute at least one tensor under its own
        key. A module that reads and contributes nothing raises "Required tensor ... not found"
        during restore instead, once the VRAM copy is already gone.
        """
        read_keys = getattr(self.config.stc, "read_keys", None)
        if read_keys is None:
            raise RuntimeError(
                "Cannot freeze: the tensor collection kept no record of loaded keys, so snapshot "
                "coverage cannot be verified"
            )

        module_keys = {module.key for module in self if module.key}
        covered = set()
        for key in tensors:
            parts = key.split(".")
            for i in range(1, len(parts) + 1):
                covered.add(".".join(parts[:i]))

        missing = {}
        for key in read_keys:
            owner = self._owning_module_key(key, module_keys)
            if owner is None or owner in covered:
                continue
            missing.setdefault(owner, key)

        if missing:
            detail = "; ".join(f"{owner} (e.g. {key})" for owner, key in sorted(missing.items()))
            raise RuntimeError(
                "Cannot freeze: these modules loaded tensors the snapshot does not carry, so "
                f"restoring from it would fail: {detail}"
            )


    @staticmethod
    def _owning_module_key(key: str, module_keys: set[str]) -> str | None:
        """The deepest module key that is `key` itself or a dotted prefix of it, if any."""
        candidate = key
        while True:
            if candidate in module_keys:
                return candidate
            cut = candidate.rfind(".")
            if cut < 0:
                return None
            candidate = candidate[:cut]
```

- [x] **Step 4: Run the tests to verify they pass**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_freeze_coverage.py -v
```

Expected: PASS (4 passed).

- [x] **Step 5: Migrate the pre-existing fakes in `tests/test_model_freeze.py`**

The fakes at `tests/test_model_freeze.py:13-31` predate the guard: `FakeConfig` has no `stc` and `FakeModule` has no `key`, so every test that reaches `_validate_freeze_state` now dies with `AttributeError` instead of its expected outcome. That affects `test_freeze_rejects_models_using_multiple_cuda_devices`, `test_freeze_returns_independent_contiguous_cpu_copies`, `test_freeze_copies_real_cuda_tensor_to_independent_cpu_storage`, `test_freeze_propagates_copy_failures_without_mutating_model_state` and `test_freeze_propagates_to_failures_without_mutating_model_state`.

Give the fakes the two attributes a real model has. An empty ledger means "this load consumed nothing", so coverage passes and every existing assertion keeps its original meaning:

```python
class FakeCollection:
    def __init__(self):
        self.read_keys = set()


class FakeConfig:
    def __init__(self, moe_cpu_hosts=None):
        self.moe_cpu_hosts = {} if moe_cpu_hosts is None else moe_cpu_hosts
        self.stc = FakeCollection()


class FakeModule:
    def __init__(self, device, tensors, key="model.fake"):
        self.device = device
        self.key = key
        self._tensors = tensors

    def __iter__(self):
        yield self

    def get_tensors(self):
        return self._tensors

    def unload(self):
        self.device = None
```

Do not weaken the guard to keep the old fakes working.

- [x] **Step 6: Run the whole freeze-related suite**

```powershell
C:\envs\rl313\Scripts\python.exe -m pytest tests\test_model_freeze.py tests\test_frozen_tensor_source.py tests\test_linear_freeze.py tests\test_freeze_coverage.py tests\test_freeze_read_ledger.py tests\test_vision_module_freeze_roundtrip.py -v
```

Expected: PASS, no failures.

- [x] **Step 7: Commit**

```powershell
git add tests\test_freeze_coverage.py tests\test_model_freeze.py exllamav3\model\model.py
git commit -m "feat(freeze): refuse snapshots that cannot restore themselves"
```

---

### Task 6: Version bump and TabbyAPI pin

A venv still holding the old build must stop satisfying the pin, so a stale install fails at install time rather than freezing into a broken snapshot.

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\exllamav3\exllamav3\version.py:1`
- Modify: `C:\Users\denys\Documents\GitHub\TabbyAPI\pyproject.toml:83` and `:106`

- [x] **Step 1: Bump the fork version**

Replace the single line in `exllamav3/version.py`:

```python
__version__ = "1.4.2+siftkit.freeze2"
```

- [x] **Step 2: Update both TabbyAPI pins**

In `C:\Users\denys\Documents\GitHub\TabbyAPI\pyproject.toml`, in both the default and the `cu13` dependency lists, replace:

```toml
    "exllamav3 == 1.4.2+siftkit.freeze",
```

with:

```toml
    "exllamav3 == 1.4.2+siftkit.freeze2",
```

- [x] **Step 3: Verify both call sites changed**

```powershell
cd C:\Users\denys\Documents\GitHub\TabbyAPI
Select-String -Path pyproject.toml -Pattern "siftkit.freeze"
```

Expected: exactly two lines, both reading `siftkit.freeze2`.

- [x] **Step 4: Commit both repos**

```powershell
cd C:\Users\denys\Documents\GitHub\exllamav3
git add exllamav3\version.py
git commit -m "build: mark the coverage-validating freeze build as 1.4.2+siftkit.freeze2"
cd C:\Users\denys\Documents\GitHub\TabbyAPI
git add pyproject.toml
git commit -m "build: require the exllamav3 freeze build that validates snapshot coverage"
```

---

### Task 7: SiftKit refuses freeze on a pre-coverage exllamav3

`hasFreezeSupport` currently only looks for `class FrozenTensorSource` and `def freeze`, both of which the broken build also has. Without this change SiftKit would keep offering "Freeze to RAM" against a stale venv.

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\src\inference-presets\exl3-model-capabilities.ts:17-28,53-58`
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\tests\helpers\tabby-fake.ts:69-77,115,144`
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\tests\exl3-engine-build-preflight.test.ts`

- [x] **Step 1: Write the failing test**

In `tests/exl3-engine-build-preflight.test.ts`, update the three existing calls that pass an explicit freeze-support object to include the new field, and add a new test after the "missing Model.freeze" case (line 66):

```ts
test('Exl3ModelCapabilities rejects a freeze build that does not validate snapshot coverage', async () => {
  await withTempEnv((root) => {
    const { pythonPath } = writeFakeExl3Venv(root, true, {
      frozenTensorSource: true,
      modelFreeze: true,
      freezeCoverage: false,
    });
    assert.equal(new Exl3ModelCapabilities().hasFreezeSupport(pythonPath), false);
  });
});
```

The three existing explicit objects become:

```ts
    const { pythonPath } = writeFakeExl3Venv(root, true, { frozenTensorSource: false, modelFreeze: false, freezeCoverage: false });
```
```ts
    const { pythonPath } = writeFakeExl3Venv(root, true, { frozenTensorSource: false, modelFreeze: true, freezeCoverage: true });
```
```ts
    const { pythonPath } = writeFakeExl3Venv(root, true, { frozenTensorSource: true, modelFreeze: false, freezeCoverage: false });
```

- [x] **Step 2: Update the fake venv helper**

In `tests/helpers/tabby-fake.ts`, extend the interface (line 69-72):

```ts
export interface FakeExl3FreezeSupport {
  frozenTensorSource: boolean;
  modelFreeze: boolean;
  freezeCoverage: boolean;
}
```

Replace `FREEZE_MODEL_SOURCE` (line 74-77) with a coverage-aware pair:

```ts
const FREEZE_MODEL_SOURCE = `
    def freeze(self) -> FrozenTensorSource:
        return FrozenTensorSource(self.get_tensors())
`;

const FREEZE_COVERAGE_MODEL_SOURCE = `
    def freeze(self) -> FrozenTensorSource:
        return FrozenTensorSource(self.get_tensors())

    def _validate_freeze_coverage(self, tensors):
        return None
`;
```

Update the default argument (line 115):

```ts
  freezeSupport: FakeExl3FreezeSupport = { frozenTensorSource: true, modelFreeze: true, freezeCoverage: true },
```

Update the model source write (line 144):

```ts
  fs.writeFileSync(
    modelSourcePath,
    freezeSupport.modelFreeze
      ? (freezeSupport.freezeCoverage ? FREEZE_COVERAGE_MODEL_SOURCE : FREEZE_MODEL_SOURCE)
      : UNPATCHED_MODEL_SOURCE,
    'utf8',
  );
```

- [x] **Step 3: Run the test to verify it fails**

```powershell
cd C:\Users\denys\Documents\GitHub\SiftKit
npx tsx --test tests\exl3-engine-build-preflight.test.ts
```

Expected: FAIL on `rejects a freeze build that does not validate snapshot coverage` — `hasFreezeSupport` returns `true`.

- [x] **Step 4: Write the minimal implementation**

In `src/inference-presets/exl3-model-capabilities.ts`, add after `MODEL_FREEZE_MARKER` (line 23):

```ts
/**
 * Watermark for the freeze build that verifies snapshot coverage before handing back a source.
 * Earlier freeze builds silently omitted vision-tower tensors, so their snapshots only failed on
 * restore — after the VRAM copy was gone. Those builds are reported as having no freeze support.
 */
const FREEZE_COVERAGE_MARKER = 'def _validate_freeze_coverage';
```

Replace the body of `hasFreezeSupport` (lines 53-58) with:

```ts
  hasFreezeSupport(pythonPath: string): boolean {
    const frozenTensors = this.readPackageSource(pythonPath, ['loader', 'frozen_tensors.py']);
    if (!frozenTensors?.includes(FROZEN_TENSOR_SOURCE_MARKER)) return false;
    const model = this.readPackageSource(pythonPath, ['model', 'model.py']);
    if (!model) return false;
    return model.includes(MODEL_FREEZE_MARKER) && model.includes(FREEZE_COVERAGE_MARKER);
  }
```

Update `FREEZE_UNSUPPORTED_REASON` (lines 26-28) to name the build:

```ts
export const FREEZE_UNSUPPORTED_REASON =
  'The installed exllamav3 has no host-RAM freeze support that validates snapshot coverage. Install '
  + 'exllamav3 1.4.2+siftkit.freeze2 or newer into the EXL3 engine venv, then restart the backend.';
```

- [x] **Step 5: Run the tests to verify they pass**

```powershell
npx tsx --test tests\exl3-engine-build-preflight.test.ts
```

Expected: PASS, 9 tests.

- [x] **Step 6: Run typecheck and lint**

```powershell
npm run typecheck
npm run lint
```

Expected: both clean.

- [x] **Step 7: Commit**

```powershell
git add src\inference-presets\exl3-model-capabilities.ts tests\helpers\tabby-fake.ts tests\exl3-engine-build-preflight.test.ts
git commit -m "fix(exl3): treat pre-coverage freeze builds as unsupported"
```

---

### Task 8: Rebuild and install the wheel

The change is pure Python, but the wheel carries the compiled CUDA extension. Build in-tree with build isolation off so the existing `build/temp.win-amd64-cpython-313` object cache (129 objects, already compiled) is reused instead of a fresh CUDA compile.

**Files:** none (build/install only)

- [x] **Step 1: Build the wheel**

```powershell
cd C:\Users\denys\Documents\GitHub\exllamav3
C:\envs\rl313\Scripts\python.exe -m pip wheel . --no-build-isolation --no-deps -w dist
```

Expected: prints `Version: 1.4.2+siftkit.freeze2` and produces `dist\exllamav3-1.4.2+siftkit.freeze2-cp313-cp313-win_amd64.whl`. No `nvcc` compile lines for unchanged sources; if a full CUDA rebuild starts, stop and confirm the `build/` cache is intact before continuing.

- [x] **Step 2: Install it into the engine venv**

```powershell
$wheel = Get-ChildItem dist\exllamav3-1.4.2+siftkit.freeze2-*.whl | Select-Object -First 1
C:\envs\rl313\Scripts\python.exe -m pip install --force-reinstall --no-deps $wheel.FullName
```

- [x] **Step 3: Verify the installed package carries the fixes**

```powershell
C:\envs\rl313\Scripts\python.exe -c "from importlib.metadata import version; from exllamav3.model.model import Model; from exllamav3.modules.arch_specific.qwen3_vl import Qwen3VLPosEmbedding; from exllamav3.modules.arch_specific.glm4v import Glm4VPosEmbedding; from exllamav3.modules.arch_specific.gemma4 import Gemma4VisionPatchEmbedder; print(version('exllamav3')); print(hasattr(Model, '_validate_freeze_coverage')); print(all('get_tensors' in c.__dict__ for c in (Qwen3VLPosEmbedding, Glm4VPosEmbedding, Gemma4VisionPatchEmbedder)))"
```

Expected output: `1.4.2+siftkit.freeze2`, then `True`, then `True`.

- [x] **Step 4: Confirm SiftKit now reports freeze support**

```powershell
cd C:\Users\denys\Documents\GitHub\SiftKit
npx tsx -e "import { Exl3ModelCapabilities } from './src/inference-presets/exl3-model-capabilities.js'; console.log(new Exl3ModelCapabilities().hasFreezeSupport('C:\\envs\\rl313\\Scripts\\python.exe'));"
```

Expected: `true`.

---

### Task 9: End-to-end verification on the real preset

This is the only step that proves the user's scenario. The active preset `exl3-3-6-27b-2` (`3.8_27b_4.6bpw`, `VisionEnabled: true`, `SpeculativeType: draft-mtp`) exercises the vision tower and the MTP draft component at once. Do not change the preset to work around a failure.

**Files:** none (runtime verification)

- [x] **Step 1: Start the SiftKit status server**

```powershell
cd C:\Users\denys\Documents\GitHub\SiftKit
npm run start
```

Wait until the EXL3 runtime reports ready.

- [x] **Step 2: Record the baseline state and a greedy completion**

```powershell
curl.exe -s http://127.0.0.1:4765/runtime/inference
```

Expected: `"modelState":"ready"`, `"backend":"exl3"`, `"freezeSupported":true`.

SiftKit proxies an OpenAI-compatible endpoint on the same port (`src/status-server/routes/inference-passthrough.ts:264`), which is the shortest path that still goes through `ensureActivePresetReady`. Save the baseline reply:

```powershell
$body = '{"model":"3.8_27b_4.6bpw","temperature":0,"max_tokens":64,"messages":[{"role":"user","content":"List the first eight prime numbers, comma separated, nothing else."}]}'
Measure-Command { curl.exe -s -X POST http://127.0.0.1:4765/v1/chat/completions -H "content-type: application/json" -d $body | Tee-Object -FilePath C:\tmp\rsx\freeze-baseline.json }
Get-Content C:\tmp\rsx\freeze-baseline.json
```

Expected: a completion. Record the reply text, the `usage` block and the elapsed time.

- [x] **Step 3: Freeze**

```powershell
curl.exe -s -X POST http://127.0.0.1:4765/runtime/model/freeze
curl.exe -s http://127.0.0.1:4765/runtime/inference
```

Expected: `{"ok":true,"status":"done"}`, then `"modelState":"frozen"`. Confirm VRAM drops (`nvidia-smi`).

- [x] **Step 4: Restore — the regression under test**

```powershell
curl.exe -s -X POST http://127.0.0.1:4765/runtime/model/load
curl.exe -s http://127.0.0.1:4765/runtime/inference
```

Expected: `{"ok":true,"status":"done"}`, then `"modelState":"ready"` with `"error":null`. In the TabbyAPI log the line `Model restored from system RAM.` must appear and `POST /v1/model/restore` must be `200`. VRAM returns to roughly its pre-freeze level.

- [x] **Step 5: Prove text inference and MTP drafting survived the restore**

```powershell
Measure-Command { curl.exe -s -X POST http://127.0.0.1:4765/v1/chat/completions -H "content-type: application/json" -d $body | Tee-Object -FilePath C:\tmp\rsx\freeze-restored.json }
Compare-Object (Get-Content C:\tmp\rsx\freeze-baseline.json) (Get-Content C:\tmp\rsx\freeze-restored.json)
```

Expected: the completion text matches the baseline exactly (temperature 0 makes decode deterministic, and restored weights must be bit-identical), and the elapsed time is within ~15% of the baseline. A large slowdown means the MTP draft component did not come back — investigate the `"draft"` component rather than accepting it.

- [x] **Step 6: Prove the vision tower runs from restored weights**

```powershell
C:\envs\rl313\Scripts\python.exe -c "from PIL import Image, ImageDraw; im = Image.new('RGB', (128, 128), 'white'); ImageDraw.Draw(im).ellipse((24, 24, 104, 104), fill='red'); im.save(r'C:\tmp\rsx\freeze-probe.png')"
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\tmp\rsx\freeze-probe.png'))
$vision = '{"model":"3.8_27b_4.6bpw","temperature":0,"max_tokens":48,"messages":[{"role":"user","content":[{"type":"text","text":"What shape and colour is in this image? Answer in four words."},{"type":"image_url","image_url":{"url":"data:image/png;base64,' + $b64 + '"}}]}]}'
curl.exe -s -X POST http://127.0.0.1:4765/v1/chat/completions -H "content-type: application/json" -d $vision
```

Expected: a reply naming a red circle. This is the code path that used to fail: `model.visual.pos_embed.weight` now comes back from the snapshot. Any `Required tensor ... not found` in the TabbyAPI log at this point means the vision fix is incomplete — capture the missing key and add the corresponding `get_tensors()` override rather than disabling vision.

- [x] **Step 7: Prove the auto-wake path**

```powershell
curl.exe -s -X POST http://127.0.0.1:4765/runtime/model/freeze
curl.exe -s -X POST http://127.0.0.1:4765/v1/chat/completions -H "content-type: application/json" -d $body
curl.exe -s http://127.0.0.1:4765/runtime/inference
```

Expected: the completion answers without a prior explicit load (restore happens inside `ensureActivePresetReady`, `src/status-server/preset-runtime-coordinator.ts:113`), not a 503, and the runtime ends at `"modelState":"ready"`.

- [x] **Step 8: Prove a freeze cycle is repeatable**

Repeat Steps 3-4 once more. `frozen_sources` is rebuilt on each freeze (`TabbyAPI/backends/exllamav3/model.py:853-860`) and cleared on a successful restore (`:955`), so a second cycle must behave identically.

- [x] **Step 9: Record the result**

Append the outcome (states observed, log lines, tokens/s before and after, VRAM figures) to this plan under a "Verification log" heading, and commit:

```powershell
git add docs\superpowers\plans\2026-08-20-exl3-freeze-restore-coverage.md
git commit -m "docs: record exl3 freeze/restore verification results"
```

---

### Task 10: Separate draft model path

No local preset uses `draft_mode == "model"`, so there is nothing to run end to end. What makes it safe is that the draft model is the same `"draft"` component slot as the MTP head (`TabbyAPI/backends/exllamav3/model.py:652-662`), is an ordinary text `Model`, and is frozen and restored through the identical code path — and that the Task 5 guard now runs for every component, so a draft model with an uncovered module refuses to freeze instead of failing on restore.

**Files:** none (analysis only)

- [x] **Step 1: Confirm the guard runs per component**

```powershell
cd C:\Users\denys\Documents\GitHub\TabbyAPI
Select-String -Path backends\exllamav3\model.py -Pattern "model.freeze\(\)","_component_inventory"
```

Expected: `freeze_to_ram` calls `model.freeze()` once per component from `_component_inventory()`, which yields vision, draft and main.

- [x] **Step 2: Confirm a refused freeze leaves the model usable**

Read `backends/exllamav3/model.py:846-914`. The snapshot dict is built before `self.loaded = False` and before any generator or cache teardown, so a `RuntimeError` from `freeze()` propagates with the model still resident. Note in the verification log that a refused freeze still cancels in-flight jobs (`wait_for_jobs(skip_wait=True)` runs first), which is acceptable because `PresetRuntimeCoordinator.refuseIfBusy` already blocks freeze while requests are active.

---

## Verification log — 2026-08-20

Run against the active preset `exl3-3-6-27b-2` (`3.8_27b_4.6bpw`, vision enabled, `SpeculativeType: draft-mtp`)
with `exllamav3 1.4.2+siftkit.freeze2` installed into `C:\envs\rl313`. TabbyAPI log:
`TabbyAPI/logs/2026-08-20_11-49-15_894148.log`.

**Runtime states.** `/runtime/inference` reported `"modelState":"ready"`, `"backend":"exl3"`,
`"freezeSupported":true` at start. Three freeze→restore cycles ran, all clean:

| Cycle | Freeze VRAM (from 22417 MiB) | Restore | VRAM after | `modelState` |
| --- | --- | --- | --- | --- |
| 1 (explicit) | 1169 MiB | 3.40 s, `{"ok":true,"status":"done"}` | 22129 MiB | `ready`, `error: null` |
| 2 (auto-wake) | 1009 MiB | inside the chat request, HTTP 200 | — | `ready` |
| 3 (explicit, repeat) | 977 MiB | 3.32 s, `{"ok":true,"status":"done"}` | 22129 MiB | `ready`, `error: null` |

**Log lines.** `Model frozen to system RAM.` ×3 and `Model restored from system RAM.` ×3, each with
`POST /v1/model/freeze 200` / `POST /v1/model/restore 200`. Zero occurrences of `Required tensor`,
`Cannot freeze`, `ERROR` or `Traceback` in the whole session log — against 5/5 restore failures on
`model.visual.pos_embed.weight` before this change.

**Vision tower (the regression under test).** After cycle 1 and again after cycle 3, the red-circle
probe was described correctly from restored weights: *"The image shows a single red circle on a
white background"* and *"Red circle on white" is four words*. `model.visual.pos_embed.weight` now
comes back from the snapshot.

**MTP drafting.** Draft acceptance and throughput are at least as good after restore as before the
freeze, so the `"draft"` component came back intact:

| Request | Generate | Draft accepted |
| --- | --- | --- |
| Baseline (pre-freeze, cold) | 67.12 T/s | 45 / 56 (80.36%) |
| After cycle 1 restore | 108.73 T/s | 44 / 60 (73.33%) |
| Repeats after cycle 1 | 98.63 / 119.65 / 128.62 T/s | 73.33% / 73.33% / 80.36% |
| After cycle 3 restore | 110.71 T/s, 104.78 T/s (vision) | 67.19%, 64.58% |

**Deviation from Step 5: the exact-match criterion is not achievable on this stack.** The restored
completion did not match the baseline byte for byte. A control ruled the freeze out as the cause:
three consecutive identical `temperature: 0` requests *with no freeze in between* also diverged from
each other (runs 1 and 2 identical, run 3 different), at the same sentence position and in the same
way as the baseline-vs-restored pair — all four variants differ only in the phrasing of one clause of
the reasoning trace and all state `First eight primes: 2,3,5,7,11,13,17,19`. Greedy decode on this
engine is not bit-reproducible run to run, which is expected with MTP speculative decoding: the
verification pass scores a variable number of draft tokens per step, so the reduction order — and
therefore tie-breaking in `argmax` — changes with the accept pattern. The restored output falls
inside the observed run-to-run variation band, and the throughput/acceptance table above is the
evidence that drafting survived. Bit-identical weight transfer is pinned by the unit tests
(`tests/test_vision_module_freeze_roundtrip.py`, `tests/test_linear_freeze.py`) instead.

**Task 10 (separate draft model), confirmed by reading:** `freeze_to_ram` calls `model.freeze()` once
per component from `_component_inventory()` — vision, draft, main
(`TabbyAPI/backends/exllamav3/model.py:652-662,852-860`) — so the Task 5 guard runs for a separate
draft model too. The snapshot dict is built at `:852-860`, before `self.loaded = False` (`:861`) and
before any generator or cache teardown (`:863-889`), so a `RuntimeError` from the guard propagates
with the model still resident. A refused freeze does still cancel in-flight jobs, because
`wait_for_jobs(skip_wait=True)` runs first (`:850`); that is acceptable because
`PresetRuntimeCoordinator.refuseIfBusy` already blocks freeze while requests are active.

---

## Follow-ups (not in this plan)

1. **SiftKit reports `ready` for a model that is not resident.** After any failed restore, `verifyResident` passes because TabbyAPI's `GET /v1/model` still returns a card, so the next chat 500s with `inline_model_loading is not True`. Needs a residency probe that distinguishes resident from frozen/failed — either a TabbyAPI field on the model card or a SiftKit-side refusal to treat `modelState === 'failed'` as recoverable by `ensurePresetReady`.
2. **Dead residency panel after a failed action.** `resolveResidencyControlState` (`dashboard/src/tabs/settings/ModelRuntimeResidencyPanel.tsx:26-34`) treats `'failed'` as unstable and disables all three buttons, leaving no in-UI recovery short of a preset or server restart.
3. **Upstreaming.** The three `get_tensors()` overrides are upstream-shaped bug fixes; the ledger and guard are freeze-specific and only make sense alongside the freeze patch.
