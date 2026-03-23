[CmdletBinding()]
param(
    [string]$LlamaBaseUrl = $(if ($env:SIFTKIT_LLAMA_BASE_URL) { $env:SIFTKIT_LLAMA_BASE_URL } else { 'http://127.0.0.1:8080' }),
    [string]$Model = $(if ($env:SIFTKIT_LLAMA_MODEL) { $env:SIFTKIT_LLAMA_MODEL } else { 'qwen3.5-9b-instruct-q4_k_m' }),
    [int]$SummaryCharacters = 12000,
    [int]$OversizedCharacters = 320001
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

function Get-ConfigServiceUrl {
    if ($env:SIFTKIT_CONFIG_SERVICE_URL) {
        return $env:SIFTKIT_CONFIG_SERVICE_URL
    }

    $statusUrl = if ($env:SIFTKIT_STATUS_BACKEND_URL) { $env:SIFTKIT_STATUS_BACKEND_URL } else { 'http://127.0.0.1:4765/status' }
    $uri = [Uri]$statusUrl
    '{0}://{1}:{2}/config' -f $uri.Scheme, $uri.Host, $uri.Port
}

Push-Location $repoRoot
try {
    Invoke-Step -Label 'Build TypeScript client' -Action {
        Invoke-CmdCommand 'npm run build'
    }

    Invoke-Step -Label 'Configure external llama.cpp backend' -Action {
        $configUrl = Get-ConfigServiceUrl
        $existing = Invoke-RestMethod -Uri $configUrl -Method Get
        if (-not $existing.LlamaCpp) {
            $existing | Add-Member -NotePropertyName LlamaCpp -NotePropertyValue @{}
        }

        $existing.Backend = 'llama.cpp'
        $existing.Model = $Model
        $existing.LlamaCpp.BaseUrl = $LlamaBaseUrl
        $existing.LlamaCpp.NumCtx = 128000
        $existing.LlamaCpp.Temperature = 0.2
        $existing.LlamaCpp.TopP = 0.95
        $existing.LlamaCpp.TopK = 20
        $existing.LlamaCpp.MinP = 0.0
        $existing.LlamaCpp.PresencePenalty = 0.0
        $existing.LlamaCpp.RepetitionPenalty = 1.0
        $existing.LlamaCpp.MaxTokens = 4096
        $existing.Thresholds.ChunkThresholdRatio = 1.0
        $json = $existing | ConvertTo-Json -Depth 12
        Invoke-RestMethod -Uri $configUrl -Method Put -ContentType 'application/json' -Body $json | Out-Null
    }

    Invoke-Step -Label 'Run llama.cpp readiness check' -Action {
        & node .\bin\siftkit.js test
        if ($LASTEXITCODE -ne 0) {
            throw "siftkit test failed with exit code $LASTEXITCODE."
        }
    }

    Invoke-Step -Label 'Run live summary smoke' -Action {
        $summaryInput = 'A' * [Math]::Max($SummaryCharacters, 1000)
        & node .\bin\siftkit.js summary --question 'summarize the main point of this synthetic test input in one short sentence' --text $summaryInput
        if ($LASTEXITCODE -ne 0) {
            throw "Live summary smoke failed with exit code $LASTEXITCODE."
        }
    }

    Invoke-Step -Label 'Run oversized recursive summary smoke' -Action {
        $oversizedInput = 'B' * [Math]::Max($OversizedCharacters, 300001)
        & node .\bin\siftkit.js summary --question 'summarize this oversized synthetic input in one short sentence' --text $oversizedInput
        if ($LASTEXITCODE -ne 0) {
            throw "Oversized live summary smoke failed with exit code $LASTEXITCODE."
        }
    }
}
finally {
    Pop-Location
}
