[CmdletBinding()]
param(
    [Parameter(ValueFromPipeline = $true)]
    [object]$InputObject,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

$ErrorActionPreference = 'Stop'
$script:PipelineBuffer = New-Object System.Collections.Generic.List[object]

function Import-SiftKitCliModule {
    $available = Get-Module -ListAvailable -Name SiftKit | Sort-Object Version -Descending | Select-Object -First 1
    if ($available) {
        Import-Module $available.Path -Force
        return
    }

    $localManifest = Join-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -ChildPath 'SiftKit\SiftKit.psd1'
    if (Test-Path -LiteralPath $localManifest) {
        Import-Module $localManifest -Force
        return
    }

    throw 'SiftKit module could not be located. Import the module or run Install-SiftKitShellIntegration first.'
}

function Read-SiftStdin {
    if ($script:PipelineBuffer.Count -gt 0) {
        $pipelineText = Convert-SiftPipelineBufferToText -PipelineBuffer $script:PipelineBuffer
        if (-not [string]::IsNullOrEmpty($pipelineText)) {
            return $pipelineText
        }
    }

    if ([Console]::IsInputRedirected) {
        $redirectedText = Normalize-SiftInputText -Text ([Console]::In.ReadToEnd())
        if (-not [string]::IsNullOrEmpty($redirectedText)) {
            return $redirectedText
        }
    }

    return $null
}

function Normalize-SiftInputText {
    param(
        [AllowNull()]
        [string]$Text
    )

    if ($null -eq $Text) {
        return $null
    }

    $Text.TrimEnd([char[]]@("`r", "`n"))
}

function Convert-SiftPipelineBufferToText {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IEnumerable]$PipelineBuffer
    )

    $items = @($PipelineBuffer)
    if ($items.Count -eq 0) {
        return ''
    }

    $allStrings = $true
    foreach ($item in $items) {
        if ($item -isnot [string]) {
            $allStrings = $false
            break
        }
    }

    if ($allStrings) {
        return (Normalize-SiftInputText -Text ($items -join [Environment]::NewLine))
    }

    return (Normalize-SiftInputText -Text ($items | Out-String -Width 200))
}

function Parse-SiftCliArguments {
    param(
        [string[]]$Tokens
    )

    $parsed = [ordered]@{
        Positionals = @()
        ArgList = @()
    }

    for ($i = 0; $i -lt $Tokens.Count; $i++) {
        $token = $Tokens[$i]
        switch ($token) {
            '--question' { $parsed.Question = $Tokens[++$i] }
            '--text' { $parsed.Text = $Tokens[++$i] }
            '--file' { $parsed.File = $Tokens[++$i] }
            '--backend' { $parsed.Backend = $Tokens[++$i] }
            '--model' { $parsed.Model = $Tokens[++$i] }
            '--profile' { $parsed.Profile = $Tokens[++$i] }
            '--format' { $parsed.Format = $Tokens[++$i] }
            '--risk' { $parsed.Risk = $Tokens[++$i] }
            '--reducer' { $parsed.Reducer = $Tokens[++$i] }
            '--command' { $parsed.Command = $Tokens[++$i] }
            '--arg' { $parsed.ArgList += $Tokens[++$i] }
            '--path' { $parsed.Path = $Tokens[++$i] }
            '--full-path' { $parsed.FullPath = $true }
            '--codex-home' { $parsed.CodexHome = $Tokens[++$i] }
            '--fixture-root' { $parsed.FixtureRoot = $Tokens[++$i] }
            '--bin-dir' { $parsed.BinDir = $Tokens[++$i] }
            '--module-root' { $parsed.ModuleRoot = $Tokens[++$i] }
            default { $parsed.Positionals += $token }
        }
    }

    [pscustomobject]$parsed
}

function Show-SiftKitHelp {
@'
SiftKit CLI

Usage:
  siftkit "question"
  some-command | siftkit "question"
  siftkit summary --question "..." [--text "..."] [--file path]
  siftkit run --command pytest --arg -q --question "did tests pass?"
  siftkit find-files [--path dir] [--full-path] pattern [pattern...]
  siftkit install
  siftkit test
  siftkit eval
  siftkit codex-policy
  siftkit install-global
  siftkit status-server
'@
}

Import-SiftKitCliModule

if ($null -ne $InputObject) {
    if ($InputObject -isnot [string] -or $InputObject.Length -gt 0) {
        [void]$script:PipelineBuffer.Add($InputObject)
    }
}

foreach ($item in $input) {
    if ($null -ne $item) {
        if ($item -isnot [string] -or $item -ne '') {
            [void]$script:PipelineBuffer.Add($item)
        }
    }
}

if (-not $CliArgs -or $CliArgs.Count -eq 0 -or $CliArgs[0] -in @('help', '--help', '-h')) {
    Show-SiftKitHelp
    exit 0
}

$knownCommands = @('summary', 'run', 'find-files', 'install', 'test', 'eval', 'codex-policy', 'install-global', 'status-server')
$commandName = if ($CliArgs[0] -in $knownCommands) { $CliArgs[0] } else { 'summary' }
$commandArgs = if ($commandName -eq 'summary' -and $CliArgs[0] -notin $knownCommands) { $CliArgs } else { $CliArgs[1..($CliArgs.Count - 1)] }
if ($CliArgs.Count -eq 1 -and $commandName -ne 'summary') {
    $commandArgs = @()
}

$parsed = Parse-SiftCliArguments -Tokens $commandArgs

switch ($commandName) {
    'summary' {
        $question = if ($parsed.Question) { $parsed.Question } elseif ($parsed.Positionals.Count -gt 0) { $parsed.Positionals[0] } else { throw 'A question is required.' }
        $hasPipelineInput = $script:PipelineBuffer.Count -gt 0
        $inputText = if ($parsed.Text) { Normalize-SiftInputText -Text $parsed.Text } elseif ($parsed.File -or $hasPipelineInput) { $null } else { Read-SiftStdin }
        $format = if ($parsed.Format) { $parsed.Format } else { 'text' }
        $profile = if ($parsed.Profile) { $parsed.Profile } else { 'general' }

        if (-not $parsed.File -and -not $hasPipelineInput -and [string]::IsNullOrWhiteSpace($inputText)) {
            throw 'Provide --text, --file, or pipe input into siftkit.'
        }

        if ($parsed.File) {
            $result = Invoke-SiftSummary -Question $question -InputFile $parsed.File -Format $format -Backend $parsed.Backend -Model $parsed.Model -PolicyProfile $profile
        }
        elseif ($hasPipelineInput) {
            $result = $script:PipelineBuffer | Invoke-SiftSummary -Question $question -Format $format -Backend $parsed.Backend -Model $parsed.Model -PolicyProfile $profile
        }
        else {
            $result = Invoke-SiftSummary -Question $question -Text $inputText -Format $format -Backend $parsed.Backend -Model $parsed.Model -PolicyProfile $profile
        }

        $result.Summary
    }
    'run' {
        $command = if ($parsed.Command) { $parsed.Command } elseif ($parsed.Positionals.Count -gt 0) { $parsed.Positionals[0] } else { throw 'A command is required.' }
        $argList = if ($parsed.ArgList.Count -gt 0) { $parsed.ArgList } elseif ($parsed.Positionals.Count -gt 1) { $parsed.Positionals[1..($parsed.Positionals.Count - 1)] } else { @() }
        $risk = if ($parsed.Risk) { $parsed.Risk } else { 'informational' }
        $reducer = if ($parsed.Reducer) { $parsed.Reducer } else { 'smart' }
        $question = if ($parsed.Question) { $parsed.Question } else { 'Summarize the main result and any actionable failures.' }
        $profile = if ($parsed.Profile) { $parsed.Profile } else { 'general' }
        $format = if ($parsed.Format) { $parsed.Format } else { 'text' }
        $result = Invoke-SiftCommand -Command $command -ArgumentList $argList -Question $question -RiskLevel $risk -ReducerProfile $reducer -Format $format -Backend $parsed.Backend -Model $parsed.Model -PolicyProfile $profile

        if ($result.Summary) {
            $result.Summary
        }
        else {
            'No summary generated.'
        }

        'Raw log: {0}' -f $result.RawLogPath
    }
    'find-files' {
        $patterns = if ($parsed.Positionals.Count -gt 0) { $parsed.Positionals } else { throw 'At least one file name or pattern is required.' }
        $searchPath = if ($parsed.Path) { $parsed.Path } else { '.' }
        $results = Find-SiftFiles -Name $patterns -Path $searchPath -FullPath:$([bool]$parsed.FullPath)

        if ($parsed.FullPath) {
            $results | ForEach-Object { $_.FullPath }
        }
        else {
            $results | ForEach-Object { $_.RelativePath }
        }
    }
    'install' {
        Install-SiftKit | Format-List *
    }
    'test' {
        Test-SiftKit | Format-List *
    }
    'eval' {
        if ($parsed.FixtureRoot) {
            Invoke-SiftEvaluation -FixtureRoot $parsed.FixtureRoot -Backend $parsed.Backend -Model $parsed.Model | Format-List *
        }
        else {
            Invoke-SiftEvaluation -Backend $parsed.Backend -Model $parsed.Model | Format-List *
        }
    }
    'codex-policy' {
        if ($parsed.CodexHome) {
            Install-SiftCodexPolicy -CodexHome $parsed.CodexHome | Format-List *
        }
        else {
            Install-SiftCodexPolicy | Format-List *
        }
    }
    'install-global' {
        $installArgs = @{}
        if ($parsed.BinDir) {
            $installArgs.BinDir = $parsed.BinDir
        }
        if ($parsed.ModuleRoot) {
            $installArgs.ModuleInstallRoot = $parsed.ModuleRoot
        }

        Install-SiftKitShellIntegration @installArgs | Format-List *
    }
    'status-server' {
        $serverScript = Join-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -ChildPath 'siftKitStatus\index.js'
        & node $serverScript
    }
}
