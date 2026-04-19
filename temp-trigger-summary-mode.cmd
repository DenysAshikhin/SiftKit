@echo off
REM =====================================================================
REM TEMP SCRIPT - safe to delete after use
REM Purpose: Trigger SiftKit planner / oversized-input summary mode.
REM Feeds ~1.09 MB (>200k tokens) of real repo TypeScript source into
REM `siftkit summary` so the input length exceeds the planner activation
REM threshold defined in src/summary/chunking.ts (getPlannerActivation-
REM ThresholdCharacters).
REM =====================================================================
setlocal

set "REPO_ROOT=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -Path (Join-Path '%REPO_ROOT%' 'src') -Recurse -Filter *.ts | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }" ^
  | siftkit summary --question "Summarize the SiftKit architecture: for each module under src/, list the primary exported function(s) with file:line anchors and a one-line purpose."

endlocal
