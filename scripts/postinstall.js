#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

if (!isWindows) {
  process.exit(0);
}

function getShimDir() {
  const prefix = process.env.npm_config_prefix;
  if (prefix) {
    return prefix;
  }

  return path.resolve(packageRoot, 'node_modules', '.bin');
}

function writeFileIfPossible(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (error) {
    console.warn(`[siftkit] Unable to write shim ${filePath}: ${error.message}`);
  }
}

const shimDir = getShimDir();

const powershellShim = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$target=Join-Path $basedir 'node_modules\\siftkit\\bin\\siftkit.ps1'
$ret=0
if ($MyInvocation.ExpectingInput) {
  $summaryMode = ($args.Count -eq 0) -or ($args[0] -eq 'summary') -or ($args[0] -notin @('run', 'find-files', 'install', 'test', 'eval', 'codex-policy', 'install-global'))
  $hasExplicitInput = $args -contains '--text' -or $args -contains '--file'
  if ($summaryMode -and -not $hasExplicitInput) {
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
      ($input | ForEach-Object { [string]$_ }) -join [Environment]::NewLine | Set-Content -LiteralPath $tempFile -Encoding UTF8
      & powershell.exe -ExecutionPolicy Bypass -File $target @args --file $tempFile
    } finally {
      if (Test-Path -LiteralPath $tempFile) {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
      }
    }
  } else {
    & powershell.exe -ExecutionPolicy Bypass -File $target @args
  }
} else {
  & powershell.exe -ExecutionPolicy Bypass -File $target @args
}
$ret=$LASTEXITCODE
exit $ret
`;

const cmdShim = `@ECHO off
powershell.exe -ExecutionPolicy Bypass -File "%~dp0\\node_modules\\siftkit\\bin\\siftkit.ps1" %*
`;

writeFileIfPossible(path.join(shimDir, 'siftkit.ps1'), powershellShim);
writeFileIfPossible(path.join(shimDir, 'siftkit.cmd'), cmdShim);
