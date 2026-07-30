# EXL3 Penalty-Range Benchmark Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and execute a PowerShell wrapper that compares direct EXL3 sampling with effectively unbounded and 4096-token penalty ranges.

**Architecture:** A single script delegates all model loading and generation to EXL3's existing `examples/chat.py`. It validates fixed local dependencies, builds one shared argument array, runs both ranges sequentially, and optionally adds a deterministic prompt for unattended smoke validation.

**Tech Stack:** Windows PowerShell 5.1, Python 3.13, EXL3 `examples/chat.py`

## Global Constraints

- Keep the wrapper minimal; do not reimplement EXL3 generation or sampling.
- Use `100000000` for the direct-EXL3 equivalent of TabbyAPI `penalty_range: -1`.
- Keep every argument other than `-penr` identical between arms.
- Interactive users enter `/x` after recording TPS to advance to the second arm.
- `-Smoke` verifies execution only and must not be presented as a long-context performance result.
- Preserve all unrelated working-tree changes.

---

### Task 1: Add and validate the benchmark wrapper

**Files:**
- Create: `scripts/exl3-penalty-range-benchmark.ps1`

**Interfaces:**
- Consumes: optional PowerShell switch `-Smoke`
- Produces: two labeled `chat.py` executions with `-penr 100000000` and `-penr 4096`

- [ ] **Step 1: Run the failing end-to-end entry-point check**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\exl3-penalty-range-benchmark.ps1 -Smoke
```

Expected: FAIL because `scripts/exl3-penalty-range-benchmark.ps1` does not exist.

- [ ] **Step 2: Add the minimal wrapper**

Create `scripts/exl3-penalty-range-benchmark.ps1`:

```powershell
[CmdletBinding()]
param(
    [switch]$Smoke
)

$ErrorActionPreference = 'Stop'

$pythonPath = 'C:\envs\rl313\Scripts\python.exe'
$chatScriptPath = 'C:\Users\denys\Documents\GitHub\exllamav3\examples\chat.py'
$modelPath = 'D:\personal\models\elx3\3.6_27b_4.7bpw'

foreach ($requiredPath in @($pythonPath, $chatScriptPath, $modelPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path does not exist: $requiredPath"
    }
}

$commonArguments = @(
    $chatScriptPath
    '-m'
    $modelPath
    '-mode'
    'qwen35'
    '-cs'
    '150016'
    '-cq'
    '8,8'
    '-maxr'
    '256'
    '-temp'
    '0.6'
    '-presp'
    '1.5'
    '-repp'
    '1.0'
    '-minp'
    '0'
    '-topk'
    '0'
    '-topp'
    '1'
    '-tps'
)

if ($Smoke) {
    $commonArguments += @(
        '-prompt'
        'Reply with exactly: penalty range smoke test passed'
    )
}

foreach ($penaltyRange in @('100000000', '4096')) {
    Write-Host "penalty_range=$penaltyRange"
    & $pythonPath @commonArguments '-penr' $penaltyRange
    if ($LASTEXITCODE -ne 0) {
        throw "EXL3 chat.py failed for penalty_range=$penaltyRange with exit code $LASTEXITCODE"
    }
}
```

- [ ] **Step 3: Verify PowerShell syntax**

Run:

```powershell
powershell -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw '.\scripts\exl3-penalty-range-benchmark.ps1')) | Out-Null"
```

Expected: PASS with exit code 0 and no output.

- [ ] **Step 4: Run the smoke benchmark end to end**

Ensure SiftKit's managed EXL3 process is stopped, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\exl3-penalty-range-benchmark.ps1 -Smoke
```

Expected:

- both `penalty_range=100000000` and `penalty_range=4096` labels appear;
- both runs load the model, generate the fixed response, and print tokens/second;
- the script exits with code 0.

- [ ] **Step 5: Review scope and commit**

Run:

```powershell
git diff --check -- scripts/exl3-penalty-range-benchmark.ps1
git status --short
```

Confirm only the new wrapper and pre-existing unrelated user changes are present, then commit:

```powershell
git add scripts/exl3-penalty-range-benchmark.ps1
git commit -m "chore: add EXL3 penalty-range benchmark runner"
```
