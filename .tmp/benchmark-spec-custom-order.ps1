[CmdletBinding()]
param(
    [string]$Prompt = '',
    [string]$OutputRoot = '.\eval\results\spec_bench',
    [string]$StatusHost = '127.0.0.1',
    [int]$StatusPort = 4765,
    [string]$RepoRoot = '.',
    [int]$CaseLimit = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$script:ServiceBaseUrl = "http://${StatusHost}:${StatusPort}"
$script:StartedStatusProcess = $null
$script:StartedStatusStdout = $null
$script:StartedStatusStderr = $null
$script:DefaultBenchmarkPrompts = @(
    'find all non-status-server call sites that pass speculativeAcceptedTokens or speculativeGeneratedTokens into sendStatusUpdate/status backend options; return exact file:line anchors and the source values used',
    'trace the repo-search completion telemetry path end to end: starting at executeRepoSearchRequest, find where promptCacheTokens, promptEvalTokens, outputTokens, thinkingTokens, and requestDurationMs are computed, persisted to run_logs, and exposed through /dashboard/runs; return exact file:line anchors grouped by stage',
    'trace the canonical speculative metrics flow end to end: find where managed llama logs are parsed, where speculativeAcceptedTokens and speculativeGeneratedTokens are written to run_logs, and where dashboard metrics or idle summaries read those persisted fields; return exact file:line anchors grouped by parse, persist, and read stages'
)

function Invoke-JsonGet {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 30
}

function Invoke-JsonPut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [object]$Body
    )

    $json = $Body | ConvertTo-Json -Depth 50
    return Invoke-RestMethod -Uri $Url -Method Put -TimeoutSec 30 -ContentType 'application/json' -Body $json
}

function Invoke-JsonPost {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [object]$Body = $null
    )

    if ($null -eq $Body) {
        return Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 30
    }

    $json = $Body | ConvertTo-Json -Depth 50
    return Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec 30 -ContentType 'application/json' -Body $json
}

function Test-StatusHealth {
    try {
        $null = Invoke-JsonGet -Url "${script:ServiceBaseUrl}/health"
        return $true
    }
    catch {
        return $false
    }
}

function Wait-StatusHealth {
    param(
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).ToUniversalTime().AddSeconds($TimeoutSeconds)
    while ((Get-Date).ToUniversalTime() -lt $deadline) {
        if (Test-StatusHealth) {
            return
        }
        Start-Sleep -Milliseconds 500
    }

    throw "Timed out waiting for ${script:ServiceBaseUrl}/health"
}

function Ensure-StatusServer {
    if (Test-StatusHealth) {
        return
    }

    $stdoutPath = Join-Path $script:RepoRoot '.tmp\benchmark-spec-status.stdout.log'
    $stderrPath = Join-Path $script:RepoRoot '.tmp\benchmark-spec-status.stderr.log'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stdoutPath) | Out-Null

    $script:StartedStatusStdout = $stdoutPath
    $script:StartedStatusStderr = $stderrPath
    $script:StartedStatusProcess = Start-Process `
        -FilePath 'npm.cmd' `
        -ArgumentList @('run', 'start:status:stable') `
        -WorkingDirectory $script:RepoRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru

    Wait-StatusHealth
}

function Stop-StartedStatusServer {
    if ($null -eq $script:StartedStatusProcess) {
        return
    }

    try {
        if (-not $script:StartedStatusProcess.HasExited) {
            Stop-Process -Id $script:StartedStatusProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        $script:StartedStatusProcess = $null
    }
}

function Get-DefaultCases {
    return @(
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 32; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 32; SpeculativeDraftMin = 4 },
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 32; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 32; SpeculativeDraftMin = 4 },
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 },
        @{ SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 },
        @{ SpeculativeEnabled = $false; SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 },
        @{ SpeculativeEnabled = $false; SpeculativeNgramSizeN = 24; SpeculativeNgramSizeM = 64; SpeculativeNgramMinHits = 2; SpeculativeDraftMax = 48; SpeculativeDraftMin = 4 }
    )
}

function Get-SelectedCases {
    $cases = Get-DefaultCases
    if ($CaseLimit -le 0 -or $CaseLimit -ge $cases.Count) {
        return @($cases)
    }

    return @($cases | Select-Object -First $CaseLimit)
}

function Get-BenchmarkPrompts {
    $selectedPrompts = New-Object System.Collections.Generic.List[string]
    $seenPrompts = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

    if (-not [string]::IsNullOrWhiteSpace($Prompt)) {
        $trimmedPrompt = $Prompt.Trim()
        if ($seenPrompts.Add($trimmedPrompt)) {
            $selectedPrompts.Add($trimmedPrompt) | Out-Null
        }
    }

    foreach ($defaultPrompt in $script:DefaultBenchmarkPrompts) {
        if ([string]::IsNullOrWhiteSpace($defaultPrompt)) {
            continue
        }
        $trimmedPrompt = $defaultPrompt.Trim()
        if ($seenPrompts.Add($trimmedPrompt)) {
            $selectedPrompts.Add($trimmedPrompt) | Out-Null
        }
        if ($selectedPrompts.Count -ge 3) {
            break
        }
    }

    return @($selectedPrompts)
}

function Get-CaseId {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Case
    )

    if ($Case.ContainsKey('SpeculativeEnabled') -and (-not [bool]$Case.SpeculativeEnabled)) {
        return 'baseline-no-spec'
    }

    return "n$($Case.SpeculativeNgramSizeN)-m$($Case.SpeculativeNgramSizeM)-h$($Case.SpeculativeNgramMinHits)-dmax$($Case.SpeculativeDraftMax)-dmin$($Case.SpeculativeDraftMin)"
}

function New-OutputDirectory {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $root = [System.IO.Path]::GetFullPath((Join-Path $script:RepoRoot $OutputRoot))
    $path = Join-Path $root $stamp
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    return $path
}

function Write-BenchmarkArtifacts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$OutputDirectory,
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[object]]$Results
    )

    $sortedResults = @($Results | Sort-Object {
        if ($null -ne $_.runMetrics -and $null -ne $_.runMetrics.outputTokensPerSecond) {
            [double]$_.runMetrics.outputTokensPerSecond
        }
        else {
            0
        }
    } -Descending)
    $resultsPath = Join-Path $OutputDirectory 'results.json'
    $summaryPath = Join-Path $OutputDirectory 'summary.csv'
    $sortedResults | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $resultsPath -Encoding utf8
    $sortedResults | ForEach-Object {
        $runMetrics = $_.runMetrics
        [pscustomobject]@{
            caseId = $_.caseId
            sampleCount = $_.sampleCount
            cliExitCode = $_.cliExitCode
            runId = $_.runId
            managedRunId = $_.managedRunId
            promptTokensPerSecond = if ($null -ne $runMetrics) { $runMetrics.promptTokensPerSecond } else { $null }
            outputTokensPerSecond = if ($null -ne $runMetrics) { $runMetrics.outputTokensPerSecond } else { $null }
            acceptanceRate = if ($null -ne $runMetrics) { $runMetrics.acceptanceRate } else { $null }
            promptCacheTokens = if ($null -ne $runMetrics) { $runMetrics.promptCacheTokens } else { $null }
            promptEvalTokens = if ($null -ne $runMetrics) { $runMetrics.promptEvalTokens } else { $null }
            speculativeAcceptedTokens = if ($null -ne $runMetrics) { $runMetrics.speculativeAcceptedTokens } else { $null }
            speculativeGeneratedTokens = if ($null -ne $runMetrics) { $runMetrics.speculativeGeneratedTokens } else { $null }
            cliDurationMs = $_.cliDurationMs
            failureStage = $_.failureStage
            error = $_.error
        }
    } | Export-Csv -LiteralPath $summaryPath -NoTypeInformation
}

function Get-AverageNumber {
    param(
        [AllowNull()]
        [object[]]$Values = @(),
        [switch]$RoundToInt
    )

    $numbers = @(@($Values) | Where-Object { $null -ne $_ })
    if ($numbers.Count -eq 0) {
        return $null
    }

    $sum = 0.0
    foreach ($value in $numbers) {
        $sum += [double]$value
    }

    $average = $sum / $numbers.Count
    if ($RoundToInt) {
        return [int][Math]::Round($average)
    }

    return $average
}

function Get-FirstNonNullValue {
    param(
        [AllowNull()]
        [object[]]$Values = @()
    )

    foreach ($value in @($Values)) {
        if ($null -ne $value) {
            return $value
        }
    }

    return $null
}

function Join-NonEmptyValues {
    param(
        [AllowNull()]
        [object[]]$Values = @()
    )

    $parts = @(
        @($Values) | Where-Object {
            $null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_)
        } | ForEach-Object { [string]$_ }
    )
    if ($parts.Count -eq 0) {
        return $null
    }

    return ($parts -join ';')
}

function Get-AverageCaseResult {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CaseId,
        [Parameter(Mandatory = $true)]
        [string[]]$Prompts,
        [Parameter(Mandatory = $true)]
        [hashtable]$Case,
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[object]]$AttemptResults
    )

    $attempts = @($AttemptResults)
    if ($attempts.Count -eq 0) {
        throw "Cannot average benchmark case '$CaseId' without attempts."
    }

    $failedAttempt = @($attempts | Where-Object { $null -ne $_.failureStage -or $_.cliExitCode -ne 0 } | Select-Object -First 1)
    $runMetricsSamples = @($attempts | ForEach-Object { $_.runMetrics } | Where-Object { $null -ne $_ })
    $firstAttempt = $attempts[0]

    $averagedRunMetrics = if ($runMetricsSamples.Count -gt 0) {
        [ordered]@{
            promptCacheTokens = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.promptCacheTokens }) -RoundToInt
            promptEvalTokens = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.promptEvalTokens }) -RoundToInt
            cacheHitRate = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.cacheHitRate })
            speculativeAcceptedTokens = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.speculativeAcceptedTokens }) -RoundToInt
            speculativeGeneratedTokens = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.speculativeGeneratedTokens }) -RoundToInt
            acceptanceRate = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.acceptanceRate })
            promptTokensPerSecond = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.promptTokensPerSecond })
            outputTokensPerSecond = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.outputTokensPerSecond })
            outputTokens = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.outputTokens }) -RoundToInt
            thinkingTokens = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.thinkingTokens }) -RoundToInt
            generationDurationMs = Get-AverageNumber -Values @($runMetricsSamples | ForEach-Object { $_.generationDurationMs }) -RoundToInt
        }
    }
    else {
        $null
    }

    return [pscustomobject][ordered]@{
        caseId = $CaseId
        prompt = if ($Prompts.Count -eq 1) { $Prompts[0] } else { $null }
        prompts = @($Prompts)
        sampleCount = $attempts.Count
        startedAtUtc = $firstAttempt.startedAtUtc
        endedAtUtc = $attempts[-1].endedAtUtc
        cliDurationMs = Get-AverageNumber -Values @($attempts | ForEach-Object { $_.cliDurationMs }) -RoundToInt
        cliExitCode = if ($failedAttempt.Count -gt 0) { [int]$failedAttempt[0].cliExitCode } else { 0 }
        cliCommand = $firstAttempt.cliCommand
        cliStdoutPath = $null
        cliStderrPath = $null
        sessionId = $null
        runId = Join-NonEmptyValues -Values @($attempts | ForEach-Object { $_.runId })
        managedRunId = Join-NonEmptyValues -Values @($attempts | ForEach-Object { $_.managedRunId })
        settings = [ordered]@{
            SpeculativeNgramSizeN = $Case.SpeculativeNgramSizeN
            SpeculativeNgramSizeM = $Case.SpeculativeNgramSizeM
            SpeculativeNgramMinHits = $Case.SpeculativeNgramMinHits
            SpeculativeDraftMax = $Case.SpeculativeDraftMax
            SpeculativeDraftMin = $Case.SpeculativeDraftMin
        }
        runMetrics = $averagedRunMetrics
        failureStage = if ($failedAttempt.Count -gt 0) { $failedAttempt[0].failureStage } else { $null }
        error = if ($failedAttempt.Count -gt 0) { $failedAttempt[0].error } else { $null }
        runs = $attempts
    }
}

function Get-RepoSearchRuns {
    $response = Invoke-JsonGet -Url "${script:ServiceBaseUrl}/dashboard/runs?kind=repo_search&limitPerGroup=100"
    if ($null -eq $response.runs) {
        return @()
    }
    return @($response.runs)
}

function Find-BenchmarkRun {
    param(
        [Parameter(Mandatory = $true)]
        [array]$Runs,
        [Parameter(Mandatory = $true)]
        [string]$PromptText,
        [Parameter(Mandatory = $true)]
        [datetime]$StartedAtUtc
    )

    $matches = @(
        $Runs | Where-Object {
            $effectiveTime = if ($_.finishedAtUtc) { $_.finishedAtUtc } else { $_.startedAtUtc }
            (($_.kind -eq 'repo_search') -or ($_.kind -eq 'repo-search')) `
            -and ($_.title -eq $PromptText) `
            -and $effectiveTime `
            -and ([datetime]::Parse($effectiveTime).ToUniversalTime() -ge $StartedAtUtc)
        } | Sort-Object {
            $effectiveTime = if ($_.finishedAtUtc) { $_.finishedAtUtc } else { $_.startedAtUtc }
            [datetime]::Parse($effectiveTime).ToUniversalTime()
        } -Descending
    )

    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0]
}

function Get-ManagedRuns {
    $response = Invoke-JsonGet -Url "${script:ServiceBaseUrl}/dashboard/admin/managed-llama/runs?limit=100"
    if ($null -eq $response.runs) {
        return @()
    }
    return @($response.runs)
}

function Find-ManagedRunForCase {
    param(
        [Parameter(Mandatory = $true)]
        [array]$Runs,
        [Parameter(Mandatory = $true)]
        [datetime]$StartedAtUtc
    )

    $matches = @(
        $Runs | Where-Object {
            $_.startedAtUtc -and ([datetime]::Parse($_.startedAtUtc).ToUniversalTime() -ge $StartedAtUtc)
        } | Sort-Object {
            [datetime]::Parse($_.startedAtUtc).ToUniversalTime()
        } -Descending
    )

    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0]
}

function Get-RunTelemetryStats {
    param(
        [Parameter(Mandatory = $false)]
        [object]$Run
    )

    $promptCacheTokens = 0.0
    $promptEvalTokens = 0.0
    $outputTokens = 0.0
    $thinkingTokens = 0.0
    $generationDurationMs = 0.0
    $promptEvalDurationMs = 0.0
    $specAccepted = $null
    $specGenerated = $null

    if ($null -ne $Run) {
        if ($null -ne $Run.promptCacheTokens) {
            $promptCacheTokens = [double]$Run.promptCacheTokens
        }
        if ($null -ne $Run.promptEvalTokens) {
            $promptEvalTokens = [double]$Run.promptEvalTokens
        }
        if ($null -ne $Run.outputTokens) {
            $outputTokens = [double]$Run.outputTokens
        }
        if ($null -ne $Run.thinkingTokens) {
            $thinkingTokens = [double]$Run.thinkingTokens
        }
        if ($null -ne $Run.generationDurationMs) {
            $generationDurationMs = [double]$Run.generationDurationMs
        }
        if ($null -ne $Run.promptEvalDurationMs) {
            $promptEvalDurationMs = [double]$Run.promptEvalDurationMs
        }
        if ($null -ne $Run.speculativeAcceptedTokens) {
            $specAccepted = [double]$Run.speculativeAcceptedTokens
        }
        if ($null -ne $Run.speculativeGeneratedTokens) {
            $specGenerated = [double]$Run.speculativeGeneratedTokens
        }
    }
    $totalPromptTokens = $promptCacheTokens + $promptEvalTokens
    $generatedTokens = $outputTokens + $thinkingTokens

    return [ordered]@{
        promptCacheTokens = [int]$promptCacheTokens
        promptEvalTokens = [int]$promptEvalTokens
        cacheHitRate = if ($totalPromptTokens -gt 0) { $promptCacheTokens / $totalPromptTokens } else { $null }
        speculativeAcceptedTokens = if ($null -ne $specAccepted) { [int]$specAccepted } else { $null }
        speculativeGeneratedTokens = if ($null -ne $specGenerated) { [int]$specGenerated } else { $null }
        acceptanceRate = if ($specGenerated -gt 0) { $specAccepted / $specGenerated } else { $null }
        promptTokensPerSecond = if ($promptEvalTokens -gt 0 -and $promptEvalDurationMs -gt 0) { $promptEvalTokens / ($promptEvalDurationMs / 1000.0) } else { $null }
        outputTokensPerSecond = if ($generatedTokens -gt 0 -and $generationDurationMs -gt 0) { $generatedTokens / ($generationDurationMs / 1000.0) } else { $null }
        outputTokens = [int]$outputTokens
        thinkingTokens = [int]$thinkingTokens
        generationDurationMs = if ($generationDurationMs -gt 0) { [int]$generationDurationMs } else { $null }
    }
}

function Get-SpeculativeMetricsVerificationError {
    param(
        [Parameter(Mandatory = $false)]
        [object]$RunMetrics,
        [Parameter(Mandatory = $false)]
        [hashtable]$VerifiedLogMetrics
    )

    if ($null -eq $RunMetrics -or $null -eq $VerifiedLogMetrics) {
        return $null
    }

    $verifiedAccepted = $VerifiedLogMetrics.speculativeAcceptedTokens
    $verifiedGenerated = $VerifiedLogMetrics.speculativeGeneratedTokens
    if ($null -eq $verifiedAccepted -and $null -eq $verifiedGenerated) {
        return $null
    }

    $runAccepted = $RunMetrics.speculativeAcceptedTokens
    $runGenerated = $RunMetrics.speculativeGeneratedTokens
    if ($runAccepted -eq $verifiedAccepted -and $runGenerated -eq $verifiedGenerated) {
        return $null
    }

    return "Persisted run speculative totals ($runAccepted/$runGenerated) did not match managed-llama log delta ($verifiedAccepted/$verifiedGenerated)."
}

function Get-LatestSpeculativeTotalsFromLogText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $statsMatches = [regex]::Matches($Text, '^\s*(?:llama_decode:\s+)?statistics\s+\S+:\s+.*?#gen tokens\s*=\s*(\d+),\s+#acc tokens\s*=\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Multiline)
    $acceptanceMatches = [regex]::Matches($Text, '^\s*(?:llama_decode:\s+)?draft acceptance rate\s*=.*$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::Multiline)
    $latestStats = if ($statsMatches.Count -gt 0) { $statsMatches[$statsMatches.Count - 1] } else { $null }
    $latestAcceptance = if ($acceptanceMatches.Count -gt 0) { $acceptanceMatches[$acceptanceMatches.Count - 1].Value } else { $null }

    return [ordered]@{
        speculative = [regex]::IsMatch($Text, '"speculative"\s*:\s*true', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        checkpointed = [regex]::IsMatch($Text, 'speculative decoding will use checkpoints', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        speculativeGeneratedTokens = if ($null -ne $latestStats) { [int]$latestStats.Groups[1].Value } else { $null }
        speculativeAcceptedTokens = if ($null -ne $latestStats) { [int]$latestStats.Groups[2].Value } else { $null }
        rawAcceptanceLine = $latestAcceptance
    }
}

function Get-SpeculativeLogDeltaTotals {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Current,
        [Parameter(Mandatory = $false)]
        [hashtable]$Baseline = $null
    )

    if ($null -eq $Baseline) {
        return $Current
    }

    $currentAccepted = $Current.speculativeAcceptedTokens
    $currentGenerated = $Current.speculativeGeneratedTokens
    $baselineAccepted = $Baseline.speculativeAcceptedTokens
    $baselineGenerated = $Baseline.speculativeGeneratedTokens

    if (
        $null -eq $currentAccepted -or
        $null -eq $currentGenerated -or
        $null -eq $baselineAccepted -or
        $null -eq $baselineGenerated
    ) {
        return $Current
    }

    if ($currentAccepted -lt $baselineAccepted -or $currentGenerated -lt $baselineGenerated) {
        return $Current
    }

    return [ordered]@{
        speculative = [bool]$Current.speculative
        checkpointed = [bool]$Current.checkpointed
        speculativeGeneratedTokens = [int]($currentGenerated - $baselineGenerated)
        speculativeAcceptedTokens = [int]($currentAccepted - $baselineAccepted)
        rawAcceptanceLine = $Current.rawAcceptanceLine
    }
}

function Invoke-RepoSearchCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PromptText,
        [Parameter(Mandatory = $true)]
        [string]$OutputDir
    )

    $stdoutPath = Join-Path $OutputDir 'cli.stdout.log'
    $stderrPath = Join-Path $OutputDir 'cli.stderr.log'
    $commandForDisplay = "siftkit repo-search --prompt `"$PromptText`""
    $startedAt = Get-Date

    Push-Location $script:RepoRoot
    try {
        $rawResult = & node .\scripts\invoke-repo-search-benchmark.js `
            --prompt $PromptText `
            --stdout-path $stdoutPath `
            --stderr-path $stderrPath `
            --repo-root $script:RepoRoot
        $result = $rawResult | ConvertFrom-Json
    }
    finally {
        Pop-Location
    }

    return [ordered]@{
        command = if ($null -ne $result.command) { [string]$result.command } else { $commandForDisplay }
        exitCode = if ($null -ne $result.exitCode) { [int]$result.exitCode } else { 1 }
        durationMs = [int][Math]::Round(([datetime]::Parse([string]$result.endedAtUtc).ToUniversalTime() - [datetime]::Parse([string]$result.startedAtUtc).ToUniversalTime()).TotalMilliseconds)
        startedAtUtc = if ($null -ne $result.startedAtUtc) { [string]$result.startedAtUtc } else { $startedAt.ToUniversalTime().ToString('o') }
        endedAtUtc = if ($null -ne $result.endedAtUtc) { [string]$result.endedAtUtc } else { (Get-Date).ToUniversalTime().ToString('o') }
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
        stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
        stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    }
}

function Format-Duration {
    param(
        [Parameter(Mandatory = $true)]
        [timespan]$Duration
    )

    return '{0:00}:{1:00}:{2:00}' -f [int]$Duration.TotalHours, $Duration.Minutes, $Duration.Seconds
}

function Get-ActiveManagedPreset {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$ServerLlamaCpp
    )

    if ($null -eq $ServerLlamaCpp.Presets -or $ServerLlamaCpp.Presets.Count -eq 0) {
        return $null
    }

    $activePresetId = if ($null -ne $ServerLlamaCpp.ActivePresetId) { [string]$ServerLlamaCpp.ActivePresetId } else { '' }
    $activePreset = @($ServerLlamaCpp.Presets | Where-Object { $_.id -eq $activePresetId } | Select-Object -First 1)
    if ($activePreset.Count -gt 0) {
        return $activePreset[0]
    }

    return $ServerLlamaCpp.Presets[0]
}

function Set-SpeculativeCaseOnConfig {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Config,
        [Parameter(Mandatory = $true)]
        [hashtable]$Case
    )

    $specEnabled = $true
    if ($Case.ContainsKey('SpeculativeEnabled')) {
        $specEnabled = [bool]$Case.SpeculativeEnabled
    }
    $activePreset = Get-ActiveManagedPreset -ServerLlamaCpp $Config.Server.LlamaCpp
    $Config.Server.LlamaCpp.SpeculativeEnabled = $specEnabled
    $Config.Server.LlamaCpp.SpeculativeType = 'ngram-mod'
    if ($null -ne $activePreset) {
        $activePreset.SpeculativeEnabled = $specEnabled
        $activePreset.SpeculativeType = 'ngram-mod'
    }
    if (-not $specEnabled) {
        return
    }
    $Config.Server.LlamaCpp.SpeculativeNgramSizeN = $Case.SpeculativeNgramSizeN
    $Config.Server.LlamaCpp.SpeculativeNgramSizeM = $Case.SpeculativeNgramSizeM
    $Config.Server.LlamaCpp.SpeculativeNgramMinHits = $Case.SpeculativeNgramMinHits
    $Config.Server.LlamaCpp.SpeculativeDraftMax = $Case.SpeculativeDraftMax
    $Config.Server.LlamaCpp.SpeculativeDraftMin = $Case.SpeculativeDraftMin
    if ($null -ne $activePreset) {
        $activePreset.SpeculativeNgramSizeN = $Case.SpeculativeNgramSizeN
        $activePreset.SpeculativeNgramSizeM = $Case.SpeculativeNgramSizeM
        $activePreset.SpeculativeNgramMinHits = $Case.SpeculativeNgramMinHits
        $activePreset.SpeculativeDraftMax = $Case.SpeculativeDraftMax
        $activePreset.SpeculativeDraftMin = $Case.SpeculativeDraftMin
    }
}

function Restore-OriginalConfig {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Config
    )

    $null = Invoke-JsonPut -Url "${script:ServiceBaseUrl}/config" -Body $Config
    $null = Invoke-JsonPost -Url "${script:ServiceBaseUrl}/status/restart"
}

$outputDirectory = New-OutputDirectory
$originalConfig = $null
$results = New-Object System.Collections.Generic.List[object]

try {
    Ensure-StatusServer
    $originalConfig = Invoke-JsonGet -Url "${script:ServiceBaseUrl}/config?skip_ready=1"
    $cases = @(Get-SelectedCases)
    $benchmarkPrompts = @(Get-BenchmarkPrompts)
    if ($benchmarkPrompts.Count -eq 0) {
        throw 'Expected at least one benchmark prompt.'
    }
    $benchmarkStartedAt = Get-Date
    $totalCaseCount = $cases.Count

    for ($caseIndex = 0; $caseIndex -lt $cases.Count; $caseIndex += 1) {
        $case = $cases[$caseIndex]
        $caseId = Get-CaseId -Case $case
        $caseStartedAt = Get-Date
        $completedCaseCount = $results.Count
        $elapsedBeforeCase = $caseStartedAt.ToUniversalTime() - $benchmarkStartedAt.ToUniversalTime()
        $remainingEstimate = if ($completedCaseCount -gt 0) {
            [timespan]::FromMilliseconds(($elapsedBeforeCase.TotalMilliseconds / $completedCaseCount) * ($totalCaseCount - $completedCaseCount))
        }
        else {
            $null
        }
        $remainingEstimateText = if ($null -ne $remainingEstimate) {
            Format-Duration -Duration $remainingEstimate
        }
        else {
            'unknown'
        }
        Write-Output ("[{0}/{1}] starting {2} | elapsed={3} | eta={4}" -f ($caseIndex + 1), $totalCaseCount, $caseId, (Format-Duration -Duration $elapsedBeforeCase), $remainingEstimateText)
        $caseOutputDirectory = Join-Path $outputDirectory $caseId
        New-Item -ItemType Directory -Force -Path $caseOutputDirectory | Out-Null
        $attemptResults = New-Object System.Collections.Generic.List[object]

        for ($promptIndex = 0; $promptIndex -lt $benchmarkPrompts.Count; $promptIndex += 1) {
            $promptText = $benchmarkPrompts[$promptIndex]
            $attemptOutputDirectory = Join-Path $caseOutputDirectory ('prompt-{0:00}' -f ($promptIndex + 1))
            New-Item -ItemType Directory -Force -Path $attemptOutputDirectory | Out-Null

            $caseConfig = $originalConfig | ConvertTo-Json -Depth 50 | ConvertFrom-Json
            Set-SpeculativeCaseOnConfig -Config $caseConfig -Case $case
            $null = Invoke-JsonPut -Url "${script:ServiceBaseUrl}/config" -Body $caseConfig

            $restartStartedAtUtc = (Get-Date).ToUniversalTime()
            $null = Invoke-JsonPost -Url "${script:ServiceBaseUrl}/status/restart"
            Wait-StatusHealth
            $baselineManagedRun = Find-ManagedRunForCase -Runs (Get-ManagedRuns) -StartedAtUtc $restartStartedAtUtc
            $baselineManagedRunDetail = if ($null -ne $baselineManagedRun) { Invoke-JsonGet -Url "${script:ServiceBaseUrl}/dashboard/admin/managed-llama/runs/$($baselineManagedRun.id)" } else { $null }
            $baselineLogText = if ($null -ne $baselineManagedRunDetail) {
                @(
                    $baselineManagedRunDetail.logTextByStream.startup_script_stdout
                    $baselineManagedRunDetail.logTextByStream.startup_script_stderr
                    $baselineManagedRunDetail.logTextByStream.llama_stdout
                    $baselineManagedRunDetail.logTextByStream.llama_stderr
                ) -join "`n"
            }
            else {
                ''
            }

            $cli = Invoke-RepoSearchCli -PromptText $promptText -OutputDir $attemptOutputDirectory
            $run = Find-BenchmarkRun -Runs (Get-RepoSearchRuns) -PromptText $promptText -StartedAtUtc ([datetime]::Parse($cli.startedAtUtc).ToUniversalTime())
            $managedRun = Find-ManagedRunForCase -Runs (Get-ManagedRuns) -StartedAtUtc $restartStartedAtUtc
            $managedRunDetail = if ($null -ne $managedRun) { Invoke-JsonGet -Url "${script:ServiceBaseUrl}/dashboard/admin/managed-llama/runs/$($managedRun.id)" } else { $null }
            $logText = if ($null -ne $managedRunDetail) {
                @(
                    $managedRunDetail.logTextByStream.startup_script_stdout
                    $managedRunDetail.logTextByStream.startup_script_stderr
                    $managedRunDetail.logTextByStream.llama_stdout
                    $managedRunDetail.logTextByStream.llama_stderr
                ) -join "`n"
            }
            else {
                ''
            }
            $baselineLogMetrics = Get-LatestSpeculativeTotalsFromLogText -Text $baselineLogText
            $finalLogMetrics = Get-LatestSpeculativeTotalsFromLogText -Text $logText
            $verifiedLogMetrics = Get-SpeculativeLogDeltaTotals -Current $finalLogMetrics -Baseline $baselineLogMetrics
            $runMetrics = if ($null -ne $run) { Get-RunTelemetryStats -Run $run } else { $null }
            $row = [ordered]@{
                promptIndex = $promptIndex + 1
                caseId = $caseId
                prompt = $promptText
                startedAtUtc = $cli.startedAtUtc
                endedAtUtc = $cli.endedAtUtc
                cliDurationMs = $cli.durationMs
                cliExitCode = $cli.exitCode
                cliCommand = $cli.command
                cliStdoutPath = $cli.stdoutPath
                cliStderrPath = $cli.stderrPath
                sessionId = $null
                runId = if ($null -ne $run) { $run.id } else { $null }
                managedRunId = if ($null -ne $managedRun) { $managedRun.id } else { $null }
                settings = [ordered]@{
                    SpeculativeNgramSizeN = $case.SpeculativeNgramSizeN
                    SpeculativeNgramSizeM = $case.SpeculativeNgramSizeM
                    SpeculativeNgramMinHits = $case.SpeculativeNgramMinHits
                    SpeculativeDraftMax = $case.SpeculativeDraftMax
                    SpeculativeDraftMin = $case.SpeculativeDraftMin
                }
                runMetrics = $runMetrics
                failureStage = $null
                error = $null
            }

            if ($cli.exitCode -ne 0) {
                $row.failureStage = 'cli'
                $row.error = "Repo-search CLI exited with code $($cli.exitCode)"
            }
            elseif ($null -eq $run) {
                $row.failureStage = 'run-discovery'
                $row.error = 'No matching repo-search run was found after the CLI invocation.'
            }
            elseif ($null -eq $managedRun) {
                $row.failureStage = 'managed-run-discovery'
                $row.error = 'No managed llama run was found for the benchmark case.'
            }
            else {
                $verificationError = Get-SpeculativeMetricsVerificationError -RunMetrics $runMetrics -VerifiedLogMetrics $verifiedLogMetrics
                if ($null -ne $verificationError) {
                    $row.failureStage = 'speculative-metrics-verification'
                    $row.error = $verificationError
                }
            }

            $attemptResults.Add([pscustomobject]$row) | Out-Null
        }

        $results.Add((Get-AverageCaseResult -CaseId $caseId -Prompts $benchmarkPrompts -Case $case -AttemptResults $attemptResults)) | Out-Null
        Write-BenchmarkArtifacts -OutputDirectory $outputDirectory -Results $results
        $caseFinishedAt = Get-Date
        $caseElapsed = $caseFinishedAt.ToUniversalTime() - $caseStartedAt.ToUniversalTime()
        $benchmarkElapsed = $caseFinishedAt.ToUniversalTime() - $benchmarkStartedAt.ToUniversalTime()
        $remainingCaseCount = $totalCaseCount - ($caseIndex + 1)
        $remainingEstimateAfterCase = if (($caseIndex + 1) -gt 0 -and $remainingCaseCount -gt 0) {
            [timespan]::FromMilliseconds(($benchmarkElapsed.TotalMilliseconds / ($caseIndex + 1)) * $remainingCaseCount)
        }
        else {
            [timespan]::Zero
        }
        Write-Output ("[{0}/{1}] finished {2} | case={3} | total={4} | eta={5}" -f ($caseIndex + 1), $totalCaseCount, $caseId, (Format-Duration -Duration $caseElapsed), (Format-Duration -Duration $benchmarkElapsed), (Format-Duration -Duration $remainingEstimateAfterCase))
    }
}
finally {
    if ($null -ne $originalConfig) {
        try {
            Restore-OriginalConfig -Config $originalConfig
        }
        catch {
            Write-Warning "Failed to restore original config: $($_.Exception.Message)"
        }
    }

    Stop-StartedStatusServer
}
Write-BenchmarkArtifacts -OutputDirectory $outputDirectory -Results $results

Write-Output "Benchmark results written to $outputDirectory"

