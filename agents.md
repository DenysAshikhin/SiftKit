Make sure to make code as succint and straightforward as possible. 

Do not pass functions around dynmically. Functions should be explicit.

Re-use as much code/components as possible.

Avoid overengineering of solutions where not 100% necessary.

Ensure as close to 100% branch coverage as possible.

Follow TDD (Test Driven Development) exclusively.

Avoid shims/legacy/backwards support. Instead aim to have things 111111111111refactored if necessary to be first-class citizen

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
  - help (`-h`, `--help`, etc.)

### When to Use `siftkit repo-search`
- Use for repo exploration questions (symbol lookup, usages, call paths, config/tooling lookup).
- Default form:
  - `siftkit repo-search --prompt "<specific extraction question>"`

### When to Use `siftkit summary`
- Use when a shell command produces output that needs interpretation/extraction.
- Always pipe command output into summary:
  - `<command> 2>&1 | siftkit summary --question "<specific extraction question>"`
- `siftkit summary` requires one of: stdin, `--text`, or `--file`.

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
- `rg -n "buildPlannerToolDefinitions|invokePlannerMode" src tests 2>&1 | siftkit summary --question "extract definition and usage file:line entries"`
- `git diff 2>&1 | siftkit summary --question "summarize behavioral changes and risks"`
- `npm test 2>&1 | siftkit summary --question "did tests pass? list failing suites and root causes"`
- `Get-Content .\logs\app.log -Tail 400 2>&1 | siftkit summary --question "extract errors with timestamps as JSON"`

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
