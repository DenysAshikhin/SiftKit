# SiftKit

SiftKit is a Windows-first PowerShell module for conservative shell-output compression in Codex workflows. It provides a local toolkit that preserves raw logs, uses deterministic reduction first, and summarizes through Ollama only when the policy allows it.

SiftKit treats its own config as the source of truth for chunk sizing, sends Ollama `num_ctx` explicitly from that config, and derives the model-bound input budget as `num_ctx * 2.5`. With the default `num_ctx` of `128000`, that yields a 320,000-character cap; with the default `ChunkThresholdRatio` of `0.92`, chunking begins at 294,400 characters. Legacy `MaxInputCharacters` settings are migrated away automatically and no longer control normal chunk budgeting.

## What it ships

- `Install-SiftKit`: bootstrap runtime folders and config under `%USERPROFILE%\.siftkit`
- `Test-SiftKit`: verify Ollama discovery, configured model presence, and runtime paths
- `Invoke-SiftSummary`: summarize pipeline input, explicit text, or a file
- `Invoke-SiftCommand`: run a command, save raw output, reduce noise, and summarize conservatively
- `Find-SiftFiles`: find exact file-path matches for one or more names or wildcard patterns
- `Invoke-SiftEvaluation`: benchmark synthetic fixtures and optional real logs
- `Install-SiftCodexPolicy`: install SiftKit guidance into Codex `AGENTS.md`

## Import and bootstrap

```powershell
Import-Module .\SiftKit\SiftKit.psd1 -Force
Install-SiftKit
Test-SiftKit
```

The default backend is `ollama` and the default model is `qwen3.5:9b-q4_K_M`.

To run inside a sandboxed Codex workspace for now, set `sift_kit_status` to a writable in-repo path such as:

```powershell
$env:sift_kit_status = (Join-Path (Get-Location) '.codex\siftkit\status\inference.txt')
```

When `sift_kit_status` is set, SiftKit derives its runtime root from that path, so config, logs, eval artifacts, and the execution lock stay under the same workspace-local root. SiftKit itself no longer writes the status file directly.

If you want an external process to mirror those transitions, start the built-in status server with its own `sift_kit_status` path:

```powershell
$env:sift_kit_status = (Join-Path (Get-Location) '.codex\siftkit\status\inference.txt')
siftkit status-server
```

By default, SiftKit posts status transitions to `http://127.0.0.1:4765/status`. You can override that with `SIFTKIT_STATUS_BACKEND_URL` if needed. The built-in server accepts `POST /status` with `{"running":true|false}`, writes the resulting `true` or `false` value to its configured status path, and logs each request and write transition to the console.

The same local service now also exposes persisted config at `GET /config` and `PUT /config`. It stores only user-configurable settings such as backend, model, thresholds, and interactive behavior. Runtime paths remain derived client-side from the active runtime root, and effective chunk-budget diagnostics are derived from the configured `num_ctx`.

## Make it global

You can install the module and CLI shims into user-scoped locations:

```powershell
Import-Module .\SiftKit\SiftKit.psd1 -Force
Install-SiftKitShellIntegration
```

That installs:

- the module into your user PowerShell modules folder
- `siftkit.ps1` and `siftkit.cmd` into `%USERPROFILE%\bin`
- optional service bootstrap scripts can be generated with `siftkit install-service`

After adding `%USERPROFILE%\bin` to `PATH`, you can use it like:

```powershell
$siftInput = Get-Content .\build.log -Raw
$siftInput | siftkit "what is the main problem?"
some-command 2>&1 | siftkit "summarize only the decisive failures"
siftkit run --command pytest --arg -q --question "did tests pass?"
siftkit find-files frigate.gd Enemy_Manager.gd
```

For PowerShell-only interactive support, also dot-source the generated shell wrapper script once per shell startup:

```powershell
. "$HOME\bin\siftkit-shell.ps1"
```

That wrapper layer preserves callsites such as `git rebase -i HEAD~5 | siftkit "summarize conflicts"` for known interactive commands by running the interactive session first, then handing a captured transcript back into SiftKit.

To install the config service bootstrap for PM2 plus Windows Startup-folder autostart:

```powershell
siftkit install-service
```

This writes a PM2 bootstrap script, a stop/remove script, and a Startup-folder launcher. The installer reports the generated paths plus a verification hint for `pm2 list` and `GET /health`.

If you want npm-style global installation behavior, the repo now exposes an npm bin entry:

```powershell
npm i -g .
```

That installs a global `siftkit` command which launches the bundled PowerShell CLI.

## Usage

Summarize raw text:

```powershell
Get-Content .\build.log -Raw |
    Invoke-SiftSummary -Question 'extract the root exception and first relevant application frame'
```

Avoid using `$input` as your own variable name in PowerShell. It is a built-in automatic variable for pipeline input.

For exact diagnosis tasks such as conflict review, schema inspection, failing-test triage, or root-exception extraction, SiftKit now stays raw-first and includes the raw artifact path instead of forcing a lossy model summary.

Run a command and keep the raw log:

```powershell
Invoke-SiftCommand `
    -Command pytest `
    -ArgumentList '-q' `
    -Question 'did tests pass? if not, list only failing tests' `
    -RiskLevel informational `
    -ReducerProfile smart
```

Summarize risky output conservatively:

```powershell
Invoke-SiftCommand `
    -Command terraform `
    -ArgumentList 'plan', '-no-color' `
    -Question 'extract resources added, changed, and destroyed' `
    -RiskLevel risky `
    -PolicyProfile risky-operation
```

Install the Codex policy block:

```powershell
Install-SiftCodexPolicy
```

Find files by multiple names or patterns:

```powershell
siftkit find-files --path . frigate.gd Enemy_Manager.gd
siftkit find-files --path . --full-path *.gd
```

## Evaluation

Run the shipped synthetic fixtures:

```powershell
Invoke-SiftEvaluation
```

Add one or more real logs for manual review:

```powershell
Invoke-SiftEvaluation -RealLogPath .\logs\pytest.log, .\logs\terraform.log
```

Results are written under `%USERPROFILE%\.siftkit\eval\results`.

## Repo layout

- [`SiftKit/SiftKit.psm1`](.\SiftKit\SiftKit.psm1): module implementation
- [`eval/fixtures/fixtures.json`](C:\Users\denys\Documents\GitHub\SiftKit\eval\fixtures\fixtures.json): synthetic benchmark manifest
- [`docs/architecture.md`](.\docs\architecture.md): architecture and policy notes
