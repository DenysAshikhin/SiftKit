[CmdletBinding()]
param(
    [ValidateSet('24k', '64k', '128k')]
    [string]$Context
)

$ErrorActionPreference = 'Stop'

$pythonPath = 'C:\envs\rl313\Scripts\python.exe'
$chatScriptPath = 'C:\Users\denys\Documents\GitHub\exllamav3\examples\chat.py'
$modelPath = 'D:\personal\models\elx3\3.6_27b_4.7bpw'

$contextFiles = @{
    '24k' = Join-Path $PSScriptRoot 'exl3-context-24k.txt'
    '64k' = Join-Path $PSScriptRoot 'exl3-context-64k.txt'
    '128k' = Join-Path $PSScriptRoot 'exl3-context-128k.txt'
}

if (-not $Context) {
    Write-Host 'Select input context size:'
    Write-Host '  1. 24k tokens'
    Write-Host '  2. 64k tokens'
    Write-Host '  3. 128k tokens'
    $selection = Read-Host 'Selection'
    $Context = switch ($selection) {
        '1' { '24k' }
        '2' { '64k' }
        '3' { '128k' }
        default { throw "Invalid selection: $selection" }
    }
}

$contextPath = $contextFiles[$Context]
foreach ($requiredPath in @($pythonPath, $chatScriptPath, $modelPath, $contextPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path does not exist: $requiredPath"
    }
}

$prompt = Get-Content -Raw -LiteralPath $contextPath

$commonArguments = @(
    $chatScriptPath
    '-m'
    $modelPath
    '-mode'
    'qwen35'
    '-cs'
    '150016'
    '-cq'
    '8,8'
    '-maxr'
    '256'
    '-temp'
    '0.6'
    '-presp'
    '1.5'
    '-repp'
    '1.0'
    '-minp'
    '0'
    '-topk'
    '0'
    '-topp'
    '1'
    '-tps'
    '-basic'
)

Write-Host "context=$Context file=$contextPath"
foreach ($penaltyRange in @('100000000', '4096')) {
    Write-Host "penalty_range=$penaltyRange"
    @($prompt, '/x') | & $pythonPath @commonArguments '-penr' $penaltyRange
    if ($LASTEXITCODE -ne 0) {
        throw "EXL3 chat.py failed for penalty_range=$penaltyRange with exit code $LASTEXITCODE"
    }
}
