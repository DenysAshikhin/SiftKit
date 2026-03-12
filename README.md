# SiftKit

SiftKit is a Windows-first client for conservative shell-output compression in Codex workflows. TypeScript is the runtime authority for client behavior. PowerShell remains only as a compatibility surface for cmdlets, PowerShell pipeline rendering, and interactive wrapper interception.

The status/config server is required infrastructure and is not hosted by this package. Normal SiftKit commands fail closed if that separate server is not reachable.

For local development, you can still start the separate server process manually from this repo with:

```powershell
npm start
```

## Required server contract

The client assumes an already-running external server that exposes:

- `GET /health`
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
- Test seams such as the mock provider environment variables exist for automated tests only and are not part of the public runtime contract.
