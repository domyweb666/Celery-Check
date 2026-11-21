@echo off
chcp 65001 >nul
title 芹查（關掉這個視窗就會停止）
cd /d "%~dp0desktop"
if not exist node_modules (
  echo.
  echo   第一次使用，請先雙擊「安裝芹查.cmd」。
  echo.
  pause
  exit /b 1
)
node server\index.js --open
echo.
echo   芹查已停止。
pause
