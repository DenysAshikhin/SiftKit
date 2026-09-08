# Minimal upstream staging candidate plan

> Execute inline. Preserve baseline and old retained checkouts. Local EXL3 commits/branches
> only; no SiftKit, worktrees, PRs or pushes. No builds/tests during timed performance runs.

**Goal:** Evaluate the actual code changes behind the seven-item list, retain only the
smallest demonstrated improvement, and provide honest PP/decode attribution.

**Architecture:** Freeze upstream at a99c309; evaluate a Python-only probe change, reuse the
existing native Pool for staging, and replace large staging slots with bounded pieces.
Existing memops/batching are baseline-covered. Automatic geometry belongs to the piece
mechanism. Reusing upstream's worker wake policy avoids a custom pool plus a repair commit.

**Spec:** `docs/superpowers/specs/2026-09-07-upstream-staging-validation.md`.

## Global constraints and measurement decisions

- Keep source SHA, native source tree, extension hash, environment, workload and full results.
- Five complete Windows and five complete Linux observations per real candidate. Identical
  upstream items reuse baseline observations, as the stated working assumption.
- Compare the candidate with its explicit parent. Do not call a small positive median a
  demonstrated win when the observation ranges overlap materially. Confirm an apparent win
  with interleaved parent/candidate observations before retaining it; report inconclusive
  results as not demonstrated, not as measured zeroes.
- No positive PP result can conceal a material decode regression. Report all contexts and
  separate recurring placement-maintenance pauses from general decode slowdown.
- Required Linux pagefile authorization remains pending. Continue independent work, but
  do not claim cross-platform acceptance without the requested completed Linux runs.
- Source benchmarks use the central Windows checkout after each prior process has exited;
  save/reinstall the binary matching its native source tree before a branch change is run.

## Task 1: Probe retries, independent branch

Branch: `perf/staging-probe-retry`, parent `baseline/upstream-dev-20260907`.
Files: `exllamav3/model/moe_cpu_host.py`, `tests/test_moe_bandwidth_probe.py`.
Prepared test file: `.scratch-upstream-staging/probe/tests/test_moe_bandwidth_probe.py`.

- [ ] Run the prepared 13 cases against upstream and require failure for missing retry policy.
- [ ] Add a small module-private policy helper and replace the existing probe loop with a
  maximum-three-sample loop. Existing 250 ms / eight-copy settings remain unchanged; each
  warmup must actually span 250 ms. Stop after two peaks agree within 10%, or three attempts.

```python
def _probe_needs_retry(peaks):
    if not peaks or any(not 0 < value < float("inf") for value in peaks):
        raise ValueError("bandwidth samples must be finite and positive")
    return len(peaks) < 3 and (len(peaks) < 2 or max(peaks[-2:]) > 1.1 * min(peaks[-2:]))
```

- [ ] Pass all tests, inspect the host-only diff and verify native source-tree identity.
- [ ] Commit only the host and its test to the local branch.
- [ ] Run five PP/decode processes per available OS with no forced stream threshold.
- [ ] Retain only if benefit is demonstrated; otherwise preserve result documentation and
  remove the unsuccessful implementation branch/code from the deliverable checkout.

## Task 2: Reuse upstream's Pool for staging

Branch: `perf/staging-worker-pool`, initially parent baseline for a standalone comparison.
Files: `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp`, `tests/test_moe_staging_workers.py`.
Prepared test file: `.scratch-upstream-staging/pool/tests/test_moe_staging_workers.py`.

The test creates tiny real CPU experts and a real worker job/control region, concurrently
submits compute/staging jobs, validates every copied byte and CPU output, checks unwritten
bytes, wraps the staging ring, varies participants and pauses between jobs. It requires
three helper threads to remain alive after the first four-worker stage job and checks
that threads do not accumulate. Upstream's per-job creation must fail that persistence
assertion before implementation. Finally it stops and joins the actual native worker.

- [ ] Run this regression against upstream; diagnose fixture errors before accepting RED.
- [ ] Reuse a separate instance of the existing Pool and a separate mutex, keeping stage
  work independent of CPU expert compute. Preserve the single-thread inline path.
- [ ] Give `Pool.ensure` an explicit pinning choice with default preserving its current
  compute behavior; staging calls it with pinning false to preserve existing unpinned staging.

```cpp
// Replace only the stage function's per-job thread creation/join block.
static Pool stage_pool;
static std::mutex stage_mutex;
std::lock_guard<std::mutex> lock(stage_mutex);
stage_pool.ensure(nt, false);
stage_pool.run(stage_phase, &ctx);
```

`ensure(int n, bool pin = true)` only gates the existing core-order initialization with
`pin`; `pin_self` already does nothing for an empty core order. No new threading class,
affinity override, idle timer, extension entrypoint or arena change is needed. Upstream's
combined dispatch word and wake policy remain the implementation under test.

- [ ] Rebuild the extension, pass the new concurrent byte/output test and existing native
  pool stress test on Windows and Linux, then run broader applicable tests.
- [ ] Review the small diff and commit only these files locally.
- [ ] Measure five complete runs per OS against baseline; confirm apparent gains with
  interleaved controls. Also evaluate in combination with pieces if standalone gain is absent.
- [ ] Do not create a separate spin-budget branch: the old custom pool's timer problem is
  avoided by reusing the upstream pool instead.

## Task 3: Piece-ring decomposition after pool evidence

Before modifying the ring protocol, write its focused implementation plan from the audited
current host/native code and the measured pool result. Required acceptance is already fixed:
anonymous arena untouched, unchanged GPU batch boundaries, topology-derived bounded staging,
complete replacement of the old staging transfer path, explicit native ABI incompatibility
failure for stale binaries, real byte-level producer/consumer tests (including wrap/reuse,
partial pieces and shutdown), five PP/decode runs per OS and honest parent comparison.

Existing experiment patches are evidence only: `.scratch-staging/piece_ring.patch` and
the retained archive contain flags/fallbacks and unrelated cache/resident code that must
not be copied wholesale. The smallest complete winning combination may be one branch;
do not retain a prerequisite as an independent performance claim or manufacture seven PRs.

## Task 4: Final local branch and evidence review

- [ ] For each original list item, record already-upstream / part-of-winning-change /
  independently-positive / rejected / externally-blocked, with all five observations per OS
  where actual measurements exist.
- [ ] Verify each retained branch diff against its explicit parent, tests and native identity.
- [ ] Run relevant/broader tests and enclosing npm typecheck/lint after final edits.
- [ ] Export results and rejected-change rationale, remove rejected active code and temporary
  artifacts after verification, preserve local winning branches and all prior unrelated work.
- [ ] Report any missing Linux acceptance plainly; do not label the campaign complete while
  required measurements remain blocked or incomplete.
