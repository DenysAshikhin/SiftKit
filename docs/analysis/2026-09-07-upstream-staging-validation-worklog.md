# Fresh upstream staging campaign: active worklog

## Request and constraints

User requested fresh upstream `dev`, five complete Windows runs and five WSL2 runs for
baseline and each of the seven listed staging changes, removal of non-contributors, and
minimal implemented local branches for incremental future PRs. No actual PRs or pushes.
No SiftKit, worktrees, arena/model-order/consumer changes. Preserve earlier retained work.

Spec: `docs/superpowers/specs/2026-09-07-upstream-staging-validation.md`.
Baseline plan: `docs/superpowers/plans/2026-09-07-upstream-staging-baseline.md`.

## Current source/build state

- Fresh official dev is `a99c30994f6d9173e505254e81b0e5d784caa36e`, six commits beyond
  `c6c45b1`. New changes include loader transient accounting and standard chunk CLI args.
- Windows: `pristine_exle/exllamav3-incremental`, clean source on `dev`, with local
  `baseline/upstream-dev-20260907` pointing at the same SHA.
- WSL: retained distro `SiftKit-EXL3-Perf-20260905`, independent checkout
  `/opt/exllamav3-incremental-20260907`, same pinned SHA/baseline branch.
- Both native builds passed. Windows extension SHA-256:
  `739884935621f919549d561231932e3d1957fa512b4561312d79aad89ebdcf38`.
  Linux: `c655bb9d5d0053860127c1f18ef017ce5ae3cca711fb8d87f1dc065f2e81f68e`.
- Native worker pool stress test passed on each OS (one test each; 14 existing torch
  deprecation warnings). These were run before performance measurement.
- Old `pristine_exle/exllamav3-upstream` and all prior WSL checkouts remain unchanged.
- Root local `.git/info/exclude` gained only the new scratch and new checkout paths;
  no root tracked source/config changes were made.

## Runner and validation

All new temporary material is `.scratch-upstream-staging/`.
`metrics.ts` / `metrics.test.ts`: four red→green tests validate eight PP contexts and nine
decode contexts, including missing/duplicate contexts, invalid rates, ANSI output, runtime
failures. `run.ts` orchestrates sequential full perf processes and validates every result.
Strict TypeScript checking passed with ESNext/bundler module settings.

`benchmark.sh` uses the fresh source, in-place extension, unmodified `eval/perf.py`, native
allocator, 410 CPU experts, 12 threads, chunk 4096, 32k cache/max length and RAM embeddings.
Inherited EXL3 overrides are cleared. Memops=1 and automatic streaming-threshold selection
are upstream defaults. Each run records import paths, source SHA, extension hash, versions,
actual override environment, arguments, start/end, status, raw output and parsed metrics.

Launch from hidden detached PowerShell via Node:

```powershell
Start-Process (Get-Command node.exe).Source `
  -ArgumentList '--experimental-strip-types .scratch-upstream-staging/run.ts windows baseline 5' `
  -WorkingDirectory 'C:/Users/denys/Documents/GitHub/SiftKit' -WindowStyle Hidden `
  -RedirectStandardOutput '.scratch-upstream-staging/windows-baseline-launch.txt' `
  -RedirectStandardError '.scratch-upstream-staging/windows-baseline-launch-stderr.txt'
```

Linux uses `linux baseline 5`. Optional fourth/fifth positional values are count/start
index; optional final value is a validated string of EXL3 numeric overrides. Existing run
outputs are never overwritten. Metadata is written in `<platform>-<label>-state.json`;
only `*-result.json` represents a successful, validated complete run.

Two launch issues were fixed before measurements: cmd requires a backslash/absolute batch
path; WSL rejects an empty argument (`/bin/true ''` reproduced E_INVALIDARG, while no empty
argument succeeds). The runner now omits empty override arguments. The initial WSL launcher
failure produced no model run; its launch log remains preserved.

## Linux capacity block

Fresh upstream's first actual WSL run (`linux-baseline-1`, launched 22:25 local) exited 1
during model loading near layers 43–44, before any PP/decode result:
`RuntimeError: CUDA driver error: unknown error`, at FLA `chunk_fwd_o`, `torch.empty_like(v)`.
This reproduces the prior session's failure location. That earlier investigation observed
Windows commit 144.13/144.63 GB with VRAM still available. This new attempt did not collect
a failure-time commit peak; do not claim a fresh measured peak.

Host pagefile remains D:\pagefile.sys, initial 16 MB, maximum 64000 MB, currently allocated
7722 MB. Host commit limit is 144630603776 bytes; idle commit roughly 37 GB. WSL memory
limit remains 108GB, swap 0. No settings changed. The distro was terminated after failure
before Windows performance began.

Prepared `.scratch-upstream-staging/set-pagefile-initial.ps1` changes only the configured
initial size to 32768 MB, verifies the expected old settings and administrator privileges,
leaves maximum unchanged and never reboots. **Permission to apply it is pending.** It may
require a user-controlled restart to obtain allocated headroom. Do not apply it or reboot
without an explicit answer. Continue independent Windows and candidate work meanwhile.

## Pending user questions and working assumptions

1. Reuse five baseline observations per OS for items already upstream / identical code,
   rather than rerunning separately labelled duplicates.
2. Retain the smallest winning combination when a component is a prerequisite, versus
   requiring every component to win independently.
3. Approve the reviewed pagefile initial-size change, or leave Linux blocked.

No replies received at this checkpoint. In commentary, the working assumptions for the
first two optional choices were explicitly stated as baseline reuse and smallest winning
combination. The third is required authorization and cannot be assumed.

The seven entries are not seven independent patches: memops and large GPU batches are
already upstream; probe retries are separate; piece geometry and a worker's spin policy
depend on the ring and pool respectively. Final decomposition must remain honest about
those dependencies. No candidate implementation branches exist yet; only baseline exists.

## Windows baseline complete

All five full runs completed and passed result validation. PP32768:
**981.76, 1017.54, 1009.16, 1009.40, 1024.15**, median **1009.40**.
Decode medians: ctx0 21.79, 256 21.95, 512 21.86, 1024 22.06, 2048 19.44,
4096 22.02, 8192 21.60, 16384 22.73, 32512 22.00.
`.scratch-upstream-staging/windows-baseline-summary.json` has every observation/range.

## Candidate branches and active Windows matrix (later checkpoint)

- `perf/staging-probe-retry`: **71bb832640ea6ff1bb17942f61829453e47a0488**,
  parent baseline, host-only retry/full-warmup change plus 13 tests. Red against upstream,
  green Windows and Linux. Native tree/binary identical to baseline.
- `perf/staging-worker-pool`: **41e20f6b811fea547744c7d373b04b67b9441e7b**,
  parent baseline. Reuses a separate instance of upstream's existing Pool (preserving
  unpinned staging) instead of adding a custom pool. Production delta is only 7 insertions /
  8 deletions in moe_mul1.cpp; the other 106 added lines are its test. Both OSes pass the
  concurrent CPU-compute/staging byte test, worker retention/reuse checks and native pool
  stress test; three broader CPU-offload tests passed on each. No throughput acceptance yet.
- The retained old spin-budget repair is not independently needed with this implementation:
  it uses the upstream Pool wake policy, including Windows WaitOnAddress. Do not claim a
  measured separate spin-policy gain.
- Windows pool extension SHA:
  `c0faeb757ab5d87e37ab951a43a69aa4d59068ee526165479be90febdbeef20f`.
  Linux pool SHA: `7716e53fb9fcb04989741a6a1dcfbaf81c35b9b22c875cf72390ecac7621aa87`.
- Both branches exist in the central Windows and new Linux repo. Temporary probe/pool
  checkouts under the one scratch directory were used to prepare tests; do not confuse
  their uncommitted work with the committed central branches.

`matrix.ts windows initial` is now running detached. It runs five interleaved rounds of
base/probe/pool, reversing order on even rounds, for five observations per case plus fresh
parent controls. It switches only the central Windows checkout, verifies tracked cleanliness,
commit and native source tree, restores a hash-checked matching binary, and runs the unchanged
perf entrypoint. On success it restores baseline source/binary. It can resume the same label
by validating/skipping completed result files; it refuses to overwrite failed run outputs.
Every perf process is wrapped in GNU timeout (1200s + 20s kill grace); nonzero/invalid runs
stop the matrix. WSL is stopped for this set.

**Do not edit/switch/build/test in the central checkout while this matrix is active.**
Read `windows-initial-matrix-state.json` and `windows-initial-matrix-launch.txt` for progress.
Per-run results are `windows-initial-{base,probe,pool}-{1..5}-result.json`.
`cases.json` pins all branch/native identities. Matching baseline/pool binaries are under
`native/{windows,linux}/{base,pool}` in scratch. Current Linux source is baseline with the
baseline binary; Linux model throughput remains blocked by the still-pending pagefile question.

Runner/parser/report/matrix TypeScript is schema-validated and typechecked. Four parser
tests passed. `report.ts <platform> <label>` requires five complete identical-build records.
Do not run any heavy work during the Windows matrix. Ring planning/test preparation may
continue in a separate scratch checkout; actual tests/builds wait until the set finishes.

Next work: finish the five Windows observations for the two real candidates; address the authorized Linux capacity
path if permission arrives; decompose and implement minimal candidate branches with TDD,
then collect the requested five observations per OS/real candidate and parent comparisons.
Do not confuse successful builds/native tests with successful Linux model benchmarks.

## Piece-ring preparation during the Windows matrix

`.scratch-upstream-staging/ring` is a separate ordinary clone (not a worktree), based on
committed pool 41e20f6, on `perf/staging-piece-ring`. Only tests are edited so far; no ring
production implementation or test execution yet. Its cached extension is still the pool build.
Focused plan: `docs/superpowers/plans/2026-09-07-upstream-staging-pieces.md`.

Prepared geometry tests cover topology decoding and bounded whole-expert geometry. Native
tests cover two layers with different packed expert sizes, a shared fixed byte stride,
partial pieces/guard bytes, held-buffer backpressure, stage queue and piece-counter uint32
wrap, three destination slots, real GPU ordered copies, and shutdown while blocked. The
existing concurrent compute/persistent-helper test is migrated to the intended new protocol.
Run RED after the matrix ends, before implementation.

Protocol refinement: repurpose the obsolete stage `prev_seq` field as `expert_bytes`.
Native derives experts per piece from the fixed byte stride and this existing host metadata;
no extra native lookup or public entrypoint is needed. GPU batches remain unchanged.
Replace two worker layout arguments with one so stale native binaries reject the new call.

After the combined ring is tested, measure removal variants for the pool and for automatic
cache sizing. The latter uses one largest eligible expert per pinned buffer (the natural
minimum ring), rather than introducing another hand-chosen byte budget. This gives actual
component attribution instead of claiming each prerequisite independently improves upstream.

## Windows initial matrix complete (September 8, 00:16 local)

All 15 interleaved runs validated and the runner restored baseline source/binary. Five
PP32768 observations, in execution-round order:

| Case | Five runs (tok/s) | Median | Versus paired-control median |
|---|---|---:|---:|
| Upstream | 1011.24, 1021.02, 1018.39, 1019.08, 875.12 | 1018.39 | baseline |
| Probe retry | 1011.98, 1026.33, 1020.22, 1007.44, 1008.99 | 1011.98 | -0.63% |
| Persistent pool | 910.33, 922.10, 1071.30, 1072.39, 1074.52 | 1071.30 | +5.20% |

Keep every valid observation, including the slow fifth control. The probe has no demonstrated
standalone median improvement. Pool remains provisional: substantial PP variation and 8k
decode median 21.39 versus upstream 22.60 (-5.35%); observation ranges overlap. Other decode
contexts also vary, so this is not yet a causal general-decode conclusion. Full per-context
observations/identities are in `windows-initial-{base,probe,pool}-summary.json` and run records.
No Linux throughput observations exist yet; required capacity authorization remains pending.

Central checkout is now `perf/staging-piece-ring`, based on pool 41e20f6. Prepared ring tests
were copied there; production source is still unchanged. Geometry RED confirmed the missing
module. Native RED is running against the pool binary; builds begin only after RED completes.
The scratch preparation clone remains test-only and is not the authoritative implementation.

## Ring implementation and component-removal branches

`perf/staging-piece-ring` is committed locally at **07009adfd8c67ac244c9ce32f43c0483e3c521ef**,
parent pool 41e20f6. Native tree **c1e12c038073713b10191075aa9dc29016318eb8**.
Windows binary SHA **bd027e98cce4810edad4f7df0fe195dbdee560cb7692c4ef8d3b95a6fdca5dca**;
Linux binary SHA **c2746a2eefa6f623a39f167606973b52aa32a1133a52d705a7623fa5bb776809**.
Both native builds passed. Geometry/native/CPU-offload validation totals 27 passing cases
per OS, including GPU memops and kernel waits across uint32 wrap, mixed expert sizes,
partial copies, backpressure and blocked shutdown. Windows cache detection returned 33554432
bytes, deriving 9830400 bytes per piece for this model's largest eligible expert.

Resolved validation issues: (1) the worker-retention test initially assumed no preceding test
had created the process-wide pool; it now measures in a fresh subprocess without weakening
the three-helper assertion; (2) combining /opt and /mnt/c test paths in one Linux pytest call
made pytest traverse the drive root and encounter hiberfil.sys; separate invocations pass.
The native pool stress and broader CPU-offload cases passed; no full-model Linux PP/decode
result is implied. WSL is currently running for native validation only.

`perf/staging-piece-ring-minimum` is **a4fb9f81c2a05013615ad921e7885910de68fa91**,
parent ring. It removes cache detection/policy and its tests, using one largest eligible
expert per piece. The native tree/binary is identical to ring. Seven Windows native/staging
checks pass. This is an attribution experiment, not yet a retained performance branch.

The central Windows checkout is now `perf/staging-piece-ring-no-pool`, based on ring.
It restores upstream staging thread creation and the original Pool implementation exactly.
Its concurrency test retains all byte/CPU-output assertions and drops the removed feature's
thread-retention expectations. The extension is rebuilding; no throughput run started yet.

Root `npm run typecheck` (including lint) passed after removing two explicit `unknown`
annotations from the scratch runner: child stdout/stderr now inherit the parent streams;
benchmark results still pass the existing runtime schemas. Four parser tests and strict
standalone TypeScript checks passed. No enclosing SiftKit implementation was changed.

## Ready for the piece comparison

No-pool branch committed at **8d7b921d78173fc8c07921557498347786f80751**, native tree
**f97d612bb915d61d68842fc9f61a5250ca4c900a**. Its CPU moe_mul1.cpp is byte-for-byte
upstream according to the Git diff. Windows binary **b3237c3a77e5ee5a49b75fdbc249c8b9a49b312be399692296c9ac284ae85f63**;
Linux **0aa4c821c9c5309c156649fbc413053ca8f5b5d896f2b48bcd90c11171ec9be0**.
It passed 27 selected tests on each OS. Minimum-ring passed its seven native/staging checks
on each OS, sharing the combined ring's native tree and binaries. All removal branches
also exist in the new Linux checkout. Its source/binary are currently the no-pool variant.

`initial-cases.json` preserves the first matrix's identities. `ring-cases.json` contains
base / minimum / ring / no-pool; it has been copied to active `cases.json`. Do not use the
active case file to resume the old initial matrix. Restore the appropriate case file first.

The code-review skill explicitly required one independent read-only reviewer; agent
`review_piece_ring` is inspecting explicit commits, without SiftKit, builds, tests, branch
switches or mutations. No other agents were dispatched.

WSL was stopped after native checks. The central Windows checkout is baseline with its
matching binary. A single **windows-pieces-base-1** control is now running via detached Node
PID **11140** (`run.ts windows pieces-base 1 1`). This useful independent control can run
while review completes. **Do not switch/edit/build/test in the central repo during it.**
After review and that control finish, `matrix.ts windows pieces` can validate/skip its
completed result and run the remaining 19 processes. Before launching, address any review
issues, update affected commits/binaries/case identities, and verify the first control ended.
No piece-variant full-model measurement has started at this checkpoint.

Concise interim results: `docs/analysis/2026-09-08-upstream-staging-results.md`.

Independent review completed with no introduced correctness blockers in ordering, ownership,
ABI agreement, wrap or blocked shutdown. The reviewer noted an inherited same-host reuse
after `shutdown()` issue (sequence state is not reset, also true of upstream's old wseq /
compute counters). Track separately; no lifecycle expansion is included in this patch.

The first piece-series control completed at **988.15 tok/s PP32k**, with every decode result.
`matrix.ts windows pieces` is now running detached for the remaining 19 processes, reusing
that validated first control. **Do not mutate/switch/build/test in the central Windows repo
or start WSL/GPU work during this set.** `windows-pieces-matrix-state.json` and
`windows-pieces-matrix-launch.txt` are the progress authority. Cases are pinned by active
`cases.json` / preserved `ring-cases.json`. Each result is `windows-pieces-CASE-INDEX-result.json`.
The benchmark uses cached raw tokenized wikitext2, not a randomly regenerated token stream.

During the piece matrix, combined-ring PP32k runs 1–4 were 1245.98, 1271.42, 1233.43,
1024.19. Minimum-ring runs 1–3: 1194.21, 1009.44, 993.81. No-pool runs 1–4:
908.91, 913.86, 910.61, 792.37. Do not decide from partial sets or discard low runs.

The fourth combined-ring slowdown justifies testing the original probe-retry candidate
inside the ring before rejecting it based only on its flat standalone median. The ring
changes probe transfer size, so the upstream 256-copy cap may shorten warmup; causality is
not established. The piece plan now specifies a ring+probe branch and five interleaved
parent/candidate pairs after the current set, with unchanged native code and benchmark
entrypoint. No production edits or extra performance processes during the active matrix.

## Piece matrix completed; probe-in-ring comparison active

All 20 piece-series processes completed and validated. Full per-context data are in
`windows-pieces-{base,minimum,ring,no-pool}-summary.json`. PP32k medians: upstream 1003.86,
minimum 993.81 (-1.00%), ring 1245.98 (+24.12%), no-pool 908.91 (-9.46%). Automatic sizing
contributes +25.37% versus minimum; pool contributes +37.09% versus no-pool, conditional
on the rest of the ring. The 2k decode median is 18.43 versus 19.33 upstream (-4.66%);
keep this limitation explicit. Updated tables are in the September 8 results document.

`perf/staging-piece-ring-probe` is **6be10e13d6499e318d9e3264de9abdffb883b7d6**,
parent 07009ad. The host retry change matches the independently tested 71bb832 policy,
with piece views retained. Thirteen cases failed RED before implementation; 36 probe,
geometry and native staging cases then passed on each OS. Native source tree and binaries
are identical to the ring, **c1e12c038073713b10191075aa9dc29016318eb8**. Earlier native
pool/broader checks cover that unchanged extension. No native rebuild was needed.

Matrix controller now restores its **first case**, allowing an explicit `ring` control
label instead of calling the already-modified ring `base`. Earlier case files already put
upstream first, so their ordering/restoration is unchanged. Strict TypeScript checks and
four parser tests passed. Re-run root validation with an explicit persisted exit status
before final closeout: the last root invocation's session/exit result was not captured,
although its log ended cleanly at lint and no validator process remained before this
series' model measurement. The earlier full root validation did exit 0.

`ring-probe-cases.json` is now active `cases.json`, containing `ring` and `ring-probe`.
Detached Node PID **37496** is running **matrix.ts windows probe-in-ring**, five interleaved
pairs (ten processes), started **2026-09-08T06:04:58Z**. Progress:
`windows-probe-in-ring-matrix-state.json` and `windows-probe-in-ring-matrix-launch.txt`.
Results: `windows-probe-in-ring-{ring,ring-probe}-{1..5}-result.json`.
**Do not switch/edit/build/test in the central checkout or run WSL/GPU work during this set.**
WSL is stopped; its source is ring-probe with the matching ring binary. On successful
completion this Windows matrix restores the ring parent, not pristine upstream.

Capacity recheck after the piece matrix: pagefile still 7722 MiB allocated, commit limit
144630603776 bytes, idle commit 37351043072 bytes. No automatic capacity increase occurred.
Manual initial-size change approval is still pending; no host setting was changed and
no new Linux model-load attempt was made against the unchanged capacity limit.

Decode interpretation follow-up: unchanged upstream `block_sparse_mlp_cpu.py:563–585`
sets a pending placement sweep at 128 ticks and forces it inline at 512 in raw forward
drivers such as perf.py. Its benchmark uses 100 calls per context after warmup, placing the
overdue sweep in the recurring 2k bucket; the September 6 hardening record already identified
that dip. Keep the new 2k difference visible as a measurement including maintenance. Do not
infer a general kernel regression or assert its cause without a separate timing breakdown.

## Checkpoint: all Windows work complete, Linux approval required

The ten-process probe-in-ring matrix completed. Parent PP32k: 1011.93, 1009.78, 1261.94,
1248.32, 1245.94 (median 1245.94). Ring+probe: 1261.98, 1250.39, 1244.06, 1254.85,
1267.32 (median 1254.85). Median change +0.72%, within normal spread. The candidate
avoided two slow parent observations; mean rate +8.67% and aggregate rate +9.86% describe
this sample's variation, not an established increase in the steady throughput ceiling.
Do not replace median reporting with a more flattering metric or claim a failure probability.

There are **50 validated Windows result records** total and **zero complete new Linux model
benchmarks**. No runtime/build/test processes remain. Windows is on ring 07009ad with its
matching bd027e98... binary, excluding retries and both unsuccessful removal variants from
the checked-out proposal. Linux was deliberately restored to baseline a99c309 with c655bb9d...
binary, ready for its first successful baseline set; distro is stopped. All six candidate
refs match across the two repos. No PRs/pushes, old retained source and consumers untouched.

Final `npm run typecheck`, including lint, exited 0 and is persisted in
`root-typecheck-status.txt`. Strict runner checks and four parser cases also pass.
`set-pagefile-initial.ps1` now additionally verifies sufficient D: free space before writing;
its syntax was checked, but it was **not executed**. D: free space was 121532497920 bytes.
The required initial-size approval is still unanswered; no global settings or reboot.

The results table and explicit branch/parent statuses are in
`2026-09-08-upstream-staging-results.md`; resume instructions are in
`2026-09-08-upstream-staging-handoff.md`. An evidence archive contains all 50 result JSONs,
raw logs, summaries, scripts and a verified delta bundle requiring base a99c309. It omits
native binaries, which remain cached locally. Scratch and experimental refs are intentionally
preserved until the requested Linux comparisons allow final selection/deletion. This is
an externally blocked checkpoint, not completion of the user's full request.
