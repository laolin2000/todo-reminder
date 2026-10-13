// ============================================================
// phone-sim.mjs — 手机模拟窗口(自测用)
// 以 390×844 打开一个独立 Electron 窗口加载本应用:
//   · 桌面端已运行 → 自动附加到 http://127.0.0.1:8790(同一份真实数据, 实时同步)
//   · 桌面端未运行 → 以真实数据目录自起服务器
// 关闭窗口即退出。用法: node scripts/phone-sim.mjs (或双击 手机模拟窗口.bat)
// ============================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
// 注意: electron/main.js 会以 TODO_DATA_DIR 为根, 再拼 /data 作为同步数据目录(与桌面端一致)
const realRoot = path.join(appData, '待办提醒');
const realDataDir = path.join(realRoot, 'data');
const realDlDir = path.join(realRoot, 'downloads');

if (!existsSync(electronBin)) {
  console.error('找不到 electron, 请先在本目录执行: npm install');
  process.exit(1);
}

const child = spawn(electronBin, ['.'], {
  cwd: ROOT,
  env: {
    ...process.env,
    TODO_PHONE_SIM: '1',
    TODO_DATA_DIR: realRoot,
    TODO_DL_DIR: realDlDir,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

console.log('[手机模拟] 打开 390×844 窗口(数据: ' + realDataDir + '), 关闭窗口即退出…');
child.on('exit', (code) => {
  console.log('[手机模拟] 已退出 (code ' + (code ?? 0) + ')');
  process.exit(code ?? 0);
});
