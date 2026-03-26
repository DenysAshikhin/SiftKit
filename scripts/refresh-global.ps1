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

function Install-SiftKitViaShellIntegration {
    $manifestPath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
    Import-Module $manifestPath -Force

    $binDir = Join-Path $env:USERPROFILE 'bin'
    $moduleInstallRoot = Join-Path $env:USERPROFILE '.siftkit\modules'
    if (-not (Test-Path -LiteralPath $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $moduleInstallRoot)) {
        New-Item -ItemType Directory -Path $moduleInstallRoot -Force | Out-Null
    }

    $installResult = Install-SiftKitShellIntegration -BinDir $binDir -ModuleInstallRoot $moduleInstallRoot -Force
    $env:PSModulePath = '{0};{1}' -f $moduleInstallRoot, $env:PSModulePath

    if ($installResult.CmdShim -and (Test-Path -LiteralPath $installResult.CmdShim)) {
        return $installResult.CmdShim
    }

    if ($installResult.PowerShellShim -and (Test-Path -LiteralPath $installResult.PowerShellShim)) {
        return $installResult.PowerShellShim
    }

    throw 'Install-SiftKitShellIntegration completed but no runnable shim was found.'
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

try {
    $tarballName = Get-SiftKitPackageTarballName

    Write-Host 'Packing current repo...'
    Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('pack', '--loglevel', 'error') -Description 'Packing current repo'

    Write-Host 'Installing packed tarball globally...'
    Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('i', '-g', $tarballName, '--force', '--loglevel', 'error') -Description 'Installing packed tarball globally'

    Write-Host 'Resolving freshly installed global siftkit command...'
    $globalSiftKit = Get-GlobalSiftKitCommandPath
}
catch {
    Write-Warning ('npm-based global refresh failed. Falling back to Install-SiftKitShellIntegration. Root cause: {0}' -f $_.Exception.Message)
    $globalSiftKit = Install-SiftKitViaShellIntegration
    Write-Host ('Using fallback global shim: {0}' -f $globalSiftKit)
}

Write-Host 'Running siftkit test...'
& $globalSiftKit test | Out-Host

$siftInput = ((1..25 | ForEach-Object { "INFO step $_ completed successfully" }) + "ERROR database migration failed: duplicate key on users.email") -join "`n"

Write-Host 'Running sample summary...'
& $globalSiftKit summary --question "what is the main problem?" --text $siftInput | Out-Host

Write-Host 'Use the siftkit test output above to verify external llama-server reachability.'
