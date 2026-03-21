param(
    [switch]$PrintDefaultsJson,
    [string]$BindHost = '127.0.0.1',
    [int]$Port = 8097,
    [string]$LlamaCppRoot = 'C:\Users\denys\Documents\GitHub\llamacpp',
    [string]$ModelPath = 'D:\personal\models\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
    [int]$ContextSize = 150000,
    [int]$GpuLayers = 999,
    [int]$Threads = 22,
    [bool]$FlashAttention = $true,
    [int]$ParallelSlots = 1,
    [int]$BatchSize = 1536,
    [int]$UBatchSize = 1536,
    [int]$NCpuMoe = 7,
    [int]$CacheRam = 0,
    [string]$Reasoning = 'off',
    [int]$ReasoningBudget = -1,
    [string]$ReasoningBudgetMessage = '__NONE__',
    [string]$ReasoningFormat = '__NONE__',
    [int]$MaxTokens = 15000,
    [double]$Temperature = 0.7,
    [double]$TopP = 0.8,
    [int]$TopK = 20,
    [double]$MinP = 0.0,
    [double]$PresencePenalty = 1.5,
    [double]$RepetitionPenalty = 1.0,
    [int]$RepeatLastN = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LauncherDefaults {
    return [ordered]@{
        LaunchDefaults = [ordered]@{
            BindHost = $BindHost
            Port = $Port
            LlamaCppRoot = $LlamaCppRoot
            ModelPath = $ModelPath
            ContextSize = $ContextSize
            GpuLayers = $GpuLayers
            Threads = $Threads
            FlashAttention = $FlashAttention
            ParallelSlots = $ParallelSlots
            BatchSize = $BatchSize
            UBatchSize = $UBatchSize
            NCpuMoe = $NCpuMoe
            CacheRam = $CacheRam
            Reasoning = $Reasoning
            ReasoningBudget = $ReasoningBudget
            ReasoningBudgetMessage = $ReasoningBudgetMessage
            ReasoningFormat = $ReasoningFormat
            MaxTokens = $MaxTokens
            Temperature = $Temperature
            TopP = $TopP
            TopK = $TopK
            MinP = $MinP
            PresencePenalty = $PresencePenalty
            RepetitionPenalty = $RepetitionPenalty
            RepeatLastN = $RepeatLastN
        }
        RequestDefaults = [ordered]@{
            Temperature = $Temperature
            TopP = $TopP
            TopK = $TopK
            MinP = $MinP
            PresencePenalty = $PresencePenalty
            RepetitionPenalty = $RepetitionPenalty
            MaxTokens = $MaxTokens
        }
    }
}

function Resolve-RequiredPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw "$Label not found: $resolved"
    }

    return $resolved
}

function Add-OptionalArgument {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [switch]$SkipWhenSentinel,
        [string]$Sentinel = '__NONE__'
    )

    if ($SkipWhenSentinel -and $Value -eq $Sentinel) {
        return
    }

    $Arguments.Add($Name)
    $Arguments.Add($Value)
}

if ($PrintDefaultsJson) {
    (Get-LauncherDefaults | ConvertTo-Json -Depth 10)
    exit 0
}

$serverPath = Resolve-RequiredPath -Path (Join-Path $LlamaCppRoot 'llama-server.exe') -Label 'llama-server.exe'
$resolvedModelPath = Resolve-RequiredPath -Path $ModelPath -Label 'model'

Write-Host 'Starting benchmark launcher with standalone defaults.'
Write-Host "Server           : $serverPath"
Write-Host "Model            : $resolvedModelPath"
Write-Host "Host             : $BindHost"
Write-Host "Port             : $Port"
Write-Host "ContextSize      : $ContextSize"
Write-Host "GpuLayers        : $GpuLayers"
Write-Host "Threads          : $Threads"
Write-Host "FlashAttention   : $FlashAttention"
Write-Host "ParallelSlots    : $ParallelSlots"
Write-Host "BatchSize        : $BatchSize"
Write-Host "UBatchSize       : $UBatchSize"
Write-Host "NCpuMoe          : $NCpuMoe"
Write-Host "CacheRam         : $CacheRam"
Write-Host "Reasoning        : $Reasoning"
if ($ReasoningBudget -ge 0) { Write-Host "ReasoningBudget  : $ReasoningBudget" }
if ($ReasoningBudgetMessage -ne '__NONE__') { Write-Host "ReasoningMessage : $ReasoningBudgetMessage" }
if ($ReasoningFormat -ne '__NONE__') { Write-Host "ReasoningFormat  : $ReasoningFormat" }
Write-Host "MaxTokens        : $MaxTokens"
Write-Host "Temperature      : $Temperature"
Write-Host "TopP             : $TopP"
Write-Host "TopK             : $TopK"
Write-Host "MinP             : $MinP"
Write-Host "PresencePenalty  : $PresencePenalty"
Write-Host "RepetitionPenalty: $RepetitionPenalty"
if ($RepeatLastN -ge 0) { Write-Host "RepeatLastN      : $RepeatLastN" }
Write-Host ''

$arguments = [System.Collections.Generic.List[string]]::new()
$arguments.Add('-m')
$arguments.Add($resolvedModelPath)
$arguments.Add('-c')
$arguments.Add([string]$ContextSize)
$arguments.Add('--cache-ram')
$arguments.Add([string]$CacheRam)
$arguments.Add('-ngl')
$arguments.Add([string]$GpuLayers)
$arguments.Add('-t')
$arguments.Add([string]$Threads)
$arguments.Add('-b')
$arguments.Add([string]$BatchSize)
$arguments.Add('-ub')
$arguments.Add([string]$UBatchSize)
$arguments.Add('-np')
$arguments.Add([string]$ParallelSlots)
$arguments.Add('--temp')
$arguments.Add([string]$Temperature)
$arguments.Add('--top-p')
$arguments.Add([string]$TopP)
$arguments.Add('--top-k')
$arguments.Add([string]$TopK)
$arguments.Add('--min-p')
$arguments.Add([string]$MinP)
$arguments.Add('--presence-penalty')
$arguments.Add([string]$PresencePenalty)
$arguments.Add('--repeat-penalty')
$arguments.Add([string]$RepetitionPenalty)
$arguments.Add('--reasoning')
$arguments.Add($Reasoning)
$arguments.Add('--host')
$arguments.Add($BindHost)
$arguments.Add('--port')
$arguments.Add([string]$Port)

if ($MaxTokens -ge 0) {
    $arguments.Add('-n')
    $arguments.Add([string]$MaxTokens)
}
if ($RepeatLastN -ge 0) {
    $arguments.Add('--repeat-last-n')
    $arguments.Add([string]$RepeatLastN)
}
if ($ReasoningBudget -ge 0) {
    $arguments.Add('--reasoning-budget')
    $arguments.Add([string]$ReasoningBudget)
}
Add-OptionalArgument -Arguments $arguments -Name '--reasoning-budget-message' -Value $ReasoningBudgetMessage -SkipWhenSentinel
Add-OptionalArgument -Arguments $arguments -Name '--reasoning-format' -Value $ReasoningFormat -SkipWhenSentinel
if ($NCpuMoe -ge 0) {
    $arguments.Add('-ncmoe')
    $arguments.Add([string]$NCpuMoe)
}
if ($FlashAttention) {
    $arguments.Add('-fa')
    $arguments.Add('on')
}

& $serverPath @arguments
