[CmdletBinding()]
param(
    [string]$SourcePath = 'C:\Users\denys\Documents\GitHub\ai_idle\core_project - Copy\rg_hardcoded_keys_output.txt',
    [int]$ChunkStart = 288000,
    [int]$ChunkLength = 288000,
    [int]$WindowSize = 100,
    [int]$MaxWindows = 10,
    [int]$StartWindowIndex = 0,
    [int]$ChildTimeoutSeconds = 180,
    [int]$DelayBetweenWindowsSeconds = 0,
    [int]$NumCtx = 128000,
    [double]$ChunkThresholdRatio = 0.90,
    [string]$Model = 'qwen3.5:9b-q4_K_M',
    [string]$Question = 'find the main files and hotspots where hardcoded tech unlock or status effect keys are used',
    [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $env:TEMP 'siftkit-chunk2-first10-blocks'
}

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$moduleManifest = Join-Path $repoRoot 'SiftKit\SiftKit.psd1'
$cliPath = Join-Path $repoRoot 'bin\siftkit.ps1'
$logPath = Join-Path $OutputRoot 'window-log.jsonl'
$metadataPath = Join-Path $OutputRoot 'metadata.json'

function Write-JsonLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        $Data
    )

    $parent = Split-Path -Path $Path -Parent
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    Add-Content -LiteralPath $Path -Value ($Data | ConvertTo-Json -Compress -Depth 10) -Encoding UTF8
}

function Read-LogText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return ''
    }

    $text = [string](Get-Content -LiteralPath $Path -Raw)
    if ($null -eq $text) {
        return ''
    }

    $text.Trim()
}

function Invoke-WindowChild {
    param(
        [Parameter(Mandatory = $true)]
        [int]$WindowIndex,
        [Parameter(Mandatory = $true)]
        [string[]]$WindowLines,
        [Parameter(Mandatory = $true)]
        [int]$StartLine,
        [Parameter(Mandatory = $true)]
        [int]$EndLine,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $windowRoot = Join-Path $OutputRoot ('window-' + $WindowIndex.ToString('D4'))
    if (Test-Path -LiteralPath $windowRoot) {
        Remove-Item -LiteralPath $windowRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $windowRoot -Force | Out-Null

    $inputPath = Join-Path $windowRoot 'input.txt'
    $windowText = ($WindowLines -join [Environment]::NewLine)
    Set-Content -LiteralPath $inputPath -Value $windowText -Encoding Unicode -NoNewline

    $childScriptPath = Join-Path $windowRoot 'run-child.ps1'
    $childScript = @"
`$ErrorActionPreference = 'Stop'
`$env:sift_kit_status = '$(Join-Path $windowRoot 'status\inference.txt')'
Remove-Item Env:SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
Remove-Item Env:SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
`$module = Import-Module '$moduleManifest' -Force -PassThru
`$bound = `$module.NewBoundScriptBlock({
    `$config = Get-SiftDefaultConfigObject
    `$config.Model = '$Model'
    `$config.Ollama.NumCtx = $NumCtx
    `$config.Thresholds.ChunkThresholdRatio = $ChunkThresholdRatio
    Save-SiftConfig -Config `$config -AllowLocalFallback | Out-Null
    Get-SiftConfig -Ensure | Out-Null
})
& `$bound
`$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    `$summary = (& '$cliPath' summary --question '$Question' --file '$inputPath' | Out-String).Trim()
    `$sw.Stop()
    [pscustomobject]@{
        status = 'success'
        wallClockMs = [int]`$sw.ElapsedMilliseconds
        summaryCharacterCount = `$summary.Length
        summaryPreview = if (`$summary.Length -gt 220) { `$summary.Substring(0, 220) } else { `$summary }
        errorMessage = `$null
    } | ConvertTo-Json -Compress -Depth 6
}
catch {
    `$sw.Stop()
    [pscustomobject]@{
        status = if (`$_.Exception.Message -match '(?i)timed out|timeout') { 'timeout' } else { 'error' }
        wallClockMs = [int]`$sw.ElapsedMilliseconds
        summaryCharacterCount = `$null
        summaryPreview = `$null
        errorMessage = `$_.Exception.Message
    } | ConvertTo-Json -Compress -Depth 6
    exit 1
}
"@
    Set-Content -LiteralPath $childScriptPath -Value $childScript -Encoding UTF8

    $stdoutPath = Join-Path $windowRoot 'stdout.log'
    $stderrPath = Join-Path $windowRoot 'stderr.log'
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $childScriptPath
    ) -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -WindowStyle Hidden

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        catch {
        }

        return [pscustomobject]@{
            windowIndex = $WindowIndex
            startLine = $StartLine
            endLine = $EndLine
            characterCount = $windowText.Length
            status = 'timeout'
            wallClockMs = $TimeoutSeconds * 1000
            summaryCharacterCount = $null
            summaryPreview = $null
            errorMessage = 'Parent watchdog expired.'
            windowRoot = $windowRoot
        }
    }

    $stdoutText = Read-LogText -Path $stdoutPath
    $stderrText = Read-LogText -Path $stderrPath
    $childResult = if ($stdoutText) {
        $stdoutText | ConvertFrom-Json
    }
    else {
        [pscustomobject]@{
            status = 'error'
            wallClockMs = $null
            summaryCharacterCount = $null
            summaryPreview = $null
            errorMessage = if ($stderrText) { $stderrText } else { 'Child produced no output.' }
        }
    }

    [pscustomobject]@{
        windowIndex = $WindowIndex
        startLine = $StartLine
        endLine = $EndLine
        characterCount = $windowText.Length
        status = $childResult.status
        wallClockMs = $childResult.wallClockMs
        summaryCharacterCount = $childResult.summaryCharacterCount
        summaryPreview = $childResult.summaryPreview
        errorMessage = if ($stderrText) { $stderrText } elseif ($childResult.errorMessage) { $childResult.errorMessage } else { $null }
        windowRoot = $windowRoot
    }
}

if (-not (Test-Path -LiteralPath $OutputRoot)) {
    New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
}

$fullText = Get-Content -LiteralPath $SourcePath -Raw
$chunkText = $fullText.Substring($ChunkStart, $ChunkLength)
$lines = @($chunkText -split "`r?`n")
$totalWindows = [int][Math]::Ceiling($lines.Count / [double]$WindowSize)
$endWindowExclusive = [Math]::Min($StartWindowIndex + $MaxWindows, $totalWindows)

[pscustomobject]@{
    sourcePath = $SourcePath
    chunkStart = $ChunkStart
    chunkLength = $ChunkLength
    totalChunkLines = $lines.Count
    windowSize = $WindowSize
    maxWindows = $MaxWindows
    startWindowIndex = $StartWindowIndex
    childTimeoutSeconds = $ChildTimeoutSeconds
    delayBetweenWindowsSeconds = $DelayBetweenWindowsSeconds
    numCtx = $NumCtx
    chunkThresholdRatio = $ChunkThresholdRatio
    model = $Model
    outputRoot = $OutputRoot
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $metadataPath -Encoding UTF8

for ($windowIndex = $StartWindowIndex; $windowIndex -lt $endWindowExclusive; $windowIndex++) {
    $startLine = $windowIndex * $WindowSize
    $endLine = [Math]::Min($startLine + $WindowSize - 1, $lines.Count - 1)
    $windowLines = @($lines[$startLine..$endLine])
    $result = Invoke-WindowChild -WindowIndex $windowIndex -WindowLines $windowLines -StartLine $startLine -EndLine $endLine -TimeoutSeconds $ChildTimeoutSeconds
    Write-JsonLine -Path $logPath -Data $result
    $result | ConvertTo-Json -Compress -Depth 8 | Write-Output
    if ($result.status -ne 'success') {
        break
    }
    if ($DelayBetweenWindowsSeconds -gt 0 -and $windowIndex -lt ($endWindowExclusive - 1)) {
        Start-Sleep -Seconds $DelayBetweenWindowsSeconds
    }
}
