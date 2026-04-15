# SiftKit

SiftKit is a Windows-first toolkit that makes AI coding agents (Codex, Claude Code, and similar runners) dramatically cheaper and more focused by compressing noisy shell output and repo exploration into exactly the information the agent actually needs. It runs a local `llama.cpp` model as the cheap "sifter" so your expensive frontier model never has to chew through 10k-line logs, full directory dumps, or raw `rg` output.

## Why use it

Modern coding agents burn most of their tokens on three things:

1. Reading huge command logs (`npm test`, `cargo build`, `pytest -v`, container logs).
2. Exploring unfamiliar repos with broad `grep`/`rg`/`ls` sweeps.
3. Re-reading files they already touched because context got evicted.

SiftKit intercepts those flows and routes them through a local model first. The agent asks a **specific extraction question**, SiftKit answers it with a small, structured response, and the raw output is preserved on disk for audit or follow-up. The net effect:

- **~10x to 100x token reduction** on long shell output without losing decisive information.
- **Deterministic raw-first behavior** on short or error-dense output, so SiftKit never hides a stack trace you actually needed.
- **Free local inference** via `llama.cpp` — no extra API costs for the sift pass.
- **Single server-owned runtime state** so agent sessions and background tooling observe one consistent activity signal.

## What SiftKit does

### `siftkit summary` — compress command output
Pipe any command's stdout/stderr in and ask an extraction-oriented question. SiftKit runs a conservative policy (short output stays raw, error-dense output stays raw-first, only long noisy output gets summarized) and returns a focused answer.

```powershell
npm test 2>&1 | siftkit summary --question "did tests pass? list failing suites and root causes"
git diff 2>&1 | siftkit summary --question "summarize behavioral changes and risks"
Get-Content .\logs\app.log -Tail 400 | siftkit summary --question "extract errors with timestamps as JSON"
```

Supports stdin, `--text`, or `--file`. Raw logs are always captured to the runtime folder so nothing is lost.

### `siftkit repo-search` — agent-style code exploration
Instead of a blind `rg` sweep, repo-search runs a constrained planner loop with a curated tool set (`repo_rg`, `repo_get_content`, `repo_select_string`, `repo_git`, `repo_ls`, and PowerShell object-pipeline tools like `repo_select_object`, `repo_where_object`, `repo_format_table`, etc.). It answers questions like "where is X defined and who calls it" without dumping the whole repo into the parent agent's context.

```powershell
siftkit repo-search --prompt "find the definition and all call sites of buildPlannerToolDefinitions"
```

### `siftkit run --preset <id>` — preset-driven runs
Presets are reusable personas that bundle a prompt prefix, an operation mode (`summary`, `read-only`, or `full`), an allowed tool list, and optional repo-context controls (agents.md injection, repo file listing). Built-in presets cover summary, chat, plan, and repo-search flows. Custom presets can be created and edited from the dashboard.

```powershell
siftkit preset list
siftkit run --preset plan --question "outline the work to migrate the config store to sqlite"
```

### Interactive / PowerShell integration
For Windows users there is a PowerShell compatibility module that exposes `Invoke-SiftSummary`, `Invoke-SiftCommand`, and a dot-sourced interactive wrapper. This is the only reason PowerShell exists in the project — TypeScript is the runtime authority; PowerShell is kept strictly as a shell-surface shim.

```powershell
Import-Module .\SiftKit\SiftKit.psd1 -Force

Get-Content .\build.log -Raw |
    Invoke-SiftSummary -Question 'extract the root exception and first relevant application frame'

Invoke-SiftCommand -Command pytest -ArgumentList '-q' -Question 'did tests pass? if not, list only failing tests'
```

### Web dashboard
A local React/Vite dashboard (served by the status server) exposes:

- **Runs** — historical summary/run/repo-search/benchmark sessions with full raw logs and metric graphs.
- **Metrics** — token usage, cache hit rate, tool-call stats, daily/per-task rollups.
- **Presets** — visual editor for custom presets, including allowed-tool matrices and per-surface visibility.
- **Settings** — live edit of the config file with schema-driven sections.
- **Run-log admin** — bulk preview and deletion of stored runs by age, type, or session.

Start it with `npm run start:dashboard` during development, or use the built assets served by the status server.

## Architecture

SiftKit is split into two processes:

1. **TypeScript client** — the `siftkit` CLI, PowerShell shims, and all runtime behavior for summary, run, repo-search, preset, eval, install, and find-files.
2. **Status/config server** — a separate long-running Node process that owns the config file, the runs database, the `llama.cpp` lifecycle, and the dashboard UI.

The client preflights `GET /health` on every server-dependent command and fails closed if the server is unreachable. There is no local config fallback and no local status-file fallback — the server is the single source of truth.

### `llama.cpp` supervision
The status server can manage `llama-server` automatically. On startup it clears stale managed processes, runs `Server.LlamaCpp.StartupScript`, waits for `/v1/models`, scans captured startup logs for warning/error markers, and only then serves as ready. After the idle summary block is emitted the server runs `Server.LlamaCpp.ShutdownScript`.

If you want the status server without managed startup (e.g., you launch `llama-server` yourself), run it with `--disable-managed-llama-startup`. In that mode it still serves health, status, and config but skips process lifecycle work, and `GET /health` advertises `disableManagedLlamaStartup: true` so external launchers can verify safely.

### Status protocol
The published status file uses a simple boolean-like activity signal:

- `true` — SiftKit is currently active.
- `false` — SiftKit is currently idle.

`GET /status` returns the same boolean-like `status` text and a matching `running` boolean.

### Server contract
The client expects these endpoints from the status server:

- `GET /health`, `GET /status`, `POST /status`
- `GET /config`, `PUT /config`
- `GET /execution`, `POST /execution/acquire`, `POST /execution/heartbeat`, `POST /execution/release`

Default URLs:

- `http://127.0.0.1:4765/health`
- `http://127.0.0.1:4765/status`
- `http://127.0.0.1:4765/config`

Overrides: `SIFTKIT_STATUS_BACKEND_URL`, `SIFTKIT_CONFIG_SERVICE_URL`, `SIFTKIT_STATUS_HOST`, `SIFTKIT_STATUS_PORT`.

## Command surface

**Client-owned commands:**

- `siftkit summary` — compress piped output
- `siftkit repo-search` — constrained repo exploration
- `siftkit preset list` — list available presets
- `siftkit run` — execute a command or a preset
- `siftkit install` — bootstrap runtime folders and verify the server
- `siftkit install-global` — install PowerShell shims user-scoped
- `siftkit config-get` / `siftkit config-set` — live config edit via the server
- `siftkit find-files` — local fuzzy file finder (no server required)
- `siftkit codex-policy` — local-only codex policy helper
- `siftkit eval` / `siftkit test` / `siftkit capture-internal` — development/eval harness

Local-only commands (`find-files`, `codex-policy`, `install-global`) do not require the external server.

## Install and usage

Build the client and dashboard:

```powershell
npm run build
```

Start the status/config server (development, with nodemon on `dist/status-server`):

```powershell
npm start
```

Start the server without file-watch restarts (stable mode for long benchmark or test loops):

```powershell
npm run start:status:stable
```

Start the server without managed `llama.cpp` lifecycle (you launch `llama-server` yourself):

```powershell
npm start -- --disable-managed-llama-startup
```

Start the dashboard dev server:

```powershell
npm run start:dashboard
```

Verify the whole client flow end-to-end (assumes the server is already running):

```powershell
npm run verify:client
```

Verify the live `llama.cpp` smoke flow:

```powershell
npm run verify:llama-live
```

Bootstrap local runtime folders and verify the external server:

```powershell
siftkit install
```

Install the PowerShell shims globally:

```powershell
Import-Module .\SiftKit\SiftKit.psd1 -Force
Install-SiftKitShellIntegration
```

Dot-source the interactive wrapper for PowerShell-only capture support:

```powershell
. "$HOME\bin\siftkit-shell.ps1"
```

## Logging and audit

Every managed llama startup attempt captures stdout/stderr under `logs\managed-llama\` with:

- `latest-startup.log` — rolling reviewable dump of the most recent attempt
- per-attempt `startup-review.log` in a timestamped folder
- startup-script env handoff: `SIFTKIT_LLAMA_SCRIPT_STDOUT_PATH`, `SIFTKIT_LLAMA_SCRIPT_STDERR_PATH`, `SIFTKIT_LLAMA_STDOUT_PATH`, `SIFTKIT_LLAMA_STDERR_PATH`

If captured logs contain warning/error markers after a nominally successful startup, the server dumps a failure file, stops the managed process, and fails closed.

Run-level artifacts (summaries, repo-search sessions, benchmark matrices, eval results, managed llama runs) are stored via the status server and browsable from the dashboard Runs view.

## Notes

- TypeScript is the runtime authority. PowerShell exists only as a shell-surface compatibility layer.
- External inference is `llama.cpp` over HTTP on the configured `LlamaCpp.BaseUrl`. No other providers ship as runtime behavior.
- The runtime is deliberately conservative: short output stays raw, error-dense output stays raw-first, only long/noisy output is compressed, and managed command execution always preserves raw logs.
- Mock provider hooks and related environment variables are test seams, not a public extensibility surface.
