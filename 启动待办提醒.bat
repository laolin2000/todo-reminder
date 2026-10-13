@echo off
rem ===== 待办提醒 一键启动(Windows) =====
rem 启动后最小化按钮收进托盘; 关闭窗口=最小化到托盘(提醒继续)
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
exit
