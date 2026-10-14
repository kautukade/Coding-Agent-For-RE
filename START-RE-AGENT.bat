@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RE Coding Agent

if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -ProjectPath "%~1"
)

exit /b %errorlevel%
