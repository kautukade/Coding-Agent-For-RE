@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RE Coding Agent - One Click Installer

if /I "%~1"=="--elevated" goto :RUN

net session >nul 2>&1
if %errorlevel%==0 goto :RUN

echo Requesting Administrator permission...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -WorkingDirectory '%~dp0' -Verb RunAs"
exit /b

:RUN
cls
echo ============================================================
echo  RE Coding Agent - Automatic Installer
echo ============================================================
echo.
echo Everything will be installed and configured automatically.
echo After setup, the local Dashboard will open in your browser.
echo Please keep this window open until setup finishes.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -NoLaunch
set "EXITCODE=%errorlevel%"

if not "%EXITCODE%"=="0" (
    echo.
    echo ============================================================
    echo  INSTALLATION FAILED
    echo ============================================================
    echo Check the log shown above.
    pause
    exit /b %EXITCODE%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dashboard-install.ps1"
if errorlevel 1 (
    echo Dashboard post-install setup reported a problem.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  INSTALLATION COMPLETE
 echo  Opening RE Coding Agent Dashboard...
echo ============================================================
start "" "%~dp0DASHBOARD.bat"
exit /b 0
