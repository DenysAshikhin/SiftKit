[CmdletBinding()]
param(
    [switch]$VerboseOutput,
    [switch]$Build,
    [int]$CommandTimeoutSeconds = 420,
    [int]$MonolithicJsonChars = 400000
)

$ErrorActionPreference = 'Stop'

$target = Join-Path $PSScriptRoot 'verify-prompt-dispatch-live-cli.ps1'
if (-not (Test-Path -LiteralPath $target)) {
    Write-Error "Missing live verifier script: $target"
    exit 1
}

Write-Host "[siftkit] verify-prompt-dispatch-cases.ps1 now forwards to live CLI verification."
Write-Host "[siftkit] This runs real client/status-server llama flows (summary/repo-search/plan mode), not runtime tests."

$forward = @(
    '-ExecutionPolicy', 'Bypass',
    '-File', $target,
    '-CommandTimeoutSeconds', [string]$CommandTimeoutSeconds,
    '-MonolithicJsonChars', [string]$MonolithicJsonChars
)
if ($VerboseOutput) { $forward += '-VerboseOutput' }
if ($Build) { $forward += '-Build' }

& powershell @forward
exit $LASTEXITCODE
