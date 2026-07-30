[CmdletBinding()]
param(
    [switch]$Smoke
)

$ErrorActionPreference = 'Stop'

$pythonPath = 'C:\envs\rl313\Scripts\python.exe'
$chatScriptPath = 'C:\Users\denys\Documents\GitHub\exllamav3\examples\chat.py'
$modelPath = 'D:\personal\models\elx3\3.6_27b_4.7bpw'

foreach ($requiredPath in @($pythonPath, $chatScriptPath, $modelPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path does not exist: $requiredPath"
    }
}

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
)

if ($Smoke) {
    $commonArguments += @(
        '-prompt'
        'Reply with exactly: penalty range smoke test passed'
    )
}

foreach ($penaltyRange in @('100000000', '4096')) {
    Write-Host "penalty_range=$penaltyRange"
    & $pythonPath @commonArguments '-penr' $penaltyRange
    if ($LASTEXITCODE -ne 0) {
        throw "EXL3 chat.py failed for penalty_range=$penaltyRange with exit code $LASTEXITCODE"
    }
}
