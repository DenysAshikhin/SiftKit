[CmdletBinding()]
param(
    [switch]$SkipPester,
    [switch]$SkipSummarySmoke,
    [string]$SummaryQuestion = 'summarize the main point of this synthetic test input in one short sentence',
    [int]$SummaryCharacters = 6000
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Path $PSScriptRoot -Parent

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-Host "==> $Label"
    & $Action
}

function Invoke-CmdCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLine
    )

    & cmd.exe /d /s /c $CommandLine
    if ($LASTEXITCODE -ne 0) {
        throw "$CommandLine failed with exit code $LASTEXITCODE."
    }
}

Push-Location $repoRoot
try {
    Invoke-Step -Label 'Build TypeScript client' -Action {
        Invoke-CmdCommand 'npm run build'
    }

    Invoke-Step -Label 'Run Node test suite' -Action {
        & node --test --test-isolation=none .\tests\runtime.test.js
        if ($LASTEXITCODE -ne 0) {
            throw "Node runtime tests failed with exit code $LASTEXITCODE."
        }
    }

    if (-not $SkipPester) {
        Invoke-Step -Label 'Run PowerShell compatibility tests' -Action {
            Invoke-Pester -Path .\tests\SiftKit.Tests.ps1 -EnableExit
            if ($LASTEXITCODE -ne 0) {
                throw "Invoke-Pester failed with exit code $LASTEXITCODE."
            }
        }
    }

    if (-not $SkipSummarySmoke) {
        Invoke-Step -Label 'Run summary smoke through the client CLI' -Action {
            $summaryInput = 'A' * [Math]::Max($SummaryCharacters, 1000)
            & node .\bin\siftkit.js summary --question $SummaryQuestion --text $summaryInput --backend mock --model mock-model
            if ($LASTEXITCODE -ne 0) {
                throw "Summary smoke test failed with exit code $LASTEXITCODE."
            }
        }
    }
}
finally {
    Pop-Location
}
