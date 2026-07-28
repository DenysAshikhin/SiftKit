# Repo-Agent State, Timeout, and Foreground Runner Refactor

## Goal

Correct three defects in the resumable repo-agent implementation:

1. make run-state revision transitions genuinely exclusive across processes;
2. treat five minutes as streamed-operation inactivity, not total run duration;
3. remove the legacy shared repo-agent/repo-search argv wrapper.

The public CLI syntax and JSON result contract do not change.

## Run-State Concurrency

`RepoAgentRunStore` must serialize every read-validate-write state mutation with
an exclusive per-run state lease. The lease is acquired before reading the
current revision and held until the replacement state is durably written.

The lease records its owner PID and creation time. A competing live process
fails closed instead of overwriting state. A process may recover a lease only
when its recorded owner is no longer alive. Lease cleanup happens in `finally`.

The following methods use the same transition primitive:

- `transition`;
- `publishApproval`;
- `clearPendingApproval`.

Decision submission retains its separate exclusive claim because it protects a
different invariant: exactly one decision for one approval revision.

Tests use real concurrent child processes against one run directory. They prove
that two writers starting from one revision cannot both succeed and that the
winning state is valid. Additional tests cover live-lease rejection, dead-owner
lease recovery, and cleanup after a failed transition.

## Inactivity Timeout

The parent boundary waiter has no wall-clock deadline. It polls while the worker
PID is alive and returns only at approval, completion, failure, or abort.

The repo-agent SSE request owns the five-minute inactivity deadline. Node's
socket inactivity timer resets whenever stream traffic arrives, so active
multi-turn runs may continue indefinitely. Five minutes without SSE activity
aborts the request.

The worker catches that abort like any other streamed-operation failure and
atomically records `failed`. The parent then returns the existing structured
failed JSON result. There is no new `active` result and no orphaned worker left
running after a timeout.

Repo-search and other streamed operations retain their existing timeout unless
their own contract explicitly changes.

Tests prove:

- a boundary wait may exceed the former five-minute wall-clock deadline while
  state remains active;
- dead workers still fail promptly;
- repo-agent uses the five-minute inactivity timeout;
- stream activity resets the timeout;
- inactivity produces one failed JSON boundary.

Tests use short injected timeout values; production code does not expose a new
public CLI option.

## Typed Foreground Runner

Delete the shared `runRepoTaskCli({ mode })` wrapper and `RepoTaskMode`.

`runRepoSearchCli` remains responsible only for repo-search parsing, help,
interactive approval, request construction, and output.

A new explicit foreground repo-agent runner accepts the already-validated
`RepoAgentStartInvocation`. It:

1. asserts a TTY only when approval is enabled;
2. creates the human approval prompter;
3. creates the repo-agent renderer and API request directly from typed fields;
4. prints the existing formatted human-readable output.

`RepoAgentCommand.runTtyStart` passes the typed invocation directly to this
runner. It does not reconstruct argv and no second parser handles repo-agent.

Remove agent-only synopsis/help/default branches from the generic argument and
repo-search modules. Top-level help reuses the canonical repo-agent invocation
exported by repo-agent help metadata.

## Error Handling

- A live state lease causes a clear concurrency error and no state write.
- A malformed lease fails closed.
- A dead-owner lease is removed and acquired by the recovering process.
- State lease cleanup failure is surfaced; it is not silently ignored.
- Stream inactivity causes the worker to record terminal failure.
- State and result files continue to be validated through Zod-derived types.

## Testing and Verification

Implementation follows strict RED-GREEN-REFACTOR cycles:

1. add cross-process store concurrency and stale-lease tests;
2. add inactivity-versus-total-duration tests;
3. add typed foreground runner tests proving no argv reconstruction or generic
   repo-agent parser path remains;
4. delete the legacy wrapper and make the tests green;
5. run focused tests, typecheck, full suite, coverage for changed production
   files, and build.

Temporary concurrency fixtures remain below one `.tmp` directory and are
removed after verification.

## Non-Goals

- changing repo-agent CLI syntax or JSON result shapes;
- adding a public timeout option;
- changing repo-search approval behavior;
- preserving the shared legacy wrapper;
- durable execution across machine restarts.
