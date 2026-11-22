@echo off
rem Celery-Check installer. Keep this file ASCII-only: cmd.exe mis-reads lines that contain Chinese.
cd /d "%~dp0desktop"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Please install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
node tools\install.js
echo.
pause
