# Agent command containment and background jobs

## Goal

1. **Containment:** no command an agent starts leaves a process behind or exhausts the status server's memory, apart from the cases under Escapes.
2. **Background jobs:** an agent can start a long command, keep working, and collect the result later, under the same guarantees.

Part 2 is built on Part 1 and is not started until Part 1's tests pass.

## Why

Measured on 2026-11-24 against `src/lib/captured-command.ts` and `src/lib/powershell.ts` at `904137b6`:

| Case | Result |
|---|---|
| A command uses `Start-Process` and exits normally | The started process keeps running |
| A timeout fires after an intermediate process already exited | The grandchild keeps running |
| A command prints 200 MB | Capturing process grows by 311 MB |
| A command prints 600 MB | `RangeError: Invalid string length` in the `data` handler; the capturing Node process dies |

- `terminateProcessTree` walks parent ids. A process whose parent has exited is unreachable, so no tree walk can be complete.
- `runCapturedCommand` appends to a string without a limit. `src/` has no `uncaughtException` handler, so the same error in the status server ends it.
- `run` blocks for up to 10 minutes (`MAX_RUN_TIMEOUT_MS`), and the agent can do nothing else meanwhile.

Of 1,268 `run` calls in 77 repo-agent runs since 2026-11-10, at least 5 were killed by SiftKit's time limit, all in two runs. Long commands do hit the limit today, but rarely.

## Part 1: containment

### Job object

Every agent shell puts itself in a Windows job object before it runs the agent's command. The kernel destroys the job, and everything in it, when its last handle closes. The shell holds the only handle, so any end of the shell ends the job.

A spike confirmed this:

| Case | Processes left |
|---|---|
| Shell exits normally, with a detached child and an orphaned grandchild | 0 of 2 |
| Only the shell is killed | 0 of 2 |
| The Node process that spawned the shell is force-killed, not its tree | 0 of 2 |
| A 2 GB allocation under a 600 MB job limit | Refused |
| A process created through WMI | **Survives** |

`src/lib/agent-command.ts` (new) owns this:

- `spawnAgentCommand(command, options)` is the only way to start an agent command. It prepends the job prelude to the existing PowerShell invocation and calls `runCapturedCommand`.
- The prelude compiles a small P/Invoke class with `Add-Type`, creates an unnamed job, and assigns the current process to it. Measured cost: 0.23 to 0.32 s per command.
- Limits: `KILL_ON_JOB_CLOSE`, `JOB_MEMORY` (`AGENT_JOB_MEMORY_GIB = 16`) and `ACTIVE_PROCESS` (`AGENT_JOB_MAX_PROCESSES = 128`). `BREAKAWAY_OK` is not set.
- The job handle is not inheritable and is not kept in any variable. The agent's command runs in the same shell, so this contains accidents, not code written to defeat it.
- The shell is not spawned `detached`. Node's own job then ends it when the server dies, which the force-kill row above depends on.
- **Fail closed:** if the prelude fails, the command does not run. The result is exit code 125 with the prelude's error.

Callers that move to `spawnAgentCommand`: `executeRun` (`src/repo-search/engine/repo-tools.ts`), `runVerificationCheck` (`src/orchestrator/verification.ts`), and `check-preflight.ts`. `dpapi.ts` keeps `spawnPowerShellAsync`: it runs no agent input.

For these callers, ending a command kills the shell and the job takes the rest. The tree walk stays for `runCapturedCommand`'s other callers.

**Confirmed exit:** a command is over when its shell has exited and its stdio pipes have closed, or 2 s (`STDIO_DRAIN_GRACE_MS`) after the shell exits if they have not. In the second case the result carries a warning and `serverLogger` records `agent_command_pipes_open` with the pid: something outside the job still holds them. Pipes, timers and listeners are released either way, so a command always ends.

### Bounded output

`runCapturedCommand` gains a required `output` policy:

| Policy | Callers | Behaviour |
|---|---|---|
| `{ kind: 'window', headBytes, tailBytes }` | Agent commands | Per stream, keeps the first 2 MiB and the last 6 MiB (16 MiB for both), with one line stating how many bytes were dropped |
| `{ kind: 'limit', bytes }` | `git`, `rg`, `nvidia-smi`, DPAPI | Past 64 MiB on one stream, the process is killed and the call fails with an error naming the limit |

- A parsed output (`git ls-files -z`) must never be silently cut, so those callers fail instead.
- Captured bytes are stored as `Buffer` chunks in a ring and decoded once at the end; a partial UTF-8 sequence at a cut is dropped.
- The 64 MiB limit is new for `git` and `rg`: today a larger output is returned whole.
- The output digest (`src/output-digest/`) reads the window. A failure that falls in the dropped middle is not in the digest, and the drop line says so.

### Escapes

Processes created by WMI, Task Scheduler, the service manager or Docker are children of another service, outside any job SiftKit can create. `findShellCommandProblem` (`src/repo-search/engine/shell-command-policy.ts`) refuses the direct forms:

- `Invoke-CimMethod` or `Invoke-WmiMethod` on `Win32_Process`, and `wmic process call create`
- `schtasks /create` and `Register-ScheduledTask`
- `New-Service` and `sc create`
- `docker run -d` and `docker compose up -d`

This is text matching. It catches ordinary use, not a determined script, and the message says what to use instead.

### Behaviour change

Anything a command leaves running ends with the command. An agent that starts a dev server with `Start-Process` and uses it from a later `run` must use a background job instead. `RUN_SHELL_GUIDANCE` states this.

## Part 2: background jobs

### Tools

- `run` gains `background: boolean` (default false). With `true` it returns at once with a job id.
- `timeoutMs` for a background run: default 30 minutes, maximum 60. The foreground maximum stays 10 minutes.
- `outputMode` is refused together with `background: true`; `job` output uses the same shaping as `run` with `auto`.
- New tool `job`, a discriminated union on `action`:

| Action | Arguments | Result |
|---|---|---|
| `wait` | `jobId`, `waitMs` (default 2 minutes, maximum 10) | The result when the job ends; otherwise status and output tail when the wait ends |
| `output` | `jobId` | Status, elapsed time and output tail |
| `stop` | `jobId` | Stops the job and returns its output tail |
| `list` | none | Every job of this run |

- `run` with `background: true` goes through the same screening and approval as any `run`. The review payload states that it runs in the background and for how long.
- `job` needs no approval: it can only read or stop what was already approved. It joins the approval-exempt tools.
- Identical `job` calls are not duplicates. `job` is excluded from the duplicate tracker, and a `wait` that returns because its time ended does not count as a failed call.
- `job` results count as tool calls against the turn limit, like any other tool.
- Granting `run` grants `job`. Repo-search, summary and the orchestrator parent get neither `background` nor `job`.

### Ownership

`BackgroundJobs` (`src/repo-search/engine/background-jobs.ts`, new) owns every job of one run. `RepoAgentSession.run()` creates it before the engine starts and awaits `dispose()` in its `finally`, **before** the model lock and the repository lease are released. A child's changed-files diff is therefore taken with nothing still writing.

`dispose()`:

1. refuses new jobs;
2. kills every running job's shell;
3. awaits each job's confirmed exit;
4. clears timers and listeners and empties the map.

It is idempotent, and it runs on every end of the run: finish, failure, abort, approval timeout and turn limit.

`BackgroundJobSlots` on `ServerContext` caps the server at 4 running jobs. Each run may have 2. A third is refused with the ids of the running ones. A slot is released at confirmed exit, as defined above, not when the kill is sent.

**Server end:** an orderly shutdown aborts sessions, which dispose their jobs. If the server dies, the kernel ends each shell with its parent, and each job with its shell. Nothing is persisted, and no job resumes after a restart.

### Memory

- A running job holds one output window (16 MiB at most). Four per server bound background output at 64 MiB. Each foreground command holds one more window while it runs.
- When a job ends, its output is shaped and digested once, and the window is dropped. Only the shaped result stays.
- A run keeps the results of its last 8 finished jobs. Asking for an older one says it was dropped.

### The agent's view

- **Finishing:** `handleFinishAction` refuses the first finish while a job is running, naming the job. A second finish is accepted; the job is killed, and the run's result says so.
- **Turn limit and forced finish:** the job is killed and the result says so; there is no refusal.
- **Compaction:** the compacted prompt lists each job's id, command, status and elapsed time.
- **Changes during a job:** a result names files this run wrote with `edit` or `write` while the job ran. Files changed by other commands are not tracked.
- **Model lock:** `job wait` holds the lock as `run` does. One wait is at most 10 minutes, under the 60-minute inactivity ceiling.

## Failure cases

| Case | Behaviour |
|---|---|
| Prelude cannot compile or assign the job | Exit code 125; the command never runs |
| Job exceeds its memory limit | Its allocation fails; the program reports its own error |
| Job exceeds its time | Killed; status `timed_out`, exit code 124 |
| `stop` on a finished job | Returns the stored result |
| Unknown job id | Refused, listing known ids |
| Pipes still open 2 s after a shell exits | Warning and `agent_command_pipes_open`; counts as exited, so the run still ends |
| Not Windows | `spawnAgentCommand` throws. Agent commands are already PowerShell-only |

## Testing

Real processes, no mocks, for containment.

**Endings.** For each of: normal finish, failure, user abort, command timeout, `job stop`, approval denied, approval timeout, turn limit, server shutdown and a force-killed server. Start a job (for the approval cases, one approved earlier in the run) with a detached child and an orphaned grandchild. Afterwards there must be no such processes, no armed timers, no abort listeners, no map entries and no used slots.

**Soak.** 500 sequential jobs, a mix of short, 100 MB output and 20-child ones. Afterwards server heap (after a forced collection), handle count and child process count are within 5% of a baseline taken after the first 20 jobs. Opt-in, in the `--process` suite.

**Output.** At, under and over each limit; a 600 MB command completes with the server alive; a multi-byte character across each window edge; a `limit` caller fails without a partial result.

**Behaviour.** Background result equals the foreground result of the same command; per-run and per-server caps; finish refused once and then accepted; job list after compaction; changed-during-job note; identical `wait` calls not rejected; escape forms refused with their replacements; exit code 125 on a broken prelude.

**Independent review.** After the suite passes, a fresh non-Fable reviewer gets the diff and one instruction: leak a process or memory. The escapes listed above are known and excluded. Every confirmed leak becomes a failing test before it is fixed.

## Out of scope

- Jobs that outlive their run, or survive a restart
- Job input, interactive processes and port management
- Containing WMI, Task Scheduler, services and Docker beyond the refusals above
- Configurable limits: they are constants until a real run needs otherwise
