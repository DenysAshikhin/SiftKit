Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue
if ($existing) {
    $existing | Stop-Process -Force
}

exit 0
