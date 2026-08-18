@echo off
setlocal
chcp 65001 >nul
title dsh-KazMode 诊断
echo ============================================
echo   dsh-KazMode 只读诊断
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Diagnose
echo.
pause
endlocal
