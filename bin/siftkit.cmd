@echo off
if exist "%~dp0siftkit.ps1" (
  powershell -ExecutionPolicy Bypass -File "%~dp0siftkit.ps1" %*
) else (
  node "%~dp0..\src\cli\main.ts" %*
)
exit /b %errorlevel%
rem cmd expands %errorlevel% when it reads a block, so it is read only after the block has run.
