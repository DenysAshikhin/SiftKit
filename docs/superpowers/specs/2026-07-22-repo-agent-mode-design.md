# repo-agent operation mode — design

Date: 2026-07-22
Status: approved (pre-implementation)

## Goal

Add a new first-class operation mode `repo-agent`: a repository coding agent that
extends the existing repo-search surface (read/grep/find/ls/git/web) with the
mutating tools `write`, `edit`, `run`. Human approval is **on by default**
(opt-out via `--no-approval`). The mode ships a pi.dev-style agentic system
prompt (minimal persona + tool list + short guidelines + injected `agents.md`),
distinct from repo-search's read-only search-discipline prompt. Surfaces: CLI + web.

Non-goals: TUI, session/history persistence for the agent, multi-repo, any
backward-compat shim. Existing `repo-search --interactive` behavior is unchanged.

## Background (current architecture)

- CLI `repo-search` → `dispatch` → `run-repo-search.ts` →
  `StatusServerApiClient.requestRepoSearch` → `POST /repo-search`
  (`RepoSearchEndpoint`) → `engineService.executeRepoSearch` →
  `executeRepoSearchRequest` → `runRepoSearch` → task-loop.
- `--interactive` already exposes `write`/`edit`/`run` and creates an
  `ApprovalGate` (`core.ts:866-883`, `planner-protocol.ts:250-251`). Approval is
  parked/resolved via `POST /repo-search/approval`; CLI answers SSE
  `approval_request` events with `CliApprovalPrompter`.
- System prompt: `buildTaskSystemPrompt` (`prompts.ts:210-277`) is a **read-only
  search-discipline** persona (min 5 turns, anchor-bullets output, forbids
  mutation claims, no speculative reads) — wrong shape for an editing agent.
- `task-loop` already honors `systemPromptOverride` (`task-loop.ts:216-221`).
- `executeRepoSearchRequest` derives `taskKind` ∈ {plan, chat, repo-search} and
  only applies `systemPromptOverride` for `chat` (`execute.ts:250-325`).
- `PresetToolNameSchema` (`packages/contracts/src/config.ts:123-127`) does **not**
  list `write`/`edit`/`run`; the interactive surface is enforced server-side, not
  via preset tools. `operationMode:'full'` default tool set is currently `[]`
  (`presets.ts:52-56`).

## Design

### 1. Contracts (`packages/contracts/src/config.ts`)

- Add `'write','edit','run'` to `PresetToolNameSchema` enum.
- Add `'repo-agent'` to `PresetKindSchema` enum.

Both make the mode first-class (no server-only special-casing of the tool set /
kind). `SiftPresetSchema` and `OperationModeAllowedToolsSchema` derive from these
automatically.

### 2. Presets (`src/presets.ts`)

- `export const REPO_AGENT_TOOLS = ['read','grep','find','ls','git','web_search','web_fetch','write','edit','run'] as const` (satisfies `readonly PresetToolName[]`).
- `DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full = [...REPO_AGENT_TOOLS]` (was `[]`).
- `PresetKind` union + `isPresetKind` gain `'repo-agent'`.
- New builtin preset:
  - `id:'repo-agent'`, `label:'Repo Agent'`,
  - `description`: interactive repository editing agent.
  - `presetKind:'repo-agent'`, `operationMode:'full'`,
  - `allowedTools:[...REPO_AGENT_TOOLS]`, `surfaces:['cli','web']`,
  - `useForSummary:false`, `builtin:true`, `deletable:false`,
  - `includeAgentsMd:true`, `includeRepoFileListing:true`,
  - `repoRootRequired:true`, `maxTurns:80`.
- Sweep `getOperationModeFromRecord` / user-preset defaulting so `repo-agent`
  presetKind defaults to `operationMode:'full'` and `repoRootRequired:true`,
  mirroring the `plan`/`repo-search` branches. No legacy fallbacks left dangling.

### 3. Agent system prompt (`src/repo-search/prompts.ts`)

New `buildAgentSystemPrompt(repoRoot, { includeAgentsMd?, includeRepoFileListing? })`,
modeled on pi's default prompt but adapted to SiftKit's single-JSON-action
protocol. Structure:

- Action framing (reused from `buildTaskSystemPrompt`): return ONE JSON object
  `{"action":"<tool>", ...args}`; independent reads may batch via `tool_batch`;
  finish via `{"action":"finish","output":"<summary of changes>"}`.
- Persona: "You are an expert coding assistant operating inside SiftKit, a
  repository coding agent. You help by reading files, searching the repo, editing
  code, writing new files, and running commands."
- Available tools: one-line list (read, grep, find, ls, git, web_search,
  web_fetch, write, edit, run) sourced from `REPO_TOOL_REGISTRY` descriptions.
- Guidelines (short, pi-style):
  - Be concise.
  - Show file paths clearly when working with files.
  - Prefer `edit` (exact replacement) over `write` for existing files; `write`
    only for new files or full rewrites.
  - Read a file before editing it; re-read after large edits to confirm.
  - Use `run` to verify changes (build/tests/lint) when a check exists.
  - `git` is read-only; staging/committing is not this agent's job unless asked.
  - Finish with a concise summary of what changed and any follow-ups — not
    anchor-bullets.
- Injected `agents.md` via existing `readAgentsMd(repoRoot)` when
  `includeAgentsMd !== false`.
- Startup file-listing line mirrors `buildTaskSystemPrompt` behavior.
- Deliberately omits pi's own doc-reference section and pi's edit/verify boilerplate
  not applicable to SiftKit.

The read-only search prompt is untouched; this is a sibling builder.

### 4. Execute (`src/repo-search/execute.ts`)

- Extend `taskKind` derivation to `'repo-agent'`.
- For `repo-agent`: `loopKind:'repo-search'`,
  `systemPromptOverride = buildAgentSystemPrompt(repoRoot, { includeAgentsMd, includeRepoFileListing })`,
  `minToolCallsBeforeFinish:0`, `allowEmptyTools:false`,
  `streamFinishAsAnswer:false`. Tools still come from `request.allowedTools`
  (server passes the full set).
- `RepoSearchExecutionRequest` type gains `taskKind:'repo-agent'` as an accepted
  value (single source; no cast).

### 5. Server (`src/status-server/routes/core.ts`)

- Extract the shared body of `RepoSearchEndpoint.execute` into a base
  `RepoTaskEndpoint` carrying an explicit `protected readonly mode: 'search' | 'agent'`
  (a data discriminant, not a passed function).
- `RepoAgentEndpoint extends RepoTaskEndpoint` with `mode:'agent'`,
  `lockKind:'repo_search'` (shared executor lock), `taskKind:'repo-agent'`, routed
  at `POST /repo-agent`.
- Mode differences inside the shared executor:
  - tools: agent always full (`INTERACTIVE_REPO_TOOL_NAMES`); search keeps
    current logic.
  - `taskKind` passed to `executeRepoSearch`: `'repo-agent'` vs `'repo-search'`.
  - approval: agent gate is on unless request `approval === false`; search gate
    on when `interactive === true` (unchanged).
- Approval endpoint (`/repo-search/approval`) is shared (keyed by `requestId`);
  no new approval route needed. Confirm the CLI/api client posts to the same path
  for agent runs.

### 6. CLI

- `src/cli/args.ts`:
  - `KNOWN_COMMANDS` + `SERVER_DEPENDENT_COMMANDS` gain `'repo-agent'`.
  - `REPO_AGENT_SYNOPSIS` constant.
  - `validateRepoAgentTokens` (mirror `validateRepoSearchTokens`; boolean flags
    `--progress`, `--no-approval`; value flags `--prompt`, `--model`, `--log-file`).
  - `parseArguments`: `--no-approval` → `parsed.noApproval = true`. Add
    `noApproval?: boolean` to `ParsedArgs`.
- `src/cli/dispatch.ts`: `repo-agent` case; approval-on (default) TTY assertion
  via `assertInteractiveStdinIsTty(!noApproval, stdin)`; route to
  `runRepoAgentCli`.
- Shared runner: extract the common body of `run-repo-search.ts` into a helper
  parameterized by an explicit mode config object
  `{ mode, synopsis, defaultApproval, requestFn }` — **no dynamically-passed
  functions**; instead the helper branches on `mode:'search'|'agent'` and calls
  the corresponding `StatusServerApiClient` method directly. `run-repo-search.ts`
  and new `run-repo-agent.ts` are thin entry points over it.
- `StatusServerApiClient.requestRepoAgent`: mirrors `requestRepoSearch`, POSTs to
  `/repo-agent`, sends `approval: !noApproval`, wires `CliApprovalPrompter` when
  approval on.
- Help text (`help.ts`) lists `repo-agent`.

### 7. TTY / approval semantics

- Approval on (default): requires TTY (reuse `assertInteractiveStdinIsTty`);
  every `write`/`edit`/`run` awaits `ApprovalGate`.
- `--no-approval`: no gate, no TTY requirement (autonomous). Full tools still
  available.

### 8. Tests (TDD, E2E-first)

- CLI E2E (mirror repo-search interactive E2E): `repo-agent --prompt` with
  `mockResponses` emitting `edit`/`write`/`run` actions →
  - approval path: asserts approval prompts and applied file mutations.
  - `--no-approval` path (non-TTY): asserts autonomous mutation, no prompt.
- Server route test: `POST /repo-agent` returns a scorecard; approval gate
  created/omitted per `approval` flag.
- Preset registration test: builtin `repo-agent` present with expected
  operationMode/tools/surfaces; `getBuiltinPresets`/normalization stable.
- Contracts schema test: `PresetToolNameSchema` accepts write/edit/run;
  `PresetKindSchema` accepts repo-agent.
- Agent-prompt test: `buildAgentSystemPrompt` contains persona, full tool list,
  guidelines, and injected `agents.md`; excludes read-only search-discipline
  lines.
- Regression sweep: `full` operationMode no longer empty — update any test/fixture
  asserting `DEFAULT_OPERATION_MODE_ALLOWED_TOOLS.full === []`; the summary
  `json_get` fixup path is unaffected but re-run its test.

## Risks

- Widening `PresetToolNameSchema` / `PresetKindSchema` may touch exhaustive
  switches or fixtures (preset normalization, operation-mode tables). Plan sweeps
  all consumers; anything missed fails loud (typecheck / test).
- Populating `operationMode:'full'` changes previously-empty defaults; audit
  `resolvePresetAllowedTools` and any UI enumerating full-mode tools.

## Acceptance

- `siftkit repo-agent --prompt "..."` runs with full tools, approval-on-by-default,
  pi-style prompt; `--no-approval` runs autonomously.
- `POST /repo-agent` works with the shared approval endpoint.
- Builtin `repo-agent` preset visible on cli+web surfaces.
- Full typecheck + near-100% branch coverage on new code; existing suites green.
