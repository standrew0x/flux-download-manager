@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup Browser Capture.ps1"
if errorlevel 1 (
  echo.
  echo Browser Capture setup could not be opened.
  pause
  exit /b 1
)
exit /b 0
