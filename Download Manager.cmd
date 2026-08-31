@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start Flux.ps1"
if errorlevel 1 (
  echo.
  echo Flux could not start. The error is shown above.
  echo Startup logs: %%LOCALAPPDATA%%\Flux Download Manager\logs
  pause
  exit /b 1
)
exit /b 0
