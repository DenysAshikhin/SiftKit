[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Write-Host 'Uninstalling global siftkit...'
npm uninstall -g siftkit | Out-Host

Write-Host 'Installing current repo globally...'
npm i -g . --force | Out-Host

Write-Host 'Running siftkit test...'
siftkit test | Out-Host

$siftInput = ((1..25 | ForEach-Object { "INFO step $_ completed successfully" }) + "ERROR database migration failed: duplicate key on users.email") -join "`n"

Write-Host 'Running sample summary...'
siftkit summary --question "what is the main problem?" --text $siftInput | Out-Host

Write-Host 'Showing loaded Ollama model state...'
ollama ps | Out-Host
