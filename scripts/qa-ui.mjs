// ============================================================
// qa-ui.mjs — 桌面 UI 响应式 QA
// 以临时数据目录启动 Electron(TODO_QA_UI=1, 窗口移出屏幕),
// 在 360/480/768/1280 四种宽度下检测: 横向溢出 / 卡片渲染 / 表单可用。
// 用法: node scripts/qa-ui.mjs
// ============================================================
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'todo-uiqa-'));

const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronBin, ['--no-sandbox', '.'], {
  cwd: ROOT,
  env: {
    ...process.env,
    TODO_QA_UI: '1',
    TODO_DATA_DIR: tmpDir,
    TODO_DL_DIR: path.join(tmpDir, 'downloads'),
    TODO_USER_DATA: tmpDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; });

const timeout = setTimeout(() => {
  console.error('QA 超时(60s)');
  child.kill();
  process.exit(1);
}, 60000);

child.on('exit', async (code) => {
  clearTimeout(timeout);
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  const pass = out.includes('QA_RESULT: ALL-PASS');
  if (!pass) console.log('── 失败详情 ──\n' + out.split('\n').filter((l) => l.includes('❌')).join('\n'));
  process.exit(pass ? 0 : 1);
});
