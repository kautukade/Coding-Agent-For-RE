@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not available. Run INSTALL.bat first.
  pause
  exit /b 1
)
node "%~dp0dashboard\server.mjs" --open
if errorlevel 1 (
  echo.
  echo Dashboard failed to start.
  pause
)
