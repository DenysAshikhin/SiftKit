#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$target=Join-Path $basedir 'node_modules\siftkit\bin\siftkit.ps1'
$ret=0
if ($MyInvocation.ExpectingInput) {
  $siftText = ($input | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  & powershell.exe -ExecutionPolicy Bypass -File $target @args --text $siftText
} else {
  & powershell.exe -ExecutionPolicy Bypass -File $target @args
}
$ret=$LASTEXITCODE
exit $ret
