@echo off
setlocal
cd /d "%~dp0"
call "%~dp0INSTALL.bat"
exit /b %errorlevel%
