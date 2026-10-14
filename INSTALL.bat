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
echo Please keep this window open until setup finishes.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
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

exit /b 0
