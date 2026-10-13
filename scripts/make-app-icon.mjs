// 生成 Windows 图标 assets/app.ico —— 经典 BMP 帧格式(兼容性最好, 不依赖 PNG-in-ICO)
// 用法: node scripts/make-app-icon.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPng = path.join(root, 'web', 'icon-512.png');
const outDir = path.join(root, 'assets');
const outFile = path.join(outDir, 'app.ico');
const SIZES = [256, 128, 64, 48, 32, 16];

await fs.mkdir(outDir, { recursive: true });

// 用 .NET(System.Drawing)把源图缩放成每个尺寸的 32bpp BGRA 原始像素 + 生成 ICO
const ps = `
Add-Type -AssemblyName System.Drawing
$srcPath = '${srcPng.replace(/'/g, "''")}'
$outFile = '${outFile.replace(/'/g, "''")}'
$sizes = @(${SIZES.join(',')})
$src = [System.Drawing.Image]::FromFile($srcPath)
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $raw = New-Object byte[] ($stride * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($data)
  # XOR 位图: 先写 40 字节 BITMAPINFOHEADER(高度=2倍, 表示 XOR+AND), 再自下而上 BGRA
  $xor = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($xor)
  $bw.Write([uint32]40)               # biSize
  $bw.Write([int32]$s)                # biWidth
  $bw.Write([int32]($s * 2))          # biHeight = XOR + AND
  $bw.Write([uint16]1)                # biPlanes
  $bw.Write([uint16]32)               # biBitCount
  $bw.Write([uint32]0)                # biCompression = BI_RGB
  $raw += New-Object byte[] (($s * 4) * $s - $raw.Length)  # 兜底: 长度不足时补零
  $bw.Write([uint32]($s * $s * 4))    # biSizeImage
  $bw.Write([int32]0); $bw.Write([int32]0)   # 分辨率
  $bw.Write([uint32]0); $bw.Write([uint32]0) # 调色板
  for ($y = $s - 1; $y -ge 0; $y--) { $bw.Write($raw, $y * $stride, $s * 4) }
  # AND 掩码: 每行按 32 位对齐, 全 0 = 用 alpha 通道
  $maskRow = [Math]::Floor(($s + 31) / 32) * 4
  $and = New-Object byte[] ($maskRow * $s)
  $bw.Write($and)
  $bw.Flush()
  $frames += , @{ size = $s; bytes = $xor.ToArray() }
  $bw.Dispose(); $xor.Dispose(); $bmp.Dispose()
}
$src.Dispose()
# 组 ICO
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($out)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $s = $f.size
  $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
  $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$f.bytes.Length); $w.Write([uint32]$offset)
  $offset += $f.bytes.Length
}
foreach ($f in $frames) { $w.Write($f.bytes) }
$w.Flush()
[System.IO.File]::WriteAllBytes($outFile, $out.ToArray())
Write-Output ('frames=' + $frames.Count + ' bytes=' + $out.Length)
$w.Dispose(); $out.Dispose()
`;
const res = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
console.log('已写入 ' + outFile + '  ' + res.trim());
