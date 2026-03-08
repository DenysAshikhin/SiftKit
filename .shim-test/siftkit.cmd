@ECHO off
powershell.exe -ExecutionPolicy Bypass -File "%~dp0\node_modules\siftkit\bin\siftkit.ps1" %*
