# Typed Native Git Tool Design

**Status:** Approved 2026-08-02

## Purpose

Replace repo-search's raw PowerShell-backed Git command surface with one typed `git` tool that supports the repository-inspection operations the planner needs. The design must remove shell injection, prevent Git mutations and out-of-repository access by construction, and preserve a single planner tool rather than adding one tool per Git subcommand.

## Public tool contract

The planner continues to receive one tool named `git`. Its arguments are a strict discriminated union with these operations:

- `status`: working-tree status.
- `log`: bounded commit history, optionally scoped to one repository path and/or starting ref.
- `show`: one commit or one file at a commit.
- `diff`: repository diff, optionally between two refs and/or scoped to one path.
- `blame`: one repository file, optionally limited to an inclusive line range.
- `grep`: one pattern over tracked content, optionally scoped by ref and path.
- `ls_files`: tracked file paths, optionally beneath one repository path.

Operation-specific fields are expressed through `z.discriminatedUnion('operation', ...)`. `GitToolArgs` is derived exclusively with `z.infer<typeof GitToolArgsSchema>`. The schema is strict: unknown fields, missing required fields, invalid line ranges, empty text, and non-positive limits fail at the boundary.

The planner-facing JSON schema is generated from `GitToolArgsSchema` with Zod 4's built-in JSON-schema conversion. No manually duplicated Git argument schema remains.

## Execution architecture

`git` becomes a native repo tool alongside `read`, `grep`, `find`, and `ls`:

1. Model output is parsed and validated by `GitToolArgsSchema`.
2. `ReadOnlyGitTool` resolves every supplied path against the repository root using the existing repository-scoped path resolver.
3. An explicit `switch` over `operation` builds a fixed argv array. Planner text never supplies an executable, Git subcommand, option name, pipeline, redirection, or shell fragment.
4. The tool invokes `spawnDirectCommand('git', argv, { cwd, abortSignal, env })`, where `env` is the scrubbed full-replacement environment described above (`spawnDirectCommand` treats a provided `env` as the child's entire environment).
5. Standard repo-tool result fitting, transcript insertion, duplicate tracking, and metrics consume the resulting `RepoToolExecution`.

Every argv begins with `-c core.fsmonitor=false -c diff.external= --no-optional-locks`, and the diff-family operations (`diff`, `show`, `log` with patches, `blame`) additionally pass `--no-ext-diff --no-textconv`. This is deliberate belt-and-braces: options such as `--output`, `--ext-diff`, pager configuration, hooks, aliases, `-C`, `--git-dir`, and `--work-tree` cannot be expressed by the planner, but `diff.external`, `diff.*.textconv`, and `core.fsmonitor` are honoured from repository/user configuration *by default*, so unexpressible is not the same as disabled. The `-c` overrides and `--no-*` flags force them off regardless of what any config file says.

The child environment is constructed, not inherited: `spawnDirectCommand`'s `env` option replaces the entire environment, and the git tool passes a copy of `process.env` with every `GIT_*` variable removed (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_CONFIG_*`, ...), so an inherited variable can neither redirect the repository nor execute a configured program.

## Removal of the legacy command path

This is a complete replacement, not compatibility work:

- Remove the `{ command: string }` Git contract.
- Remove Git-specific command-token detection and command-string normalization.
- Remove `evaluateCommandSafety` and its PowerShell producer/filter allow-lists.
- Remove the repo-search PowerShell execution fallback and its command-string mock path.
- Remove PowerShell pipeline support for Git.
- Update prompts, replay messages, mocks, logging, tests, and documentation to use typed Git arguments and the normalized synthetic command produced by the native tool.

The interactive `run` tool remains separate and approval-gated. This design does not change its PowerShell execution behavior.

## Path and ref rules

Every `path` is resolved against the canonical repository root. Absolute paths, traversal outside the root, and ignored paths are rejected before Git runs.

Refs are passed as argv values, never concatenated with a path. A ref must be non-empty, must not begin with `-`, and must not contain NUL or ASCII control characters. `show` uses separate `ref` and `path` fields and constructs the object expression only after both fields pass validation.

The same option-injection rule extends to every planner-supplied positional, not only refs: `grep` passes its pattern behind `-e` (a pattern like `--open-files-in-pager=<cmd>` must arrive as a pattern, never as an option), and every path list is separated from options by a literal `--`. No planner string is ever placed where git could parse it as an option name.

`blame` requires `path`. If either line boundary is supplied, both are required and `startLine <= endLine`.

## Duplicate and mutation state

Duplicate history becomes run-wide. Until the typed Git conversion is complete, every accepted command-shaped `git`/`run` call conservatively clears duplicate history because the existing gate cannot prove immutability. After Git becomes native, Git no longer clears read or duplicate state because its fixed operations cannot mutate the tree.

Successful native `write` and `edit` calls clear duplicate history and invalidate the affected read path. `run` clears all read and duplicate state on every completion because a failing process may still have mutated the tree.

## Other validated corrections in the implementation plan

The implementation plan also covers the independently reproduced repo-tool defects:

- `**/` spans zero or more directories.
- Scoped `find` applies root-relative ignore paths in the correct coordinate frame.
- Empty tool output does not increment `newEvidenceCalls`.
- `find` and `ls` share one deterministic comparator.
- Every exposed `limit`, including `read`, rejects non-positive values; planner schemas declare `minimum: 1`.
- Read line splitting removes exactly one terminator-created trailing entry and represents a zero-byte file as zero lines.

## Error handling

Invalid model arguments produce a rejected native tool result and never reach process execution. Git exit codes remain visible through the existing result path. Empty successful output remains a successful result but contributes no evidence key. No fallback converts invalid typed arguments into legacy command execution.

## Testing

Testing is TDD-first and includes:

- Schema tests for every operation, required/forbidden fields, positive limits, line ranges, unknown fields, malicious command-shaped text, and generated JSON-schema parity.
- Native execution tests asserting exact executable/argv/cwd/env values through the existing command-spawn boundary.
- End-to-end repo-search loop tests for representative Git operations and transcript replay.
- Negative tests proving that mutations, shell operators, pipelines, `-C`, out-of-root paths, sibling-prefix paths, external diff/pager execution, and arbitrary option injection cannot be represented.
- Regression tests for every validated glob, ignore, duplicate, novelty, ordering, limit, and line-count finding.

The affected suites, typecheck, lint, full tests, build, and one live repo-search smoke run form the completion gate.
