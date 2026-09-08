# Upstream staging checkpoint

Read this, then `2026-09-08-upstream-staging-results.md` and the tail of
`2026-09-07-upstream-staging-validation-worklog.md`. Do not use SiftKit or worktrees.

The user's full request is **not complete**: all 50 Windows measurements are done, but there
are **zero complete new Linux model benchmarks**. New native builds and correctness tests
pass on both OSes. No PRs/pushes or consumer migrations. No commits in the outer SiftKit repo.

## State

- Frozen official dev: `a99c30994f6d9173e505254e81b0e5d784caa36e`.
- Windows repo: `pristine_exle/exllamav3-incremental`, currently clean tracked source on
  `perf/staging-piece-ring` (`07009ad`). Matching ring binary is installed.
- Linux repo: `/opt/exllamav3-incremental-20260907`, currently baseline a99c309 with its
  matching baseline binary. Distro `SiftKit-EXL3-Perf-20260905` is stopped. Preserve its VHDX.
- Both repos contain every branch listed in the results document. They have explicit
  dependencies; the whole ring/sizing/pool combination is the Windows PP candidate.
- Old `pristine_exle/exllamav3-upstream` at c6c45b1 plus its retained patch is untouched.
- GPU idle; no benchmark/build/test processes. Outer preexisting dirty files are preserved.
- Essential resume artifacts are in `.scratch-upstream-staging/`. Do not remove them while
  Linux validation remains pending. Its probe/pool/ring preparation clones are stale;
  authoritative implementations are committed in the central repo.

## Required permission is still pending

The fresh Linux baseline failed during model loading near layers 43–44 with a CUDA driver
error, before any PP/decode. The earlier investigation measured host commit exhaustion at
this failure location; this fresh attempt did not measure its failure-time peak.

Latest recheck: D:\pagefile.sys initial 16 MB, maximum 64000 MB, allocated 7722 MiB;
commit limit 144630603776 bytes, idle commit about 37.35 GB. D: has 121532497920 bytes free.
No host/pagefile/THP settings have been changed. WSL memory cap remains 108 GB, swap 0.

Prepared and syntax-validated `.scratch-upstream-staging/set-pagefile-initial.ps1` verifies
administrator privileges, the exact old settings and available disk space, then sets only
InitialSize to 32768 MB. Maximum remains 64000 MB. **Do not execute until the user approves.**
It does not reboot. Check actual allocated size/commit limit after applying; a user-controlled
restart may be needed. Do not reboot without separate explicit authorization.

The optional earlier questions (reuse baseline for identical upstream code; retain a smallest
winning combination) received no replies. Working assumptions, communicated during the work,
are baseline reuse and keeping necessary components together. Required pagefile approval
cannot be inferred from elapsed time or those optional assumptions.

## Linux campaign after capacity is available

The existing benchmark entrypoint is unchanged. Fixed command:
`eval/perf.py -m MODEL -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 32768`.
Scripts contain the model path. Full warmup, native allocator,
upstream default memops/threshold/slots/staging threads; no forced T8 or tuning.

From the outer workspace, copy the corresponding saved case manifest to active
`.scratch-upstream-staging/cases.json`, then launch hidden/detached:

1. `initial-cases.json` → `node --experimental-strip-types .scratch-upstream-staging/matrix.ts linux initial`
   (five each: pristine, standalone probe, standalone pool).
2. `ring-cases.json` → `... matrix.ts linux pieces`
   (five each: pristine, minimum ring, combined ring, no-pool ring).
3. `ring-probe-cases.json` → `... matrix.ts linux probe-in-ring`
   (five paired ring/ring+probe observations).

The matrix restores its **first case** on completion. It verifies source/native identities,
uses matching cached binaries under `native/linux`, and rejects invalid/incomplete results.
The earlier failed `linux-baseline-1` is preserved; the new matrix labels do not overwrite it.
Do not count failed loads as observations. Stop and investigate any failure. Do not build,
test, switch source or run another GPU workload during a timed set. Keep Windows/WSL runs
serial on the shared GPU. Git Bash is `C:/personal/Git/bin/bash.exe`; system32 bash is WSL.

After each case reaches five, `report.ts linux LABEL` writes validated summaries. Finish
cross-platform attribution, select only contributing combinations, remove rejected active
branches after preserving documentary evidence, and clean scratch at actual task completion.
Never label Linux throughput or the whole task complete based on native tests alone.

## Windows findings and validation

Pristine paired PP32k median 1003.86; combined ring 1245.98 (+24.12%). Minimum ring 993.81
(-1.00%); no-pool 908.91 (-9.46%). Decode remains context-dependent, with a bucket including
placement maintenance at 2k: 18.43 versus 19.33 (-4.66%). Full data and caveats are in the results document.

Retries alone: -0.63% median. Inside the ring: +0.72% median, narrower observed spread;
do not call this a demonstrated steady-speed improvement. Keep its consistency evidence
separate from median throughput and from the larger ring mechanism's gain.

Ring and no-pool each passed 27 selected cases per OS. Ring+probe passed 36 focused cases per
OS; native pool/broader checks cover the identical native extension. The probe's 13 cases
failed before implementation and passed afterward. Four parser tests and strict runner
typechecks pass. Final `npm run typecheck` (including lint) exited 0, persisted in
`root-typecheck-status.txt`. The read-only independent ring review found no introduced blockers.

The evidence zip contains 50 validated Windows result JSONs, raw logs, summaries, scripts,
and `candidate-deltas.bundle` (requires base a99c309). Cached native binaries remain locally
in scratch and are deliberately not in the archive. Full hashes are in saved case manifests.
