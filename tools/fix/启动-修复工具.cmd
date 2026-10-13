@echo off
chcp 65001 >nul 2>nul
title TodoReminder Fix Tool
cd /d "D:\toolresources\DSHStool\TodoReminder\tools\fix"
where node >nul 2>nul || (echo [ERROR] node.exe not found. Install Node.js first. & pause & exit /b 1)
node "%~dp0tool.mjs"
echo.
pause
