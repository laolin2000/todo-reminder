# ============================================================
# build-apk.ps1 — 安卓 APK 构建(等用户指令再运行)
# 自动准备: JDK17(如缺) → Android SDK(如缺) → Gradle → assembleDebug
# 产物: <项目>\dl\todo-reminder-vX.Y.Z.apk
#   之后手机浏览器打开 http://<电脑地址>:8790/dl 即可下载安装
# 用法: 右键“使用 PowerShell 运行”或:
#   powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 默认不启用 TLS1.2, 导致 https 下载失败
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AndroidDir  = Join-Path $ProjectRoot 'android'
$DlDir       = Join-Path $ProjectRoot 'dl'
$ToolsRoot   = Join-Path $env:USERPROFILE '.todo-tools'
New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $DlDir | Out-Null

function Log($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Find-Java17 {
    # 依次检查: JAVA_HOME / PATH / 常见安装位置
    $cands = @()
    if ($env:JAVA_HOME) { $cands += Join-Path $env:JAVA_HOME 'bin\java.exe' }
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    $cands += "$env:ProgramFiles\Eclipse Adoptium\*\bin\java.exe"
    $cands += "$env:ProgramFiles\Java\*\bin\java.exe"
    $cands += "$env:ProgramFiles\Microsoft\jdk-*\bin\java.exe"
    foreach ($c in $cands) {
        $res = Get-Item $c -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $res) { continue }
        $ver = & $res.FullName -version 2>&1 | Select-Object -First 1
        if ($ver -match 'version "(\d+)') {
            if ([int]$Matches[1] -ge 17) { return $res.FullName }
        }
    }
    return $null
}

function Install-TemurinJdk17 {
    $dest = Join-Path $ToolsRoot 'jdk17'
    if (Test-Path (Join-Path $dest 'bin\java.exe')) { return (Join-Path $dest 'bin\java.exe') }
    Log '未找到 JDK17+, 下载 Temurin 17(约 180MB, 请稍候)…'
    $zip = Join-Path $ToolsRoot 'jdk17.zip'
    $urls = @(
        'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse',
        'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/'
    )
    $downloaded = $false
    foreach ($u in $urls) {
        try {
            if ($u -like '*/Adoptium/*') {
                # 清华镜像没有 latest 链接: 从目录页解析最新 zip 文件名
                $page = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 30
                $names = [regex]::Matches($page.Content, 'OpenJDK17U-jdk_x64_windows_hotspot_[\d._]+\.zip') |
                    ForEach-Object { $_.Value } | Sort-Object -Unique
                if (-not $names) { throw '镜像目录解析失败' }
                $file = $names[-1]
                Invoke-WebRequest -Uri ($u + $file) -OutFile $zip -UseBasicParsing
            } else {
                Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing
            }
            $downloaded = $true
            break
        } catch { Log "下载失败($u): $($_.Exception.Message), 换下一个源…" }
    }
    if (-not $downloaded) { throw 'JDK 下载全部失败, 请手动安装 JDK17 后重试(如 https://adoptium.net 或清华镜像)' }
    Log '解压 JDK…'
    Expand-Archive -Path $zip -DestinationPath (Join-Path $ToolsRoot 'jdk17-tmp') -Force
    $inner = Get-ChildItem (Join-Path $ToolsRoot 'jdk17-tmp') -Directory | Select-Object -First 1
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item $inner.FullName $dest
    Remove-Item (Join-Path $ToolsRoot 'jdk17-tmp') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    return (Join-Path $dest 'bin\java.exe')
}

function Find-AndroidSdk {
    if ($env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) { return $env:ANDROID_HOME }
    $def = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path $def) { return $def }
    $tool = Join-Path $ToolsRoot 'android-sdk'
    if (Test-Path $tool) { return $tool }
    return $null
}

function Install-AndroidSdk {
    Log '未找到 Android SDK, 下载 commandline-tools(约 150MB, 请稍候)…'
    $sdk = Join-Path $ToolsRoot 'android-sdk'
    $zip = Join-Path $ToolsRoot 'cmdtools.zip'
    $url = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
    Expand-Archive -Path $zip -DestinationPath (Join-Path $sdk 'cmdline-tools\latest-tmp') -Force
    Move-Item (Join-Path $sdk 'cmdline-tools\latest-tmp\cmdline-tools') (Join-Path $sdk 'cmdline-tools\latest') -Force
    Remove-Item (Join-Path $sdk 'cmdline-tools\latest-tmp') -Recurse -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    return $sdk
}

function Find-Gradle {
    $cmd = Get-Command gradle -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $g = Join-Path $ToolsRoot 'gradle-8.6\bin\gradle.bat'
    if (Test-Path $g) { return $g }
    return $null
}

function Install-Gradle {
    Log '未找到 Gradle, 下载 Gradle 8.6(约 130MB, 请稍候)…'
    $zip = Join-Path $ToolsRoot 'gradle.zip'
    try {
        Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.6-bin.zip' -OutFile $zip -UseBasicParsing
    } catch {
        Log '官方源失败, 尝试腾讯镜像…'
        Invoke-WebRequest -Uri 'https://mirrors.cloud.tencent.com/gradle/gradle-8.6-bin.zip' -OutFile $zip -UseBasicParsing
    }
    Expand-Archive -Path $zip -DestinationPath $ToolsRoot -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    return Join-Path $ToolsRoot 'gradle-8.6\bin\gradle.bat'
}

# ---------- 1. JDK ----------
Log '检查 JDK…'
$java = Find-Java17
if (-not $java) { $java = Install-TemurinJdk17 }
$env:JAVA_HOME = Split-Path (Split-Path $java -Parent) -Parent
Log "使用 JDK: $java"

# ---------- 2. Android SDK ----------
Log '检查 Android SDK…'
$sdk = Find-AndroidSdk
if (-not $sdk) { $sdk = Install-AndroidSdk }
$env:ANDROID_HOME = $sdk
Log "使用 SDK: $sdk"

$sdkmanager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
    # 兼容部分安装布局
    $alt = Get-ChildItem (Join-Path $sdk 'cmdline-tools') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'bin\sdkmanager.bat' } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($alt) { $sdkmanager = $alt } else { throw 'Android SDK commandline-tools 未就绪' }
}

$plat = Join-Path $sdk 'platforms\android-34'
$bt   = Join-Path $sdk 'build-tools\34.0.0'
if (-not (Test-Path $plat) -or -not (Test-Path $bt)) {
    Log '接受 SDK 许可(直接写入 license 文件)…'
    $licDir = Join-Path $sdk 'licenses'
    New-Item -ItemType Directory -Force -Path $licDir | Out-Null
    Set-Content -Path (Join-Path $licDir 'android-sdk-license') -Value @(
        '8933bad161af4178b1185d1a37fbf41ea5269c55',
        'd56f5187479451eabf01fb78af6dfcb131a6481e',
        '24333f8a63b6825ea9c5514f83c2829b004d1fee') -Encoding Ascii
    Set-Content -Path (Join-Path $licDir 'android-sdk-preview-license') -Value '84831b9409646a918e30573bab4c9c91346d8abd' -Encoding Ascii
    Log '安装 platform-34 / build-tools / platform-tools…'
    & $sdkmanager --sdk_root=$sdk "platforms;android-34" "build-tools;34.0.0" "platform-tools" 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { throw 'sdkmanager 安装组件失败' }
}

# ---------- 3. 写 local.properties ----------
Set-Content -Path (Join-Path $AndroidDir 'local.properties') -Value "sdk.dir=$($sdk -replace '\\','\\')" -Encoding ASCII

# ---------- 4. Gradle 构建 ----------
$gradle = Find-Gradle
if (-not $gradle) { $gradle = Install-Gradle }
Log '开始构建 APK(首次较慢: 下载依赖)…'
Push-Location $AndroidDir
try {
    & $gradle assembleDebug --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'gradle 构建失败' }
} finally { Pop-Location }

# ---------- 5. 拷贝产物到 dl/ ----------
$apk = Get-ChildItem (Join-Path $AndroidDir 'app\build\outputs\apk\debug\*.apk') | Select-Object -First 1
if (-not $apk) { throw '未找到构建产物' }
$ver = (Get-Content (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json).version
$target = Join-Path $DlDir "todo-reminder-v$ver.apk"
Copy-Item $apk.FullName $target -Force
Log "✅ APK 已生成: $target ($([math]::Round((Get-Item $target).Length/1MB,1)) MB)"
Log '在手机浏览器打开 http://<电脑地址>:8790/dl 下载安装(需在同一网络或 Tailscale)'
Log '注意: 首次安装需在系统设置中允许“安装未知来源应用”'
