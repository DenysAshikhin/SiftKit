[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$moduleManifest = Join-Path $repoRoot 'SiftKit\SiftKit.psd1'
$sourcePath = 'C:\Users\denys\Documents\GitHub\ai_idle\core_project - Copy\rg_hardcoded_keys_output.txt'
$ollamaExe = 'C:\Users\denys\AppData\Local\Programs\Ollama\ollama.exe'
$question = 'find the main files and hotspots where hardcoded tech unlock or status effect keys are used'
$model = 'qwen3.5:9b-q4_K_M'
$numCtx = 140000
$numPredict = 10000
$chunkThresholdRatio = 0.90
$watchdogSeconds = 180
$delaySeconds = 2
$chunkStart = 288000
$chunkLength = 288000
$windowSpecs = @(
    [pscustomobject]@{ WindowIndex = 0; StartLine = 0; EndLine = 1061 },
    [pscustomobject]@{ WindowIndex = 1; StartLine = 1062; EndLine = 1856 }
)

$runRoot = Join-Path $env:TEMP 'siftkit-num-predict-10k-experiment'
if (Test-Path $runRoot) {
    Remove-Item -LiteralPath $runRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$logRoot = Join-Path $runRoot 'ollama-logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stdoutPath = Join-Path $logRoot 'serve-stdout.log'
$stderrPath = Join-Path $logRoot 'serve-stderr.log'
$resultsPath = Join-Path $runRoot 'window-results.jsonl'
$metadataPath = Join-Path $runRoot 'metadata.json'

function Write-JsonLine {
    param([string]$Path, $Data)
    Add-Content -LiteralPath $Path -Value ($Data | ConvertTo-Json -Compress -Depth 12) -Encoding UTF8
}

function Invoke-RequestWithWatchdog {
    param(
        [Parameter(Mandatory = $true)] [string]$BodyPath,
        [Parameter(Mandatory = $true)] [string]$OutputPath,
        [Parameter(Mandatory = $true)] [string]$ErrorPath,
        [Parameter(Mandatory = $true)] [int]$TimeoutSeconds
    )

    $scriptPath = Join-Path (Split-Path -Path $BodyPath -Parent) 'invoke-request.ps1'
    $scriptText = @"
`$ErrorActionPreference = 'Stop'
try {
    `$body = Get-Content -LiteralPath '$BodyPath' -Raw
    `$response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body `$body -TimeoutSec 600
    [pscustomobject]@{
        status = 'success'
        httpStatusCode = 200
        responseText = [string]`$response.response
        errorMessage = `$null
    } | ConvertTo-Json -Compress -Depth 6
}
catch {
    `$statusCode = `$null
    if (`$_.Exception.Response -and `$_.Exception.Response.StatusCode) {
        `$statusCode = [int]`$_.Exception.Response.StatusCode
    }
    [pscustomobject]@{
        status = if (`$_.Exception.Message -match '(?i)timed out|timeout') { 'timeout' } else { 'error' }
        httpStatusCode = `$statusCode
        responseText = `$null
        errorMessage = `$_.Exception.Message
    } | ConvertTo-Json -Compress -Depth 6
    exit 1
}
"@
    Set-Content -LiteralPath $scriptPath -Value $scriptText -Encoding UTF8

    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath) -RedirectStandardOutput $OutputPath -RedirectStandardError $ErrorPath -PassThru -WindowStyle Hidden
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        $sw.Stop()
        return [pscustomobject]@{ status = 'timeout'; httpStatusCode = $null; responseText = $null; errorMessage = 'Parent watchdog expired.'; wallClockMs = [int]$sw.ElapsedMilliseconds }
    }
    $sw.Stop()

    $stdoutText = if (Test-Path $OutputPath) { [string](Get-Content -LiteralPath $OutputPath -Raw) } else { '' }
    $stderrText = if (Test-Path $ErrorPath) { [string](Get-Content -LiteralPath $ErrorPath -Raw) } else { '' }
    if ([string]::IsNullOrWhiteSpace($stdoutText)) {
        return [pscustomobject]@{ status = 'error'; httpStatusCode = $null; responseText = $null; errorMessage = if ($stderrText) { $stderrText.Trim() } else { 'Child produced no output.' }; wallClockMs = [int]$sw.ElapsedMilliseconds }
    }

    $parsed = $stdoutText | ConvertFrom-Json
    [pscustomobject]@{ status = [string]$parsed.status; httpStatusCode = $parsed.httpStatusCode; responseText = $parsed.responseText; errorMessage = if ($stderrText) { $stderrText.Trim() } elseif ($parsed.errorMessage) { [string]$parsed.errorMessage } else { $null }; wallClockMs = [int]$sw.ElapsedMilliseconds }
}

try {
    ollama stop $model 2>$null | Out-Null
}
catch {
}
Get-Process | Where-Object { $_.ProcessName -eq 'ollama' -or $_.ProcessName -eq 'ollama app' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$cmdArgs = '/c set OLLAMA_DEBUG=1&& set OLLAMA_CONTEXT_LENGTH=' + $numCtx + '&& "' + $ollamaExe + '" serve'
$serveProc = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -WindowStyle Hidden
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    & $ollamaExe ps *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if (-not $ready) { throw 'Ollama debug server did not become ready.' }

$module = Import-Module $moduleManifest -Force -PassThru
$bound = $module.NewBoundScriptBlock({
    param($QuestionArg, $SourcePathArg, $ChunkStartArg, $ChunkLengthArg, $WindowSpecsArg, $RunRootArg, $ModelArg, $NumCtxArg, $ChunkThresholdRatioArg)
    $env:sift_kit_status = Join-Path $RunRootArg 'status\inference.txt'
    Remove-Item Env:SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
    $config = Get-SiftDefaultConfigObject
    $config.Model = $ModelArg
    $config.Ollama.NumCtx = $NumCtxArg
    $config.Thresholds.ChunkThresholdRatio = $ChunkThresholdRatioArg
    Save-SiftConfig -Config $config -AllowLocalFallback | Out-Null
    $loaded = Get-SiftConfig -Ensure
    $fullText = Get-Content -LiteralPath $SourcePathArg -Raw
    $chunkText = $fullText.Substring($ChunkStartArg, $ChunkLengthArg)
    $lines = @($chunkText -split "`r?`n")
    $windows = foreach ($spec in $WindowSpecsArg) {
        $windowText = (@($lines[$spec.StartLine..$spec.EndLine]) -join [Environment]::NewLine)
        $prompt = New-SiftPrompt -Question $QuestionArg -InputText $windowText -Format 'text' -PolicyProfile 'general' -RawReviewRequired $false
        [pscustomobject]@{ windowIndex = [int]$spec.WindowIndex; startLine = [int]$spec.StartLine; endLine = [int]$spec.EndLine; characterCount = $windowText.Length; promptCharacterCount = $prompt.Length; prompt = $prompt }
    }
    [pscustomobject]@{ Config = [pscustomobject]@{ Model = $loaded.Model; NumCtx = [int]$loaded.Ollama.NumCtx; ChunkThresholdRatio = [double]$loaded.Thresholds.ChunkThresholdRatio }; Windows = $windows }
})

$promptData = & $bound $question $sourcePath $chunkStart $chunkLength $windowSpecs $runRoot $model $numCtx $chunkThresholdRatio
$window0PromptPath = Join-Path $runRoot 'window-0000-prompt.txt'
$window1PromptPath = Join-Path $runRoot 'window-0001-prompt.txt'
Set-Content -LiteralPath $window0PromptPath -Value $promptData.Windows[0].prompt -Encoding UTF8
Set-Content -LiteralPath $window1PromptPath -Value $promptData.Windows[1].prompt -Encoding UTF8
$loadedModel = & $ollamaExe ps | Out-String

$metadata = [ordered]@{
    RunRoot = $runRoot
    SourcePath = $sourcePath
    Model = $model
    NumCtx = $numCtx
    NumPredict = $numPredict
    ChunkThresholdRatio = $chunkThresholdRatio
    WatchdogSeconds = $watchdogSeconds
    DelayBetweenWindowsSeconds = $delaySeconds
    OllamaServeProcessId = $serveProc.Id
    OllamaPsInitial = $loadedModel
    Windows = @(
        [ordered]@{ WindowIndex = $promptData.Windows[0].windowIndex; StartLine = $promptData.Windows[0].startLine; EndLine = $promptData.Windows[0].endLine; CharacterCount = $promptData.Windows[0].characterCount; PromptCharacterCount = $promptData.Windows[0].promptCharacterCount; PromptPath = $window0PromptPath },
        [ordered]@{ WindowIndex = $promptData.Windows[1].windowIndex; StartLine = $promptData.Windows[1].startLine; EndLine = $promptData.Windows[1].endLine; CharacterCount = $promptData.Windows[1].characterCount; PromptCharacterCount = $promptData.Windows[1].promptCharacterCount; PromptPath = $window1PromptPath }
    )
    RequestBodyTemplate = [ordered]@{ stream = $false; think = $false; options = [ordered]@{ temperature = 0.2; top_p = 0.95; top_k = 20; min_p = 0.0; presence_penalty = 0.0; repeat_penalty = 1.0; num_ctx = $numCtx; num_predict = $numPredict } }
}
$metadata | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $metadataPath -Encoding UTF8

foreach ($window in $promptData.Windows) {
    $windowRoot = Join-Path $runRoot ('window-' + ([int]$window.windowIndex).ToString('D4'))
    New-Item -ItemType Directory -Path $windowRoot -Force | Out-Null
    $body = [ordered]@{ model = $model; prompt = [string]$window.prompt; stream = $false; think = $false; options = [ordered]@{ temperature = 0.2; top_p = 0.95; top_k = 20; min_p = 0.0; presence_penalty = 0.0; repeat_penalty = 1.0; num_ctx = $numCtx; num_predict = $numPredict } }
    $bodyPath = Join-Path $windowRoot 'request-body.json'
    $outputPath = Join-Path $windowRoot 'request-output.json'
    $errorPath = Join-Path $windowRoot 'request-error.log'
    $summaryPath = Join-Path $windowRoot 'summary.txt'
    $body | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $bodyPath -Encoding UTF8
    $result = Invoke-RequestWithWatchdog -BodyPath $bodyPath -OutputPath $outputPath -ErrorPath $errorPath -TimeoutSeconds $watchdogSeconds
    if ($result.responseText) { Set-Content -LiteralPath $summaryPath -Value $result.responseText -Encoding UTF8 }
    $record = [ordered]@{ windowIndex = [int]$window.windowIndex; characterCount = [int]$window.characterCount; promptCharacterCount = [int]$window.promptCharacterCount; wallClockMs = [int]$result.wallClockMs; status = [string]$result.status; httpStatusCode = $result.httpStatusCode; summaryCharacterCount = if ($result.responseText) { [int]$result.responseText.Length } else { $null }; errorMessage = $result.errorMessage; summaryPath = if ($result.responseText) { $summaryPath } else { $null }; requestBodyPath = $bodyPath; windowRoot = $windowRoot }
    Write-JsonLine -Path $resultsPath -Data $record
    $record | ConvertTo-Json -Compress -Depth 12 | Write-Output
    if ($record.status -ne 'success') { break }
    if ([int]$window.windowIndex -eq 0) { Start-Sleep -Seconds $delaySeconds }
}

$psFinal = & $ollamaExe ps | Out-String
[pscustomobject]@{ RunRoot = $runRoot; MetadataPath = $metadataPath; ResultsPath = $resultsPath; OllamaPsFinal = $psFinal; StdoutTail = (Get-Content -LiteralPath $stdoutPath -Tail 80 | Out-String); StderrTail = (Get-Content -LiteralPath $stderrPath -Tail 120 | Out-String) } | ConvertTo-Json -Depth 8
