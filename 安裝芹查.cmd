@echo off
chcp 65001 >nul
title 安裝芹查
cd /d "%~dp0desktop"

echo.
echo   ==== 安裝芹查（電腦端）====
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   找不到 Node.js。請先到 https://nodejs.org 下載安裝 LTS 版，裝好後重新執行這個檔案。
  echo.
  pause
  exit /b 1
)

echo   [1/3] 安裝需要的套件…
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   套件安裝失敗。請確認網路正常後再試一次。
  pause
  exit /b 1
)

echo.
echo   [2/3] 把芹查加到 Claude Code…
where claude >nul 2>nul
if errorlevel 1 (
  echo   沒找到 claude 指令，先跳過。之後到芹查的「設定」頁複製指令，貼到命令提示字元執行即可。
) else (
  call claude mcp remove celery-check --scope user >nul 2>nul
  call claude mcp add celery-check --scope user -- node "%~dp0desktop\server\mcp.js"
  if errorlevel 1 (
    echo   加入失敗。之後到芹查的「設定」頁複製指令手動執行。
  ) else (
    echo   完成。之後在任何專案打開 Claude Code，都能用芹查的工具。
  )
)

echo.
echo   [3/3] 在桌面建立「芹查」捷徑…
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\芹查.lnk'); $s.TargetPath='%~dp0啟動芹查.cmd'; $s.WorkingDirectory='%~dp0'; $s.Save()" >nul 2>nul
if errorlevel 1 (
  echo   建立捷徑失敗，直接雙擊資料夾裡的「啟動芹查.cmd」也一樣。
) else (
  echo   完成。
)

echo.
echo   全部裝好了。雙擊桌面的「芹查」就能開始用。
echo   第一次啟動時 Windows 會問要不要讓 Node.js 通過防火牆，請勾「私人網路」並按允許，手機才連得到。
echo.
pause
