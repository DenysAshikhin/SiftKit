# Handoff: repo-agent dispatch failures (2026-08-21)

Context: dispatching Tasks 1-3 of `docs/superpowers/plans/2026-08-21-live-thinking-render.md` to `siftkit repo-agent` from Claude Code on Windows. Three distinct failures, in order.

## 1. Git Bash shim executes `main.js` as a shell script (exit 2)

- **Where:** `Bash` tool dispatch of `siftkit repo-agent '...'`.
- **Symptom:** `C:\Users\denys\AppData\Roaming\npm/node_modules/siftkit/dist/cli/main.js: line 1: import: command not found`, exit 2. The run never started.
- **Why:** under Git Bash the `siftkit` shim resolves to `dist/cli/main.js` and executes it with `sh`. The built `main.js` has no `#!/usr/bin/env node` shebang, so the shell parses ESM `import` statements as shell commands.
- **Fix forward:** add a shebang to the CLI build output (esbuild `banner` / build script prepend) so the npm sh-shim works. **Workaround:** dispatch `siftkit` only via PowerShell/cmd (uses `siftkit.cmd`), or call `node .../dist/cli/main.js` explicitly in bash.

## 2. PowerShell strips embedded double quotes from the task prompt

- **Where:** PowerShell dispatch, run `b3f9c83a-929e-41c6-9f4d-99ce2e4020e0`.
- **Symptom:** repo-agent printed `note: joined 27 command-line tokens into one task; embedded double quotes were lost to shell argument splitting.` Task headings lost their quotes (cosmetic here, could be semantic elsewhere).
- **Why:** PowerShell native-command argument passing drops interior `"` unless re-escaped; repo-agent then re-joins argv tokens.
- **Fix forward:** accept the task via stdin or `--task-file` in repo-agent so prompts bypass shell splitting. **Workaround:** avoid embedded double quotes in prompts, or use `--%`.

## 3. Agent self-terminated after the RED phase while saying it would continue (the real failure)

- **Where:** same run `b3f9c83a-929e-41c6-9f4d-99ce2e4020e0`, after one `approval_required` pause on `npm run build:test` was resolved with `decide ... approve`.
- **Symptom:** run ended `{"status":"completed"}` at turn 10/100 with `{"action":"finish","output":"Task 1 Step 2 (RED) confirmed: ... Continuing with implementation now."}`. Only `dashboard/tests/chat-tab.test.tsx` was modified; `ChatTab.tsx` and `chat.css` were untouched. Tasks 1 (steps 3-5), 2, and 3 were never attempted.
- **Why (hypothesis, unverified):** the agent emitted the terminal `finish` action as if it were a progress update — the output text explicitly says it intends to continue. Most likely the post-approval resume prompt biases the model toward emitting `finish`, or the action schema makes `finish` the only way to narrate status. Not a turn limit (10/100) and not an error.
- **Fix forward (investigate in this order):**
  1. Inspect the repo-agent resume-after-approval prompt/loop (`src/` repo-agent runtime) for why a status narration became `finish`.
  2. Consider a distinct non-terminal `progress` action, or reject `finish` when the output text signals continuation ("continuing", "next I will").
  3. Have `finish` validation compare modified files against the task's declared file list and downgrade to `partial` on mismatch, so `status:"completed"` can't mask partial work.
- **Caller-side guard used this session (keep doing this):** treat `status:"completed"` as unverified until the diff is reviewed against task scope; on partial completion, finish directly per policy (no redispatch).

## Exit-code map observed

| Exit | Meaning |
| --- | --- |
| 2 | CLI failed to launch (shim/shell issue) |
| 3 | `approval_required` (JSON on stdout has the exact `decide` commands) |
| 0 | Run ended — parse JSON `status`; `completed` still requires diff review |
