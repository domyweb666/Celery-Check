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
set OPENFLAG=--open
:run
node server\index.js %OPENFLAG%
set CODE=%errorlevel%
set OPENFLAG=
rem 0 = closed normally, 3 = already running. Anything else: it stopped unexpectedly, restart.
if "%CODE%"=="0" goto end
if "%CODE%"=="3" goto end
echo.
echo   [%date% %time%] Celery-Check stopped (code %CODE%). Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto run
:end
echo.
pause
