@echo off
rem Launcher for the whale balance pet (browser tab mode).
rem Keep this file pure ASCII: cmd.exe does not re-read the batch file after
rem a `chcp 65001`, so non-ASCII text here would be mojibake or even parsed as
rem a bogus command. All user-facing messages live in tools\start.ps1 instead.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start.ps1" -Mode tab
endlocal
