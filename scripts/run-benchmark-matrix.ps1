[CmdletBinding()]
param(
    [string]$ManifestPath = '',
    [string[]]$RunId,
    [string]$PromptPrefixFile = '',
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$nodeExe = (Get-Command node.exe -CommandType Application).Source
$entrypoint = Join-Path $repoRoot 'dist\benchmark-matrix.js'

if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "Benchmark matrix entrypoint not found: $entrypoint. Run 'npm run build' first."
}

$arguments = @($entrypoint)
if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $arguments += @('--manifest-path', $ManifestPath)
}
foreach ($item in @($RunId)) {
    if (-not [string]::IsNullOrWhiteSpace($item)) {
        $arguments += @('--run-id', $item.Trim())
    }
}
if (-not [string]::IsNullOrWhiteSpace($PromptPrefixFile)) {
    $arguments += @('--prompt-prefix-file', $PromptPrefixFile)
}
if ($ValidateOnly) {
    $arguments += '--validate-only'
}

& $nodeExe @arguments
exit $LASTEXITCODE
