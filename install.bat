@echo off
setlocal
chcp 65001 >nul
title dsh-KazMode Installer
echo ============================================
echo   dsh-KazMode 一键安装
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [失败] 安装未完成，请把上方红色错误信息发给作者。
) else (
  echo [完成] 请重启 dsh 并强刷页面 ^(Ctrl+F5^)，然后选「Kaz 模式」预设。
)
echo.
pause
endlocal
