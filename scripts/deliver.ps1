# ============================================================
# deliver.ps1 —— 把任意文件投递到「待办提醒」的 /dl/ 公开下载目录
#   用途: 电脑上生成的文件(文稿/PDF/APK/图片/压缩包…)一键给手机取走
#   公开地址: http://100.119.164.72:8790/dl/   (Tailscale IP, 手机可直连)
#   用法:
#     .\deliver.ps1 <文件路径> [更多文件...]
#     .\deliver.ps1 -Ascii <文件路径>        # 复制成 ASCII 文件名(避免手机端中文名乱码)
#     .\deliver.ps1 -List                    # 只列出当前 /dl/ 内容与地址
#   注意: /dl/ 是免鉴权目录, 不要投递含隐私的文件(局域网/Tailscale 内可见)
# ============================================================
[CmdletBinding()]
param(
  [switch]$Ascii,
  [switch]$List,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'
$DlDir   = Join-Path $env:APPDATA '待办提醒\downloads'
$PublicHost = '100.119.164.72'
$Port    = 8790

if (-not (Test-Path $DlDir)) { throw "找不到 /dl/ 目录: $DlDir (待办提醒桌面端可能未运行过)" }

function Show-Url([string]$name) {
  'http://{0}:{1}/dl/{2}' -f $PublicHost, $Port, [uri]::EscapeDataString($name)
}

if ($List) {
  "DL 目录: $DlDir"
  "公开列表: http://${PublicHost}:${Port}/dl/"
  ''
  Get-ChildItem $DlDir -File | Sort-Object LastWriteTime -Descending |
    Select-Object @{n='文件';e={$_.Name}}, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}, LastWriteTime |
    Format-Table -AutoSize
  return
}

if (-not $Paths -or $Paths.Count -eq 0) { throw "用法: .\deliver.ps1 <文件路径> [...]  |  .\deliver.ps1 -List" }

$done = @()
foreach ($p in $Paths) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Warning "跳过(不存在): $p"; continue }
  $item = Get-Item -LiteralPath $p
  if ($item.PSIsContainer) { Write-Warning "跳过(是目录): $p"; continue }

  $name = $item.Name
  if ($Ascii) {
    $safe = $name -replace '[^\x20-\x7E]', ''
    $safe = ($safe -replace '[\\/:*?"<>|]', '_').Trim()
    if (-not $safe) { $safe = 'file' }
    if ($safe -notmatch '\.') { $safe += $item.Extension }
    $name = $safe
  }

  $dest = Join-Path $DlDir $name
  Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
  $st = Get-Item -LiteralPath $dest
  if ($st.Length -ne $item.Length) { throw "复制后大小不一致: $name" }

  $done += [pscustomobject]@{
    文件 = $name
    KB   = [math]::Round($st.Length / 1KB, 1)
    URL  = (Show-Url $name)
  }
}

if ($done.Count -eq 0) { throw "没有文件被投递" }
''
'投递完成, 手机/浏览器可直接打开:'
$done | Format-Table -AutoSize -Wrap
''
"列表页: http://${PublicHost}:${Port}/dl/"
