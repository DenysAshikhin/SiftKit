[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$VerboseOutput,
    [int]$CommandTimeoutSeconds = 420,
    [int]$SmallSummaryChars = 4000,
    [int]$PlannerSummaryChars = 800000,
    [int]$MonolithicJsonChars = 400000
)

$ErrorActionPreference = 'Stop'

function New-TempTextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("siftkit-{0}-{1}.txt" -f $Prefix, [Guid]::NewGuid().ToString('N'))
    Set-Content -LiteralPath $path -Value $Content -Encoding UTF8
    return $path
}

function New-TempJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)]$Object
    )
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("siftkit-{0}-{1}.json" -f $Prefix, [Guid]::NewGuid().ToString('N'))
    $json = $Object | ConvertTo-Json -Depth 20
    Set-Content -LiteralPath $path -Value $json -Encoding UTF8
    return $path
}

function New-FixedLengthText {
    param(
        [Parameter(Mandatory = $true)][string]$Seed,
        [Parameter(Mandatory = $true)][int]$Length
    )
    $targetLength = [Math]::Max(1, $Length)
    $buffer = New-Object System.Text.StringBuilder
    while ($buffer.Length -lt $targetLength) {
        [void]$buffer.Append($Seed)
    }
    return $buffer.ToString().Substring(0, $targetLength)
}

function Invoke-NodeCommand {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 300
    )

    $display = "node " + ($Arguments -join ' ')
    Write-Host ""
    Write-Host ">>> $display"

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    $exitCode = 1
    $timedOut = $false
    $stderr = ''
    $stdout = ''

    function Quote-ProcessArg {
        param([Parameter(Mandatory = $true)][string]$Arg)
        if ($Arg -notmatch '[\s"]') {
            return $Arg
        }
        $escaped = $Arg -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        return '"' + $escaped + '"'
    }

    try {
        $argumentLine = ($Arguments | ForEach-Object { Quote-ProcessArg -Arg ([string]$_) }) -join ' '
        $proc = Start-Process -FilePath 'node' `
            -ArgumentList $argumentLine `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        Write-Host ("    PID: {0}" -f $proc.Id)
        $start = Get-Date
        while (-not $proc.HasExited) {
            $elapsed = [int]((Get-Date) - $start).TotalSeconds
            if ($elapsed -ge $TimeoutSeconds) {
                $timedOut = $true
                break
            }
            if (($elapsed -gt 0) -and ($elapsed % 15 -eq 0)) {
                Write-Host ("    ... running ({0}s)" -f $elapsed)
            }
            Start-Sleep -Seconds 1
        }

        if ($timedOut) {
            Write-Host ("    Timeout reached ({0}s). Killing process tree..." -f $TimeoutSeconds)
            try { taskkill /PID $proc.Id /T /F | Out-Null } catch {}
            $exitCode = 124
        } else {
            $exitCode = [int]$proc.ExitCode
        }

        $stdout = if (Test-Path $stdoutPath) { [string](Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue) } else { '' }
        $stderr = if (Test-Path $stderrPath) { [string](Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue) } else { '' }
    } catch {
        $stderr = "FAILED TO START COMMAND: $($_.Exception.Message)"
        $exitCode = 1
    } finally {
        if (Test-Path $stdoutPath) { Remove-Item -LiteralPath $stdoutPath -ErrorAction SilentlyContinue }
        if (Test-Path $stderrPath) { Remove-Item -LiteralPath $stderrPath -ErrorAction SilentlyContinue }
    }

    Write-Host ("    Exit: {0}" -f $exitCode)
    $stdoutText = if ($null -eq $stdout) { '' } else { [string]$stdout }
    $stderrText = if ($null -eq $stderr) { '' } else { [string]$stderr }
    Write-Host ("    Stdout bytes: {0}" -f ([Text.Encoding]::UTF8.GetByteCount($stdoutText)))
    Write-Host ("    Stderr bytes: {0}" -f ([Text.Encoding]::UTF8.GetByteCount($stderrText)))
    if ($VerboseOutput) {
        if ($stdoutText) { Write-Host "----- stdout -----"; Write-Host $stdoutText.TrimEnd() }
        if ($stderrText) { Write-Host "----- stderr -----"; Write-Host $stderrText.TrimEnd() }
    }

    return @{
        ExitCode = $exitCode
        Stdout = $stdoutText
        Stderr = $stderrText
        TimedOut = $timedOut
        Command = $display
    }
}

function Assert-Match {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not [Regex]::IsMatch($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw $Message
    }
}

function Assert-NotMatch {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if ([Regex]::IsMatch($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw $Message
    }
}

function Get-ConfigUrl {
    if ($env:SIFTKIT_CONFIG_SERVICE_URL -and $env:SIFTKIT_CONFIG_SERVICE_URL.Trim()) {
        return $env:SIFTKIT_CONFIG_SERVICE_URL.Trim()
    }
    $statusUrl = if ($env:SIFTKIT_STATUS_BACKEND_URL -and $env:SIFTKIT_STATUS_BACKEND_URL.Trim()) {
        $env:SIFTKIT_STATUS_BACKEND_URL.Trim()
    } else {
        'http://127.0.0.1:4765/status'
    }
    $uri = [Uri]$statusUrl
    return ('{0}://{1}:{2}/config' -f $uri.Scheme, $uri.Host, $uri.Port)
}

function Get-StatusServiceBaseUrl {
    $statusUrl = if ($env:SIFTKIT_STATUS_BACKEND_URL -and $env:SIFTKIT_STATUS_BACKEND_URL.Trim()) {
        $env:SIFTKIT_STATUS_BACKEND_URL.Trim()
    } else {
        'http://127.0.0.1:4765/status'
    }
    $uri = [Uri]$statusUrl
    return ('{0}://{1}:{2}' -f $uri.Scheme, $uri.Host, $uri.Port)
}

function Get-RepoSearchArtifacts {
    $root = Join-Path (Join-Path (Get-Location) '.siftkit') 'logs\repo_search'
    if (-not (Test-Path -LiteralPath $root)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $root -Filter 'request_*.json' -Recurse -File | Sort-Object LastWriteTimeUtc)
}

Push-Location (Split-Path -Path $PSScriptRoot -Parent)
try {
    $node = Get-Command node -ErrorAction Stop
    Write-Host ("Using node: {0}" -f $node.Source)
    Write-Host ("Node version: {0}" -f ((& node -v) -join ''))
    Write-Host ("Working dir: {0}" -f (Get-Location).Path)

    $env:SIFTKIT_TRACE_SUMMARY = '1'
    $env:SIFTKIT_TRACE_REPO_SEARCH = '1'

    if ($Build) {
        Write-Host ""
        Write-Host ">>> npm run build"
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed with exit code $LASTEXITCODE."
        }
    }

    $configUrl = Get-ConfigUrl
    $statusServiceBaseUrl = Get-StatusServiceBaseUrl
    Write-Host ("Config URL: {0}" -f $configUrl)
    Write-Host ("Status service base URL: {0}" -f $statusServiceBaseUrl)
    $originalConfig = Invoke-RestMethod -Uri $configUrl -Method Get

    $results = New-Object System.Collections.Generic.List[object]
    $createdTempPaths = New-Object System.Collections.Generic.List[string]

    try {
        # L1: one-shot summary (non-thinking override expected)
        $smallInput = New-FixedLengthText -Seed 'small input line ' -Length $SmallSummaryChars
        $smallFile = New-TempTextFile -Prefix 'small-summary' -Content $smallInput
        $createdTempPaths.Add($smallFile) | Out-Null
        $l1 = Invoke-NodeCommand -Arguments @('.\bin\siftkit.js', 'summary', '--question', 'Summarize in one sentence.', '--file', $smallFile) -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l1.ExitCode -ne 0) { throw "Non-zero exit code: $($l1.ExitCode)" }
            Assert-Match -Text $l1.Stderr -Pattern 'summary invokeSummaryCore start phase=leaf' -Message 'Did not hit leaf one-shot summary path.'
            Assert-Match -Text $l1.Stderr -Pattern 'summary provider start backend=llama\.cpp .* phase=leaf' -Message 'Did not observe leaf provider request.'
            Assert-Match -Text $l1.Stderr -Pattern 'summary notify running=true phase=leaf chunk=none' -Message 'Did not observe leaf running status update.'
            Assert-NotMatch -Text $l1.Stderr -Pattern 'phase=planner' -Message 'Unexpected planner mode for below-threshold case.'
            $results.Add([pscustomobject]@{ Id = 'L1'; Passed = $true; Description = 'Summary below planner threshold -> one-shot non-thinking'; Detail = 'ok' }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L1'; Passed = $false; Description = 'Summary below planner threshold -> one-shot non-thinking'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L2: planner summary path
        $plannerInput = New-FixedLengthText -Seed 'planner threshold probe line with repeated context. ' -Length $PlannerSummaryChars
        $plannerFile = New-TempTextFile -Prefix 'planner-summary' -Content $plannerInput
        $createdTempPaths.Add($plannerFile) | Out-Null
        $l2 = Invoke-NodeCommand -Arguments @('.\bin\siftkit.js', 'summary', '--question', 'Extract the most important points with evidence.', '--file', $plannerFile) -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l2.ExitCode -ne 0) { throw "Non-zero exit code: $($l2.ExitCode)" }
            Assert-Match -Text $l2.Stderr -Pattern 'phase=planner' -Message 'Planner mode traces were not observed.'
            Assert-Match -Text $l2.Stderr -Pattern 'summary notify running=true phase=planner chunk=none' -Message 'Planner running status trace was not observed.'
            Assert-Match -Text $l2.Stderr -Pattern 'llama-cpp generate start .*base_url=' -Message 'Planner llama generate trace was not observed.'
            $results.Add([pscustomobject]@{ Id = 'L2'; Passed = $true; Description = 'Summary above planner threshold -> planner mode'; Detail = 'ok' }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L2'; Passed = $false; Description = 'Summary above planner threshold -> planner mode'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L3: oversized monolithic JSON should still use planner mode (rewrite expectation)
        $chunkBlob = 'A' * [Math]::Max($MonolithicJsonChars, 120000)
        $chunkJson = "{`"blob`":`"$chunkBlob`"}"
        $chunkFile = New-TempTextFile -Prefix 'monolithic-json-planner' -Content $chunkJson
        $createdTempPaths.Add($chunkFile) | Out-Null
        $l3 = Invoke-NodeCommand -Arguments @('.\bin\siftkit.js', 'summary', '--question', 'Summarize this JSON payload.', '--file', $chunkFile) -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l3.ExitCode -ne 0) { throw "Non-zero exit code: $($l3.ExitCode)" }
            Assert-Match -Text $l3.Stderr -Pattern 'phase=planner' -Message 'Planner mode was not observed for oversized monolithic JSON.'
            Assert-NotMatch -Text $l3.Stderr -Pattern 'phase=leaf chunk=1/\d+' -Message 'Chunk leaf trace observed, but this case is expected to stay in planner mode.'
            Assert-NotMatch -Text $l3.Stderr -Pattern 'phase=merge' -Message 'Merge phase observed, but this case is expected to stay in planner mode.'
            $results.Add([pscustomobject]@{ Id = 'L3'; Passed = $true; Description = 'Oversized monolithic JSON -> planner mode (no chunk+merge fallback)'; Detail = 'ok' }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L3'; Passed = $false; Description = 'Oversized monolithic JSON -> planner mode (no chunk+merge fallback)'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L4: command-output classification guard path via internal op
        $commandAnalyzeRequest = @{
            ExitCode = 0
            RawText = "build completed`nall checks passed`nno error markers"
            Question = 'Summarize this command output.'
            Format = 'text'
            PolicyProfile = 'general'
        }
        $commandAnalyzeFile = New-TempJsonFile -Prefix 'command-analyze' -Object $commandAnalyzeRequest
        $createdTempPaths.Add($commandAnalyzeFile) | Out-Null
        $l4 = Invoke-NodeCommand -Arguments @('.\bin\siftkit.js', 'internal', '--op', 'command-analyze', '--request-file', $commandAnalyzeFile, '--response-format', 'json') -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l4.ExitCode -ne 0) { throw "Non-zero exit code: $($l4.ExitCode)" }
            $l4Json = $l4.Stdout.Trim() | ConvertFrom-Json
            if ([string]$l4Json.Classification -eq 'unsupported_input') {
                throw 'Classification was unsupported_input for non-empty command output.'
            }
            Assert-Match -Text $l4.Stderr -Pattern 'summary invokeSummaryCore start' -Message 'Command-output summary pipeline trace was not observed.'
            $results.Add([pscustomobject]@{ Id = 'L4'; Passed = $true; Description = 'Command-output source path rejects unsupported_input for non-empty input'; Detail = "classification=$($l4Json.Classification)" }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L4'; Passed = $false; Description = 'Command-output source path rejects unsupported_input for non-empty input'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L5: interactive-capture flow via internal op
        $interactiveRequest = @{
            Command = 'powershell'
            ArgumentList = @('-NoProfile', '-Command', 'Write-Output "interactive capture smoke output"')
            Question = 'Summarize the captured command output in one sentence.'
            Format = 'text'
            PolicyProfile = 'general'
        }
        $interactiveFile = New-TempJsonFile -Prefix 'interactive-capture' -Object $interactiveRequest
        $createdTempPaths.Add($interactiveFile) | Out-Null
        $l5 = Invoke-NodeCommand -Arguments @('.\bin\siftkit.js', 'internal', '--op', 'interactive-capture', '--request-file', $interactiveFile, '--response-format', 'json') -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l5.ExitCode -ne 0) { throw "Non-zero exit code: $($l5.ExitCode)" }
            $l5Json = $l5.Stdout.Trim() | ConvertFrom-Json
            if ([string]$l5Json.Classification -eq 'unsupported_input') {
                throw 'Interactive-capture returned unsupported_input unexpectedly.'
            }
            Assert-Match -Text $l5.Stderr -Pattern 'summary invokeSummaryCore start' -Message 'Interactive-capture did not route through summary pipeline.'
            $results.Add([pscustomobject]@{ Id = 'L5'; Passed = $true; Description = 'Interactive-capture flow -> summary pipeline'; Detail = "classification=$($l5Json.Classification)" }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L5'; Passed = $false; Description = 'Interactive-capture flow -> summary pipeline'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L6: repo-search via public CLI + transcript verification
        $beforeArtifacts = Get-RepoSearchArtifacts
        $l6 = Invoke-NodeCommand -Arguments @('.\bin\siftkit.js', 'repo-search', '--prompt', 'Find where invokePlannerMode is called in summary flow and cite the file path.', '--max-turns', '8') -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l6.ExitCode -ne 0) { throw "Non-zero exit code: $($l6.ExitCode)" }
            $afterArtifacts = Get-RepoSearchArtifacts
            $newArtifacts = @($afterArtifacts | Where-Object { $beforeArtifacts.FullName -notcontains $_.FullName })
            if ($newArtifacts.Count -eq 0) {
                throw 'No new repo-search artifact file was created.'
            }
            $artifactPath = $newArtifacts[-1].FullName
            $artifact = Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json
            $transcriptPath = [string]$artifact.transcriptPath
            if (-not $transcriptPath -or -not (Test-Path -LiteralPath $transcriptPath)) {
                throw "Missing transcript path from artifact: $artifactPath"
            }
            $plannerActionSeen = $false
            Get-Content -LiteralPath $transcriptPath | ForEach-Object {
                $line = $_.Trim()
                if (-not $line) { return }
                $event = $line | ConvertFrom-Json
                if ($event.kind -eq 'provider_request_start' -and $event.stage -eq 'planner_action' -and [string]$event.path -eq '/v1/chat/completions') {
                    $plannerActionSeen = $true
                }
            }
            if (-not $plannerActionSeen) {
                throw 'Repo-search transcript did not include planner_action provider request to /v1/chat/completions.'
            }
            $results.Add([pscustomobject]@{ Id = 'L6'; Passed = $true; Description = 'Repo-search public CLI flow -> status server /repo-search planner loop'; Detail = $artifactPath }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L6'; Passed = $false; Description = 'Repo-search public CLI flow -> status server /repo-search planner loop'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L7: direct bridge utility path
        $currentConfig = Invoke-RestMethod -Uri $configUrl -Method Get
        $bridgeModel = if ($env:SIFTKIT_LLAMA_MODEL -and $env:SIFTKIT_LLAMA_MODEL.Trim()) { $env:SIFTKIT_LLAMA_MODEL.Trim() } elseif ($currentConfig.Runtime.Model) { [string]$currentConfig.Runtime.Model } else { [string]$currentConfig.Model }
        $llama = if ($currentConfig.Runtime.LlamaCpp) { $currentConfig.Runtime.LlamaCpp } else { $currentConfig.LlamaCpp }
        $bridgePromptFile = New-TempTextFile -Prefix 'bridge-prompt' -Content 'Reply with one short sentence acknowledging live bridge test.'
        $createdTempPaths.Add($bridgePromptFile) | Out-Null
        $l7 = Invoke-NodeCommand -Arguments @(
            '.\dist\llama-cpp-bridge.js',
            'generate',
            '--prompt-file', $bridgePromptFile,
            '--base-url', [string]$llama.BaseUrl,
            '--model', $bridgeModel,
            '--num-ctx', [string]$llama.NumCtx,
            '--temperature', [string]$llama.Temperature,
            '--top-p', [string]$llama.TopP,
            '--top-k', [string]$llama.TopK,
            '--min-p', [string]$llama.MinP,
            '--presence-penalty', [string]$llama.PresencePenalty,
            '--repeat-penalty', [string]$llama.RepetitionPenalty,
            '--max-tokens', [string]$llama.MaxTokens,
            '--timeout-seconds', '120'
        ) -TimeoutSeconds $CommandTimeoutSeconds
        try {
            if ($l7.ExitCode -ne 0) { throw "Non-zero exit code: $($l7.ExitCode)" }
            $bridgeJson = $l7.Stdout.Trim() | ConvertFrom-Json
            if (-not [string]$bridgeJson.response) {
                throw 'Bridge response payload was empty.'
            }
            $results.Add([pscustomobject]@{ Id = 'L7'; Passed = $true; Description = 'Direct llama-cpp-bridge generate path'; Detail = 'ok' }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{ Id = 'L7'; Passed = $false; Description = 'Direct llama-cpp-bridge generate path'; Detail = $_.Exception.Message }) | Out-Null
        }

        # L8: dashboard GUI plan mode path (/dashboard/chat/sessions/:id/plan)
        $sessionId = $null
        try {
            $createSessionBody = @{
                title = 'Live Plan Mode Validation'
                model = $bridgeModel
                contextWindowTokens = [int]($llama.NumCtx)
            } | ConvertTo-Json -Depth 6
            $createSession = Invoke-RestMethod `
                -Uri "$statusServiceBaseUrl/dashboard/chat/sessions" `
                -Method Post `
                -ContentType 'application/json' `
                -Body $createSessionBody

            $sessionId = [string]$createSession.session.id
            if (-not $sessionId) {
                throw 'Dashboard session creation did not return a session id.'
            }

            $planBody = @{
                content = 'Create an implementation plan for how summary dispatch enters planner mode in this repo.'
                repoRoot = (Get-Location).Path
                maxTurns = 8
            } | ConvertTo-Json -Depth 8
            $planResponse = Invoke-RestMethod `
                -Uri "$statusServiceBaseUrl/dashboard/chat/sessions/$([Uri]::EscapeDataString($sessionId))/plan" `
                -Method Post `
                -ContentType 'application/json' `
                -Body $planBody

            if ([string]$planResponse.session.mode -ne 'plan') {
                throw "Expected session.mode=plan but got '$($planResponse.session.mode)'."
            }
            if (-not [string]$planResponse.repoSearch.requestId) {
                throw 'Plan response did not include repoSearch.requestId.'
            }
            $assistantMessage = @($planResponse.session.messages | Where-Object { $_.role -eq 'assistant' } | Select-Object -Last 1)[0]
            if (-not $assistantMessage -or -not [string]$assistantMessage.content) {
                throw 'Plan response did not include assistant plan content.'
            }
            Assert-Match -Text ([string]$assistantMessage.content) -Pattern '^#\s*Implementation Plan' -Message 'Assistant content did not match plan markdown format.'
            $transcriptPath = [string]$planResponse.repoSearch.transcriptPath
            if (-not $transcriptPath -or -not (Test-Path -LiteralPath $transcriptPath)) {
                throw 'Plan response transcript path is missing or does not exist.'
            }

            $results.Add([pscustomobject]@{
                Id = 'L8'
                Passed = $true
                Description = 'Dashboard GUI plan mode -> /dashboard/chat/sessions/:id/plan'
                Detail = $transcriptPath
            }) | Out-Null
        } catch {
            $results.Add([pscustomobject]@{
                Id = 'L8'
                Passed = $false
                Description = 'Dashboard GUI plan mode -> /dashboard/chat/sessions/:id/plan'
                Detail = $_.Exception.Message
            }) | Out-Null
        } finally {
            if ($sessionId) {
                try {
                    Invoke-RestMethod -Uri "$statusServiceBaseUrl/dashboard/chat/sessions/$([Uri]::EscapeDataString($sessionId))" -Method Delete | Out-Null
                } catch {
                    Write-Warning "Failed to delete temporary dashboard session '$sessionId': $($_.Exception.Message)"
                }
            }
        }
    } finally {
        foreach ($tempPath in $createdTempPaths) {
            if ($tempPath -and (Test-Path -LiteralPath $tempPath)) {
                Remove-Item -LiteralPath $tempPath -ErrorAction SilentlyContinue
            }
        }
        try {
            Invoke-RestMethod -Uri $configUrl -Method Put -ContentType 'application/json' -Body ($originalConfig | ConvertTo-Json -Depth 30) | Out-Null
        } catch {
            Write-Warning "Failed to restore config to original state: $($_.Exception.Message)"
        }
    }

    Write-Host ""
    Write-Host "=== Live Prompt Dispatch Matrix (CLI-first) ==="
    foreach ($row in $results) {
        $status = if ($row.Passed) { 'PASS' } else { 'FAIL' }
        Write-Host ("{0,-4} {1,-5} {2}" -f $row.Id, $status, $row.Description)
        Write-Host ("     {0}" -f $row.Detail)
    }

    $failed = @($results | Where-Object { -not $_.Passed })
    if ($failed.Count -gt 0) {
        Write-Host ""
        Write-Error ("Failed case(s): {0}" -f (($failed | ForEach-Object { $_.Id }) -join ', '))
        exit 1
    }

    Write-Host ""
    Write-Host "All live CLI prompt-dispatch cases passed."
    exit 0
}
finally {
    Pop-Location
}
