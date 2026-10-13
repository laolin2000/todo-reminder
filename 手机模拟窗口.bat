@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 待办提醒 · 手机模拟窗口
echo 正在打开 390x844 手机模拟窗口(桌面端已运行则自动使用同一数据)…
echo 提示: 关闭模拟窗口即退出本进程; 手机端不在此窗口内测试。
node scripts\phone-sim.mjs
pause
