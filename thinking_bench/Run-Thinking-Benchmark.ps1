[CmdletBinding()]
param(
    [string]$SuitePath = '',
    [switch]$ValidateOnly,
    [string[]]$CandidateId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SuitePath)) {
    $SuitePath = Join-Path $PSScriptRoot 'suites\default\suite.json'
}

function Get-UtcTimestamp {
    return [DateTime]::UtcNow.ToString('yyyyMMdd_HHmmss_fff')
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    return $Path
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if ($directory) {
        Ensure-Directory -Path $directory | Out-Null
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    Write-Utf8NoBom -Path $Path -Content (($Value | ConvertTo-Json -Depth 32) + "`r`n")
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Resolve-PathFromBase {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'Path value cannot be empty.'
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Path))
}

function Resolve-ExistingPathFromBase {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BaseDirectory,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $resolved = Resolve-PathFromBase -Path $Path -BaseDirectory $BaseDirectory
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw "$Label not found: $resolved"
    }

    return $resolved
}

function Copy-Dictionary {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Source)

    $copy = [ordered]@{}
    foreach ($key in $Source.Keys) {
        $copy[$key] = $Source[$key]
    }

    return $copy
}

function Get-PropertyDictionary {
    param([object]$InputObject)

    $dictionary = [ordered]@{}
    if ($null -eq $InputObject) {
        return $dictionary
    }

    foreach ($property in $InputObject.PSObject.Properties) {
        $dictionary[$property.Name] = $property.Value
    }

    return $dictionary
}

function Get-SweepCombinations {
    param([object]$SweepSpec)

    $dictionary = Get-PropertyDictionary -InputObject $SweepSpec
    if ($dictionary.Count -eq 0) {
        return @([ordered]@{})
    }

    $keys = @($dictionary.Keys | Sort-Object)
    $combinations = @([ordered]@{})
    foreach ($key in $keys) {
        $values = @($dictionary[$key])
        if ($values.Count -eq 0) {
            throw "Sweep '$key' must contain at least one value."
        }

        $next = @()
        foreach ($existing in $combinations) {
            foreach ($value in $values) {
                $merged = [ordered]@{}
                foreach ($existingKey in $existing.Keys) {
                    $merged[$existingKey] = $existing[$existingKey]
                }
                $merged[$key] = $value
                $next += ,$merged
            }
        }
        $combinations = $next
    }

    return $combinations
}

function Validate-SuiteSemantics {
    param([Parameter(Mandatory = $true)][object]$Suite)

    $launchSweep = Get-PropertyDictionary -InputObject $Suite.LaunchSweep
    if ($launchSweep.Contains('ReasoningFormat')) {
        $allowedReasoningFormats = @('auto', 'none', 'deepseek', 'deepseek-legacy')
        foreach ($value in @($launchSweep['ReasoningFormat'])) {
            $text = [string]$value
            if ($allowedReasoningFormats -notcontains $text) {
                throw "Unsupported ReasoningFormat in LaunchSweep: $text. Allowed values: $($allowedReasoningFormats -join ', ')"
            }
        }
    }
}

function ConvertTo-Slug {
    param([Parameter(Mandatory = $true)][string]$Value)

    $slug = $Value.ToLowerInvariant()
    $slug = [regex]::Replace($slug, '[^a-z0-9]+', '-')
    $slug = $slug.Trim('-')
    if ([string]::IsNullOrWhiteSpace($slug)) {
        return 'default'
    }

    return $slug
}

function Format-DurationMs {
    param([double]$Milliseconds)

    if ([double]::IsNaN($Milliseconds) -or [double]::IsInfinity($Milliseconds) -or $Milliseconds -lt 0) {
        return 'n/a'
    }

    return ([TimeSpan]::FromMilliseconds($Milliseconds)).ToString('hh\:mm\:ss')
}

function Get-CandidateDescriptor {
    param(
        [Parameter(Mandatory = $true)][int]$Index,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$LaunchOverrides,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$RequestOverrides
    )

    $segments = @()
    foreach ($key in @($LaunchOverrides.Keys | Sort-Object)) {
        $segments += "$key=$($LaunchOverrides[$key])"
    }
    foreach ($key in @($RequestOverrides.Keys | Sort-Object)) {
        $segments += "$key=$($RequestOverrides[$key])"
    }
    if ($segments.Count -eq 0) {
        $segments = @('baseline')
    }

    return [pscustomobject]@{
        Id = ('{0:D3}_{1}' -f $Index, (ConvertTo-Slug -Value ($segments -join '-')))
        Label = ($segments -join '; ')
        LaunchOverrides = Copy-Dictionary -Source $LaunchOverrides
        RequestOverrides = Copy-Dictionary -Source $RequestOverrides
    }
}

function ConvertTo-ArgumentList {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Parameters)

    $arguments = @()
    foreach ($key in @($Parameters.Keys | Sort-Object)) {
        $value = $Parameters[$key]
        if ($null -eq $value) {
            continue
        }

        $arguments += "-$key"
        $arguments += [string]$value
    }

    return $arguments
}

function Stop-LlamaServer {
    $existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Stop-Process -Force
    }
}

function Start-Launcher {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Overrides,
        [Parameter(Mandatory = $true)][string]$LogDirectory
    )

    Ensure-Directory -Path $LogDirectory | Out-Null
    $stdoutPath = Join-Path $LogDirectory 'launcher.stdout.log'
    $stderrPath = Join-Path $LogDirectory 'launcher.stderr.log'
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $ScriptPath
    ) + (ConvertTo-ArgumentList -Parameters $Overrides)

    $process = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList $argumentList `
        -WorkingDirectory (Split-Path -Parent $ScriptPath) `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    Start-Sleep -Milliseconds 750
    if ($process.HasExited) {
        $details = @()
        if (Test-Path -LiteralPath $stderrPath) {
            $stderr = Get-Content -LiteralPath $stderrPath -Raw
            if (-not [string]::IsNullOrWhiteSpace($stderr)) {
                $details += $stderr.Trim()
            }
        }
        if (Test-Path -LiteralPath $stdoutPath) {
            $stdout = Get-Content -LiteralPath $stdoutPath -Raw
            if (-not [string]::IsNullOrWhiteSpace($stdout)) {
                $details += $stdout.Trim()
            }
        }
        throw "Launcher exited before llama-server became ready. $($details -join ' ')".Trim()
    }

    return [pscustomobject]@{
        Process = $process
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
    }
}

function Get-LauncherDefaults {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -PrintDefaultsJson
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read launcher defaults from $ScriptPath"
    }

    return $json | ConvertFrom-Json
}

function Wait-ForLlamaReadiness {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = 'No response yet.'
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/v1/models') -Method Get -TimeoutSec 10
            $models = @($response.data | ForEach-Object {
                if ($_.id) { [string]$_.id }
            } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if ($models.Count -gt 0) {
                return $models
            }

            $lastError = 'llama-server responded without any loaded models.'
        }
        catch {
            $lastError = $_.Exception.Message
        }

        Start-Sleep -Seconds 2
    }

    throw "Timed out waiting for llama-server at $BaseUrl. Last error: $lastError"
}

function Get-ResponseText {
    param([Parameter(Mandatory = $true)][object]$Response)

    $messageContent = $Response.choices[0].message.content
    if ($messageContent -is [string]) {
        return [string]$messageContent
    }
    if ($messageContent -is [System.Collections.IEnumerable]) {
        $parts = @()
        foreach ($part in $messageContent) {
            if ($part.text) {
                $parts += [string]$part.text
            }
        }
        return ($parts -join '')
    }
    if ($Response.choices[0].text) {
        return [string]$Response.choices[0].text
    }

    return ''
}

function Get-ResponseReasoningText {
    param([Parameter(Mandatory = $true)][object]$Response)

    $reasoningContent = $Response.choices[0].message.reasoning_content
    if ($reasoningContent -is [string]) {
        return [string]$reasoningContent
    }
    if ($reasoningContent -is [System.Collections.IEnumerable]) {
        $parts = @()
        foreach ($part in $reasoningContent) {
            if ($part.text) {
                $parts += [string]$part.text
            }
        }
        return ($parts -join '')
    }

    return ''
}

function Get-SavedOutputText {
    param(
        [Parameter(Mandatory = $true)][string]$AnswerText,
        [Parameter(Mandatory = $true)][string]$ReasoningText
    )

    if ([string]::IsNullOrWhiteSpace($ReasoningText)) {
        return $AnswerText
    }

    return @(
        '<think>'
        $ReasoningText
        '</think>'
        ''
        $AnswerText
    ) -join "`n"
}

function Invoke-LlamaChat {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$ModelId,
        [Parameter(Mandatory = $true)][string]$SystemPrompt,
        [Parameter(Mandatory = $true)][string]$UserPrompt,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$RequestParameters,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $body = [ordered]@{
        model = $ModelId
        messages = @(
            [ordered]@{
                role = 'system'
                content = $SystemPrompt
            },
            [ordered]@{
                role = 'user'
                content = $UserPrompt
            }
        )
    }

    $extraBody = [ordered]@{}
    foreach ($key in @($RequestParameters.Keys | Sort-Object)) {
        $value = $RequestParameters[$key]
        if ($null -eq $value) {
            continue
        }

        switch ($key) {
            'Temperature' { $body.temperature = [double]$value }
            'TopP' { $body.top_p = [double]$value }
            'MaxTokens' { $body.max_tokens = [int]$value }
            'TopK' { $extraBody.top_k = [int]$value }
            'MinP' { $extraBody.min_p = [double]$value }
            'PresencePenalty' { $extraBody.presence_penalty = [double]$value }
            'RepetitionPenalty' { $extraBody.repeat_penalty = [double]$value }
            default { throw "Unsupported request parameter: $key" }
        }
    }
    if ($extraBody.Count -gt 0) {
        $body.extra_body = $extraBody
    }

    $jsonBody = $body | ConvertTo-Json -Depth 16
    $response = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd('/') + '/v1/chat/completions') `
        -Method Post `
        -ContentType 'application/json' `
        -Body $jsonBody `
        -TimeoutSec $TimeoutSeconds

    $answerText = Get-ResponseText -Response $response
    $reasoningText = Get-ResponseReasoningText -Response $response

    return [pscustomobject]@{
        Text = $answerText
        ReasoningText = $reasoningText
        SavedOutputText = Get-SavedOutputText -AnswerText $answerText -ReasoningText $reasoningText
        Usage = $response.usage
        RawResponse = $response
    }
}

function Build-BenchmarkPrompt {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Case,
        [Parameter(Mandatory = $true)][string]$InputText
    )

    return @(
        "Case: $($Case.Label)"
        ''
        'Question:'
        $Case.Question
        ''
        'Input:'
        $InputText
    ) -join "`n"
}

function Strip-CodeFence {
    param([Parameter(Mandatory = $true)][string]$Text)

    $trimmed = $Text.Trim()
    if ($trimmed -match '^```(?:json)?\s*([\s\S]*?)\s*```$') {
        return $matches[1].Trim()
    }

    return $trimmed
}

function Parse-EvaluatorRanking {
    param([Parameter(Mandatory = $true)][string]$Text)

    $parsed = Strip-CodeFence -Text $Text | ConvertFrom-Json
    if (-not $parsed.Rankings) {
        throw 'Evaluator response did not include Rankings.'
    }

    return $parsed
}

function Build-EvaluatorPrompt {
    param(
        [Parameter(Mandatory = $true)][int]$TopK,
        [Parameter(Mandatory = $true)][object[]]$Candidates
    )

    $payload = [ordered]@{
        Instructions = @(
            'Rank the best overall parameter sets for the suite.'
            'Prefer concise, faithful, useful answers.'
            'Treat disqualified or failed cases as strong negatives.'
            'Return only valid JSON with this shape: {"Rankings":[{"Rank":1,"CandidateId":"...","Why":"..."}]}'
            "Return at most $TopK ranking entries."
        )
        Candidates = $Candidates
    }

    return ($payload | ConvertTo-Json -Depth 32)
}

function ConvertTo-CaseSummary {
    param([Parameter(Mandatory = $true)][pscustomobject]$CaseResult)

    return [ordered]@{
        CaseId = $CaseResult.CaseId
        Label = $CaseResult.Label
        Score = $CaseResult.Score
        Disqualified = $CaseResult.Disqualified
        Failed = $CaseResult.Failed
        OutputCharacters = $CaseResult.OutputCharacters
        MaxOutputCharacters = $CaseResult.MaxOutputCharacters
        DurationMs = $CaseResult.DurationMs
        Output = $CaseResult.Output
    }
}

function Get-ShortlistedCandidates {
    param(
        [Parameter(Mandatory = $true)][object[]]$Candidates,
        [Parameter(Mandatory = $true)][int]$PoolSize
    )

    return @(
        $Candidates |
            Sort-Object `
                @{ Expression = { $_.TotalScore }; Descending = $true }, `
                @{ Expression = { $_.DisqualifiedCaseCount }; Descending = $false }, `
                @{ Expression = { $_.FailedCaseCount }; Descending = $false }, `
                @{ Expression = { $_.TotalDurationMs }; Descending = $false }, `
                @{ Expression = { $_.CandidateId }; Descending = $false } |
            Select-Object -First $PoolSize
    )
}

function Merge-RequestParameters {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$BaseDefaults,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$LaunchOverrides,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$RequestOverrides
    )

    $merged = [ordered]@{}
    foreach ($key in @($BaseDefaults.Keys | Sort-Object)) {
        $merged[$key] = $BaseDefaults[$key]
    }
    foreach ($key in @($LaunchOverrides.Keys | Sort-Object)) {
        if ($merged.Contains($key)) {
            $merged[$key] = $LaunchOverrides[$key]
        }
    }
    foreach ($key in @($RequestOverrides.Keys | Sort-Object)) {
        $merged[$key] = $RequestOverrides[$key]
    }

    return $merged
}

function Get-CaseInput {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Case,
        [Parameter(Mandatory = $true)][string]$SuiteDirectory
    )

    $casePath = Resolve-ExistingPathFromBase -Path $Case.InputFile -BaseDirectory $SuiteDirectory -Label "case input for $($Case.Id)"
    return [pscustomobject]@{
        Path = $casePath
        Text = Get-Content -LiteralPath $casePath -Raw
    }
}

$resolvedSuitePath = [System.IO.Path]::GetFullPath($SuitePath)
if (-not (Test-Path -LiteralPath $resolvedSuitePath)) {
    throw "Suite manifest not found: $resolvedSuitePath"
}

$suiteDirectory = Split-Path -Parent $resolvedSuitePath
$suite = Read-JsonFile -Path $resolvedSuitePath
Validate-SuiteSemantics -Suite $suite

$benchmarkLauncherPath = Resolve-ExistingPathFromBase -Path $suite.BenchmarkLauncherScript -BaseDirectory $suiteDirectory -Label 'benchmark launcher script'
$evaluatorLauncherPath = Resolve-ExistingPathFromBase -Path $suite.EvaluatorLauncherScript -BaseDirectory $suiteDirectory -Label 'evaluator launcher script'
$benchmarkSystemPromptPath = Resolve-ExistingPathFromBase -Path $suite.BenchmarkSystemPromptFile -BaseDirectory $suiteDirectory -Label 'benchmark system prompt file'
$evaluatorSystemPromptPath = Resolve-ExistingPathFromBase -Path $suite.EvaluatorSystemPromptFile -BaseDirectory $suiteDirectory -Label 'evaluator system prompt file'
$resultsRoot = Resolve-PathFromBase -Path $suite.ResultsRoot -BaseDirectory $suiteDirectory
$baseUrl = [string]$suite.LlamaBaseUrl
$readinessTimeoutSeconds = if ($suite.ReadinessTimeoutSeconds) { [int]$suite.ReadinessTimeoutSeconds } else { 180 }
$requestTimeoutSeconds = if ($suite.RequestTimeoutSeconds) { [int]$suite.RequestTimeoutSeconds } else { 600 }
$evaluatorTopK = if ($suite.EvaluatorTopK) { [int]$suite.EvaluatorTopK } else { 10 }
$evaluatorPoolSize = if ($suite.EvaluatorCandidatePoolSize) { [int]$suite.EvaluatorCandidatePoolSize } else { 12 }
$benchmarkSystemPrompt = Get-Content -LiteralPath $benchmarkSystemPromptPath -Raw
$evaluatorSystemPrompt = Get-Content -LiteralPath $evaluatorSystemPromptPath -Raw
$benchmarkLauncherDefaults = Get-LauncherDefaults -ScriptPath $benchmarkLauncherPath
$evaluatorLauncherDefaults = Get-LauncherDefaults -ScriptPath $evaluatorLauncherPath

$cases = @($suite.Cases)
if ($cases.Count -lt 1) {
    throw 'Suite must contain at least one case.'
}

$launchCombinations = Get-SweepCombinations -SweepSpec $suite.LaunchSweep
$requestCombinations = Get-SweepCombinations -SweepSpec $suite.RequestSweep
$requestDefaults = Get-PropertyDictionary -InputObject $benchmarkLauncherDefaults.RequestDefaults

$candidates = @()
$candidateIndex = 1
foreach ($launchOverride in $launchCombinations) {
    foreach ($requestOverride in $requestCombinations) {
        $candidates += Get-CandidateDescriptor -Index $candidateIndex -LaunchOverrides $launchOverride -RequestOverrides $requestOverride
        $candidateIndex += 1
    }
}

if (@($CandidateId | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    $requestedIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $CandidateId) {
        if (-not [string]::IsNullOrWhiteSpace($item)) {
            [void]$requestedIds.Add($item.Trim())
        }
    }

    $candidates = @($candidates | Where-Object { $requestedIds.Contains($_.Id) })
    if ($candidates.Count -eq 0) {
        throw 'No candidates matched the requested CandidateId filter.'
    }
}

if ($ValidateOnly) {
    Ensure-Directory -Path $resultsRoot | Out-Null
    Write-Host 'Suite validation passed.'
    Write-Host "Suite             : $resolvedSuitePath"
    Write-Host "BenchmarkLauncher : $benchmarkLauncherPath"
    Write-Host "EvaluatorLauncher : $evaluatorLauncherPath"
    Write-Host "ResultsRoot       : $resultsRoot"
    Write-Host "Cases             : $($cases.Count)"
    Write-Host "Candidates        : $($candidates.Count)"
    exit 0
}

$sessionDirectory = Ensure-Directory -Path (Join-Path $resultsRoot (Get-UtcTimestamp))
$indexPath = Join-Path $sessionDirectory 'session_index.json'
$resolvedSuiteCopyPath = Join-Path $sessionDirectory 'resolved_suite.json'
Write-JsonFile -Path $resolvedSuiteCopyPath -Value $suite

$benchmarkStartedAt = Get-Date
$totalSuites = $candidates.Count
$casesPerSuite = $cases.Count
$totalCaseTests = $totalSuites * $casesPerSuite
$completedSuites = 0
$completedCaseTests = 0
$completedSuiteDurationsMs = @()

Write-Host "Benchmark run will execute $totalSuites suites across $totalCaseTests case tests."
Write-Host "Cases per suite: $casesPerSuite"
Write-Host ''

$sessionIndex = [ordered]@{
    SuitePath = $resolvedSuitePath
    BenchmarkLauncherScript = $benchmarkLauncherPath
    EvaluatorLauncherScript = $evaluatorLauncherPath
    ResultsRoot = $resultsRoot
    SessionDirectory = $sessionDirectory
    StartedAtUtc = [DateTime]::UtcNow.ToString('o')
    CompletedAtUtc = $null
    BaseUrl = $baseUrl
    CandidateCount = $candidates.Count
    Candidates = @()
    Evaluator = $null
}
Write-JsonFile -Path $indexPath -Value $sessionIndex

$finalRanking = $null

try {
    $suiteIndex = 0
    foreach ($candidate in $candidates) {
        $suiteIndex += 1
        $candidateStartedAt = Get-Date
        Write-Host "Running suite [$suiteIndex/$totalSuites] candidate [$($candidate.Id)] $($candidate.Label)"
        $candidateDirectory = Ensure-Directory -Path (Join-Path $sessionDirectory $candidate.Id)
        $launchLogDirectory = Ensure-Directory -Path (Join-Path $candidateDirectory 'launch')
        $caseDirectory = Ensure-Directory -Path (Join-Path $candidateDirectory 'cases')

        Stop-LlamaServer
        $launchInfo = Start-Launcher -ScriptPath $benchmarkLauncherPath -Overrides $candidate.LaunchOverrides -LogDirectory $launchLogDirectory
        $models = Wait-ForLlamaReadiness -BaseUrl $baseUrl -TimeoutSeconds $readinessTimeoutSeconds
        $modelId = [string]$models[0]

        $caseResults = @()
        $caseIndex = 0
        foreach ($case in $cases) {
            $caseIndex += 1
            $caseInput = Get-CaseInput -Case $case -SuiteDirectory $suiteDirectory
            $casePrompt = Build-BenchmarkPrompt -Case $case -InputText $caseInput.Text
            $requestParameters = Merge-RequestParameters `
                -BaseDefaults $requestDefaults `
                -LaunchOverrides $candidate.LaunchOverrides `
                -RequestOverrides $candidate.RequestOverrides

            $caseStartedAt = Get-Date
            $outputText = ''
            $savedOutputText = ''
            $reasoningText = ''
            $providerError = $null
            $failed = $false
            try {
                $response = Invoke-LlamaChat `
                    -BaseUrl $baseUrl `
                    -ModelId $modelId `
                    -SystemPrompt $benchmarkSystemPrompt `
                    -UserPrompt $casePrompt `
                    -RequestParameters $requestParameters `
                    -TimeoutSeconds $requestTimeoutSeconds
                $outputText = [string]$response.Text
                $reasoningText = [string]$response.ReasoningText
                $savedOutputText = [string]$response.SavedOutputText
            }
            catch {
                $providerError = $_.Exception.Message
                $failed = $true
            }

            $durationMs = [math]::Round(((Get-Date) - $caseStartedAt).TotalMilliseconds, 3)
            $outputCharacters = if ($failed) { 0 } else { $outputText.Length }
            $disqualified = (-not $failed) -and ($outputCharacters -gt [int]$case.MaxOutputCharacters)
            $score = if ($failed -or $disqualified) { 0 } else { 1 }

            $safeCaseId = ConvertTo-Slug -Value $case.Id
            $outputFilePath = Join-Path $caseDirectory "$safeCaseId.output.txt"
            $metadataFilePath = Join-Path $caseDirectory "$safeCaseId.result.json"
            if (-not $failed) {
                Write-Utf8NoBom -Path $outputFilePath -Content $savedOutputText
            }

            $caseResult = [pscustomobject]@{
                CaseId = [string]$case.Id
                Label = [string]$case.Label
                InputPath = $caseInput.Path
                OutputPath = $(if ($failed) { $null } else { $outputFilePath })
                Question = [string]$case.Question
                RequestParameters = $requestParameters
                DurationMs = $durationMs
                OutputCharacters = $outputCharacters
                MaxOutputCharacters = [int]$case.MaxOutputCharacters
                Disqualified = $disqualified
                Failed = $failed
                Error = $providerError
                Score = $score
                ReasoningOutput = $(if ($failed) { $null } else { $reasoningText })
                Output = $(if ($failed) { $null } else { $outputText })
            }
            Write-JsonFile -Path $metadataFilePath -Value $caseResult
            $caseResults += $caseResult
            $completedCaseTests += 1

            $suiteElapsedMs = ((Get-Date) - $candidateStartedAt).TotalMilliseconds
            $benchmarkElapsedMs = ((Get-Date) - $benchmarkStartedAt).TotalMilliseconds
            $completedCasesInSuite = $caseResults.Count
            $remainingCasesInSuite = $casesPerSuite - $completedCasesInSuite
            $averageCaseMs = if ($completedCasesInSuite -gt 0) { $suiteElapsedMs / $completedCasesInSuite } else { 0 }
            $suiteRemainingMs = $averageCaseMs * $remainingCasesInSuite
            $remainingSuitesAfterCurrent = $totalSuites - $completedSuites - 1
            if ($completedSuites -gt 0) {
                $averageSuiteMs = (@($completedSuiteDurationsMs | Measure-Object -Sum).Sum) / $completedSuites
                $benchmarkRemainingMs = $suiteRemainingMs + ($averageSuiteMs * $remainingSuitesAfterCurrent)
            }
            else {
                $projectedCurrentSuiteMs = $averageCaseMs * $casesPerSuite
                $benchmarkRemainingMs = $suiteRemainingMs + ($projectedCurrentSuiteMs * $remainingSuitesAfterCurrent)
            }

            Write-Host (
                "Progress: suite {0}/{1}, case {2}/{3}, overall {4}/{5} | suite elapsed {6} | suite ETA {7} | total elapsed {8} | benchmark ETA {9}" -f `
                $suiteIndex, $totalSuites, $caseIndex, $casesPerSuite, $completedCaseTests, $totalCaseTests, `
                (Format-DurationMs -Milliseconds $suiteElapsedMs), `
                (Format-DurationMs -Milliseconds $suiteRemainingMs), `
                (Format-DurationMs -Milliseconds $benchmarkElapsedMs), `
                (Format-DurationMs -Milliseconds $benchmarkRemainingMs)
            )
        }

        $suiteDurationMs = ((Get-Date) - $candidateStartedAt).TotalMilliseconds
        $completedSuites += 1
        $completedSuiteDurationsMs += $suiteDurationMs
        $candidateResult = [ordered]@{
            CandidateId = $candidate.Id
            Label = $candidate.Label
            ModelId = $modelId
            LaunchOverrides = $candidate.LaunchOverrides
            RequestOverrides = $candidate.RequestOverrides
            LauncherStdoutPath = $launchInfo.StdoutPath
            LauncherStderrPath = $launchInfo.StderrPath
            CaseCount = $caseResults.Count
            TotalScore = @($caseResults | Measure-Object -Property Score -Sum).Sum
            DisqualifiedCaseCount = @($caseResults | Where-Object { $_.Disqualified }).Count
            FailedCaseCount = @($caseResults | Where-Object { $_.Failed }).Count
            TotalDurationMs = [math]::Round($suiteDurationMs, 3)
            Cases = $caseResults
        }

        $candidateResultPath = Join-Path $candidateDirectory 'candidate_result.json'
        Write-JsonFile -Path $candidateResultPath -Value $candidateResult
        $sessionIndex.Candidates += $candidateResult
        Write-JsonFile -Path $indexPath -Value $sessionIndex
        Write-Host (
            "Completed suite {0}/{1} [{2}] in {3}. Running average per suite: {4}" -f `
            $completedSuites, $totalSuites, $candidate.Id, `
            (Format-DurationMs -Milliseconds $suiteDurationMs), `
            (Format-DurationMs -Milliseconds ((@($completedSuiteDurationsMs | Measure-Object -Sum).Sum) / $completedSuites))
        )
        Write-Host ''
    }

    $shortlistedCandidates = Get-ShortlistedCandidates -Candidates $sessionIndex.Candidates -PoolSize ([Math]::Max($evaluatorTopK, $evaluatorPoolSize))
    $shortlistForPrompt = @()
    foreach ($candidate in $shortlistedCandidates) {
        $shortlistForPrompt += [ordered]@{
            CandidateId = $candidate.CandidateId
            Label = $candidate.Label
            LaunchOverrides = $candidate.LaunchOverrides
            RequestOverrides = $candidate.RequestOverrides
            TotalScore = $candidate.TotalScore
            DisqualifiedCaseCount = $candidate.DisqualifiedCaseCount
            FailedCaseCount = $candidate.FailedCaseCount
            TotalDurationMs = $candidate.TotalDurationMs
            Cases = @($candidate.Cases | ForEach-Object { ConvertTo-CaseSummary -CaseResult $_ })
        }
    }

    $evaluatorDirectory = Ensure-Directory -Path (Join-Path $sessionDirectory 'evaluator')
    $evaluatorInputPath = Join-Path $evaluatorDirectory 'evaluator_input.json'
    Write-JsonFile -Path $evaluatorInputPath -Value $shortlistForPrompt

    Stop-LlamaServer
    $evaluatorLaunch = Start-Launcher -ScriptPath $evaluatorLauncherPath -Overrides @{} -LogDirectory $evaluatorDirectory
    $evaluatorModels = Wait-ForLlamaReadiness -BaseUrl $baseUrl -TimeoutSeconds $readinessTimeoutSeconds
    $evaluatorModelId = [string]$evaluatorModels[0]

    $evaluatorPrompt = Build-EvaluatorPrompt -TopK $evaluatorTopK -Candidates $shortlistForPrompt
    $evaluatorRequestOverrides = Get-PropertyDictionary -InputObject $evaluatorLauncherDefaults.RequestDefaults

    $evaluatorResponse = Invoke-LlamaChat `
        -BaseUrl $baseUrl `
        -ModelId $evaluatorModelId `
        -SystemPrompt $evaluatorSystemPrompt `
        -UserPrompt $evaluatorPrompt `
        -RequestParameters $evaluatorRequestOverrides `
        -TimeoutSeconds $requestTimeoutSeconds

    $evaluatorRawTextPath = Join-Path $evaluatorDirectory 'evaluator_raw_response.txt'
    Write-Utf8NoBom -Path $evaluatorRawTextPath -Content ([string]$evaluatorResponse.Text)
    $finalRanking = Parse-EvaluatorRanking -Text ([string]$evaluatorResponse.Text)

    $rankingPath = Join-Path $evaluatorDirectory 'top10.json'
    Write-JsonFile -Path $rankingPath -Value $finalRanking

    $summaryLines = @(
        '# Thinking Benchmark Top Rankings'
        ''
        "Session: $sessionDirectory"
        ''
    )
    foreach ($ranking in @($finalRanking.Rankings)) {
        $summaryLines += "$($ranking.Rank). $($ranking.CandidateId) - $($ranking.Why)"
    }
    Write-Utf8NoBom -Path (Join-Path $evaluatorDirectory 'top10.md') -Content (($summaryLines -join "`r`n") + "`r`n")

    $sessionIndex.Evaluator = [ordered]@{
        ModelId = $evaluatorModelId
        LauncherStdoutPath = $evaluatorLaunch.StdoutPath
        LauncherStderrPath = $evaluatorLaunch.StderrPath
        InputPath = $evaluatorInputPath
        RawResponsePath = $evaluatorRawTextPath
        RankingPath = $rankingPath
    }
}
finally {
    Stop-LlamaServer
    $sessionIndex.CompletedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-JsonFile -Path $indexPath -Value $sessionIndex
}

Write-Host "Completed. Session directory: $sessionDirectory"
if ($finalRanking) {
    Write-Host "Top ranking artifact: $(Join-Path $sessionDirectory 'evaluator\top10.json')"
}
