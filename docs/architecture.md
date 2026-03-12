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

The client assumes the external server provides `GET /health`, `GET /config`, `PUT /config`, and `POST /status`. There is no local config fallback and no local status-file fallback for normal operation.

## Policy and tests

The runtime remains conservative:

- short output stays raw
- exact-diagnosis and error-dense output stays raw-first
- risky or debug flows only get secondary summaries
- managed command execution always preserves raw logs

Only the Ollama provider ships as runtime behavior. Mock provider hooks and related environment variables are test seams, not public extensibility points.
