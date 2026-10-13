# 开放防火墙入站端口(供手机访问同步服务器/下载 APK)。需以管理员运行:
#   powershell -ExecutionPolicy Bypass -File scripts\open-firewall.ps1 [-Port 8790]
param([int]$Port = 8790)
$name = "TodoReminder-$Port"
$rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($rule) {
    Write-Host "规则已存在: $name"
} else {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private,Domain | Out-Null
    Write-Host "已开放 TCP $Port (名称 $name)"
}
Write-Host "说明: 仅当手机连不上时才需要(首次允许弹窗选择“允许”即可)。"
