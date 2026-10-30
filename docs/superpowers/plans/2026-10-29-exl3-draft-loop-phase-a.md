# EXL3 Draft Loop Phase A (MTP experts on GPU) Implementation Plan

> **Status (2026-10-29):** Tasks 1-5 executed. Phase A failed its gate (+1% at fixed NcpuMoe 409, net slower than today) and the code was reverted; Task 6 skipped. Results: `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`, "Phase A (MTP experts on GPU) result".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the MTP draft head's routed experts on the GPU, so the ~3.4 draft passes per decode step stop waiting on the CPU MoE worker. Pay for the VRAM by moving 10 more main-layer experts to the CPU. Then measure the result against today's preset.

**Architecture:**
- **exllamav3:** gains `InferParams.draft_moe_cpu_split` (None follows `moe_cpu_split`), read through one method `InferParams.cpu_split_experts()` for the component being loaded. That method is the single source for the split load, the worker spawn and the TP guard.
- **TabbyAPI:** passes a new model option `cpu_moe_split_mtp_experts` into it.
- **SiftKit:** gets a boolean preset field `MtpExpertsOnGpu`, wired only after the measurement gate passes. Until then the trial sets the Tabby env var directly.

**Tech Stack:**
- Python 3.14, torch, pytest 9 (exllamav3), TabbyAPI (pydantic config)
- TypeScript, zod, node test runner and vitest (SiftKit)

**Spec:** `docs/superpowers/specs/2026-10-29-exl3-draft-loop-design.md`, Phase A.

**Departures from the spec (decided while planning):**
1. **exllamav3 name:** `draft_moe_cpu_split` instead of `moe_cpu_split_mtp`. It matches the existing `draft_moe_cpu_offload`, which already means "non-text components sharing this config".
2. **SiftKit field:** a boolean `MtpExpertsOnGpu` instead of an integer `NcpuMoeMtp`.
   - The only useful values are "follow `NcpuMoe`" and 0.
   - A boolean reuses the existing toggle machinery, while a nullable integer would need new dashboard plumbing.
   - Tabby keeps the integer.
3. **No greedy-identity check in Phase A.** Moving experts between the CPU (int8 activations) and the GPU changes numerics, so the gate checks for coherent output instead. B and C keep the identity requirement.

**Rules for this plan:**
- No commits (user rule).
- No edits to `venv-runtime` or the production wheel until the final step, which asks the user first.
- exllamav3 tests run from the repo root with the build venv, which has pytest and the production `exllamav3_ext`:

```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider <tests>
```

- Trials run the dev source through `PYTHONPATH='C:\AI\exl3\dev-20261011\src'`, as in the tier sweep. TabbyAPI runs from its repo, so its edits take effect directly.
- The SiftKit stack must be stopped during trials, since trials own port 8098. It is currently stopped.

---

## File structure

| File | Responsibility |
| --- | --- |
| `C:\AI\exl3\dev-20261011\src\exllamav3\model\config.py` | `draft_moe_cpu_split` setting and the `cpu_split_experts()` resolver |
| `…\exllamav3\modules\block_sparse_mlp_cpu.py` | split load reads the resolver |
| `…\exllamav3\model\model.py` | worker spawn and TP guard read the resolver |
| `…\tests\moe_cpu\test_draft_split.py` (new) | resolver and split-load behaviour per component |
| `C:\Users\denys\Documents\GitHub\TabbyAPI\common\config_models.py`, `endpoints\core\types\model.py`, `backends\exllamav3\model.py`, `config_sample.yml`, `docs\02.-Server-options.md` | `cpu_moe_split_mtp_experts` option |
| SiftKit `packages/contracts/src/config.ts`, `src/config/{defaults,normalization}.ts`, `src/inference-presets/{preset-compatibility,exl3-preset-adapter}.ts`, `dashboard/src/{settings-sections.ts,tabs/settings/ModelPresetsSection.tsx}`, `dashboard/tests/fixtures.ts` + tests | `MtpExpertsOnGpu` preset field (Task 6, only if the gate passes) |

---

### Task 1: exllamav3 per-component split resolver

**Files:**
- Create: `C:\AI\exl3\dev-20261011\src\tests\moe_cpu\test_draft_split.py`
- Modify: `C:\AI\exl3\dev-20261011\src\exllamav3\model\config.py` (InferParams `__init__` after `self.moe_cpu_split = …`, line 49; new method before `def use_mgemm`)
- Modify: `C:\AI\exl3\dev-20261011\src\exllamav3\modules\block_sparse_mlp_cpu.py:472-475`

- [ ] **Step 1: Baseline the moe_cpu suite**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu 2>&1 | tail -5`
Expected: pass/skip counts recorded. Every later run must match them, plus the new tests.

- [ ] **Step 2: Write the failing test**

```python
"""
An MTP head shares the main model's config, so the per-layer CPU expert split applied to its MoE layer too and every
draft pass waited on the CPU worker. infer_params.draft_moe_cpu_split sets the split for non-text components; None
keeps them on moe_cpu_split. Checked on the real class, built without weights.
"""

from types import SimpleNamespace

import pytest

from exllamav3.model.config import InferParams
from exllamav3.modules.block_sparse_mlp import BlockSparseMLP

pytestmark = pytest.mark.nogpu


def _params(split, draft_split, component):
    ip = InferParams()
    ip.moe_cpu_split = split
    ip.draft_moe_cpu_split = draft_split
    ip.moe_cpu_component = component
    return ip


def test_draft_split_defaults_to_following_the_main_split():
    assert InferParams().draft_moe_cpu_split is None


@pytest.mark.parametrize("draft_split, component, expected", [
    (None, "text", 399), (None, "mtp", 399), (0, "text", 399), (0, "mtp", 0), (100, "mtp", 100),
])
def test_split_experts_per_component(draft_split, component, expected):
    assert _params(399, draft_split, component).cpu_split_experts() == expected


def _module(ip):
    # A routed-expert layer eligible for the split; load_cpu_split records the tail size instead of loading
    m = BlockSparseMLP.__new__(BlockSparseMLP)
    m.config = SimpleNamespace(infer_params = ip)
    m.num_experts = 512
    m.num_local_experts = 512
    m.routing_first = None
    m.cpu_split_first = None
    m.gated = True
    m.activation_fn = "silu"
    m.split_calls = []
    m.load_cpu_split = lambda device, split_k, **kwargs: m.split_calls.append(split_k) or True
    return m


@pytest.mark.parametrize("draft_split, component, expected", [
    (None, "mtp", [399]), (0, "mtp", []), (0, "text", [399]), (100, "mtp", [100]),
])
def test_split_load_uses_the_component_split(monkeypatch, draft_split, component, expected):
    monkeypatch.delenv("EXL3_MOE_CPU_SPLIT_LAYERS", raising = False)
    m = _module(_params(399, draft_split, component))
    m.cpu_maybe_split_load("cuda:0")
    assert m.split_calls == expected
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_draft_split.py`

Expected: these fail:
- `test_draft_split_defaults…`: AttributeError `draft_moe_cpu_split`
- `test_split_experts_per_component`: AttributeError `cpu_split_experts`
- the `(0, "mtp")` load case: `[399] != []`
- the `(100, "mtp")` load case: `[399] != [100]`

The two cases that follow the main split pass.

- [ ] **Step 4: Implement**

In `config.py`, directly after `self.moe_cpu_split = int(os.environ.get("EXL3_MOE_CPU_SPLIT", 0))`:

```python
        # Per-layer split for non-text components sharing this config (an MTP head); None follows moe_cpu_split
        self.draft_moe_cpu_split = None
```

In `config.py`, a new `InferParams` method placed directly before `def use_mgemm`:

```python
    def cpu_split_experts(self) -> int:
        """Tail routed experts per MoE layer the component being loaded (moe_cpu_component) runs on the CPU"""
        if self.moe_cpu_component != "text" and self.draft_moe_cpu_split is not None:
            return self.draft_moe_cpu_split
        return self.moe_cpu_split
```

In `block_sparse_mlp_cpu.py`, replace:

```python
        # Registration shrinks the module to its GPU slice, then the normal load below loads
        # that slice. infer_params.moe_cpu_split is authoritative (the EXL3_MOE_CPU_SPLIT env
        # is its construction-time default)
        split_k = int(getattr(ip, "moe_cpu_split", 0))
```

with:

```python
        # Registration shrinks the module to its GPU slice, then the normal load below loads
        # that slice. infer_params.cpu_split_experts() is authoritative for the component being loaded
        # (the EXL3_MOE_CPU_SPLIT env is moe_cpu_split's construction-time default)
        split_k = ip.cpu_split_experts()
```

- [ ] **Step 5: Run the new test and the suite**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu 2>&1 | tail -5`
Expected: the new file passes (10 tests), and the rest matches the Step 1 counts.

---

### Task 2: exllamav3 worker spawn and TP guard use the resolver

**Files:**
- Modify: `C:\AI\exl3\dev-20261011\src\exllamav3\model\model.py:640` and `:730`

There's no unit seam for `Model.load`: it needs a model and a GPU. The behaviour is covered end to end in Task 4, Step 2: the MTP head starts no worker when its split is 0.

- [ ] **Step 1: Confirm both lines run after `moe_cpu_component` is set**

Run: `cd /c/AI/exl3/dev-20261011/src && sed -n 600,640p exllamav3/model/model.py | grep -n "def \|moe_cpu_component"; sed -n 700,735p exllamav3/model/model.py | grep -n "def "`

Expected:
- Line 633 (`moe_cpu_component = …`) and line 640 are in the same method, with 633 first.
- Line 730 is in a method whose call follows the line-633 assignment. Check the call site with `grep -n "<method name>(" exllamav3/model/model.py`.

If line 730 can run before the component is set, stop and report: the TP guard would then need the component passed explicitly.

- [ ] **Step 2: Edit line 640**

Replace:

```python
            if int(getattr(ip, "moe_cpu_split", 0) or 0) or int(getattr(ip, "moe_cpu_offload", 0) or 0):
```

with:

```python
            if ip.cpu_split_experts() or int(getattr(ip, "moe_cpu_offload", 0) or 0):
```

- [ ] **Step 3: Edit line 730**

Replace:

```python
                        ("moe_cpu_split", getattr(ip, "moe_cpu_split", 0)),
```

with:

```python
                        ("moe_cpu_split", ip.cpu_split_experts()),
```

- [ ] **Step 4: Check nothing else reads the raw attribute**

Run: `cd /c/AI/exl3/dev-20261011/src && grep -rn "\"moe_cpu_split\"\|\.moe_cpu_split\b" exllamav3 --include=*.py`

Expected: only
- `config.py` (definition and resolver)
- `model_init.py:229` (CLI sets the main split)
- `block_sparse_mlp_cpu.py:450` (offload mutual-exclusion assert, which applies to any split)
- `model.py:730`'s label string

- [ ] **Step 5: Run the suite**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu 2>&1 | tail -5`
Expected: same counts as Task 1, Step 5.

---

### Task 3: TabbyAPI `cpu_moe_split_mtp_experts`

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\TabbyAPI\common\config_models.py` (after the `cpu_moe_split_experts` Field, ~line 328)
- Modify: `…\TabbyAPI\endpoints\core\types\model.py:209`
- Modify: `…\TabbyAPI\backends\exllamav3\model.py:335-344`
- Modify: `…\TabbyAPI\config_sample.yml` (after `cpu_moe_split_experts:`, line 176)
- Modify: `…\TabbyAPI\docs\02.-Server-options.md` (after the `cpu_moe_split_experts` row, line 82)

TabbyAPI has no unit-test suite (`tests/` holds request scripts). This option is verified end to end in Task 4, Step 2.

- [ ] **Step 1: Config field**

In `common/config_models.py`, directly after the `cpu_moe_split_experts` Field:

```python
    cpu_moe_split_mtp_experts: Optional[int] = Field(
        None,
        description=(
            "Routed experts per MoE layer of the MTP draft head to run on the CPU\n"
            "(default: None, follows cpu_moe_split_experts). Set 0 to keep the\n"
            "head's experts in VRAM so draft passes never wait on the CPU worker.\n"
            "Only has an effect with cpu_moe_split_experts."
        ),
    )
```

- [ ] **Step 2: Load-request field**

In `endpoints/core/types/model.py`, after `cpu_moe_split_experts: Optional[int] = None`:

```python
    cpu_moe_split_mtp_experts: Optional[int] = None
```

- [ ] **Step 3: Pass it to exllamav3**

In `backends/exllamav3/model.py`, inside `if cpu_moe_split_experts:`, directly after `self.config.infer_params.moe_cpu_split = cpu_moe_split_experts`:

```python
            # The MTP head shares this config; its own split overrides the main one when set
            cpu_moe_split_mtp_experts = kwargs.get("cpu_moe_split_mtp_experts")
            if cpu_moe_split_mtp_experts is not None:
                self.config.infer_params.draft_moe_cpu_split = cpu_moe_split_mtp_experts
```

- [ ] **Step 4: Sample config and docs**

In `config_sample.yml`, after the `cpu_moe_split_experts:` line (keep its blank-line spacing):

```yaml

  # Routed experts per MoE layer of the MTP draft head to run on the CPU (default: None,
  # follows cpu_moe_split_experts). Set 0 to keep the head's experts in VRAM so draft passes
  # never wait on the CPU worker. Only has an effect with cpu_moe_split_experts.
  cpu_moe_split_mtp_experts:
```

In `docs/02.-Server-options.md`, add a row after the `cpu_moe_split_experts` row. Pad the columns to the table's widths.

```markdown
| cpu_moe_split_mtp_experts | Int (None)                     | Routed experts per MoE layer of the MTP draft head to run on the CPU. Unset follows `cpu_moe_split_experts`; 0 keeps the head's experts in VRAM so draft passes never wait on the CPU worker. Only has an effect with `cpu_moe_split_experts`. |
```

- [ ] **Step 5: Import check**

Run: `cd /c/Users/denys/Documents/GitHub/TabbyAPI && /c/AI/exl3/prod-20260924/venv-runtime/Scripts/python.exe -c "from common.config_models import ModelConfig; from endpoints.core.types.model import ModelLoadRequest; print(ModelConfig().cpu_moe_split_mtp_experts, ModelLoadRequest(model_name='x').cpu_moe_split_mtp_experts)"`
Expected: `None None`. If the class names differ, use the classes that hold `cpu_moe_split_experts` in each file.

---

### Task 4: End-to-end load check (dev source)

**Files:** none changed. Uses `C:\tmp\siftkit-single-orchestrator\scripts\ctx-trial.sh` and `C:\tmp\exl3-match\expert_stats.bak`.

- [ ] **Step 1: Confirm nothing holds port 8098**

Run: `curl -s -m 2 http://127.0.0.1:8098/v1/model; curl -s -m 2 http://127.0.0.1:4765/health`
Expected: both fail to connect. If either answers, stop the SiftKit stack as in the `updated-exl3` skill, step 2.

- [ ] **Step 2: Load with the MTP head on GPU and check the worker count**

```bash
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
export PYTHONPATH='C:\AI\exl3\dev-20261011\src' EXL3_MOE_CPU_SWAP_DEBUG=1 TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS=0
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 phaseA-smoke "24k" NcpuMoe=409
grep -a "CPU MoE worker started\|promote verify\|Traceback\|out of memory" $S/trial-phaseA-smoke.log | cut -c1-200
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

Expected:
- Load succeeds and both probes report a decode rate.
- Exactly **one** `CPU MoE worker started` line (the main model). Today's preset prints two: main plus the 1-layer MTP worker.
- No traceback, OOM or `promote verify` failure.
- The peak VRAM line is printed. Record it.

- [ ] **Step 3: Same load with the env var unset shows two workers**

```bash
unset TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 phaseA-follow "24k"
grep -a -c "CPU MoE worker started" $S/trial-phaseA-follow.log
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

Expected: `2`. That confirms None still follows the main split.

---

### Task 5: Phase A measurement and gate

**Files:**
- Create (scratch): `C:\tmp\exl3-match\phaseA-abba.sh`
- Append the results to SiftKit `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`

- [ ] **Step 1: Write the A B B A script**

```bash
#!/usr/bin/env bash
# Phase A ABBA: base = NcpuMoe 399 with the MTP head split; A = NcpuMoe <n> with the MTP head on GPU. Usage: phaseA-abba.sh "<arm> ..."
# An arm is base, gpu:<NcpuMoe> or split:<NcpuMoe>; profiles restored before every run.
set -u
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
export PYTHONPATH='C:\AI\exl3\dev-20261011\src' EXL3_MOE_CPU_SWAP_DEBUG=1
for arm in $1; do
  rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
  case $arm in
    base) unset TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS; n=399 ;;
    gpu:*) export TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS=0; n=${arm#gpu:} ;;
    split:*) unset TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS; n=${arm#split:} ;;
  esac
  label=phaseA-${arm/:/-}-$(date +%H%M%S)
  echo "ARM $arm $label"
  bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 $label "short 24k 64k" NcpuMoe=$n
  grep -a "promote-on-miss: step" $S/trial-$label.log | tail -1 | sed "s/^/$label /" | cut -c1-300
done
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

- [ ] **Step 2: Run A B B A (base, gpu:409, gpu:409, base)**

Run it in the background, logging to `C:\tmp\exl3-match\phaseA-abba.log`: `bash /c/tmp/exl3-match/phaseA-abba.sh "base gpu:409 gpu:409 base"`
Expected: four arms. Each prints short/24k/64k decode T/s, peak VRAM and the last row-hit line, with no `LOAD FAILED`.

- [ ] **Step 3: Run the sweep arms (split:409, gpu:419)**

Run in the background, logging to `C:\tmp\exl3-match\phaseA-sweep.log`: `bash /c/tmp/exl3-match/phaseA-abba.sh "split:409 gpu:419"`
Expected:
- `split:409` isolates the cost of the 10 fewer GPU slots per main layer.
- `gpu:419` shows whether giving up even more main-layer slots still pays.

- [ ] **Step 4: nsys check that the draft passes no longer wait on the CPU**

```bash
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
N="/c/Program Files/NVIDIA Corporation/Nsight Systems 2025.6.3/target-windows-x64/nsys.exe"
export PYTHONPATH='C:\AI\exl3\dev-20261011\src' TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS=0 NSYS_WRAP="$N"
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
cd /c/Users/denys/Documents/GitHub/SiftKit && node $S/scripts/tabby-trial.mts exl3-3-8-next-3-5bpw-f16 $M/nsys/phaseA-tabby.log NcpuMoe=409 > /dev/null 2>&1 &
for i in $(seq 1 200); do curl -s -m 2 http://127.0.0.1:8098/v1/model | grep -q '"id"' && break; sleep 3; done
model=$(curl -s http://127.0.0.1:8098/v1/model | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
bash $M/nsys/capture.sh exl3 http://127.0.0.1:8098 "$model" exl3-phaseA
"$N" export --type sqlite -o "C:/tmp/exl3-match/nsys/exl3-phaseA.sqlite" -f true "C:/tmp/exl3-match/nsys/exl3-phaseA.nsys-rep"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe' and CommandLine like '%main.py%'\" | ForEach-Object { taskkill /PID \$_.ProcessId /T /F | Out-Null }"
unset NSYS_WRAP
python $M/nsys/passes.py $M/nsys/exl3-phaseA.sqlite
python $M/nsys/gapkinds.py $M/nsys/exl3-phaseA.sqlite
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

Expected:
- `passes.py` shows no one-wait (draft) passes; the baseline had about 3.4 per step at ~1,055 µs each.
- `gapkinds.py` shows draft-loop blocked time per step well below the baseline 8.1 ms.

If the `nsys export` flags differ in this version, check `"$N" export --help`.

- [ ] **Step 5: Apply the gate**

Compute the mean decode T/s per arm for each probe size from the Step 2 log.

**Pass** requires all of:
- The mean of the two `gpu:409` runs is at least 3% above the mean of the two `base` runs.
- The gap is larger than the spread between the two `base` runs, at each size.
- Peak VRAM is below the card's limit, with no OOM.
- No traceback.
- The answers are coherent: read the short probe's text in each trial log.

If `gpu:419` beats `gpu:409` by the same rule, the production value is 419. Otherwise it's 409.

**Fail:** revert Tasks 1-3 in exllamav3 and TabbyAPI (`git restore` of the files they touched, after showing the user the diff) and record the numbers. Skip Task 6.

- [ ] **Step 6: Record the result**

Append a section "Phase A: MTP experts on GPU" to `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` containing:
- a table of arms by size with decode T/s, peak VRAM and row hit
- the nsys draft-loop numbers before and after
- the verdict

---

### Task 6 (only if the gate passed): SiftKit `MtpExpertsOnGpu` preset field

**Files:**
- Modify: `packages/contracts/src/config.ts:60` (shape) and `:82` (field enum)
- Modify: `src/config/defaults.ts:79`, `src/config/normalization.ts:482`
- Modify: `src/inference-presets/preset-compatibility.ts:93` and `:155`
- Modify: `src/inference-presets/exl3-preset-adapter.ts:58` (schema) and `:181` (env)
- Modify: `dashboard/src/settings-sections.ts` (label constant near line 28; help entry after the NcpuMoe entry, line 128)
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx` (import line 8; control after the NcpuMoe control, line 183)
- Modify: `dashboard/tests/fixtures.ts:122`
- Test: `tests/model-preset-adapters.test.ts`, `tests/config-normalization.test.ts`, `tests/preset-model-relevance.test.ts`, `tests/settings-sections.test.ts`, new `dashboard/tests/mtp-experts-preset-control.test.tsx`

- [ ] **Step 1: Write the failing tests**

`tests/model-preset-adapters.test.ts`, after the NgramRam adapter test:

```ts
test('EXL3 adapter keeps the MTP head on the main split unless MtpExpertsOnGpu is set', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  const base = { Backend: 'exl3' as const, ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B', NcpuMoe: 409 };

  const follow = adapter.buildLaunchEnvironment(createModelPreset({ ...base, MtpExpertsOnGpu: false }));
  assert.equal(follow.TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS, '409');

  const onGpu = adapter.buildLaunchEnvironment(createModelPreset({ ...base, MtpExpertsOnGpu: true }));
  assert.equal(onGpu.TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS, '0');
});
```

In the same file's field-support map (line 376 block), after `NcpuMoe: MANAGED_ONLY,` add `MtpExpertsOnGpu: MANAGED_ONLY,`.

`tests/config-normalization.test.ts`, after the NgramRam tests:

```ts
test('MtpExpertsOnGpu defaults to false and schema accepts true', () => {
  assert.equal(activePreset(normalizeConfig(getDefaultConfig())).MtpExpertsOnGpu, false);

  const config = defaultConfigObject();
  activePresetObject(config).MtpExpertsOnGpu = true;
  assert.equal(activePreset(normalizeConfig(JsonValueSchema.parse(config))).MtpExpertsOnGpu, true);
});

test('MtpExpertsOnGpu defaults to false when omitted from a persisted preset', () => {
  const config = defaultConfigObject();
  delete activePresetObject(config).MtpExpertsOnGpu;

  assert.equal(activePreset(normalizeConfig(JsonValueSchema.parse(config))).MtpExpertsOnGpu, false);
});
```

`tests/preset-model-relevance.test.ts`: in the BARE_PROFILE list, change `'NcpuMoe', 'CacheRecurrentRam',` to `'NcpuMoe', 'MtpExpertsOnGpu', 'CacheRecurrentRam',`.

`tests/settings-sections.test.ts`: after `'NcpuMoe',` in the label list, add `'MTP experts on GPU',`.

`dashboard/tests/mtp-experts-preset-control.test.tsx`:

```tsx
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen, cleanup } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { MTP_EXPERTS_ON_GPU_LABEL } from '../src/settings-sections.ts';
import { DASHBOARD_CONFIG, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import type { DashboardModelRuntimePreset } from '../src/types.ts';

type ModelPresetsSectionProps = React.ComponentProps<typeof ModelPresetsSection>;

function sectionProps(
  overrides: Partial<DashboardModelRuntimePreset> = {},
  modelPresetActions: ModelPresetsSectionProps['modelPresetActions'] = MODEL_PRESET_ACTIONS,
): ModelPresetsSectionProps {
  const preset = { ...MANAGED_PRESET, Backend: 'exl3' as const, ...overrides };
  const dashboardConfig = JSON.parse(JSON.stringify(DASHBOARD_CONFIG));
  dashboardConfig.Server.ModelPresets.Presets = [preset];
  dashboardConfig.Server.ModelPresets.ActivePresetId = preset.id;
  return {
    dashboardConfig,
    selectedModelPreset: preset,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    modelPresetActions,
    runtimeStatus: null,
    modelProfileStatus: { state: 'no-path' },
  };
}

test('the MTP experts toggle reflects the preset value', () => {
  render(<ModelPresetsSection {...sectionProps({ MtpExpertsOnGpu: false })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(MTP_EXPERTS_ON_GPU_LABEL).checked, false);

  cleanup();
  render(<ModelPresetsSection {...sectionProps({ MtpExpertsOnGpu: true })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(MTP_EXPERTS_ON_GPU_LABEL).checked, true);
});

test('toggling the MTP experts control writes the preset field', () => {
  const calls: Array<[string, boolean]> = [];
  render(
    <ModelPresetsSection
      {...sectionProps(
        { MtpExpertsOnGpu: false },
        { ...MODEL_PRESET_ACTIONS, setBoolean: (field, value) => calls.push([field, value]) },
      )}
    />,
  );

  fireEvent.click(screen.getByLabelText(MTP_EXPERTS_ON_GPU_LABEL));

  assert.deepEqual(calls, [['MtpExpertsOnGpu', true]]);
});

test('the MTP experts toggle is inert for external inference servers', () => {
  render(<ModelPresetsSection {...sectionProps({ ExternalServerEnabled: true })} />);

  const enclosure = screen.getByLabelText(MTP_EXPERTS_ON_GPU_LABEL).closest('fieldset');
  assert.equal(enclosure?.disabled, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck:test 2>&1 | tail -20`
Expected: type errors naming `MtpExpertsOnGpu` (not in the preset type) and `MTP_EXPERTS_ON_GPU_LABEL` (not exported).

- [ ] **Step 3: Implement**

`packages/contracts/src/config.ts`:
- In `ModelPresetSettingsShape`, after `NcpuMoe: z.number().int().nonnegative(),` add `MtpExpertsOnGpu: z.boolean(),`.
- In `ModelPresetFieldSchema`, after `'NcpuMoe',` add `'MtpExpertsOnGpu',`.

`src/config/defaults.ts`, after `NcpuMoe: 0,`:

```ts
    MtpExpertsOnGpu: false,
```

`src/config/normalization.ts`, after `NcpuMoe: getStrictNcpuMoe(input, defaults.NcpuMoe),`:

```ts
    MtpExpertsOnGpu: getBooleanWithDefault(input.MtpExpertsOnGpu, defaults.MtpExpertsOnGpu),
```

`src/inference-presets/preset-compatibility.ts`:
- In `PRESET_FIELD_SUPPORT`, after `NcpuMoe: 'managed-only',` add `MtpExpertsOnGpu: 'managed-only',`.
- In `PROFILE_REQUIREMENTS`, after `NcpuMoe: 'moe',` add `MtpExpertsOnGpu: 'mtp',`.

`src/inference-presets/exl3-preset-adapter.ts`:
- In `Exl3BaseLaunchEnvironmentSchema`, after `TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: z.string(),` add:

```ts
  /** The MTP head's split: 0 keeps its experts in VRAM, otherwise it follows NcpuMoe. */
  TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS: z.string(),
```

- In `buildLaunchEnvironment`, after `TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: String(preset.NcpuMoe),` add:

```ts
      TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS: preset.MtpExpertsOnGpu ? '0' : String(preset.NcpuMoe),
```

`dashboard/src/settings-sections.ts`:
- Next to `export const NGRAM_RAM_LABEL = …`:

```ts
export const MTP_EXPERTS_ON_GPU_LABEL = 'MTP experts on GPU';
```

- After the `NcpuMoe` field entry:

```ts
      { label: MTP_EXPERTS_ON_GPU_LABEL, layout: 'quarter', helpText: 'Keeps every routed expert of the MTP draft head in VRAM (`TABBY_MODEL_CPU_MOE_SPLIT_MTP_EXPERTS=0`) instead of splitting it like the main layers, so draft passes never wait on the CPU worker. Costs about 2.4 MiB of VRAM per CPU-split expert (about 0.95 GB at NcpuMoe 399); raise NcpuMoe by about 10 to pay for it.' },
```

`dashboard/src/tabs/settings/ModelPresetsSection.tsx`:
- Change the import on line 8 to `import { HYBRID_DRAFT_TOKENS_LABEL, MTP_EXPERTS_ON_GPU_LABEL, NGRAM_RAM_LABEL } from '../../settings-sections.ts';`.
- After the NcpuMoe `ModelPresetControl`:

```tsx
          <ModelPresetControl preset={preset} profile={profile} field="MtpExpertsOnGpu" label={MTP_EXPERTS_ON_GPU_LABEL}>
            <label className="settings-live-toggle-control">
              <input
                type="checkbox"
                aria-label={MTP_EXPERTS_ON_GPU_LABEL}
                checked={preset.MtpExpertsOnGpu}
                onChange={(event) => modelPresetActions.setBoolean('MtpExpertsOnGpu', event.target.checked)}
              />
              <span>{preset.MtpExpertsOnGpu ? 'GPU' : 'Split like NcpuMoe'}</span>
            </label>
          </ModelPresetControl>
```

`dashboard/tests/fixtures.ts` line 122: after `NcpuMoe: 0,` add `MtpExpertsOnGpu: false,`.

- [ ] **Step 4: Run the tests and checks**

```bash
cd /c/Users/denys/Documents/GitHub/SiftKit
npm run test 2>&1 | tail -15
npm run test:dashboard 2>&1 | tail -15
npm run typecheck 2>&1 | tail -15
npm run lint 2>&1 | tail -15
```

Expected: everything passes.
- If another test enumerates the preset fields and now fails, add `MtpExpertsOnGpu` to it next to `NcpuMoe`, matching its pattern.
- Do not weaken any assertion.

- [ ] **Step 5: Set the production presets (server stopped)**

Write a scratch `C:\tmp\exl3-match\set-mtp-gpu.mjs`, modelled on `C:\tmp\siftkit-single-orchestrator\scripts\set-ncpumoe.mjs`. It sets `MtpExpertsOnGpu = true` and `NcpuMoe = <gate value>` on presets `exl3-swift1-5-3-8-next-3-5bpw-f16` and `exl3-3-8-next-3-5bpw-f16`:

```js
// Sets MtpExpertsOnGpu and NcpuMoe on the given presets in the config row (server stopped). Usage: node set-mtp-gpu.mjs <NcpuMoe> <presetId>...
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/denys/Documents/GitHub/SiftKit/package.json');
const Database = require('better-sqlite3');
const [value, ...ids] = process.argv.slice(2);
if (!/^\d+$/u.test(value ?? '') || ids.length === 0) throw new Error('usage: <NcpuMoe> <presetId>...');
const db = new Database('C:/Users/denys/Documents/GitHub/SiftKit/.siftkit/runtime.sqlite');
const presets = JSON.parse(db.prepare('SELECT server_model_presets_json AS presets FROM app_config WHERE id = 1').get().presets);
for (const id of ids) {
  const preset = presets.find((entry) => entry.id === id);
  if (!preset) throw new Error(`unknown preset ${id}`);
  preset.NcpuMoe = Number(value);
  preset.MtpExpertsOnGpu = true;
  console.log(`${id} NcpuMoe=${preset.NcpuMoe} MtpExpertsOnGpu=true`);
}
db.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = 1').run(JSON.stringify(presets));
```

Run: `node /c/tmp/exl3-match/set-mtp-gpu.mjs <409|419> exl3-swift1-5-3-8-next-3-5bpw-f16 exl3-3-8-next-3-5bpw-f16`, then delete the script.

- [ ] **Step 6: Ask the user before production**

The production venv still runs the 3780142 wheel, which doesn't have `draft_moe_cpu_split`. Tabby would set the attribute, but nothing would read it.

Ask the user whether to:
- commit Tasks 1-2 onto `production-dev-20261029b` and the TabbyAPI change onto `production-upstream` (the wheel builder needs a clean, committed tree), and
- build and promote the wheel with the `updated-exl3` skill (steps 3-4 and 6),
- and whether to open an upstream exllamav3 PR for `draft_moe_cpu_split`.

Until then, the SiftKit stack runs the production wheel, and the new preset field has no effect on it.

---

## Phase A done when

- Tasks 1-4 pass, and Task 5 records a verdict with numbers.
- If the gate passes: Task 6 is green on test, test:dashboard, typecheck and lint, and the user has decided on Step 6.
- Scratch is cleaned: the trial logs for `phaseA-*` stay under `C:\tmp\siftkit-single-orchestrator` until final cleanup, and `phaseA-abba.sh` stays in `C:\tmp\exl3-match` until final cleanup.
- Phase B gets its own plan after this.
