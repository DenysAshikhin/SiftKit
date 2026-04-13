# SiftKit

SiftKit is a Windows-first client for conservative shell-output compression in Codex workflows. TypeScript is the runtime authority for client behavior. PowerShell remains only as a compatibility surface for cmdlets, PowerShell pipeline rendering, and interactive wrapper interception.

The status/config server is required infrastructure and is not hosted by this package. Normal SiftKit commands fail closed if that separate server is not reachable.

The client still talks to `llama.cpp` over HTTP on the configured `LlamaCpp.BaseUrl`, but the status server now owns the runtime lifecycle and participates in a shared GPU status-file protocol. On normal startup, it clears stale managed llama processes, acquires the shared lock before using GPU, starts `llama-server`, dumps the startup logs for review, fails closed on warning/error markers, and keeps the published status `true` while SiftKit owns the GPU. After the idle summary is emitted and the server shuts the model back down, the published status returns to `false`.

The shared status file now uses four canonical values:

- `true`: SiftKit currently owns the GPU lock.
- `false`: no lock is held and other processes may claim the GPU.
- `lock_requested`: SiftKit wants the GPU and is waiting for a foreign owner to release it.
- `foreign_lock`: a non-SiftKit process currently owns the GPU.

`GET /status` remains backward-compatible: `status` returns the full 4-state value, while `running` is `true` only when `status === 'true'`.

For local development, you can still start the separate server process manually from this repo with:

```powershell
npm start
```

That launch path uses `nodemon --signal SIGINT`, so a managed llama process is torn down on graceful restarts instead of being left behind between reloads.

If you need a long-running status/config server while running parallel builds or test loops, use:

```powershell
npm run start:status:stable
```

That launch path runs the same server without `nodemon` file-watch restarts.

If you need the status/config server without managed `llama.cpp` startup, use:

```powershell
npm start -- --disable-managed-llama-startup
```

In that mode the server still serves `GET /health`, `GET /status`, `GET /config`, and `PUT /config`, but it does not auto-start `llama-server` during boot or `GET /config`. `GET /health` also reports `disableManagedLlamaStartup: true`.

When the status server runs a managed llama startup script, it captures startup-script stdout/stderr under the runtime `logs\managed-llama` folder and exposes server-owned log paths to the script through these environment variables:

- `SIFTKIT_LLAMA_SCRIPT_STDOUT_PATH`
- `SIFTKIT_LLAMA_SCRIPT_STDERR_PATH`
- `SIFTKIT_LLAMA_STDOUT_PATH`
- `SIFTKIT_LLAMA_STDERR_PATH`

Each managed startup attempt also writes a reviewable startup-only dump to `logs\managed-llama\latest-startup.log`, and a per-attempt copy to the timestamped startup folder as `startup-review.log`.

If startup succeeds but those captured logs contain warning/error markers, the server dumps the logs to a failure file under `logs\managed-llama`, stops the managed llama process, and fails closed.

## Required server contract

The client assumes an already-running external server that exposes:

- `GET /health`
- `GET /status`
- `GET /config`
- `PUT /config`
- `POST /status`

By default the client looks for:

- status endpoint: `http://127.0.0.1:4765/status`
- health endpoint: `http://127.0.0.1:4765/health`
- config endpoint: `http://127.0.0.1:4765/config`

You can override those with:

- `SIFTKIT_STATUS_BACKEND_URL`
- `SIFTKIT_CONFIG_SERVICE_URL`
- `SIFTKIT_STATUS_HOST`
- `SIFTKIT_STATUS_PORT`

If the server is down, client-owned commands return:

`SiftKit status/config server is not reachable at <health-url>. Start the separate server process and stop issuing further siftkit commands until it is available.`

## What the client owns

- `siftkit summary`
- `siftkit run`
- `siftkit install`
- `siftkit test`
- `siftkit eval`
- `siftkit config-get`
- `siftkit config-set`
- `siftkit capture-internal`
- `siftkit find-files`
- `siftkit codex-policy`
- `siftkit install-global`

Removed from the client surface:

- `siftkit status-server`
- `siftkit install-service`
- `siftkit uninstall-service`

## Install and usage

Build the TS client:

```powershell
npm run build
```

Run the full client verification flow, including a live `siftkit summary` smoke test:

```powershell
npm run verify:client
```

That script assumes the separate status/config server is already running and reachable.

Point SiftKit at the target `llama-server` base URL through the config service, for example `http://127.0.0.1:8080`, and set `Server.LlamaCpp.StartupScript` plus `Server.LlamaCpp.ShutdownScript` in the config file if you want the status server to manage the process lifecycle. External model launchers that manage `llama-server` themselves should verify `GET /health` reports `disableManagedLlamaStartup: true` before calling `GET /config` or `PUT /config`.

Run the dedicated live `llama.cpp` smoke flow against the status/config server plus a reachable `llama.cpp` endpoint:

```powershell
npm run verify:llama-live
```

Import the PowerShell compatibility module when you want cmdlets or wrapper behavior:

```powershell
Import-Module .\SiftKit\SiftKit.psd1 -Force
```

Bootstrap local runtime folders and verify the external server/config path:

```powershell
siftkit install
```

Summarize text:

```powershell
Get-Content .\build.log -Raw |
    Invoke-SiftSummary -Question 'extract the root exception and first relevant application frame'
```

Run a command and keep the raw log:

```powershell
Invoke-SiftCommand `
    -Command pytest `
    -ArgumentList '-q' `
    -Question 'did tests pass? if not, list only failing tests'
```

Use the Node CLI directly:

```powershell
some-command 2>&1 | siftkit "summarize only the decisive failures"
siftkit run --command pytest --arg -q --question "did tests pass?"
siftkit find-files frigate.gd Enemy_Manager.gd
```

Install the compatibility shims globally:

```powershell
Import-Module .\SiftKit\SiftKit.psd1 -Force
Install-SiftKitShellIntegration
```

That installs the module plus `siftkit.ps1` and `siftkit.cmd` into user-scoped locations. The shims still delegate normal runtime behavior to the TS client.

For PowerShell-only interactive capture support, dot-source the generated wrapper script:

```powershell
. "$HOME\bin\siftkit-shell.ps1"
```

## Notes

- `find-files`, `codex-policy`, and `install-global` are local-only client operations and do not require the external server.
- All other normal commands require the external server and do not fall back to local config or local status handling.
- External inference is provided by `llama.cpp` via `llama-server` on the configured `LlamaCpp.BaseUrl`.
- The status server can supervise startup and shutdown through `Server.LlamaCpp.StartupScript` and `Server.LlamaCpp.ShutdownScript`.
- Test seams such as the mock provider environment variables exist for automated tests only and are not part of the public runtime contract.
