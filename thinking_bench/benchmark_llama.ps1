param(
    [int]$MinNCpuMoe = 2,
    [int]$MaxNCpuMoe = 24,
    [int]$StartBatch = 512,
    [double]$MaxGpuGiB = 20,

    [string]$ModelPath = 'D:\personal\models\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
    [string]$LlamaServerPath = 'C:\Users\denys\Documents\GitHub\llamacpp\llama-server.exe',
    [string]$BindHost = '127.0.0.1',
    [int]$BasePort = 8097,
    [int]$ContextSize = 150000,
    [int]$GpuLayers = 999,
    [int]$Threads = 22,
    [int]$ParallelSlots = 1,
    [int]$CacheRam = 0,
    [ValidateSet('f32', 'f16', 'bf16', 'q4_0', 'q8_0')]
    [string]$CacheType = 'f16',
    [int]$PromptTokens = 32768,
    [int]$OutputTokens = 2048,
    [int]$BenchRepeats = 3,
    [int]$Alignment = 16,
    [int]$ProbeTimeoutSeconds = 240,
    [int]$BenchTimeoutSeconds = 1800,

    # Options: 'time_to_finish', 'combined_tps', 'pp_tps', 'output_tps'
    [ValidateSet('time_to_finish', 'combined_tps', 'pp_tps', 'output_tps')]
    [string]$RankBy = 'time_to_finish',

    [string]$OutputRoot = '.\qwen35-best-only-search'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:PromptSetCache = $null

function Assert-PathExists {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Label not found: $Path"
    }
}

function Remove-IfExists {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

function Read-FileSafe {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        return (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
    }
    return ''
}

function Get-CombinedText {
    param(
        [string]$StdOutPath,
        [string]$StdErrPath
    )
    return ((Read-FileSafe -Path $StdOutPath) + "`r`n" + (Read-FileSafe -Path $StdErrPath))
}

function Parse-MiB {
    param(
        [string]$Text,
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }

    $pattern = [regex]::Escape($Label) + '\s*=\s*(?<value>[\d.]+)\s*MiB'
    $m = [regex]::Match($Text, $pattern)
    if ($m.Success) {
        return [double]$m.Groups['value'].Value
    }
    return $null
}

function Get-TimeToFinishSeconds {
    param(
        [double]$PromptTps,
        [double]$OutputTps,
        [int]$PromptTokens,
        [int]$OutputTokens
    )

    if ($null -eq $PromptTps -or $null -eq $OutputTps) { return $null }
    if ($PromptTps -le 0 -or $OutputTps -le 0) { return $null }

    $totalSeconds = ($PromptTokens / $PromptTps) + ($OutputTokens / $OutputTps)
    if ($totalSeconds -le 0) { return $null }

    return [math]::Round($totalSeconds, 2)
}

function Get-CombinedTps {
    param(
        [double]$PromptTps,
        [double]$OutputTps,
        [int]$PromptTokens,
        [int]$OutputTokens
    )

    if ($null -eq $PromptTps -or $null -eq $OutputTps) { return $null }
    if ($PromptTps -le 0 -or $OutputTps -le 0) { return $null }

    $totalTokens = $PromptTokens + $OutputTokens
    $totalSeconds = ($PromptTokens / $PromptTps) + ($OutputTokens / $OutputTps)

    if ($totalSeconds -le 0) { return $null }

    return [math]::Round(($totalTokens / $totalSeconds), 2)
}

function Get-RankPropertyName {
    param([string]$RankBy)

    switch ($RankBy) {
        'pp_tps'         { return 'PP_tps_Avg' }
        'output_tps'     { return 'Output_tps_Avg' }
        'combined_tps'   { return 'Combined_tps_Avg' }
        'time_to_finish' { return 'TimeToFinish_Avg' }
        default          { throw "Unsupported RankBy value: $RankBy" }
    }
}

function Get-RankLabel {
    param([string]$RankBy)

    switch ($RankBy) {
        'pp_tps'         { return 'pp_avg' }
        'output_tps'     { return 'output_avg' }
        'combined_tps'   { return 'combined_avg' }
        'time_to_finish' { return 'time_to_finish_avg_s' }
        default          { throw "Unsupported RankBy value: $RankBy" }
    }
}

function Get-RankValue {
    param(
        $Item,
        [string]$RankBy
    )

    switch ($RankBy) {
        'pp_tps'         { return $Item.PP_tps_Avg }
        'output_tps'     { return $Item.Output_tps_Avg }
        'combined_tps'   { return $Item.Combined_tps_Avg }
        'time_to_finish' { return $Item.TimeToFinish_Avg }
        default          { throw "Unsupported RankBy value: $RankBy" }
    }
}

function Get-RankDescending {
    param([string]$RankBy)

    switch ($RankBy) {
        'pp_tps'         { return $true }
        'output_tps'     { return $true }
        'combined_tps'   { return $true }
        'time_to_finish' { return $false }
        default          { throw "Unsupported RankBy value: $RankBy" }
    }
}

function Start-LoggedProcess {
    param(
        [string]$FilePath,
        [object[]]$ArgumentList,
        [string]$StdOutPath,
        [string]$StdErrPath
    )

    if (Test-Path -LiteralPath $StdOutPath) { Remove-Item -LiteralPath $StdOutPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $StdErrPath) { Remove-Item -LiteralPath $StdErrPath -Force -ErrorAction SilentlyContinue }

    return Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -PassThru `
        -NoNewWindow `
        -RedirectStandardOutput $StdOutPath `
        -RedirectStandardError $StdErrPath
}

function Stop-ProcessSafe {
    param($Proc)

    if ($null -ne $Proc -and -not $Proc.HasExited) {
        try { Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        try { Wait-Process -Id $Proc.Id -Timeout 5 -ErrorAction SilentlyContinue } catch {}
    }
}

function Align-Up {
    param(
        [int]$Value,
        [int]$Step
    )
    return [int]([math]::Ceiling($Value / [double]$Step) * $Step)
}

function Align-Down {
    param(
        [int]$Value,
        [int]$Step
    )
    return [int]([math]::Floor($Value / [double]$Step) * $Step)
}

function Format-Seconds {
    param([double]$Seconds)
    return ('{0:N1}s' -f $Seconds)
}

function Get-BestFitSoFar {
    param(
        [System.Collections.Generic.List[object]]$Results,
        [string]$RankBy
    )

    $rankProperty = Get-RankPropertyName -RankBy $RankBy
    $rankDescending = Get-RankDescending -RankBy $RankBy
    $fitting = $Results | Where-Object { $_.Fits -and $null -ne $_.$rankProperty }
    if (-not $fitting) { return $null }

    return $fitting |
        Sort-Object `
            @{ Expression = $rankProperty; Descending = $rankDescending }, `
            @{ Expression = 'Batch'; Descending = $true } |
        Select-Object -First 1
}

function Get-TopFittingRuns {
    param(
        [System.Collections.Generic.List[object]]$Results,
        [string]$RankBy,
        [int]$Top = 5
    )

    $rankProperty = Get-RankPropertyName -RankBy $RankBy
    $rankDescending = Get-RankDescending -RankBy $RankBy

    $fitting = $Results | Where-Object { $_.Fits -and $null -ne $_.$rankProperty }
    if (-not $fitting) { return @() }

    return @(
        $fitting |
            Sort-Object `
                @{ Expression = $rankProperty; Descending = $rankDescending }, `
                @{ Expression = 'Batch'; Descending = $true } |
            Select-Object -First $Top
    )
}

function Invoke-JsonPost {
    param(
        [string]$Uri,
        [object]$Body,
        [int]$TimeoutSec
    )

    $json = $Body | ConvertTo-Json -Depth 10 -Compress
    return Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json' -Body $json -TimeoutSec $TimeoutSec
}

function Get-TokenCount {
    param(
        [string]$BaseUrl,
        [string]$Text
    )

    $resp = Invoke-JsonPost `
        -Uri ($BaseUrl.TrimEnd('/') + '/tokenize') `
        -Body @{ content = $Text } `
        -TimeoutSec 120

    if ($resp -is [System.Array]) {
        return @($resp).Count
    }

    if ($null -ne $resp.tokens) {
        return @($resp.tokens).Count
    }

    if ($null -ne $resp.content) {
        return @($resp.content).Count
    }

    throw "Unable to parse /tokenize response."
}

function Get-DistinctSeedBlock {
    param(
        [string]$PromptName
    )

    switch ($PromptName) {
        'prompt_warmup' {
            return @"
[prompt_warmup]
This is the warmup benchmark prompt.
It is intentionally distinct from the measured prompts.
Alpha corridor bronze lattice signal marker.
"@
        }
        'prompt_1' {
            return @"
[prompt_1]
This is the first measured benchmark prompt.
It is intentionally distinct from warmup and other measured prompts.
Bravo chamber copper relay vector pattern.
"@
        }
        'prompt_2' {
            return @"
[prompt_2]
This is the second measured benchmark prompt.
It is intentionally distinct from warmup and other measured prompts.
Charlie engine amber matrix beacon sequence.
"@
        }
        'prompt_3' {
            return @"
[prompt_3]
This is the third measured benchmark prompt.
It is intentionally distinct from warmup and other measured prompts.
Delta anchor silver channel fragment signal.
"@
        }
        default {
            throw "Unknown prompt name: $PromptName"
        }
    }
}

function Build-PromptNearTokenTarget {
    param(
        [string]$BaseUrl,
        [int]$TargetTokens,
        [string]$PromptName
    )

    Write-Host ("  [prompt] building {0} near {1} tokens..." -f $PromptName, $TargetTokens) -ForegroundColor DarkGray

    $seed = Get-DistinctSeedBlock -PromptName $PromptName
    $separator = "`n"
    $unit = $seed + $separator
    $unitTokenCount = Get-TokenCount -BaseUrl $BaseUrl -Text $unit

    if ($unitTokenCount -le 0) {
        throw "Failed to tokenize prompt seed for $PromptName."
    }

    $approxRepeats = [math]::Max(1, [int][math]::Floor($TargetTokens / $unitTokenCount))
    $low = [math]::Max(1, [int]($approxRepeats * 0.5))
    $high = [math]::Max($low + 2, [int]($approxRepeats * 1.5) + 4)

    $bestText = $null
    $bestCount = $null
    $bestDelta = [double]::PositiveInfinity

    while ($low -le $high) {
        $mid = [int](($low + $high) / 2)
        $text = (($unit) * $mid).Trim()
        $count = Get-TokenCount -BaseUrl $BaseUrl -Text $text
        $delta = [math]::Abs($count - $TargetTokens)

        if ($delta -lt $bestDelta) {
            $bestDelta = $delta
            $bestCount = $count
            $bestText = $text
        }

        if ($count -lt $TargetTokens) {
            $low = $mid + 1
        }
        elseif ($count -gt $TargetTokens) {
            $high = $mid - 1
        }
        else {
            break
        }
    }

    if ($null -eq $bestText) {
        throw "Failed to build prompt for $PromptName."
    }

    Write-Host ("  [prompt] built {0} with approx_token_count={1}" -f $PromptName, $bestCount) -ForegroundColor DarkGray

    return [pscustomobject]@{
        Name       = $PromptName
        Text       = $bestText
        TokenCount = $bestCount
    }
}

function Get-OrBuildPromptSet {
    param(
        [string]$BaseUrl,
        [int]$TargetTokens
    )

    if ($null -ne $script:PromptSetCache) {
        Write-Host ("  [prompt] using cached prompt set: prompt_warmup={0}, prompt_1={1}, prompt_2={2}, prompt_3={3}" -f `
            $script:PromptSetCache.PromptWarmup.TokenCount,
            $script:PromptSetCache.Prompt1.TokenCount,
            $script:PromptSetCache.Prompt2.TokenCount,
            $script:PromptSetCache.Prompt3.TokenCount) -ForegroundColor DarkGray
        return $script:PromptSetCache
    }

    Write-Host ("  [prompt] building 4 fixed prompts near {0} tokens each..." -f $TargetTokens) -ForegroundColor DarkGray

    $promptWarmup = Build-PromptNearTokenTarget -BaseUrl $BaseUrl -TargetTokens $TargetTokens -PromptName 'prompt_warmup'
    $prompt1      = Build-PromptNearTokenTarget -BaseUrl $BaseUrl -TargetTokens $TargetTokens -PromptName 'prompt_1'
    $prompt2      = Build-PromptNearTokenTarget -BaseUrl $BaseUrl -TargetTokens $TargetTokens -PromptName 'prompt_2'
    $prompt3      = Build-PromptNearTokenTarget -BaseUrl $BaseUrl -TargetTokens $TargetTokens -PromptName 'prompt_3'

    $script:PromptSetCache = [pscustomobject]@{
        PromptWarmup = $promptWarmup
        Prompt1      = $prompt1
        Prompt2      = $prompt2
        Prompt3      = $prompt3
    }

    Write-Host ("  [prompt] prompt set ready: prompt_warmup={0}, prompt_1={1}, prompt_2={2}, prompt_3={3}" -f `
        $promptWarmup.TokenCount,
        $prompt1.TokenCount,
        $prompt2.TokenCount,
        $prompt3.TokenCount) -ForegroundColor DarkGray

    return $script:PromptSetCache
}

function Get-ServerMetricsFromResponse {
    param($Response)

    $timings = $Response.timings
    if ($null -eq $timings) {
        return [pscustomobject]@{
            PromptTps = $null
            OutputTps = $null
        }
    }

    $promptTps = $null
    $outputTps = $null

    if ($null -ne $timings.prompt_per_second) {
        $promptTps = [double]$timings.prompt_per_second
    }
    elseif (($null -ne $timings.prompt_n) -and ($null -ne $timings.prompt_ms) -and ([double]$timings.prompt_ms -gt 0)) {
        $promptTps = [math]::Round(([double]$timings.prompt_n / ([double]$timings.prompt_ms / 1000.0)), 2)
    }

    if ($null -ne $timings.predicted_per_second) {
        $outputTps = [double]$timings.predicted_per_second
    }
    elseif (($null -ne $timings.predicted_n) -and ($null -ne $timings.predicted_ms) -and ([double]$timings.predicted_ms -gt 0)) {
        $outputTps = [math]::Round(([double]$timings.predicted_n / ([double]$timings.predicted_ms / 1000.0)), 2)
    }

    return [pscustomobject]@{
        PromptTps = if ($null -ne $promptTps) { [math]::Round([double]$promptTps, 2) } else { $null }
        OutputTps = if ($null -ne $outputTps) { [math]::Round([double]$outputTps, 2) } else { $null }
    }
}

function Start-ServerForEval {
    param(
        [int]$NCpuMoe,
        [int]$Batch,
        [int]$Port,
        [string]$TestDir
    )

    $stdoutPath = Join-Path $TestDir 'server.stdout.log'
    $stderrPath = Join-Path $TestDir 'server.stderr.log'
    $baseUrl = "http://$BindHost`:$Port"

    $args = @(
        '-m', $ModelPath,
        '-c', $ContextSize,
        '--cache-ram', $CacheRam,
        '--cache-type-k', $CacheType,
        '--cache-type-v', $CacheType,
        '-ngl', $GpuLayers,
        '-t', $Threads,
        '-b', $Batch,
        '-ub', $Batch,
        '-np', $ParallelSlots,
        '--reasoning', 'off',
        '--host', $BindHost,
        '--port', $Port,
        '-ncmoe', $NCpuMoe,
        '-fa', 'on'
    )

    Write-Host ("  [probe] starting b=ub={0}, ncmoe={1}, port={2}" -f $Batch, $NCpuMoe, $Port) -ForegroundColor DarkCyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $proc = Start-LoggedProcess `
        -FilePath $LlamaServerPath `
        -ArgumentList $args `
        -StdOutPath $stdoutPath `
        -StdErrPath $stderrPath

    $deadline = (Get-Date).AddSeconds($ProbeTimeoutSeconds)
    $ready = $false
    $combined = ''

    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { break }

        $combined = Get-CombinedText -StdOutPath $stdoutPath -StdErrPath $stderrPath

        if ($combined -match 'server is listening on http://') {
            $ready = $true
            break
        }

        if ($combined -match 'not enough memory|cuda error|failed|exception|address already in use|bind failed') {
            break
        }

        Start-Sleep -Milliseconds 500
    }

    $combined = Get-CombinedText -StdOutPath $stdoutPath -StdErrPath $stderrPath

    $cudaModelMiB   = Parse-MiB -Text $combined -Label 'CUDA0 model buffer size'
    $cpuMappedMiB   = Parse-MiB -Text $combined -Label 'CPU_Mapped model buffer size'
    $cpuModelMiB    = Parse-MiB -Text $combined -Label 'CPU model buffer size'
    $cudaKvMiB      = Parse-MiB -Text $combined -Label 'CUDA0 KV buffer size'
    $cpuKvMiB       = Parse-MiB -Text $combined -Label 'CPU KV buffer size'
    $cudaComputeMiB = Parse-MiB -Text $combined -Label 'CUDA0 compute buffer size'
    $cudaRsMiB      = Parse-MiB -Text $combined -Label 'CUDA0 RS buffer size'

    $gpuTotalMiB = 0.0
    foreach ($v in @($cudaModelMiB, $cudaKvMiB, $cudaComputeMiB, $cudaRsMiB)) {
        if ($null -ne $v) { $gpuTotalMiB += $v }
    }

    $gpuTotalGiB = if ($gpuTotalMiB -gt 0) { [math]::Round($gpuTotalMiB / 1024.0, 3) } else { $null }
    $fits = ($null -ne $gpuTotalGiB) -and ($gpuTotalGiB -le $MaxGpuGiB)

    $sw.Stop()
    Write-Host ("  [probe] done in {0} | ready={1} | fits={2} | gpu={3}" -f `
        (Format-Seconds $sw.Elapsed.TotalSeconds),
        $ready,
        $fits,
        $(if ($null -ne $gpuTotalGiB) { "$gpuTotalGiB GiB" } else { '<not parsed>' })) -ForegroundColor DarkCyan

    return [pscustomobject]@{
        Process        = $proc
        BaseUrl        = $baseUrl
        Batch          = $Batch
        Ready          = $ready
        ExitCode       = if ($proc.HasExited) { $proc.ExitCode } else { $null }
        Fits           = $fits
        GpuTotalMiB    = if ($gpuTotalMiB -gt 0) { [math]::Round($gpuTotalMiB, 2) } else { $null }
        GpuTotalGiB    = $gpuTotalGiB
        CudaModelMiB   = $cudaModelMiB
        CpuMappedMiB   = $cpuMappedMiB
        CpuModelMiB    = $cpuModelMiB
        CudaKvMiB      = $cudaKvMiB
        CpuKvMiB       = $cpuKvMiB
        CudaComputeMiB = $cudaComputeMiB
        CudaRsMiB      = $cudaRsMiB
        Combined       = $combined
        StdOutPath     = $stdoutPath
        StdErrPath     = $stderrPath
        ProbeSeconds   = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    }
}

function Invoke-OneServerRun {
    param(
        [string]$BaseUrl,
        [string]$PromptText,
        [string]$PromptName,
        [int]$RepeatIndex,
        [string]$TestDir,
        [switch]$IsWarmup
    )

    $label = if ($IsWarmup) { 'warmup' } else { "bench $RepeatIndex/$BenchRepeats" }

    $stdoutPath = Join-Path $TestDir ($(if ($IsWarmup) { 'warmup.response.json' } else { "bench.r$RepeatIndex.response.json" }))
    Remove-IfExists -Path $stdoutPath

    Write-Host ("  [{0}] starting request against warm server using {1}" -f $label, $PromptName) -ForegroundColor DarkGreen
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $body = @{
        prompt       = $PromptText
        n_predict    = $OutputTokens
        temperature  = 0
        top_k        = 1
        top_p        = 1.0
        min_p        = 0.0
        stream       = $false
        cache_prompt = $false
        ignore_eos   = $true
        n_keep       = 0
    }

    $resp = Invoke-JsonPost `
        -Uri ($BaseUrl.TrimEnd('/') + '/completion') `
        -Body $body `
        -TimeoutSec $BenchTimeoutSeconds

    $sw.Stop()

    ($resp | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $stdoutPath -Encoding UTF8

    $metrics = Get-ServerMetricsFromResponse -Response $resp
    $combinedTps = Get-CombinedTps `
        -PromptTps $metrics.PromptTps `
        -OutputTps $metrics.OutputTps `
        -PromptTokens $PromptTokens `
        -OutputTokens $OutputTokens

    $timeToFinishSeconds = Get-TimeToFinishSeconds `
        -PromptTps $metrics.PromptTps `
        -OutputTps $metrics.OutputTps `
        -PromptTokens $PromptTokens `
        -OutputTokens $OutputTokens

    if ($IsWarmup) {
        Write-Host ("  [warmup] done in {0} | using={1} | pp_tps={2} || output_tps={3} || combined_tps={4} || time_to_finish={5}s" -f `
            (Format-Seconds $sw.Elapsed.TotalSeconds),
            $PromptName,
            $(if ($null -ne $metrics.PromptTps) { $metrics.PromptTps } else { '<parse failed>' }),
            $(if ($null -ne $metrics.OutputTps) { $metrics.OutputTps } else { '<parse failed>' }),
            $(if ($null -ne $combinedTps) { $combinedTps } else { '<parse failed>' }),
            $(if ($null -ne $timeToFinishSeconds) { $timeToFinishSeconds } else { '<parse failed>' })) -ForegroundColor DarkGreen
    }
    else {
        Write-Host ("  [bench {0}/{1}] done in {2} | using={3} | pp_tps={4} || output_tps={5} || combined_tps={6} || time_to_finish={7}s" -f `
            $RepeatIndex,
            $BenchRepeats,
            (Format-Seconds $sw.Elapsed.TotalSeconds),
            $PromptName,
            $(if ($null -ne $metrics.PromptTps) { $metrics.PromptTps } else { '<parse failed>' }),
            $(if ($null -ne $metrics.OutputTps) { $metrics.OutputTps } else { '<parse failed>' }),
            $(if ($null -ne $combinedTps) { $combinedTps } else { '<parse failed>' }),
            $(if ($null -ne $timeToFinishSeconds) { $timeToFinishSeconds } else { '<parse failed>' })) -ForegroundColor DarkGreen
    }

    return [pscustomobject]@{
        PromptTps           = $metrics.PromptTps
        OutputTps           = $metrics.OutputTps
        CombinedTps         = $combinedTps
        TimeToFinishSeconds = $timeToFinishSeconds
        StdOutPath          = $stdoutPath
        BenchSeconds        = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    }
}

function Run-BenchAverage {
    param(
        [string]$BaseUrl,
        [object]$PromptSet,
        [int]$NCpuMoe,
        [int]$Batch,
        [string]$TestDir
    )

    Write-Host ("  [prompt] planned sequence: warmup=prompt_warmup, bench1=prompt_1, bench2=prompt_2, bench3=prompt_3") -ForegroundColor Yellow
    Write-Host ("  [warmup] starting warmup run for b=ub={0}, ncmoe={1} using prompt_warmup" -f $Batch, $NCpuMoe) -ForegroundColor Yellow

    $warmup = Invoke-OneServerRun `
        -BaseUrl $BaseUrl `
        -PromptText $PromptSet.PromptWarmup.Text `
        -PromptName $PromptSet.PromptWarmup.Name `
        -RepeatIndex 0 `
        -TestDir $TestDir `
        -IsWarmup

    $measuredPrompts = @(
        $PromptSet.Prompt1,
        $PromptSet.Prompt2,
        $PromptSet.Prompt3
    )

    $promptSamples = @()
    $outputSamples = @()
    $combinedSamples = @()
    $timeToFinishSamples = @()

    $totalBenchSeconds = 0.0
    $stdoutPaths = @()

    for ($i = 1; $i -le $BenchRepeats; $i++) {
        $promptSpec = $measuredPrompts[$i - 1]

        Write-Host ("  [bench {0}/{1}] scheduled to use {2}" -f $i, $BenchRepeats, $promptSpec.Name) -ForegroundColor DarkYellow

        $run = Invoke-OneServerRun `
            -BaseUrl $BaseUrl `
            -PromptText $promptSpec.Text `
            -PromptName $promptSpec.Name `
            -RepeatIndex $i `
            -TestDir $TestDir

        $stdoutPaths += $run.StdOutPath
        $totalBenchSeconds += $run.BenchSeconds

        if ($null -ne $run.PromptTps)           { $promptSamples += [double]$run.PromptTps }
        if ($null -ne $run.OutputTps)           { $outputSamples += [double]$run.OutputTps }
        if ($null -ne $run.CombinedTps)         { $combinedSamples += [double]$run.CombinedTps }
        if ($null -ne $run.TimeToFinishSeconds) { $timeToFinishSamples += [double]$run.TimeToFinishSeconds }
    }

    $promptAvg = $null
    $promptMin = $null
    $promptMax = $null
    $outputAvg = $null
    $outputMin = $null
    $outputMax = $null
    $combinedAvg = $null
    $combinedMin = $null
    $combinedMax = $null
    $timeToFinishAvg = $null
    $timeToFinishMin = $null
    $timeToFinishMax = $null

    if ($promptSamples.Count -gt 0) {
        $promptAvg = [math]::Round((($promptSamples | Measure-Object -Average).Average), 2)
        $promptMin = [math]::Round((($promptSamples | Measure-Object -Minimum).Minimum), 2)
        $promptMax = [math]::Round((($promptSamples | Measure-Object -Maximum).Maximum), 2)
    }

    if ($outputSamples.Count -gt 0) {
        $outputAvg = [math]::Round((($outputSamples | Measure-Object -Average).Average), 2)
        $outputMin = [math]::Round((($outputSamples | Measure-Object -Minimum).Minimum), 2)
        $outputMax = [math]::Round((($outputSamples | Measure-Object -Maximum).Maximum), 2)
    }

    if ($combinedSamples.Count -gt 0) {
        $combinedAvg = [math]::Round((($combinedSamples | Measure-Object -Average).Average), 2)
        $combinedMin = [math]::Round((($combinedSamples | Measure-Object -Minimum).Minimum), 2)
        $combinedMax = [math]::Round((($combinedSamples | Measure-Object -Maximum).Maximum), 2)
    }

    if ($timeToFinishSamples.Count -gt 0) {
        $timeToFinishAvg = [math]::Round((($timeToFinishSamples | Measure-Object -Average).Average), 2)
        $timeToFinishMin = [math]::Round((($timeToFinishSamples | Measure-Object -Minimum).Minimum), 2)
        $timeToFinishMax = [math]::Round((($timeToFinishSamples | Measure-Object -Maximum).Maximum), 2)
    }

    Write-Host ("  [bench avg] pp_avg={0} | out_avg={1} | combined_avg={2} | time_to_finish_avg={3}s" -f `
        $(if ($null -ne $promptAvg) { $promptAvg } else { '<n/a>' }),
        $(if ($null -ne $outputAvg) { $outputAvg } else { '<n/a>' }),
        $(if ($null -ne $combinedAvg) { $combinedAvg } else { '<n/a>' }),
        $(if ($null -ne $timeToFinishAvg) { $timeToFinishAvg } else { '<n/a>' })) -ForegroundColor Green

    return [pscustomobject]@{
        PromptAvg           = $promptAvg
        PromptMin           = $promptMin
        PromptMax           = $promptMax
        PromptSamples       = ($promptSamples -join ', ')

        OutputAvg           = $outputAvg
        OutputMin           = $outputMin
        OutputMax           = $outputMax
        OutputSamples       = ($outputSamples -join ', ')

        CombinedAvg         = $combinedAvg
        CombinedMin         = $combinedMin
        CombinedMax         = $combinedMax
        CombinedSamples     = ($combinedSamples -join ', ')

        TimeToFinishAvg     = $timeToFinishAvg
        TimeToFinishMin     = $timeToFinishMin
        TimeToFinishMax     = $timeToFinishMax
        TimeToFinishSamples = ($timeToFinishSamples -join ', ')

        BenchSeconds        = [math]::Round($totalBenchSeconds, 2)
        WarmupStdOut        = $warmup.StdOutPath
        StdOutPaths         = ($stdoutPaths -join '; ')
        StdErrPaths         = $null
    }
}

function Evaluate-Batch {
    param(
        [int]$NCpuMoe,
        [int]$Batch,
        [int]$Port,
        [string]$RunDir,
        [hashtable]$Cache,
        [System.Collections.Generic.List[object]]$Results,
        [ref]$EvalCounter,
        [string]$RankBy
    )

    $cacheKey = "{0}|{1}" -f $NCpuMoe, $Batch
    if ($Cache.ContainsKey($cacheKey)) {
        Write-Host ("[cache] ncmoe={0} batch={1} already evaluated" -f $NCpuMoe, $Batch) -ForegroundColor Yellow
        return $Cache[$cacheKey]
    }

    $EvalCounter.Value++
    $evalNumber = $EvalCounter.Value

    Write-Host ""
    Write-Host ("========== evaluation #{0} | ncmoe {1} | batch {2} ==========" -f $evalNumber, $NCpuMoe, $Batch) -ForegroundColor Magenta

    $testDir = Join-Path $RunDir ("ncmoe{0}_b{1}_ub{1}" -f $NCpuMoe, $Batch)
    New-Item -ItemType Directory -Path $testDir -Force | Out-Null

    $server = $null
    try {
        $server = Start-ServerForEval -NCpuMoe $NCpuMoe -Batch $Batch -Port $Port -TestDir $testDir

        $benchAvg = $null
        if ($server.Fits -and $server.Ready) {
            $promptSet = Get-OrBuildPromptSet -BaseUrl $server.BaseUrl -TargetTokens $PromptTokens
            $benchAvg = Run-BenchAverage `
                -BaseUrl $server.BaseUrl `
                -PromptSet $promptSet `
                -NCpuMoe $NCpuMoe `
                -Batch $Batch `
                -TestDir $testDir
        }
        else {
            Write-Host "  [bench] skipped because probe did not fit under GPU limit or server was not ready" -ForegroundColor DarkYellow
        }

        $result = [pscustomobject]@{
            NCpuMoe              = $NCpuMoe
            Batch                = $Batch
            CacheType            = $CacheType
            ServerReady          = $server.Ready
            Fits                 = $server.Fits
            GpuTotalGiB          = $server.GpuTotalGiB
            GpuTotalMiB          = $server.GpuTotalMiB
            CudaModelMiB         = $server.CudaModelMiB
            CudaKvMiB            = $server.CudaKvMiB
            CudaComputeMiB       = $server.CudaComputeMiB
            CudaRsMiB            = $server.CudaRsMiB
            CpuMappedMiB         = $server.CpuMappedMiB

            PP_tps_Avg           = if ($null -ne $benchAvg) { $benchAvg.PromptAvg } else { $null }
            PP_tps_Min           = if ($null -ne $benchAvg) { $benchAvg.PromptMin } else { $null }
            PP_tps_Max           = if ($null -ne $benchAvg) { $benchAvg.PromptMax } else { $null }
            PP_tps_Samples       = if ($null -ne $benchAvg) { $benchAvg.PromptSamples } else { $null }

            Output_tps_Avg       = if ($null -ne $benchAvg) { $benchAvg.OutputAvg } else { $null }
            Output_tps_Min       = if ($null -ne $benchAvg) { $benchAvg.OutputMin } else { $null }
            Output_tps_Max       = if ($null -ne $benchAvg) { $benchAvg.OutputMax } else { $null }
            Output_tps_Samples   = if ($null -ne $benchAvg) { $benchAvg.OutputSamples } else { $null }

            Combined_tps_Avg     = if ($null -ne $benchAvg) { $benchAvg.CombinedAvg } else { $null }
            Combined_tps_Min     = if ($null -ne $benchAvg) { $benchAvg.CombinedMin } else { $null }
            Combined_tps_Max     = if ($null -ne $benchAvg) { $benchAvg.CombinedMax } else { $null }
            Combined_tps_Samples = if ($null -ne $benchAvg) { $benchAvg.CombinedSamples } else { $null }

            TimeToFinish_Avg     = if ($null -ne $benchAvg) { $benchAvg.TimeToFinishAvg } else { $null }
            TimeToFinish_Min     = if ($null -ne $benchAvg) { $benchAvg.TimeToFinishMin } else { $null }
            TimeToFinish_Max     = if ($null -ne $benchAvg) { $benchAvg.TimeToFinishMax } else { $null }
            TimeToFinish_Samples = if ($null -ne $benchAvg) { $benchAvg.TimeToFinishSamples } else { $null }

            ProbeSeconds         = $server.ProbeSeconds
            BenchSeconds         = if ($null -ne $benchAvg) { $benchAvg.BenchSeconds } else { $null }
            ProbeStdOut          = $server.StdOutPath
            ProbeStdErr          = $server.StdErrPath
            BenchStdOut          = if ($null -ne $benchAvg) { $benchAvg.StdOutPaths } else { $null }
            BenchStdErr          = if ($null -ne $benchAvg) { $benchAvg.StdErrPaths } else { $null }
        }

        $Cache[$cacheKey] = $result
        $Results.Add($result)

        Write-Host ("[result] ncmoe={0} | batch={1} | fits={2} | gpu={3} | pp_avg={4} | out_avg={5} | combined_avg={6} | time_to_finish_avg={7}s" -f `
            $result.NCpuMoe,
            $result.Batch,
            $result.Fits,
            $(if ($null -ne $result.GpuTotalGiB) { "$($result.GpuTotalGiB) GiB" } else { '<n/a>' }),
            $(if ($null -ne $result.PP_tps_Avg) { $result.PP_tps_Avg } else { '<n/a>' }),
            $(if ($null -ne $result.Output_tps_Avg) { $result.Output_tps_Avg } else { '<n/a>' }),
            $(if ($null -ne $result.Combined_tps_Avg) { $result.Combined_tps_Avg } else { '<n/a>' }),
            $(if ($null -ne $result.TimeToFinish_Avg) { $result.TimeToFinish_Avg } else { '<n/a>' })) -ForegroundColor White

        $best = Get-BestFitSoFar -Results $Results -RankBy $RankBy
        if ($null -ne $best) {
            $rankLabel = Get-RankLabel -RankBy $RankBy
            $rankValue = Get-RankValue -Item $best -RankBy $RankBy
            Write-Host ("[best-so-far] ncmoe={0} | batch={1} | gpu={2} GiB | {3}={4}" -f `
                $best.NCpuMoe, $best.Batch, $best.GpuTotalGiB, $rankLabel, $rankValue) -ForegroundColor Green
        }

        return $result
    }
    finally {
        if ($null -ne $server -and $null -ne $server.Process) {
            Stop-ProcessSafe -Proc $server.Process
        }
    }
}

try {
    Write-Host "Script starting..." -ForegroundColor Cyan

    if ($MinNCpuMoe -gt $MaxNCpuMoe) {
        throw "MinNCpuMoe must be <= MaxNCpuMoe."
    }

    if ($BenchRepeats -ne 3) {
        throw "This script currently expects BenchRepeats = 3 because it uses exactly 3 fixed measured prompts."
    }

    Assert-PathExists -Path $ModelPath -Label 'Model'
    Assert-PathExists -Path $LlamaServerPath -Label 'llama-server.exe'

    $StartBatch = Align-Up -Value $StartBatch -Step $Alignment

    Write-Host ("MinNCpuMoe   : {0}" -f $MinNCpuMoe)
    Write-Host ("MaxNCpuMoe   : {0}" -f $MaxNCpuMoe)
    Write-Host ("StartBatch   : {0}" -f $StartBatch)
    Write-Host ("MaxGpuGiB    : {0}" -f $MaxGpuGiB)
    Write-Host ("Alignment    : {0}" -f $Alignment)
    Write-Host ("CacheType    : {0}" -f $CacheType)
    Write-Host ("PromptTokens : {0}" -f $PromptTokens)
    Write-Host ("OutputTokens : {0}" -f $OutputTokens)
    Write-Host ("BenchRepeats : {0}" -f $BenchRepeats)
    Write-Host ("RankBy       : {0}" -f $RankBy)

    $timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $runDir = Join-Path $OutputRoot ("moe{0}-{1}_{2}" -f $MinNCpuMoe, $MaxNCpuMoe, $timestamp)
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null

    Write-Host ("RunDir       : {0}" -f $runDir)

    $cache = @{}
    $allResults = New-Object System.Collections.Generic.List[object]
    $portCounter = 0
    $evalCounter = 0

    function Eval-And-Store {
        param(
            [int]$NCpuMoe,
            [int]$Batch
        )

        $script:portCounter++
        $port = $BasePort + $script:portCounter

        return Evaluate-Batch `
            -NCpuMoe $NCpuMoe `
            -Batch $Batch `
            -Port $port `
            -RunDir $runDir `
            -Cache $cache `
            -Results $allResults `
            -EvalCounter ([ref]$script:evalCounter) `
            -RankBy $RankBy
    }

    for ($ncmoe = $MinNCpuMoe; $ncmoe -le $MaxNCpuMoe; $ncmoe++) {
        Write-Host ""
        Write-Host ("############################################################") -ForegroundColor Cyan
        Write-Host ("### Searching ncmoe = {0}" -f $ncmoe) -ForegroundColor Cyan
        Write-Host ("############################################################") -ForegroundColor Cyan

        Write-Host ""
        Write-Host "Phase 1: find fitting upper/lower bounds" -ForegroundColor Cyan

        $startResult = Eval-And-Store -NCpuMoe $ncmoe -Batch $StartBatch
        if (-not $startResult.Fits) {
            Write-Host ("StartBatch {0} does not fit for ncmoe={1}. Skipping this moe." -f $StartBatch, $ncmoe) -ForegroundColor Red
            continue
        }

        $lowFit = $StartBatch
        $highFail = $null

        $probeCandidate = Align-Up -Value ($StartBatch * 2) -Step $Alignment
        Write-Host ("[bounds] trying doubled point {0}" -f $probeCandidate) -ForegroundColor DarkCyan
        $probeResult = Eval-And-Store -NCpuMoe $ncmoe -Batch $probeCandidate

        if ($probeResult.Fits) {
            $lowFit = $probeCandidate

            while ($true) {
                $next = Align-Up -Value ($lowFit * 2) -Step $Alignment
                Write-Host ("[bounds] expanding upward to {0}" -f $next) -ForegroundColor DarkCyan
                $nextResult = Eval-And-Store -NCpuMoe $ncmoe -Batch $next

                if ($nextResult.Fits) {
                    $lowFit = $next
                }
                else {
                    $highFail = $next
                    break
                }
            }
        }
        else {
            $highFail = $probeCandidate
        }

        if ($null -eq $highFail) {
            Write-Host ("Failed to establish a failing upper bound for ncmoe={0}. Skipping." -f $ncmoe) -ForegroundColor Red
            continue
        }

        Write-Host ("[bounds] initial window: lowFit={0}, highFail={1}" -f $lowFit, $highFail) -ForegroundColor Cyan

        while (($highFail - $lowFit) -gt $Alignment) {
            $mid = Align-Down -Value ([int](($lowFit + $highFail) / 2)) -Step $Alignment
            if ($mid -le $lowFit) { break }

            Write-Host ("[binary-search] lowFit={0} highFail={1} mid={2}" -f $lowFit, $highFail, $mid) -ForegroundColor DarkCyan
            $midResult = Eval-And-Store -NCpuMoe $ncmoe -Batch $mid

            if ($midResult.Fits) {
                $lowFit = $mid
            }
            else {
                $highFail = $mid
            }
        }

        $rankProperty = Get-RankPropertyName -RankBy $RankBy
        $rankDescending = Get-RankDescending -RankBy $RankBy

        $moeResults = $allResults | Where-Object { $_.NCpuMoe -eq $ncmoe }
        $moeFitting = $moeResults | Where-Object { $_.Fits -and $null -ne $_.$rankProperty }

        if ($moeFitting) {
            $largestFit = $moeFitting |
                Sort-Object @{ Expression = 'Batch'; Descending = $true } |
                Select-Object -First 1

            $bestByRank = $moeFitting |
                Sort-Object `
                    @{ Expression = $rankProperty; Descending = $rankDescending }, `
                    @{ Expression = 'Batch'; Descending = $true } |
                Select-Object -First 1

            Write-Host ""
            Write-Host ("Largest fitting batch for ncmoe={0}" -f $ncmoe) -ForegroundColor Green
            $largestFit | Format-Table Batch, GpuTotalGiB, PP_tps_Avg, Output_tps_Avg, Combined_tps_Avg, TimeToFinish_Avg -AutoSize

            Write-Host ""
            Write-Host ("Best result for ncmoe={0} ranked by {1}" -f $ncmoe, $RankBy) -ForegroundColor Green
            $bestByRank | Format-Table Batch, GpuTotalGiB, PP_tps_Avg, Output_tps_Avg, Combined_tps_Avg, TimeToFinish_Avg -AutoSize
        }
        else {
            Write-Host ("No fitting configurations found for ncmoe={0}" -f $ncmoe) -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host ("############################################################") -ForegroundColor Cyan
    Write-Host ("### FINAL GLOBAL TOP RUNS BY {0}" -f $RankBy) -ForegroundColor Cyan
    Write-Host ("############################################################") -ForegroundColor Cyan

    $topRuns = Get-TopFittingRuns -Results $allResults -RankBy $RankBy -Top 5

    if ($topRuns.Count -gt 0) {
        $topRuns |
            Select-Object `
                @{ Name = 'Rank'; Expression = {
                    $script:__rankCounter = if ($null -eq $script:__rankCounter) { 1 } else { $script:__rankCounter + 1 }
                    $script:__rankCounter
                } },
                CacheType,
                NCpuMoe,
                Batch,
                GpuTotalGiB,
                PP_tps_Avg,
                Output_tps_Avg,
                Combined_tps_Avg,
                TimeToFinish_Avg |
            Format-Table -AutoSize

        $bestOverall = $topRuns | Select-Object -First 1
        Write-Host ""
        Write-Host ("Best overall: ncmoe={0} | batch={1} | gpu={2} GiB | pp_avg={3} | out_avg={4} | combined_avg={5} | time_to_finish_avg={6}s" -f `
            $bestOverall.NCpuMoe,
            $bestOverall.Batch,
            $bestOverall.GpuTotalGiB,
            $bestOverall.PP_tps_Avg,
            $bestOverall.Output_tps_Avg,
            $bestOverall.Combined_tps_Avg,
            $bestOverall.TimeToFinish_Avg) -ForegroundColor Green
    }
    else {
        Write-Host "No fitting runs found to rank globally." -ForegroundColor Red
    }

    $resultsCsvPath = Join-Path $runDir 'all_results.csv'
    $allResults | Export-Csv -LiteralPath $resultsCsvPath -NoTypeInformation -Encoding UTF8

    if ($topRuns.Count -gt 0) {
        $script:__rankCounter = $null
        $topRunsCsvPath = Join-Path $runDir 'top_runs.csv'
        $topRuns |
            Select-Object `
                @{ Name = 'Rank'; Expression = {
                    $script:__rankCounter = if ($null -eq $script:__rankCounter) { 1 } else { $script:__rankCounter + 1 }
                    $script:__rankCounter
                } },
                CacheType,
                NCpuMoe,
                Batch,
                GpuTotalGiB,
                PP_tps_Avg,
                Output_tps_Avg,
                Combined_tps_Avg,
                TimeToFinish_Avg,
                ProbeSeconds,
                BenchSeconds,
                PP_tps_Samples,
                Output_tps_Samples,
                Combined_tps_Samples,
                TimeToFinish_Samples,
                ProbeStdOut,
                ProbeStdErr,
                BenchStdOut,
                BenchStdErr |
            Export-Csv -LiteralPath $topRunsCsvPath -NoTypeInformation -Encoding UTF8

        Write-Host ("Saved all results to: {0}" -f $resultsCsvPath) -ForegroundColor DarkGreen
        Write-Host ("Saved top runs to:   {0}" -f $topRunsCsvPath) -ForegroundColor DarkGreen
    }
    else {
        Write-Host ("Saved all results to: {0}" -f $resultsCsvPath) -ForegroundColor DarkGreen
    }
}
catch {
    Write-Host ""
    Write-Host "SCRIPT FAILED" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    throw
}
