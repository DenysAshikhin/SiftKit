# Typed Native Git Tool Implementation Plan

**Status:** Implemented 2026-08-23

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute each task in order. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the raw `{ command: string }` Git planner surface with a strict operation-based native Git tool that cannot express shell syntax, repository mutation, or out-of-repository access.

**Architecture:** `GitToolArgsSchema` defines the planner contract and derives `GitToolArgs`. `ReadOnlyGitTool` validates repository-scoped paths, constructs fixed Git argv, scrubs all `GIT_*` environment variables, and invokes `spawnDirectCommand` without a shell. The normal native repo-tool pipeline executes it; the Git-specific command normalization, PowerShell safety gate, and fallback execution path are deleted completely.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js child processes, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-02-typed-native-git-tool-design.md`

## Global Constraints

- Work inline; do not use worktrees or SiftKit.
- Use strict TDD: observe the intended failure before each production change.
- Do not commit unless explicitly requested.
- No `any`, assertions, non-null assertions, unknown laundering, namespace imports, or dynamically passed functions.
- Remove the Git command-string path completely; no compatibility parser or fallback remains.
- Preserve the separately approval-gated `run` tool and its PowerShell behavior.
- Preserve unrelated working-tree changes.

---

### Task 1: Canonical Git argument schema and generated planner contract

**Files:**
- Modify: `src/repo-search/repo-tool-arguments.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Test: `tests/repo-tool-arguments.test.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`

**Interfaces:**
- Produces: `GitToolArgsSchema`, `GitToolArgs`, and a `git` member of `RepoNativeToolCallSchema`.
- Produces: planner parameters derived from `z.toJSONSchema(GitToolArgsSchema)`.

- [x] **Step 1: Add failing schema tests**

Cover all seven operations with representative valid payloads. Reject empty refs/patterns, refs beginning with `-`, ASCII controls, unknown fields, missing operation fields, non-positive limits, incomplete blame ranges, and `startLine > endLine`. Assert that `{ command: 'git status' }` fails.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js repo-tool-arguments repo-search-planner-protocol
```

Expected: failure because `GitToolArgsSchema` does not exist and the planner still exposes `command`.

- [x] **Step 3: Implement the strict discriminated union**

Define these exact operations:

```ts
type GitToolArgs =
  | { operation: 'status' }
  | { operation: 'log'; limit?: number; ref?: string; path?: string; patches?: boolean }
  | { operation: 'show'; ref: string; path?: string }
  | { operation: 'diff'; base?: string; target?: string; path?: string }
  | { operation: 'blame'; path: string; startLine?: number; endLine?: number }
  | { operation: 'grep'; pattern: string; ref?: string; path?: string; ignoreCase?: boolean; limit?: number }
  | { operation: 'ls_files'; path?: string; limit?: number };
```

Derive the type with `z.infer`; enforce the paired blame range with `.superRefine`. Add `git` to `RepoNativeToolCallSchema`.

- [x] **Step 4: Generate the planner schema**

Parse `z.toJSONSchema(GitToolArgsSchema)` through `JsonObjectSchema` and use the result as the `git` tool parameters. Change the description to name the seven operations and remove command examples.

- [x] **Step 5: Verify GREEN**

Run the Task 1 command and require all selected tests to pass.

---

### Task 2: Native read-only Git executor

**Files:**
- Create: `src/repo-search/engine/read-only-git-tool.ts`
- Modify: `src/repo-search/engine/repo-tools.ts`
- Test: Create `tests/read-only-git-tool.test.ts`
- Test: `tests/repo-tools.test.ts`

**Interfaces:**
- Produces: `class ReadOnlyGitTool { execute(args: GitToolArgs): Promise<RepoToolExecution> }`.
- Produces: deterministic synthetic command text for logs, fingerprints, mocks, and transcripts.

- [x] **Step 1: Add failing execution tests**

Create temporary repositories and test every operation through the real Git executable. Assert status, bounded log, show, diff, blame ranges, grep, and ls-files output. Assert rejection of absolute paths, traversal, ignored paths, sibling-prefix escapes, option-shaped refs, and option-shaped paths.

- [x] **Step 2: Add failing argv/environment tests**

Expose a pure `buildReadOnlyGitInvocation(repoRoot, ignorePolicy, args)` returning `{ args, env }`. Assert every argv starts with:

```ts
['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '--no-optional-locks']
```

Assert diff-family operations include `--no-ext-diff` and `--no-textconv`; path lists use `--`; grep uses `-e`; and no `GIT_*` key remains in `env`.

- [x] **Step 3: Verify RED**

Run:

```powershell
npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js read-only-git-tool repo-tools
```

Expected: module-not-found or missing-export failure.

- [x] **Step 4: Implement invocation construction**

Use one explicit `switch` over `args.operation`. Resolve paths with the repository path guard used by native file tools, reject ignored paths, build fixed argv, and scrub `GIT_*` from a string-valued copy of `process.env`.

- [x] **Step 5: Implement execution**

Invoke `spawnDirectCommand('git', invocation.args, { cwd: repoRoot, abortSignal, env })`. Return the exit code and output in the normal `RepoToolExecution` shape, including the deterministic synthetic command.

- [x] **Step 6: Wire `executeRepoTool`**

Add the `git` switch branch to `executeRepoToolUnguarded`; no command string reaches the executor.

- [x] **Step 7: Verify GREEN**

Run the Task 2 command and require all selected tests to pass.

---

### Task 3: Native pipeline integration and legacy-path deletion

**Files:**
- Modify: `src/lib/model-json.ts`
- Modify: `src/repo-search/engine/pending-tool-call-message.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/repo-search/engine/command-execution.ts`
- Modify: `src/repo-search/command-safety.ts`
- Modify: `src/repo-search/index.ts`
- Test: `tests/model-json.test.ts`
- Test: `tests/engine-tool-action-processor.test.ts`
- Test: `tests/command-execution.test.ts`
- Delete: `tests/command-safety.test.ts`

**Interfaces:**
- `git` is parsed by `RepoNativeToolCallSchema` like every other native tool.
- `executeRepoCommand` remains only for `run` and never recognizes Git specially.
- `command-safety.ts` retains only ignore-policy construction.

- [x] **Step 1: Add failing boundary tests**

Assert model JSON accepts typed Git and rejects legacy `command`. Assert the processor executes a typed status call and rejects malformed Git args before execution. Assert Git is reported as native in the turn log.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js model-json engine-tool-action-processor command-execution
```

Expected: typed Git is rejected or handled as a command tool.

- [x] **Step 3: Remove command-tool classification**

Delete `REPO_COMMAND_TOOL_NAME`, `isRepoSearchCommandToolName`, `getRepoSearchCommandTokenForToolName`, `normalizeRepoSearchCommandForToolName`, and `getRepoSearchToolNameForCommand`. Make `isRepoSearchNativeToolName` recognize Git through the registry.

- [x] **Step 4: Simplify the parser and pending-message identity**

Delete the Git command branch from `ModelJson.normalizeRepoSearchToolCall` and from pending-message resolution. Both parse the canonical native call.

- [x] **Step 5: Simplify the processor**

Remove command-tool fields and safety screening. Every planner tool except `run` executes from a typed native call; `run` remains approval-gated and uses its existing shell executor.

- [x] **Step 6: Delete the shell safety implementation**

Remove `evaluateCommandSafety`, `SafetyResult`, Git tokenization, pipeline allow-lists, and Git direct-spawn parsing. Keep `buildIgnorePolicy`. Remove the public safety exports and delete obsolete tests.

- [x] **Step 7: Verify GREEN**

Run the Task 3 command and require all selected tests to pass.

---

### Task 4: Transcript, duplicate, prompt, fixture, and documentation migration

**Files:**
- Modify: `src/tool-loop-governor.ts`
- Modify: `src/repo-search/prompts.ts`
- Modify: `tests/**/*.test.ts` and `tests/helpers/**/*.ts` wherever Git actions are constructed
- Modify: `README.md` and active documentation that describes the planner Git contract

**Interfaces:**
- Fingerprints use canonical `{ toolName: 'git', args }` JSON.
- Blank-line preservation uses the typed Git operation or unified-diff output shape.
- Fixtures use `{ action: 'git', operation: ... }`, never `command`.

- [x] **Step 1: Add failing governor tests**

Assert typed `show` preserves blank lines, typed `log` removes decorative blank lines, typed `diff` preserves unified-diff context, and equivalent typed calls fingerprint identically.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js tool-loop-governor repo-search-prompts approval-verdict-prefix
```

Expected: the governor still requires Git command strings and prompt fixtures still advertise them.

- [x] **Step 3: Migrate governor behavior**

Use `GitToolArgs` operation information instead of parsing command text. Preserve blank lines for `show` and unified diffs; filter decoration elsewhere.

- [x] **Step 4: Migrate prompts and fixtures**

Replace raw examples with typed examples such as `{"action":"git","operation":"status"}` and `{"action":"git","operation":"grep","pattern":"planner","path":"src"}`. Convert mocks to use deterministic synthetic Git command keys.

- [x] **Step 5: Remove stale architecture guards**

Update structural tests to assert that Git is native and that no Git command-string/safety path remains.

- [x] **Step 6: Verify GREEN**

Run the Task 4 command plus every test file touched during migration.

---

### Task 5: Completion gate

**Files:** none expected beyond fixes required by verification.

- [x] **Step 1: Prove legacy removal**

```powershell
rg -n "isRepoSearchCommandToolName|normalizeRepoSearchCommandForToolName|evaluateCommandSafety|READ_ONLY_GIT_SUBCOMMANDS|parseDirectSpawnCommand|command-string tool" src tests
```

Expected: no matches.

- [x] **Step 2: Focused tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-tool-arguments read-only-git-tool repo-tools model-json engine-tool-action-processor tool-loop-governor repo-search-loop repo-search-status-server approval-verdict-prefix
```

- [x] **Step 3: Full validation**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: zero failures and zero diagnostics.

- [x] **Step 4: Review scope**

Confirm only typed-Git implementation/tests/docs plus pre-existing user changes are present. Do not stage or commit.
