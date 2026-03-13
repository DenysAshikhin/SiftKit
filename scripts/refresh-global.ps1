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
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $resolvedFilePath
        $psi.Arguments = ConvertTo-ProcessArgumentString -ArgumentList $ArgumentList
        $psi.WorkingDirectory = $script:RepoRoot
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.EnvironmentVariables['npm_config_cache'] = Get-SiftKitNpmCachePath

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            $process.Dispose()
        }

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

function Stop-RunningOllamaModels {
    $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollamaCommand) {
        Write-Host 'Ollama not found. Skipping model stop step.'
        return
    }

    $loadedModels = @(
        & ollama ps 2>$null |
            Select-Object -Skip 1 |
            ForEach-Object {
                $line = $_.ToString().Trim()
                if (-not $line) {
                    return
                }

                ($line -split '\s{2,}')[0].Trim()
            } |
            Where-Object { $_ } |
            Select-Object -Unique
    )

    if ($loadedModels.Count -eq 0) {
        Write-Host 'No running Ollama models to stop.'
        return
    }

    Write-Host ('Stopping running Ollama models: {0}' -f ($loadedModels -join ', '))
    foreach ($model in $loadedModels) {
        & ollama stop $model | Out-Host
    }
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

Write-Host 'Stopping running Ollama models...'
Stop-RunningOllamaModels

try {
    $tarballName = Get-SiftKitPackageTarballName

    Write-Host 'Packing current repo...'
    Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('pack') -Description 'Packing current repo'

    Write-Host 'Installing packed tarball globally...'
    Invoke-RetryableCommand -FilePath 'npm.cmd' -ArgumentList @('i', '-g', $tarballName, '--force') -Description 'Installing packed tarball globally'

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

$ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaCommand) {
    Write-Host 'Showing loaded Ollama model state...'
    & $ollamaCommand.Source ps | Out-Host
}
else {
    Write-Host 'Ollama not found. Skipping loaded model state.'
}
