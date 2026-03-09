[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Stop-RunningOllamaModels {
    $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollamaCommand) {
        Write-Host 'Ollama not found. Skipping model stop step.'
        return
    }

    $loadedModels = @(
        & ollama ps 2>$null |
            Select-Object -Skip 1 |
            ForEach-Object {
                $line = $_.ToString().Trim()
                if (-not $line) {
                    return
                }

                ($line -split '\s{2,}')[0].Trim()
            } |
            Where-Object { $_ } |
            Select-Object -Unique
    )

    if ($loadedModels.Count -eq 0) {
        Write-Host 'No running Ollama models to stop.'
        return
    }

    Write-Host ('Stopping running Ollama models: {0}' -f ($loadedModels -join ', '))
    foreach ($model in $loadedModels) {
        & ollama stop $model | Out-Host
    }
}

function Get-GlobalSiftKitCommandPath {
    $globalPrefix = (npm prefix -g 2>$null | Select-Object -First 1).ToString().Trim()
    if (-not $globalPrefix) {
        throw 'Unable to determine npm global prefix.'
    }

    $candidatePaths = @(
        (Join-Path $globalPrefix 'siftkit.cmd'),
        (Join-Path $globalPrefix 'siftkit.ps1')
    )

    foreach ($candidatePath in $candidatePaths) {
        if (Test-Path -LiteralPath $candidatePath) {
            return $candidatePath
        }
    }

    throw ('Unable to locate the global siftkit shim under {0}.' -f $globalPrefix)
}

Write-Host 'Stopping running Ollama models...'
Stop-RunningOllamaModels

Write-Host 'Uninstalling global siftkit...'
npm uninstall -g siftkit | Out-Host

Write-Host 'Installing current repo globally...'
npm i -g . --force | Out-Host

Write-Host 'Resolving freshly installed global siftkit command...'
$globalSiftKit = Get-GlobalSiftKitCommandPath

Write-Host 'Running siftkit test...'
& $globalSiftKit test | Out-Host

$siftInput = ((1..25 | ForEach-Object { "INFO step $_ completed successfully" }) + "ERROR database migration failed: duplicate key on users.email") -join "`n"

Write-Host 'Running sample summary...'
& $globalSiftKit summary --question "what is the main problem?" --text $siftInput | Out-Host

Write-Host 'Showing loaded Ollama model state...'
ollama ps | Out-Host
