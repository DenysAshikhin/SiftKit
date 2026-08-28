[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function ConvertTo-ProcessArgumentString {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    $escaped = foreach ($argument in $ArgumentList) {
        if ($argument -match '[\s"]') {
            '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
        }
        else {
            $argument
        }
    }

    $escaped -join ' '
}

function Resolve-CommandFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        if ($command.Source) {
            return $command.Source
        }
        if ($command.Path) {
            return $command.Path
        }
    }

    throw ('Unable to resolve command path for {0}.' -f $Name)
}

function Get-SiftKitNpmCachePath {
    $cachePath = Join-Path $PSScriptRoot '..\.npm-cache'
    if (-not (Test-Path -LiteralPath $cachePath)) {
        New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
    }

    (Resolve-Path -LiteralPath $cachePath).Path
}

function Invoke-RetryableCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,
        [string]$Description = $FilePath,
        [int]$MaxAttempts = 4,
        [int]$DelaySeconds = 2
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Write-Host ('{0} (attempt {1}/{2})...' -f $Description, $attempt, $MaxAttempts)

        $resolvedFilePath = Resolve-CommandFilePath -Name $FilePath
        $previousNpmCache = $env:npm_config_cache
        $outputLines = @()
        try {
            $env:npm_config_cache = Get-SiftKitNpmCachePath
            Push-Location $script:RepoRoot
            try {
                $previousErrorActionPreference = $ErrorActionPreference
                $hasNativeErrorPreference = Test-Path Variable:\PSNativeCommandUseErrorActionPreference
                if ($hasNativeErrorPreference) {
                    $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
                }
                try {
                    $ErrorActionPreference = 'Continue'
                    if ($hasNativeErrorPreference) {
                        $PSNativeCommandUseErrorActionPreference = $false
                    }
                    $outputLines = & $resolvedFilePath @ArgumentList 2>&1
                    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
                }
                finally {
                    if ($hasNativeErrorPreference) {
                        $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
                    }
                    $ErrorActionPreference = $previousErrorActionPreference
                }
            }
            finally {
                Pop-Location
            }
        }
        finally {
            if ($null -eq $previousNpmCache) {
                Remove-Item Env:\npm_config_cache -ErrorAction SilentlyContinue
            }
            else {
                $env:npm_config_cache = $previousNpmCache
            }
        }

        $stdout = ($outputLines | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        $stderr = ($outputLines | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine

        if ($stdout) {
            $stdout | Out-Host
        }
        if ($stderr) {
            $stderr | Out-Host
        }

        if ($exitCode -eq 0) {
            return
        }

        $joinedOutput = (@($stdout, $stderr) | Where-Object { $_ }) -join [Environment]::NewLine
        $isRetryableLockError = $joinedOutput -match '\bEPERM\b' -or $joinedOutput -match 'operation not permitted' -or $joinedOutput -match 'file was already in use'
        if (-not $isRetryableLockError -or $attempt -eq $MaxAttempts) {
            throw ('{0} failed with exit code {1}.{2}{3}' -f $Description, $exitCode, [Environment]::NewLine, $joinedOutput)
        }

        Write-Host ('Retrying after {0}s because npm reported a Windows file lock / EPERM condition.' -f $DelaySeconds)
        Start-Sleep -Seconds $DelaySeconds
    }
}

function Get-SiftKitPackageTarballName {
    $package = Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
    $packageName = $package.name -replace '^@', '' -replace '/', '-'
    '{0}-{1}.tgz' -f $packageName, $package.version
}

function Get-GlobalSiftKitCommandPath {
    $globalPrefix = (npm prefix -g 2>$null | Select-Object -First 1).ToString().Trim()
    if (-not $globalPrefix) {
        throw 'Unable to determine npm global prefix.'
    }

    $candidatePaths = @(
        (Join-Path $globalPrefix 'siftkit.cmd'),
        (Join-Path $globalPrefix 'siftkit.ps1')
    )

    foreach ($candidatePath in $candidatePaths) {
        if (Test-Path -LiteralPath $candidatePath) {
            return $candidatePath
        }
    }

    throw ('Unable to locate the global siftkit shim under {0}.' -f $globalPrefix)
}

function Stop-ExistingGlobalSiftKitStatusServer {
    $globalPrefix = (npm prefix -g 2>$null | Select-Object -First 1).ToString().Trim()
    if (-not $globalPrefix) {
        return
    }

    $globalPackageRoot = Join-Path $globalPrefix 'node_modules\siftkit'
    $statusServerPath = Join-Path $globalPackageRoot 'dist\status-server\main.js'
    $normalizedStatusServerPath = [System.IO.Path]::GetFullPath($statusServerPath).ToLowerInvariant()
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = [string]$_.CommandLine
        $commandLine.ToLowerInvariant().Contains($normalizedStatusServerPath)
    })

    foreach ($process in $processes) {
        Write-Host ('Stopping existing global SiftKit status server process {0} before npm global refresh.' -f $process.ProcessId)
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
}

function Get-SiftKitDesktopToolingRoot {
    if ($env:SIFTKIT_TOOLING_ROOT) {
        return $env:SIFTKIT_TOOLING_ROOT
    }

    Join-Path (Split-Path $script:RepoRoot -Parent) '.tooling\siftkit-gate-d'
}

$tarballName = Get-SiftKitPackageTarballName

# Reconcile node_modules and the hidden node_modules/.package-lock.json before packing.
# Workspace package.json edits (e.g. dashboard) leave that lockfile stale, which drops the
# @siftkit/contracts workspace link's resolved target and makes `npm pack` crash inside
# npm-packlist with a silent exit 1 while gathering bundleDependencies.
Write-Host 'Reconciling workspace install before packing...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('install', '--loglevel', 'error') -Description 'Reconciling workspace install'

$cargoTauriPath = Join-Path (Get-SiftKitDesktopToolingRoot) 'cargo\bin\cargo-tauri.exe'
if (-not (Test-Path -LiteralPath $cargoTauriPath)) {
    Write-Host 'Portable Rust toolchain missing; installing...'
    Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop:install-toolchain') -Description 'Installing the desktop Rust toolchain' -MaxAttempts 1
}

Write-Host 'Building the desktop shell...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop:build') -Description 'Building the desktop shell' -MaxAttempts 1

Write-Host 'Packing current repo...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('pack', '--workspaces=false', '--loglevel', 'error') -Description 'Packing current repo'

Stop-ExistingGlobalSiftKitStatusServer

Write-Host 'Installing packed tarball globally...'
Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('i', '-g', $tarballName, '--force', '--loglevel', 'error') -Description 'Installing packed tarball globally'

Write-Host 'Resolving freshly installed global siftkit command...'
$globalSiftKit = Get-GlobalSiftKitCommandPath

Write-Host 'Running public CLI smoke checks...'
& $globalSiftKit --help | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw ('Global siftkit --help failed with exit code {0}.' -f $LASTEXITCODE)
}

& $globalSiftKit repo-search --help | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw ('Global siftkit repo-search --help failed with exit code {0}.' -f $LASTEXITCODE)
}

Write-Host 'Verifying double-quote round-trip through the PowerShell shim...'
$globalPrefix = (npm prefix -g 2>$null | Select-Object -First 1).ToString().Trim()
$psShimPath = Join-Path $globalPrefix 'siftkit.ps1'
$probeArgument = 'quote-probe "with quotes"'
$probeJson = (& $psShimPath argv-probe $probeArgument | Out-String).Trim()
$probeExitCode = $LASTEXITCODE
$probeResult = $probeJson | ConvertFrom-Json
if ($probeExitCode -ne 0 -or @($probeResult.argv).Count -ne 1 -or $probeResult.argv[0] -ne $probeArgument) {
    throw ('Double-quote round-trip failed through {0}. Output: {1}' -f $psShimPath, $probeJson)
}

# PATH bash.exe is often the WSL stub; resolve Git Bash from the git install instead.
function Get-GitBashPath {
    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gitCommand -or -not $gitCommand.Source) {
        return $null
    }
    $gitRoot = Split-Path (Split-Path $gitCommand.Source -Parent) -Parent
    $bashPath = Join-Path $gitRoot 'bin\bash.exe'
    if (Test-Path -LiteralPath $bashPath) {
        return $bashPath
    }
    $null
}

$gitBashPath = Get-GitBashPath
if ($gitBashPath) {
    Write-Host 'Verifying the Git Bash sh shim and its double-quote round-trip...'
    $shShimBashPath = (Join-Path $globalPrefix 'siftkit') -replace '\\', '/'
    $bashScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ('siftkit-shim-probe-{0}.sh' -f [guid]::NewGuid().ToString('N'))
    try {
        Set-Content -LiteralPath $bashScriptPath -Encoding Ascii -Value ('"{0}" argv-probe "quote-probe \"with quotes\""' -f $shShimBashPath)
        $bashProbeJson = (& $gitBashPath $bashScriptPath | Out-String).Trim()
        $bashProbeExitCode = $LASTEXITCODE
        $bashProbeResult = $bashProbeJson | ConvertFrom-Json
        if ($bashProbeExitCode -ne 0 -or $bashProbeResult.argv[0] -ne $probeArgument) {
            throw ('Git Bash double-quote round-trip failed through {0}. Output: {1}' -f $shShimBashPath, $bashProbeJson)
        }
    }
    finally {
        Remove-Item -LiteralPath $bashScriptPath -Force -ErrorAction SilentlyContinue
    }
}
else {
    Write-Host 'Git Bash not found; skipped the Git Bash shim check.'
}

Write-Host 'Global siftkit public CLI smoke checks passed.'
