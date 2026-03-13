@echo off
if exist "%~dp0siftkit.ps1" (
  powershell -ExecutionPolicy Bypass -File "%~dp0siftkit.ps1" %*
  exit /b %errorlevel%
)

node "%~dp0siftkit.js" %*
