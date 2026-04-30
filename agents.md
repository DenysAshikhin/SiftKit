Make sure to make code as succint and straightforward as possible. 

Do not pass functions around dynmically. Functions should be explicit.

Re-use as much code/components as possible.

Avoid overengineering of solutions where not 100% necessary.

Ensure as close to 100% branch coverage as possible.

Follow TDD (Test Driven Development) exclusively.

Avoid shims/legacy/backwards support. Instead aim to have things refactored if necessary to be first-class citizen

Make sure everything is typescript and typed. Ensure everything possible has explicit types and avoid unknown/generics/any wherever possible.

AVOID worktrees.

Ensure code is abstraced into re-usable classes.

Do not pass functions around dynmically. Functions should be explicit.

## Response style

Default to ultra-concise technical communication.

Rules:
- No pleasantries, filler, or motivational language.
- No long intros or summaries unless requested.
- Prefer short, information-dense sentences.
- Keep code, commands, paths, logs, error text, and exact technical identifiers unchanged.
- Preserve correctness over brevity.
- When giving fixes, lead with cause and action.
- Use bullets only when they improve scanability.
- Do not roleplay or add humor unless asked.

Compression target:
- Say minimum needed to be correct and useful.

## SiftKit-First Command Policy (Required)

### Core Rule
- For discovery, search, logs, diffs, and test-output interpretation, agents MUST use `siftkit` first.
- Allowed public `siftkit` commands are:
  - `siftkit summary ...`
  - `siftkit repo-search ...`
  - `siftkit run ...`
  - help (`-h`, `--help`, etc.)

### When to Use `siftkit repo-search`
- Use for repo exploration questions (symbol lookup, usages, call paths, config/tooling lookup).
- Default form:
  - `siftkit repo-search --prompt "<specific extraction question>"`

### When to Use `siftkit summary`
- Use when output already exists (stdin, `--text`, or `--file`) and only needs interpretation/extraction.
- `siftkit summary` requires one of: stdin, `--text`, or `--file`.
- Pipe form (works in bash; in PowerShell only on simple pipelines, NOT after `if`/`foreach`/script blocks):
  - `<command> 2>&1 | siftkit summary --question "<specific extraction question>"`

### When to Use `siftkit run`
- Use whenever the agent needs to *execute* a command and have its combined stdout+stderr summarized. This is the canonical, shell-agnostic pattern — no `2>&1` needed.
- Plain command form (no shell, cross-platform):
  - `siftkit run --command "<exe>" --arg "<a1>" --arg "<a2>" --question "<...>"`
- Shell-script form (when you need pipes, redirects, `if`/`else`, env-var assignment, etc.):
  - `siftkit run --shell auto --command "<full script>" --question "<...>"`
  - `--shell auto` picks `pwsh` (or `powershell`) on Windows and `bash` (or `sh`) on POSIX.
  - Pin the shell explicitly when needed: `--shell pwsh`, `--shell powershell`, `--shell bash`, `--shell sh`, `--shell cmd`.
- Prefer `siftkit run` over the `<cmd> 2>&1 | siftkit summary` pipe form whenever you would otherwise reach for `2>&1`.

### Timeout Requirement
- Any command routed through `siftkit` must be given a 5-minute timeout budget in the agent runner.

### Prompt Quality (Mandatory)
- Prompts must be extraction-oriented and specific.
- Ask for exact fields/format when needed (e.g., JSON arrays, pass/fail verdict, file:line anchors).

### Raw Shell Output Policy
- Broad discovery MUST go through `siftkit` first.
- Raw non-siftkit output is allowed only for narrow follow-up when:
  - target file/path is already known, and
  - exact raw lines are immediately needed for patching/debugging.

### Examples
- `siftkit run --command "rg" --arg "-n" --arg "buildPlannerToolDefinitions|invokePlannerMode" --arg "src" --arg "tests" --question "extract definition and usage file:line entries"`
- `siftkit run --command "git" --arg "diff" --question "summarize behavioral changes and risks"`
- `siftkit run --command "npm" --arg "test" --question "did tests pass? list failing suites and root causes"`
- `siftkit run --shell auto --command "Get-Content .\logs\app.log -Tail 400" --question "extract errors with timestamps as JSON"`
- `siftkit run --shell auto --command "$s = git -C . status --short; if ($s) { $s } else { 'CLEAN' }" --question "extract git status as short entries; if CLEAN, state clean worktree"`
- Pipe form (bash only — fails in PowerShell on script-block expressions): `git diff 2>&1 | siftkit summary --question "summarize behavioral changes and risks"`

### Compliance Check Before Final Answer
- Agent must confirm:
  1. Discovery/search steps used `siftkit`.
  2. Prompts were specific and extraction-oriented.
  3. Any raw-output step was narrow follow-up only.

THESE ARE THE ONLY SCENARIOS WHEN YOU ARE ALLOWED TO NOT USE `siftkit`:
- Do not use `siftkit` if exact uncompressed output is required.
- Do not use `siftkit` if it would break an interactive/TUI workflow.
- Do not use `siftkit` if you are trying to look at the exact code to understand its functionality AND you know exact lines to parse.


Intermediary updates are event-driven, not time-driven.
Send updates only at meaningful milestones: start, before edits, before validation, on blocker, on failure, on completion.
Do not send periodic progress updates while reading, searching, or thinking if there is no new decision or risk.
Prefer silence over low-information commentary.
Keep updates to 1 sentence by default.
