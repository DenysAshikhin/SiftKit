param(
    [string]$ConfigPath,
    [string]$ConfigUrl,
    [string]$StatusPath,
    [string]$StatusUrl,
    [string]$HealthUrl,
    [string]$RuntimeRoot,
    [string]$ScriptPath,
    [string]$BaseUrl = 'http://127.0.0.1:8097',
    [string]$BindHost = '127.0.0.1',
    [int]$Port = 8097,
    [string]$LlamaCppRoot = 'C:\Users\denys\Documents\GitHub\llamacpp',
    [string]$ModelPath = 'D:\personal\models\Qwen3.5-9B-Q8_0.gguf',
    [int]$ContextSize = 130000,
    [int]$GpuLayers = 999,
    [int]$Threads = 22,
    [bool]$FlashAttention = $true,
    [int]$ParallelSlots = 1,
    [int]$BatchSize = 2048,
    [int]$UBatchSize = 2048,
    [int]$CacheRam = 4096,
    [int]$MaxTokens = 15000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Set-Json {
    param(
        [string]$Url,
        [object]$Body
    )

    $json = $Body | ConvertTo-Json -Depth 20
    Invoke-RestMethod -Uri $Url -Method Put -ContentType 'application/json' -Body $json -TimeoutSec 10 | Out-Null
}

$serverPath = Join-Path $LlamaCppRoot 'llama-server.exe'
if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "llama-server.exe not found at $serverPath"
}

$resolvedModelPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ModelPath)
if (-not (Test-Path -LiteralPath $resolvedModelPath)) {
    throw "Model file not found: $resolvedModelPath"
}

$temperature = 0.6
$topP = 0.95
$topK = 20
$minP = 0.0
$presencePenalty = 0.0
$repetitionPenalty = 1.0
$reasoning = 'on'
$reasoningBudget = 10000

if ($ConfigUrl) {
    Set-Json -Url $ConfigUrl -Body @{
        Backend = 'llama.cpp'
        Model = 'Qwen3.5-9B-Q8_0.gguf'
        Runtime = @{
            Model = 'Qwen3.5-9B-Q8_0.gguf'
            LlamaCpp = @{
                BaseUrl = $BaseUrl
                NumCtx = $ContextSize
                ModelPath = $resolvedModelPath
                Temperature = $temperature
                TopP = $topP
                TopK = $topK
                MinP = $minP
                PresencePenalty = $presencePenalty
                RepetitionPenalty = $repetitionPenalty
                MaxTokens = $MaxTokens
                GpuLayers = $GpuLayers
                Threads = $Threads
                FlashAttention = $FlashAttention
                ParallelSlots = $ParallelSlots
                Reasoning = $reasoning
            }
        }
    }
}

Write-Output "managed_startup=$($env:SIFTKIT_MANAGED_LLAMA_STARTUP)"
Write-Output "model_path=$resolvedModelPath"
Write-Output "base_url=$BaseUrl"
Write-Output "reasoning=$reasoning"

$arguments = @(
    '-m', $resolvedModelPath,
    '-c', $ContextSize,
    '--cache-ram', $CacheRam,
    '-ngl', $GpuLayers,
    '-t', $Threads,
    '-b', $BatchSize,
    '-ub', $UBatchSize,
    '-np', $ParallelSlots,
    '--temp', $temperature,
    '--top-p', $topP,
    '--top-k', $topK,
    '--min-p', $minP,
    '--presence-penalty', $presencePenalty,
    '--repeat-penalty', $repetitionPenalty,
    '--reasoning', $reasoning,
    '--reasoning-budget', $reasoningBudget,
    '--host', $BindHost,
    '--port', $Port
)

if ($FlashAttention) {
    $arguments += @('-fa', 'on')
}

$startInfo = @{
    FilePath = $serverPath
    ArgumentList = $arguments
    WorkingDirectory = $LlamaCppRoot
    PassThru = $true
    WindowStyle = 'Hidden'
}

if ($env:SIFTKIT_LLAMA_STDOUT_PATH) {
    $startInfo.RedirectStandardOutput = $env:SIFTKIT_LLAMA_STDOUT_PATH
}
if ($env:SIFTKIT_LLAMA_STDERR_PATH) {
    $startInfo.RedirectStandardError = $env:SIFTKIT_LLAMA_STDERR_PATH
}

$process = Start-Process @startInfo
Write-Output "llama_pid=$($process.Id)"
exit 0
