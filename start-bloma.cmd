@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js first.
  pause
  exit /b 1
)
node scripts\start.mjs %*
set "BLOMA_EXIT_CODE=%ERRORLEVEL%"
if not "%BLOMA_EXIT_CODE%"=="0" pause
exit /b %BLOMA_EXIT_CODE%
