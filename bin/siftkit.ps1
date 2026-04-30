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

function Get-SiftTsCliPath {
    $module = Get-Module SiftKit
    if (-not $module) {
        throw 'SiftKit module is not loaded.'
    }

    $candidatePaths = @(
        (Join-Path -Path (Split-Path -Path $module.ModuleBase -Parent) -ChildPath 'dist\cli\index.js'),
        (Join-Path -Path $module.ModuleBase -ChildPath 'dist\cli\index.js'),
        (Join-Path -Path (Split-Path -Path $module.ModuleBase -Parent) -ChildPath 'dist\cli\dispatch.js'),
        (Join-Path -Path $module.ModuleBase -ChildPath 'dist\cli\dispatch.js')
    )

    foreach ($candidate in $candidatePaths) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    throw ('TS CLI entrypoint not found. Checked: {0}. Run npm run build.' -f ($candidatePaths -join '; '))
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
    $cliPath = Get-SiftTsCliPath
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
    & node $cliPath @forwardedArgs
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
