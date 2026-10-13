$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\todo-firewall-result.txt"
try {
    $existing = netsh advfirewall firewall show rule name="TodoReminder-8790" 2>$null | Select-String "TodoReminder-8790"
    if ($existing) {
        "RULE-ALREADY" | Out-File -FilePath $log -Encoding utf8
    } else {
        $out = netsh advfirewall firewall add rule name="TodoReminder-8790" dir=in action=allow protocol=TCP localport=8790 profile=any 2>&1
        ($out | Out-String) | Out-File -FilePath $log -Encoding utf8
    }
    $check = netsh advfirewall firewall show rule name="TodoReminder-8790" 2>&1 | Out-String
    ("CHECK:`n" + $check) | Out-File -FilePath $log -Append -Encoding utf8
} catch {
    ("ERR: " + $_.Exception.Message) | Out-File -FilePath $log -Encoding utf8
}
