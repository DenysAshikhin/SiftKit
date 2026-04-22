[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runnerSourcePath = Join-Path $repoRoot 'scripts\benchmark-siftkit-spec-settings.ps1'
$runnerTempPath = Join-Path $repoRoot '.tmp\benchmark-spec-custom-order.ps1'
$watchdogScriptPath = Join-Path $repoRoot '.tmp\benchmark-spec-cleanup-watchdog.ps1'
$resultsRoot = Join-Path $repoRoot 'eval\results\spec_bench_custom_order'
$resultsRootArg = '.\eval\results\spec_bench_custom_order'

function Get-ListenerPids {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    $output = & netstat -ano -p tcp
    foreach ($line in $output) {
        foreach ($port in $Ports) {
            if ($line -match (":{0}\s" -f $port)) {
                $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
                if ($parts.Count -gt 0) {
                    $pidText = $parts[-1]
                    $listenerPid = 0
                    if ([int]::TryParse($pidText, [ref]$listenerPid) -and $listenerPid -gt 0) {
                        $null = $pids.Add($listenerPid)
                    }
                }
            }
        }
    }
    return @($pids)
}

function Stop-Ports {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $pids = @(Get-ListenerPids -Ports $Ports)
    foreach ($processId in $pids) {
        try {
            & taskkill /PID $processId /T /F | Out-Null
        }
        catch {
            Write-Warning ("Failed to kill PID {0}: {1}" -f $processId, $_.Exception.Message)
        }
    }
}

function New-CustomRunnerText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptText
    )

    $replacement = @'
function Get-DefaultCases {
    return @(
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 32; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 32; SpeculativeDraftMin = 4 },
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 32; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 32; SpeculativeDraftMin = 4 },
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 },
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 },
        @{ SpeculativeEnabled = $false; SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 },
        @{ SpeculativeEnabled = $false; SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 }
    )
}

function Get-SelectedCases {
'@

    $updated = [regex]::Replace(
        $ScriptText,
        'function Get-DefaultCases \{[\s\S]*?function Get-SelectedCases \{',
        $replacement
    )

    $updated = $updated.Replace(
        '$script:RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)',
        '$script:RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path'
    )

    return $updated
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runnerTempPath) | Out-Null
New-Item -ItemType Directory -Force -Path $resultsRoot | Out-Null

$originalScript = Get-Content $runnerSourcePath -Raw
$customScript = New-CustomRunnerText -ScriptText $originalScript
Set-Content -LiteralPath $runnerTempPath -Value $customScript -Encoding UTF8

$benchmarkProcess = $null
$benchmarkExitCode = 1

$watchdogScript = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$BenchmarkPid
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ListenerPids {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    $output = & netstat -ano -p tcp
    foreach ($line in $output) {
        foreach ($port in $Ports) {
            if ($line -match (":{0}\s" -f $port)) {
                $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
                if ($parts.Count -gt 0) {
                    $pidText = $parts[-1]
                    $listenerPid = 0
                    if ([int]::TryParse($pidText, [ref]$listenerPid) -and $listenerPid -gt 0) {
                        $null = $pids.Add($listenerPid)
                    }
                }
            }
        }
    }
    return @($pids)
}

function Stop-Ports {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$Ports
    )

    $pids = @(Get-ListenerPids -Ports $Ports)
    foreach ($processId in $pids) {
        try {
            & taskkill /PID $processId /T /F | Out-Null
        }
        catch {
        }
    }
}

while (Get-Process -Id $BenchmarkPid -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 2
}

Start-Sleep -Seconds 2
Stop-Ports -Ports @(4765, 8097)
'@
Set-Content -LiteralPath $watchdogScriptPath -Value $watchdogScript -Encoding UTF8

try {
    Stop-Ports -Ports @(4765, 8097)
    $benchmarkProcess = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList @(
            '-ExecutionPolicy', 'Bypass',
            '-File', $runnerTempPath,
            '-RepoRoot', $repoRoot,
            '-OutputRoot', $resultsRootArg
        ) `
        -WorkingDirectory $repoRoot `
        -PassThru `
        -NoNewWindow

    $null = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList @(
            '-ExecutionPolicy', 'Bypass',
            '-File', $watchdogScriptPath,
            '-BenchmarkPid', [string]$benchmarkProcess.Id
        ) `
        -WorkingDirectory $repoRoot

    Wait-Process -Id $benchmarkProcess.Id
    $benchmarkExitCode = $benchmarkProcess.ExitCode
}
finally {
    Stop-Ports -Ports @(4765, 8097)
}

exit $benchmarkExitCode
