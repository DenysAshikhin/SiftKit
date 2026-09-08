# Fresh upstream staging validation and local branch isolation

## Authorized outcome

Refresh pristine upstream from `dev`; measure five complete PP/decode runs on Windows and
five on WSL2 for the baseline and each real staging candidate. Retain only changes with a
demonstrated positive result, in minimal local branches suitable for incremental review.
Do not create PRs, push, modify consumers, change model order, or touch the anonymous arena.
No SiftKit or worktrees. Local commits in the new EXL3 checkout are authorized by the request
for implemented local branches; the SiftKit working branch and old prototype checkout stay
uncommitted and preserved.

## Pinned upstream and environments

Freshly cloned official `dev`: `a99c30994f6d9173e505254e81b0e5d784caa36e`
(`LMF: Remove select_hq_bits args`, September 7). It is six commits beyond `c6c45b1`,
including loader transient accounting and the standard chunk-size CLI option.

- Windows checkout: `pristine_exle/exllamav3-incremental`.
- Linux checkout: `/opt/exllamav3-incremental-20260907` in retained distro
  `SiftKit-EXL3-Perf-20260905`.
- Baseline branch: `baseline/upstream-dev-20260907`, pointing exactly at the upstream SHA.
- Python: Windows `C:/envs/rl313-turbo/Scripts/python.exe`, Linux `/opt/exl3/bin/python`.
- Both use Python 3.13.14 and torch 2.13.0+cu132, and fresh native extension builds from
  the pinned source. Preserve upstream platform compiler flags. Record extension paths/hashes.
- Temporary work and logs: `.scratch-upstream-staging/`; archive evidence before cleanup.
- All earlier source checkouts, archives and the retained WSL virtual disk are preserved.

## Benchmark contract

Use unmodified `eval/perf.py`, full warmup, both PP and decode, exact command shape:

```text
python eval/perf.py -m <existing td_flash-next_4.05bpw_h6_ng6 path>
  -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 32768
```

Use native allocator on both OSes. Remove inherited EXL3 tuning variables; use upstream
defaults for memops (1), stream threshold selection, slots, staging threads, and swizzle.
Do not substitute the previous runner, which explicitly forced memops off. Diagnostic
variants may override only their declared experimental variable, recorded with the run.
Do not change chunk size, offload count, model, cache size, workload or compiler flags
between candidate and parent. Run one benchmark at a time, with no builds/tests or another
platform's model running. Stop WSL before Windows measurement sets.

Each process must exit zero and supply finite positive PP rates at
256/512/1024/2048/4096/8192/16384/32768 and decode rates at
0/256/512/1024/2048/4096/8192/16384/32512. Missing rates, traceback, worker failure, timeout
or nonzero exit invalidate the run and do not count toward five. Preserve failed attempts.
The parser validates these output contracts with runtime schemas. Record raw stdout/stderr,
command, environment, SHA, binary hash, start/end, exit and parsed metrics per run.

Report all five observations and medians/ranges per OS. Primary PP metric is 32768 tokens;
report every decode context, including placement-maintenance dips. Do not quietly exclude
slow valid observations or claim a win from cross-session absolute values. Candidate comparisons
use their declared parent and fresh paired/interleaved parent observations where needed.

## Seven-item accounting

The source audit confirms memops-on and large GPU batches already exist. The existing warmed
probe is also upstream; retries are the actual proposed change. Worker spin policy depends
on a worker pool, and L3 piece sizing depends on the piece ring. Do not manufacture seven
independent commits by splitting prerequisites into broken or misleading changes.

Two questions are pending with the user: reuse baseline runs for identical code; and retain
the smallest winning combination when dependent components do not win separately. Until
resolved, proceed with the fully authorized fresh baseline and factual source audit. Final
candidate decomposition and promotion criteria must preserve the answers and the request
to discard non-contributing changes. Native implementations/tests follow the upstream
Python/C++ conventions; benchmark orchestration and result schemas use TypeScript.

## Validation and retention

Run TDD for new behavior, same-input correctness checks for scheduling/copy changes, relevant
native/Python tests and broader applicable suites, plus enclosing `npm run typecheck` and
`npm run lint`. No failure or unverified Linux run may be labelled passing. The prior WSL
capacity failure at the Windows commit limit remains a risk to check; host/pagefile/THP
changes require explicit authorization if needed. No settings change has been authorized.

Keep each successful logical change in a small local branch with explicit parent SHA,
minimal commit(s), tests and concise rationale. Remove failed experimental code/branches
after preserving documentation and evidence; preserve the prior retained prototype tree.
Document dependencies instead of claiming all branches apply independently to upstream.
