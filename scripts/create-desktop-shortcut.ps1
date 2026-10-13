<#
  在桌面创建(或重建)「待办提醒」快捷方式 —— 双击即可打开本软件。
  用法: 右键“使用 PowerShell 运行”, 或在项目目录执行:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1
  说明:
    · 目标 = 项目内置的 electron.exe, 参数 = 项目目录(用引号包住, 避免中文路径出错)
    · 图标 = assets\app.ico(不存在时由 scripts\make-app-icon.mjs 自动生成)
    · 已存在同名快捷方式会直接覆盖, 不会重复创建
#>
$ErrorActionPreference = 'Stop'

# 项目根 = 本脚本所在目录的上一级
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "找不到 electron.exe: $exe(请先在项目目录执行 npm install)" }

$ico = Join-Path $root 'assets\app.ico'
if (-not (Test-Path $ico)) {
  Write-Host '图标不存在, 正在生成 assets\app.ico …'
  & node (Join-Path $root 'scripts\make-app-icon.mjs')
}

$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '待办提醒.lnk'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.Arguments = '"' + $root + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = $ico + ',0'
$sc.Description = '待办提醒 · 待办/课表/时段提醒(双击打开)'
$sc.WindowStyle = 1
$sc.Save()

Write-Host ('已创建桌面快捷方式: ' + $lnk)
Write-Host ('  目标: ' + $exe)
Write-Host ('  参数: "' + $root + '"')
Write-Host ('  图标: ' + $ico)
