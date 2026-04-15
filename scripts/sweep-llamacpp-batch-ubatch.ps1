[CmdletBinding()]
param(
    [string]$LlamaCppRoot = 'C:\Users\denys\Documents\GitHub\llamacpp',
    [string]$ModelPath = 'C:\Users\denys\Documents\GitHub\llamacpp\models\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
    [string]$StartupScript = 'C:\Users\denys\Documents\GitHub\llamacpp\models\Start-Qwen35-35B-4bit-200k.ps1',
    [int]$PromptTokens = 32768,
    [int]$GenTokens = 512,
    [int[]]$BatchSizes = @(2048, 512, 1024),
    [int[]]$UBatchSizes = @(512, 1024),
    [int]$Repetitions = 3,
    [int]$Threads = 22,
    [switch]$NoWarmup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RequiredPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw "$Name not found: $resolved"
    }

    return $resolved
}

function Get-HardcodedNCpuMoe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath
    )

    $content = Get-Content -LiteralPath $ScriptPath -Raw
    $match = [regex]::Match($content, '(?m)^\$effectiveNCpuMoe\s*=\s*(\d+)\s*$')
    if (-not $match.Success) {
        return $null
    }

    return [int]$match.Groups[1].Value
}

function Invoke-BenchRun {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BenchExe,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $BenchExe `
            -ArgumentList $Arguments `
            -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -Wait `
            -NoNewWindow `
            -PassThru

        $stdoutLines = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath } else { @() }
        $stderrLines = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath } else { @() }
        $lines = @($stdoutLines + $stderrLines | ForEach-Object { "$_" })
        $exitCode = $process.ExitCode
    }
    finally {
        if (Test-Path -LiteralPath $stdoutPath) {
            Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $stderrPath) {
            Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
        }
    }

    if ($exitCode -ne 0) {
        throw "llama-bench failed with exit code $exitCode`n$($lines -join [Environment]::NewLine)"
    }

    $jsonLine = $lines | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
    if (-not $jsonLine) {
        throw "llama-bench completed but did not emit a JSON result."
    }

    return $jsonLine | ConvertFrom-Json
}

function Write-ResultsTable {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Results
    )

    $table = $Results |
        Sort-Object @{ Expression = 'TkPerSecond'; Descending = $true }, @{ Expression = 'Batch'; Descending = $false } |
        Select-Object `
            @{ Name = 'Batch'; Expression = { $_.Batch } }, `
            @{ Name = 'UBatch'; Expression = { $_.UBatch } }, `
            @{ Name = 'Default'; Expression = { if ($_.IsDefault) { 'yes' } else { '' } } }, `
            @{ Name = 'tk/s'; Expression = { '{0:N2}' -f $_.TkPerSecond } }, `
            @{ Name = 'StdDev'; Expression = { '{0:N2}' -f $_.StdDevTkPerSecond } }, `
            @{ Name = 'Avg s/run'; Expression = { '{0:N2}' -f $_.AvgSeconds } }

    Write-Host ''
    Write-Host 'Results so far:'
    Write-Host ($table | Format-Table -AutoSize | Out-String)
}

$resolvedLlamaCppRoot = Resolve-RequiredPath -Path $LlamaCppRoot -Name 'llama.cpp root'
$benchExe = Resolve-RequiredPath -Path (Join-Path $resolvedLlamaCppRoot 'llama-bench.exe') -Name 'llama-bench.exe'
$resolvedModelPath = Resolve-RequiredPath -Path $ModelPath -Name 'model'
$resolvedStartupScript = Resolve-RequiredPath -Path $StartupScript -Name 'startup script'
$nCpuMoe = Get-HardcodedNCpuMoe -ScriptPath $resolvedStartupScript

Write-Host "Model     : $resolvedModelPath"
Write-Host "StartScript: $resolvedStartupScript"
Write-Host "Prompt/Gen: $PromptTokens / $GenTokens"
Write-Host "Batch     : $($BatchSizes -join ',')"
Write-Host "UBatch    : $($UBatchSizes -join ',')"
Write-Host "Threads   : $Threads"
if ($null -ne $nCpuMoe) {
    Write-Host "NCpuMoe   : $nCpuMoe"
}
Write-Host ''

$results = @()
$totalRuns = $BatchSizes.Count * $UBatchSizes.Count
$runIndex = 0

foreach ($batchSize in $BatchSizes) {
    foreach ($uBatchSize in $UBatchSizes) {
        $runIndex += 1
        Write-Host ("[{0}/{1}] Running batch={2}, ubatch={3}" -f $runIndex, $totalRuns, $batchSize, $uBatchSize)

        $arguments = @(
            '--model', $resolvedModelPath,
            '--repetitions', [string]$Repetitions,
            '--output', 'jsonl',
            '--progress',
            '--flash-attn', '1',
            '--threads', [string]$Threads,
            '--batch-size', [string]$batchSize,
            '--ubatch-size', [string]$uBatchSize,
            '-pg', ("{0},{1}" -f $PromptTokens, $GenTokens)
        )

        if ($null -ne $nCpuMoe) {
            $arguments += @('--n-cpu-moe', [string]$nCpuMoe)
        }

        if ($NoWarmup) {
            $arguments += '--no-warmup'
        }

        $result = Invoke-BenchRun -BenchExe $benchExe -WorkingDirectory $resolvedLlamaCppRoot -Arguments $arguments
        $results += [pscustomobject]@{
            Batch = $batchSize
            UBatch = $uBatchSize
            IsDefault = ($batchSize -eq 2048 -and $uBatchSize -eq 512)
            TkPerSecond = [double]$result.avg_ts
            StdDevTkPerSecond = [double]$result.stddev_ts
            AvgSeconds = ([double]$result.avg_ns / 1e9)
        }

        Write-ResultsTable -Results $results
    }
}
