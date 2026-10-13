// 生成手机一体包的权威版本清单 version.json(含 versionCode / sha256 / size),
// 并同步 APK 与清单到两个发布目录(dl/ 与 %APPDATA%\待办提醒\downloads\)。
// 用法: node scripts/make-version-json.mjs   (先完成 gradle assembleDebug)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradle = fs.readFileSync(path.join(root, 'android-web/app/build.gradle'), 'utf8');
const versionCode = Number((/versionCode\s+(\d+)/.exec(gradle) || [])[1]);
const versionName = (/versionName\s+"([^"]+)"/.exec(gradle) || [])[1];
if (!versionCode || !versionName) {
  console.error('无法从 android-web/app/build.gradle 解析 versionCode/versionName');
  process.exit(1);
}
const apkSrc = path.join(root, 'android-web/app/build/outputs/apk/debug/app-debug.apk');
if (!fs.existsSync(apkSrc)) {
  console.error('缺少构建产物: ' + apkSrc + ' (请先运行 gradle assembleDebug)');
  process.exit(1);
}
const buf = fs.readFileSync(apkSrc);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const name = `todo-reminder-phone-v${versionName}.apk`;
const meta = { name, version: versionName, versionCode, size: buf.length, sha256, builtAt: Date.now() };

const dirs = [
  path.join(root, 'dl'),
  path.join(os.homedir(), 'AppData', 'Roaming', '待办提醒', 'downloads'),
];
for (const d of dirs) {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), buf);
  fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log('已写入 ' + d + '\\' + name + ' 与 version.json');
}
console.log('META ' + JSON.stringify(meta));
