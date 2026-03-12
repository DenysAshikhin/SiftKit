$ErrorActionPreference = 'Stop'
Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
Remove-Item Env:\SIFTKIT_STATUS_PATH -ErrorAction SilentlyContinue
Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
Import-Module 'C:\Users\denys\Documents\GitHub\SiftKit\SiftKit\SiftKit.psd1' -Force
$env:USERPROFILE = 'C:\Users\denys\Documents\GitHub\SiftKit\tests\.debug-concurrent-home'
$env:SIFTKIT_TEST_PROVIDER = 'mock'
$env:SIFTKIT_LOCK_TIMEOUT_MS = '5000'
$env:SIFTKIT_TEST_PROVIDER_SLEEP_MS = '0'
$commandScript = "Start-Sleep -Milliseconds 150; Write-Output 'cmd-1 stdout'"
$result = Invoke-SiftCommand -Command 'powershell.exe' -ArgumentList '-NoProfile', '-Command', $commandScript -Question 'what failed?' -RiskLevel informational -NoSummarize
[ordered]@{ Token='cmd-1'; ExitCode=$result.ExitCode; RawLogPath=$result.RawLogPath; ReducedLogPath=$result.ReducedLogPath } | ConvertTo-Json -Compress -Depth 5
