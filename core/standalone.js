// 独立运行同步服务器(不带桌面界面): node core/standalone.js
// 环境变量: TODO_PORT=8790  TODO_DATA_DIR=<dir>(默认 ./data)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.TODO_DATA_DIR || path.join(__dirname, '..', 'data');
const webDir = process.env.TODO_WEB_DIR || path.join(__dirname, '..', 'web');
const dlDir = process.env.TODO_DL_DIR || path.join(__dirname, '..', 'dl');

let closing = false;
async function graceful(reason) {
  if (closing) return;
  closing = true;
  console.log(`[standalone] 关停(${reason})…`);
  try { await api.close(); } finally { process.exit(0); }
}

const api = await startServer({
  dataDir, webDir, dlDir,
  port: Number(process.env.TODO_PORT) || undefined,
  allowShutdown: true,
  onShutdown: () => graceful('api'),
});

process.on('SIGINT', () => graceful('SIGINT'));
process.on('SIGTERM', () => graceful('SIGTERM'));
process.on('message', (m) => { if (m === 'shutdown') graceful('ipc'); });
