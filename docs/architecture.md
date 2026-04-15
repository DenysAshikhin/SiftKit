# SiftKit Architecture

## Runtime ownership

SiftKit is split into two processes:

1. The client in TypeScript.
2. A separate status/config server process.

The client never hosts the server. Normal client operations preflight `GET /health` and fail closed if the server is unavailable. The repo may still start the server manually with `npm start`, but that is an explicit operator action outside normal `siftkit` command execution.

## Client layers

The client has four practical layers:

1. TS CLI/runtime for summary, run, config, eval, install, and file-finding behavior.
2. Config/status HTTP client logic that treats the external server as authoritative.
3. Policy and provider logic for deterministic reduction plus conservative summarization.
4. PowerShell compatibility shims for object-pipeline rendering and interactive wrapper interception.

PowerShell is not the runtime owner. It exists only to preserve the current Windows-facing shell surface where Node cannot reproduce the same behavior directly.

## Server dependency

Server-dependent commands:

- `summary`
- `run`
- `install`
- `test`
- `eval`
- `config-get`
- `config-set`
- `capture-internal`

Local-only commands:

- `find-files`
- `codex-policy`
- `install-global`

The client assumes the external server provides `GET /health`, `GET /status`, `GET /config`, `PUT /config`, `GET /execution`, `POST /execution/acquire`, `POST /execution/heartbeat`, `POST /execution/release`, and `POST /status`. There is no local config fallback and no local status-file fallback for normal operation.

Inference is still external over HTTP, but the status server now supervises the `llama.cpp` lifecycle for normal request flow. Server startup is the readiness gate: when the configured `LlamaCpp.BaseUrl` is down, the server clears stale managed processes, runs `Server.LlamaCpp.StartupScript`, waits until `/v1/models` responds, scans the captured startup logs for warning/error markers, and only then serves as ready while publishing a simple boolean status: `true` while the managed model or request flow is active, `false` when idle.

After the idle summary block is emitted, the status server can run `Server.LlamaCpp.ShutdownScript` and clear the published status back to `false`.

The server also supports a process-level safe mode via `--disable-managed-llama-startup`. In that mode it still serves health, status, and config endpoints, but it skips managed `llama.cpp` startup during boot and `GET /config`, skips stale-process cleanup on boot, and advertises `disableManagedLlamaStartup: true` from `GET /health` so external launchers can verify they will not trigger a second managed model startup.

## Policy and tests

The runtime remains conservative:

- short output stays raw
- exact-diagnosis and error-dense output stays raw-first
- risky or debug flows only get secondary summaries
- managed command execution always preserves raw logs

Only the `llama.cpp` provider ships as runtime behavior. Mock provider hooks and related environment variables are test seams, not public extensibility points.
