[CmdletBinding()]
param(
    [string]$LlamaCppRoot = 'C:\Users\denys\Documents\GitHub\llamacpp',
    [string]$OutputRoot = '.\eval\results\llama_bench_models',
    [int]$Repetitions = 3,
    [int]$Threads = 22,
    [int]$MaxGenTokens = 512,
    [switch]$NoWarmup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-UtcTimestamp {
    return [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss_fff')
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

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
        throw "Could not find a hardcoded `$effectiveNCpuMoe value in $ScriptPath"
    }

    return [int]$match.Groups[1].Value
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedLlamaCppRoot = Resolve-RequiredPath -Path $LlamaCppRoot -Name 'llama.cpp root'
$benchExe = Resolve-RequiredPath -Path (Join-Path $resolvedLlamaCppRoot 'llama-bench.exe') -Name 'llama-bench.exe'
$modelsRoot = Resolve-RequiredPath -Path (Join-Path $resolvedLlamaCppRoot 'models') -Name 'models directory'
$q4StartupScript = Resolve-RequiredPath -Path (Join-Path $modelsRoot 'Start-Qwen35-35B-4bit-200k.ps1') -Name 'Start-Qwen35-35B-4bit-200k.ps1'
$q5StartupScript = Resolve-RequiredPath -Path (Join-Path $modelsRoot 'Start-Qwen35-35B-200k.ps1') -Name 'Start-Qwen35-35B-200k.ps1'
$q4NCpuMoe = Get-HardcodedNCpuMoe -ScriptPath $q4StartupScript
$q5NCpuMoe = Get-HardcodedNCpuMoe -ScriptPath $q5StartupScript
$resolvedOutputRoot = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    [System.IO.Path]::GetFullPath($OutputRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
}

$promptContexts = @(4096, 8192, 16384, 32768, 65536, 131072, 200000)
$promptContextArg = ($promptContexts -join ',')
$promptGenerationPairs = @($promptContexts | ForEach-Object { "{0},{1}" -f $_, $MaxGenTokens })
$sessionDirectory = Join-Path $resolvedOutputRoot (Get-UtcTimestamp)
New-Item -ItemType Directory -Force -Path $sessionDirectory | Out-Null

$models = @(
    [pscustomobject]@{
        Id = 'qwen35_9b_q8'
        Label = 'Qwen3.5 9B Q8_0'
        ModelPath = Resolve-RequiredPath -Path (Join-Path $modelsRoot 'Qwen3.5-9B-Q8_0.gguf') -Name 'Qwen3.5-9B-Q8_0.gguf'
        NCpuMoe = $null
    },
    [pscustomobject]@{
        Id = 'qwen35_35b_q4'
        Label = 'Qwen3.5 35B A3B Q4_K_L'
        ModelPath = Resolve-RequiredPath -Path (Join-Path $modelsRoot 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf') -Name 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'
        StartupScript = $q4StartupScript
        NCpuMoe = $q4NCpuMoe
    },
    [pscustomobject]@{
        Id = 'qwen35_35b_q5'
        Label = 'Qwen3.5 35B A3B Q5_K_XL'
        ModelPath = Resolve-RequiredPath -Path (Join-Path $modelsRoot 'Qwen3.5-35B-A3B-UD-Q5_K_XL.gguf') -Name 'Qwen3.5-35B-A3B-UD-Q5_K_XL.gguf'
        StartupScript = $q5StartupScript
        NCpuMoe = $q5NCpuMoe
    }
)

$manifest = [ordered]@{
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
    llamaCppRoot = $resolvedLlamaCppRoot
    llamaBenchExe = $benchExe
    outputDirectory = $sessionDirectory
    promptContexts = $promptContexts
    nGen = $MaxGenTokens
    repetitions = $Repetitions
    threads = $Threads
    noWarmup = [bool]$NoWarmup
    startupScripts = [ordered]@{
        qwen35_35b_q4 = $q4StartupScript
        qwen35_35b_q5 = $q5StartupScript
    }
    models = @()
}

Write-Host "Session : $sessionDirectory"
Write-Host "Bench   : $benchExe"
Write-Host "Contexts: $promptContextArg"
Write-Host "N Gen   : $MaxGenTokens"
Write-Host "Q4 NCpuMoe (from startup script): $q4NCpuMoe"
Write-Host "Q5 NCpuMoe (from startup script): $q5NCpuMoe"
Write-Host ''

foreach ($model in $models) {
    $stdoutPath = Join-Path $sessionDirectory ("{0}.jsonl" -f $model.Id)
    $stderrPath = Join-Path $sessionDirectory ("{0}.stderr.log" -f $model.Id)
    $commandPath = Join-Path $sessionDirectory ("{0}.command.txt" -f $model.Id)

    $arguments = @(
        '-m', $model.ModelPath,
        '-r', [string]$Repetitions,
        '-o', 'jsonl',
        '--progress',
        '-fa', '1'
    )

    foreach ($pair in $promptGenerationPairs) {
        $arguments += @('-pg', $pair)
    }

    if ($Threads -ge 1) {
        $arguments += @('-t', [string]$Threads)
    }

    if ($null -ne $model.NCpuMoe) {
        $arguments += @('-ncmoe', [string]$model.NCpuMoe)
    }
    if ($NoWarmup) {
        $arguments += '--no-warmup'
    }

    $quoted = @($benchExe) + ($arguments | ForEach-Object {
        if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ }
    })
    Write-Utf8NoBom -Path $commandPath -Content (($quoted -join ' ') + "`r`n")

    Write-Host "Benchmarking [$($model.Id)] $($model.Label)"
    Write-Host "Model: $($model.ModelPath)"

    $process = Start-Process -FilePath $benchExe `
        -ArgumentList $arguments `
        -WorkingDirectory $resolvedLlamaCppRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -Wait `
        -NoNewWindow `
        -PassThru

    if ($process.ExitCode -ne 0) {
        throw "llama-bench failed for $($model.Id) with exit code $($process.ExitCode). See $stderrPath"
    }

    $startupScript = $null
    if ($model.PSObject.Properties['StartupScript']) {
        $startupScript = $model.PSObject.Properties['StartupScript'].Value
    }

    $manifest.models += [ordered]@{
        id = $model.Id
        label = $model.Label
        modelPath = $model.ModelPath
        startupScript = $startupScript
        nCpuMoe = $model.NCpuMoe
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
        commandPath = $commandPath
    }

    Write-Host "Wrote: $stdoutPath"
    Write-Host ''
}

$manifest.completedAtUtc = [DateTime]::UtcNow.ToString('o')
$manifestPath = Join-Path $sessionDirectory 'manifest.json'
Write-Utf8NoBom -Path $manifestPath -Content ((ConvertTo-Json $manifest -Depth 8) + "`r`n")

Write-Host "Completed. Manifest: $manifestPath"
