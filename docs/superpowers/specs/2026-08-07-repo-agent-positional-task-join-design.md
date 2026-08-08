# Repo-Agent Positional Task Join Design

Supersedes the "exactly one positional task" rule in
`docs/superpowers/specs/2026-07-28-repo-agent-auto-default-positional-cli-design.md`
(lines 22 and 40-42). Every other clause of that contract stands.

## Problem

Windows PowerShell 5.1 builds the native command line for `siftkit` by wrapping
each argument in double quotes without escaping the double quotes already inside
the string. `CommandLineToArgvW` then re-splits on those stray quotes, so one
argument arrives as several.

Observed, PowerShell 5.1.26100.8875:

```text
PS> node -e "console.log(JSON.stringify(process.argv.slice(1)))" 'Implement ONLY "Task 1: Add widget" from docs/plan.md'
["Implement ONLY Task","1:","Add","widget from docs/plan.md"]

PS> siftkit repo-agent 'Implement ONLY "Task 1: Add widget" from docs/plan.md.'
Expected exactly one positional task; found multiple.
EXIT=1
```

The error comes from `src/cli/repo-agent-args.ts:115-117`: `parseStartInvocation`
assigns the first non-flag token to `task` and rejects any second one.

Single quotes are not the trigger. `'plain text with spaces'` survives intact as
one argv entry. The trigger is the embedded `"` characters, which the canonical
repo-agent dispatch template (`Implement ONLY "<task heading>" from <plan path>`)
always produces.

SiftKit cannot recover the original string. Node sees only the post-split
`process.argv`; the raw command line is unreachable without a native
`GetCommandLineW` binding.

## Decision

Join the positional tokens.

`parseStartInvocation` accumulates every non-flag token and joins the non-empty
ones with a single space. The multiple-task rejection is removed. No new input
channel, no new flag.

Because the join silently alters the caller's text, a start invocation that
consumed more than one positional token emits a two-line note on stderr and then
proceeds.

## Contract

### Task assembly

| argv after the shell splits it | resulting `task` |
| --- | --- |
| `["fix login"]` | `fix login` |
| `["Implement ONLY Task","1:","Add","widget from p.md"]` | `Implement ONLY Task 1: Add widget from p.md` |
| `["fix login","--progress"]` | `fix login`, `progress` = true |
| `["a","","b"]` | `a b` |
| `[]` | throws `No task provided. Usage: siftkit repo-agent "task"` |

Empty tokens are dropped before the join, so a stray empty argument never
produces a double space. The existing `.trim().min(1)` on
`RepoAgentStartInvocationSchema.task` still rejects an all-whitespace result.

### Flag handling is unchanged

Options remain parseable before or after the task, because
`siftkit repo-agent "task" [options]` is the published canonical invocation and
callers rely on trailing options. Every existing rejection stands: `--prompt`
and `-prompt`, unknown options, missing option values, invalid `--approval`
values, and the `decide` and `status` subcommand rules.

### Diagnostic

When a start invocation consumed more than one positional token,
`src/cli/dispatch.ts` writes to stderr, before the run begins:

```text
note: joined 4 command-line tokens into one task; embedded double quotes were lost to shell argument splitting.
  task: Implement ONLY Task 1: Add widget from docs/plan.md
```

stdout, the resumable JSON result, and the exit code are untouched. The note is
informational, not a failure.

The token count reaches dispatch as data, not through an injected writer:
`RepoAgentStartInvocationSchema` gains a required
`taskTokenCount: z.number().int().min(1)` field, set by the parser. The parser
stays pure and directly testable; dispatch owns all output. Making the field
required rather than defaulted means any construction site that forgets it fails
to compile or fails schema validation.

## Accepted losses

These are consequences of the decision, not defects:

- The caller's `"` characters do not reach the agent. The task arrives as
  unquoted prose.
- A run of whitespace at a split point collapses to a single space.
- `siftkit repo-agent "task one" "task two"` is no longer an error. It becomes
  the task `task one task two`.
- A dash-leading word inside the task text is still consumed as a flag. Given
  `'Implement ONLY "Task 3: harden --progress output" from docs/plan.md'`, the
  shell yields
  `["Implement ONLY Task","3:","harden","--progress","output from docs/plan.md"]`
  and `--progress` is parsed as the flag, so the word disappears from the task.
  If the dash-leading word is not a known option the run fails with
  `Unknown option:`. This is the reason the stderr note exists; the note fires
  in exactly this situation, and the printed task shows the caller what the
  agent will actually receive.

## Components

`src/cli/repo-agent-args.ts`
: `parseStartInvocation` replaces the `task: string | undefined` slot with a
  `string[]` accumulator, drops the `Expected exactly one positional task`
  throw, joins at the end, and reports `taskTokenCount`.
  `RepoAgentStartInvocationSchema` gains `taskTokenCount`.

`src/cli/dispatch.ts`
: At the existing `parseRepoAgentInvocation` call site (lines 73-75), emits the
  note to the `stderr` stream already in scope when the parsed invocation is a
  start with `taskTokenCount > 1`.

No other module reads or constructs a start invocation:
`src/cli/run-repo-agent.ts`, `src/cli/run-repo-agent-foreground.ts`, and
`src/cli/repo-agent-command.ts` consume the type opaquely.

## Testing

`tests/repo-agent-args.test.ts`
: `rejects two positional tasks` (lines 166-171) asserts the contract being
  removed and is replaced by a test that two positionals join. Add a regression
  test feeding the literal argv array captured from the PowerShell repro above
  and asserting both the joined task and `taskTokenCount === 4`. Add an
  empty-token case. Existing deep-equal assertions on parsed start invocations
  (lines 20, 29, 41, 64) gain `taskTokenCount`. `rejects unknown option`
  (line 187) already pins trailing-flag parsing and stays as written.

`tests/repo-agent-foreground.test.ts`
: The two `RepoAgentStartInvocationSchema.parse` literals (lines 105 and 140)
  gain `taskTokenCount`.

`tests/repo-agent-cli.test.ts`
: One case using the file's existing `runCli` plus mock-server harness (the
  `complete` server mode) asserting the stderr note fires for a multi-token
  start, is absent for a single-token start, and that stdout carries the same
  result JSON in both. The note is written immediately after
  `parseRepoAgentInvocation` and therefore before the server preflight, so it
  survives a preflight failure.

Verification before completion: `npm run test`, `npm run typecheck`,
`npm run lint`, plus a manual PowerShell 5.1 run of the original failing command
confirming it now starts.

## Rejected alternatives

`--task-file <path>`
: Lossless in every shell and free of stdin coupling, but adds a second input
  channel and requires the caller to write a file for what is one line of prose.

Task on stdin
: Lossless and file-free, but piping makes stdin non-TTY, which forecloses
  `--approval interactive` for that invocation form.

Documentation only
: Zero risk and zero benefit to a caller who writes the natural form. The trap
  stays live.

An improved error instead of a join
: Explains the failure but still costs the caller a retry on every dispatch.
