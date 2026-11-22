@echo off
rem Celery-Check launcher. Keep this file ASCII-only: cmd.exe mis-reads lines that contain Chinese.
title Celery-Check
cd /d "%~dp0desktop"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Please install the LTS version from https://nodejs.org first.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  node tools\install.js
)
node server\index.js --open
echo.
pause
