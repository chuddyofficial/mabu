@echo off
rem Double-click to put MABU live on your Linux server (see deploy-windows.ps1).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-windows.ps1" %*
echo.
pause
