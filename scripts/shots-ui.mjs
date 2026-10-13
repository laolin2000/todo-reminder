// ============================================================
// shots-ui.mjs — 手机界面预览截图(390×844)
// 用法: node scripts/shots-ui.mjs [输出目录]
// 生成: <out>/01-list.png 02-trace.png 03-slots.png 04-slotform.png 05-editor.png
// ============================================================
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'shots'));
const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'todo-shots-'));
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const child = spawn(electronBin, ['--no-sandbox', '.'], {
  cwd: ROOT,
  env: {
    ...process.env,
    TODO_SHOT: '1',
    TODO_DATA_DIR: tmpDir,
    TODO_DL_DIR: path.join(tmpDir, 'downloads'),
    TODO_USER_DATA: tmpDir,
    TODO_SHOT_DIR: outDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; });

const timeout = setTimeout(() => {
  console.error('截图超时(40s)');
  child.kill();
  process.exit(1);
}, 40000);

child.on('exit', async (code) => {
  clearTimeout(timeout);
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  const ok = out.includes('SHOTS_OK');
  console.log(ok ? `📷 截图完成 → ${outDir}` : 'SHOTS_FAILED');
  process.exit(ok ? 0 : 1);
});
