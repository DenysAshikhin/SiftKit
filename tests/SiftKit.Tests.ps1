$modulePath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
$script:OriginalUserProfile = $env:USERPROFILE
$script:TestHome = Join-Path $PSScriptRoot '.test-home'
$script:TestCodexHome = Join-Path $PSScriptRoot '.test-codex'
$script:TestBinDir = Join-Path $PSScriptRoot '.test-bin'
$script:TestModuleRoot = Join-Path $PSScriptRoot '.test-modules'
$script:TestNpmPrefix = Join-Path $PSScriptRoot '.npm-prefix'

Import-Module $modulePath -Force

Describe 'SiftKit' {

    BeforeEach {
        $env:USERPROFILE = $script:TestHome

        if (Test-Path -LiteralPath $script:TestHome) {
            Remove-Item -LiteralPath $script:TestHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestCodexHome) {
            Remove-Item -LiteralPath $script:TestCodexHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestBinDir) {
            Remove-Item -LiteralPath $script:TestBinDir -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestModuleRoot) {
            Remove-Item -LiteralPath $script:TestModuleRoot -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestNpmPrefix) {
            Remove-Item -LiteralPath $script:TestNpmPrefix -Recurse -Force
        }

        Install-SiftKit -Force | Out-Null

        InModuleScope SiftKit {
            $script:MockSummaryCalls = 0
            Register-SiftProvider -Name 'mock' `
                -TestScript {
                    param($Config)

                    [pscustomobject]@{
                        Available = $true
                        ExecutablePath = 'mock.exe'
                        Reachable = $true
                        BaseUrl = 'mock://local'
                        Error = $null
                    }
                } `
                -ListModelsScript {
                    param($Config)
                    @('mock-model')
                } `
                -SummarizeScript {
                    param($Config, $Model, $Prompt)

                    $script:MockSummaryCalls++

                    if ($Prompt -match 'Return only valid JSON') {
                        return '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]'
                    }

                    if ($Prompt -match 'did tests pass') {
                        return 'test_order_processing failed and test_auth_timeout failed'
                    }

                    if ($Prompt -match 'resources added, changed, and destroyed') {
                        return 'destroy aws_db_instance.main; raw review required'
                    }

                    return 'mock summary'
                }
        }
    }

    AfterAll {
        $env:USERPROFILE = $script:OriginalUserProfile

        if (Test-Path -LiteralPath $script:TestHome) {
            Remove-Item -LiteralPath $script:TestHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestCodexHome) {
            Remove-Item -LiteralPath $script:TestCodexHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestBinDir) {
            Remove-Item -LiteralPath $script:TestBinDir -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestModuleRoot) {
            Remove-Item -LiteralPath $script:TestModuleRoot -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestNpmPrefix) {
            Remove-Item -LiteralPath $script:TestNpmPrefix -Recurse -Force
        }
    }

    It 'bootstraps config and runtime directories' {
        $result = Install-SiftKit -Force

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.ConfigPath) | Should Be $true
        (Test-Path -LiteralPath $result.LogsPath) | Should Be $true
        (Test-Path -LiteralPath $result.EvalResultsPath) | Should Be $true
    }

    It 'bypasses short summary input' {
        $result = Invoke-SiftSummary -Question 'summarize this' -Text 'short output' -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.PolicyDecision | Should Be 'short-output'
        $result.Summary | Should Be 'short output'
    }

    It 'summarizes long input through the selected backend' {
        $text = ((1..40 | ForEach-Object { "line $_ with repeated status" }) -join "`n")
        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Match 'mock summary'
    }

    It 'reads explicit input files without falling back to empty text' {
        $inputPath = Join-Path $script:TestHome 'input.txt'
        Set-Content -LiteralPath $inputPath -Value 'short output' -Encoding UTF8 -NoNewline

        $result = Invoke-SiftSummary -Question 'summarize this' -InputFile $inputPath -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.Summary | Should Be 'short output'
    }

    It 'splits oversized input into chunk summaries before the final summary' {
        $text = ('A' * 25000)
        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Match 'mock summary'
        InModuleScope SiftKit { $script:MockSummaryCalls } | Should Be 3
    }

    It 'migrates legacy config files with missing chunk thresholds' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:2b'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }

        $config.Thresholds.MaxInputCharacters | Should Be 32000
        $config.Thresholds.ChunkThresholdRatio | Should Be 0.75
        $config.Ollama.NumCtx | Should Be 16384
    }

    It 'captures raw logs and flags debug commands for raw review' {
        $script = '1..60 | ForEach-Object { "INFO item $_ processed successfully" }; Write-Error "fatal problem"'
        $result = Invoke-SiftCommand `
            -Command 'powershell.exe' `
            -ArgumentList '-NoProfile', '-Command', $script `
            -Question 'what failed?' `
            -RiskLevel debug `
            -Backend 'mock' `
            -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.RawReviewRequired | Should Be $true
        (Test-Path -LiteralPath $result.RawLogPath) | Should Be $true
    }

    It 'finds multiple file names through the module command' {
        $root = Join-Path $script:TestHome 'find-root'
        $nested = Join-Path $root 'nested'
        $null = New-Item -ItemType Directory -Path $nested -Force
        $null = New-Item -ItemType File -Path (Join-Path $root 'frigate.gd') -Force
        $null = New-Item -ItemType File -Path (Join-Path $nested 'Enemy_Manager.gd') -Force
        $null = New-Item -ItemType File -Path (Join-Path $nested 'ignore.txt') -Force

        $results = Find-SiftFiles -Path $root -Name 'frigate.gd', 'Enemy_Manager.gd'

        @($results).Count | Should Be 2
        ((@($results | ForEach-Object Name) -contains 'frigate.gd')) | Should Be $true
        ((@($results | ForEach-Object Name) -contains 'Enemy_Manager.gd')) | Should Be $true
        ((@($results | ForEach-Object RelativePath) -contains 'frigate.gd')) | Should Be $true
        ((@($results | ForEach-Object RelativePath) -contains (Join-Path 'nested' 'Enemy_Manager.gd'))) | Should Be $true
    }

    It 'installs the Codex policy block without duplicating it' {
        $first = Install-SiftCodexPolicy -CodexHome $script:TestCodexHome
        $second = Install-SiftCodexPolicy -CodexHome $script:TestCodexHome
        $content = Get-Content -LiteralPath $first.AgentsPath -Raw

        $first.Installed | Should Be $true
        $second.Installed | Should Be $true
        ([regex]::Matches($content, 'SiftKit Policy:Start')).Count | Should Be 1
    }

    It 'writes an evaluation artifact' {
        $result = Invoke-SiftEvaluation -FixtureRoot (Join-Path $PSScriptRoot '..\eval\fixtures') -Backend 'mock' -Model 'mock-model'

        (Test-Path -LiteralPath $result.ResultPath) | Should Be $true
        @($result.Results).Count | Should Be 8
    }

    It 'installs module and global shims into target directories' {
        $result = Install-SiftKitShellIntegration -BinDir $script:TestBinDir -ModuleInstallRoot $script:TestModuleRoot -Force

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.ModulePath) | Should Be $true
        (Test-Path -LiteralPath $result.PowerShellShim) | Should Be $true
        (Test-Path -LiteralPath $result.CmdShim) | Should Be $true
    }

    It 'exposes the npm package metadata for siftkit' {
        $package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json

        $package.name | Should Be 'siftkit'
        $package.bin.siftkit | Should Be 'bin/siftkit.js'
        $package.scripts.postinstall | Should Be 'node scripts/postinstall.js'
    }

    It 'writes global shims through the postinstall script' {
        $prefix = $script:TestNpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }

        $env:npm_config_prefix = $prefix
        try {
            node (Join-Path $PSScriptRoot '..\scripts\postinstall.js')
        }
        finally {
            Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue
        }

        (Test-Path -LiteralPath (Join-Path $prefix 'siftkit.ps1')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $prefix 'siftkit.cmd')) | Should Be $true
    }

    It 'spools large piped input through a temp file in the generated global shim' {
        $prefix = $script:TestNpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }

        $env:npm_config_prefix = $prefix
        try {
            node (Join-Path $PSScriptRoot '..\scripts\postinstall.js')
        }
        finally {
            Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue
        }

        $shimPath = Join-Path $prefix 'siftkit.ps1'
        $shimContent = Get-Content -LiteralPath $shimPath -Raw

        $shimContent | Should Match 'GetTempFileName'
        $shimContent | Should Match 'Set-Content -LiteralPath \$tempFile -Encoding UTF8'
        $shimContent | Should Match '--file \$tempFile'
        $shimContent | Should Not Match '--text \$siftText'
    }

    It 'accepts direct powershell pipeline input with cli args' {
        $siftInput = 'short output'
        $output = $siftInput | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'what is this?'

        ($output -join "`n") | Should Match 'short output'
    }

    It 'accepts redirected stdin when launched with powershell file mode' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.ps1')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`" `"what is this?`""
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $process.StandardInput.WriteLine('short output')
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout | Should Match 'short output'
    }

    It 'find-files cli accepts multiple patterns' {
        $root = Join-Path $script:TestHome 'cli-find-root'
        $nested = Join-Path $root 'nested'
        $null = New-Item -ItemType Directory -Path $nested -Force
        $null = New-Item -ItemType File -Path (Join-Path $root 'frigate.gd') -Force
        $null = New-Item -ItemType File -Path (Join-Path $nested 'Enemy_Manager.gd') -Force

        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') find-files --path $root 'frigate.gd' 'Enemy_Manager.gd'

        ($output -join "`n") | Should Match 'frigate\.gd'
        ($output -join "`n") | Should Match 'Enemy_Manager\.gd'
    }

    It 'accepts redirected stdin when launched through the node cli wrapper' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.js')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = "`"$scriptPath`" `"what is this?`""
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $process.StandardInput.Write('short output')
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout | Should Match 'short output'
    }

    It 'accepts multiline redirected stdin when launched through the node cli wrapper' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.js')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = "`"$scriptPath`" `"what is this?`""
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $process.StandardInput.Write("first line`n`nthird line")
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout | Should Match 'first line'
        $stdout | Should Match 'third line'
    }
}
