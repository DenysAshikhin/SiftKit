$CliArgs = @($args)
$ErrorActionPreference = 'Stop'
$script:PipelineBuffer = New-Object System.Collections.Generic.List[object]

function Import-SiftKitCliModule {
    $localManifest = Join-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -ChildPath 'SiftKit\SiftKit.psd1'
    if (Test-Path -LiteralPath $localManifest) {
        Import-Module $localManifest -Force
        return
    }

    $available = Get-Module -ListAvailable -Name SiftKit | Sort-Object Version -Descending | Select-Object -First 1
    if ($available) {
        Import-Module $available.Path -Force
        return
    }

    throw 'SiftKit module could not be located. Import the module or run Install-SiftKitShellIntegration first.'
}

function Get-SiftCliPath {
    $module = Get-Module SiftKit
    if (-not $module) {
        throw 'SiftKit module is not loaded.'
    }

    $cliPath = Join-Path -Path (Split-Path -Path $module.ModuleBase -Parent) -ChildPath 'dist\cli\main.js'
    if (-not (Test-Path -LiteralPath $cliPath)) {
        throw ('TS CLI entrypoint not found: {0}. Run npm run build.' -f $cliPath)
    }
    $cliPath
}

function Get-SiftCommandName {
    param(
        [string[]]$Args
    )

    $knownCommands = @('summary', 'run', 'find-files', 'install', 'test', 'eval', 'codex-policy', 'install-global', 'config-get', 'config-set', 'capture-internal', 'internal')
    if ($Args.Count -gt 0 -and $Args[0] -in $knownCommands) {
        return $Args[0]
    }

    'summary'
}

function Test-SiftSummaryHasExplicitInput {
    param(
        [string[]]$Args
    )

    $Args -contains '--text' -or $Args -contains '--file'
}

function ConvertTo-SiftNativeArguments {
    param(
        [string[]]$Arguments
    )

    # PowerShell engines with legacy native argument passing (Windows PowerShell 5.1,
    # PowerShell < 7.2) wrap whitespace-bearing arguments in quotes but never escape
    # embedded quotes or trailing backslashes, so node receives a mangled argv.
    # Pre-escape per the MSVCRT parsing rules. Newer engines with Standard/Windows
    # argument passing escape correctly themselves and must not be double-escaped.
    $legacyPassing = -not (Test-Path Variable:\PSNativeCommandArgumentPassing) `
        -or $PSNativeCommandArgumentPassing -eq 'Legacy'
    if (-not $legacyPassing) {
        return ,@($Arguments)
    }

    $escaped = @(foreach ($argument in $Arguments) {
        $value = [string]$argument -replace '(\\*)"', '$1$1\"'
        if ($value -match '\s') {
            $value = $value -replace '(\\+)$', '$1$1'
        }
        $value
    })
    ,$escaped
}

function Invoke-SiftModuleHelper {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,
        [object[]]$ArgumentList = @()
    )

    $module = Get-Module SiftKit
    if (-not $module) {
        throw 'SiftKit module is not loaded.'
    }

    & ($module.NewBoundScriptBlock($ScriptBlock)) @ArgumentList
}

Import-SiftKitCliModule

if ($MyInvocation.ExpectingInput) {
    foreach ($item in $input) {
        if ($item -isnot [string] -or $item.Length -gt 0) {
            [void]$script:PipelineBuffer.Add($item)
        }
    }
}

$commandName = Get-SiftCommandName -Args $CliArgs
$forwardedArgs = @($CliArgs)
$tempInputPath = $null

if ($script:PipelineBuffer.Count -gt 0 -and $commandName -eq 'summary' -and -not (Test-SiftSummaryHasExplicitInput -Args $CliArgs)) {
    $pipelineText = Invoke-SiftModuleHelper -ScriptBlock {
        param($PipelineBuffer)
        Convert-SiftPipelineBufferToText -PipelineBuffer $PipelineBuffer
    } -ArgumentList (, $script:PipelineBuffer)

    $tempInputPath = Invoke-SiftModuleHelper -ScriptBlock {
        param($Content)
        New-SiftTempTextFile -Content $Content -Prefix 'siftkit_cli'
    } -ArgumentList @($pipelineText)

    if ($CliArgs.Count -gt 1 -and $CliArgs[0] -eq 'summary') {
        $forwardedArgs = @('summary', '--file', $tempInputPath) + $CliArgs[1..($CliArgs.Count - 1)]
    }
    elseif ($CliArgs.Count -eq 1 -and $CliArgs[0] -eq 'summary') {
        $forwardedArgs = @('summary', '--file', $tempInputPath)
    }
    else {
        $forwardedArgs = @('summary', '--file', $tempInputPath) + $CliArgs
    }
}

try {
    $cliPath = Get-SiftCliPath
    $previousSourceKind = $env:SIFTKIT_SUMMARY_SOURCE_KIND
    $previousCommandExitCode = $env:SIFTKIT_SUMMARY_COMMAND_EXIT_CODE
    if ($tempInputPath) {
        $env:SIFTKIT_SUMMARY_SOURCE_KIND = 'command-output'
        if ($LASTEXITCODE -ne $null) {
            $env:SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = [string]$LASTEXITCODE
        }
        else {
            $env:SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = '0'
        }
    }
    $nativeArgs = ConvertTo-SiftNativeArguments -Arguments @($forwardedArgs)
    & node $cliPath @nativeArgs
    exit $LASTEXITCODE
}
finally {
    if ($null -eq $previousSourceKind) {
        Remove-Item Env:\SIFTKIT_SUMMARY_SOURCE_KIND -ErrorAction SilentlyContinue
    }
    else {
        $env:SIFTKIT_SUMMARY_SOURCE_KIND = $previousSourceKind
    }
    if ($null -eq $previousCommandExitCode) {
        Remove-Item Env:\SIFTKIT_SUMMARY_COMMAND_EXIT_CODE -ErrorAction SilentlyContinue
    }
    else {
        $env:SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = $previousCommandExitCode
    }
    if ($tempInputPath -and (Test-Path -LiteralPath $tempInputPath)) {
        Remove-Item -LiteralPath $tempInputPath -Force -ErrorAction SilentlyContinue
    }
}
