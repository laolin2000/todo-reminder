// ============================================================
// 待办提醒 · 修复工具 —— 公共库
// 只依赖 Node 内置模块, 不引入任何第三方包。
// ============================================================
import { promises as fs, existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

export const TOOL_VERSION = '1.0.0';

// ------------------------------------------------------------
// 日志输出: 同时打印到控制台 + 追加到 UTF-8 文本文件
// ------------------------------------------------------------
let LOG_FILE = null;
export function setLogFile(p) { LOG_FILE = p; }
export function log(msg = '') {
  const s = String(msg);
  try { console.log(s); } catch { /* ignore */ }
  if (LOG_FILE) { try { appendFileSync(LOG_FILE, s + '\n', 'utf8'); } catch { /* ignore */ } }
}
/** 带缩进的条目输出 */
export function bullet(msg) { log('   ' + msg); }
export function title(msg) { log(''); log('── ' + msg + ' ' + '─'.repeat(Math.max(0, 46 - String(msg).length))); }

// ------------------------------------------------------------
// 读文件 / 时间格式化
// ------------------------------------------------------------
export function readJson(file) {
  let raw = readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}
export async function readJsonOr(file, dflt) {
  try { return readJson(file); } catch { return dflt; }
}
export async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 1), 'utf8');
}

const P2 = (n) => String(n).padStart(2, '0');
/** 毫秒时间戳 → 可读时间 */
export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms == null) return '-';
  return fmtDate(new Date(ms));
}
export function fmtDate(d) {
  return `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())} ${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}`;
}
/** 格式化当前/给定时间; 参数可以是 Date、毫秒时间戳或不传 */
export function nowStr(d = new Date()) {
  if (typeof d === 'number') return Number.isFinite(d) ? fmtDate(new Date(d)) : '-';
  if (typeof d === 'string') { const t = new Date(d); return Number.isFinite(t.getTime()) ? fmtDate(t) : d; }
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return '-';
  return fmtDate(d);
}
export function stampName(d = new Date()) { return fmtDate(d).replace(/[: ]/g, '-'); }
export function dayStr(ms) { const d = new Date(ms); return `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())}`; }
export function hhmm(ms) { const d = new Date(ms); return `${P2(d.getHours())}:${P2(d.getMinutes())}`; }
export function pad2(n) { return P2(n); }
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ------------------------------------------------------------
// 环境解析: App 目录 / 数据目录 / 端口 / 日志目录
// ------------------------------------------------------------
function appDataDir() { return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); }

/** 从工具目录向上找含 package.json + electron/main.js 的目录 */
function detectAppDir(baseDir) {
  let cur = baseDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(cur, 'package.json')) && existsSync(path.join(cur, 'electron', 'main.js'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(baseDir, '..', '..');
}

export function loadConfig(baseDir) {
  const cfgFile = path.join(baseDir, 'config.json');
  const cfg = existsSync(cfgFile) ? readJson(cfgFile) : {};
  const appDir = (cfg.appDir && existsSync(cfg.appDir)) ? cfg.appDir : detectAppDir(baseDir);
  // 允许用环境变量把数据目录/日志目录指到别处(沙盒自测用)
  const dataDir = process.env.TODO_FIX_DATA_DIR || cfg.dataDir || path.join(appDataDir(), '待办提醒', 'data');
  const coreDir = path.join(appDir, 'core');

  const ports = [];
  if (cfg.port) ports.push(Number(cfg.port));
  try {
    const c = readJson(path.join(dataDir, 'config.json'));
    if (c && c.port) ports.push(Number(c.port));
  } catch { /* ignore */ }
  for (const p of [8790, 8788, 8791, 18800]) if (!ports.includes(p)) ports.push(p);

  return {
    baseDir, appDir, dataDir, coreDir,
    // 运行产物统一放在 运行/ 子目录: 归档日志、每次运行的体检记录
    runtimeDir: path.join(baseDir, '运行'),
    logDir: process.env.TODO_FIX_LOG_DIR || cfg.logDir || path.join(baseDir, '运行', 'logs'),
    port: ports[0], ports,
    oldDoneDays: Number.isFinite(cfg.oldDoneDays) ? cfg.oldDoneDays : 3,
    tombstoneKeepDays: Number.isFinite(cfg.tombstoneKeepDays) ? cfg.tombstoneKeepDays : 90,
    todosFile: path.join(dataDir, 'todos.json'),
    aiFile: path.join(dataDir, 'ai.json'),
    dataCfgFile: path.join(dataDir, 'config.json'),
    backupsDir: path.join(dataDir, 'backups'),
  };
}

export function electronExe(cfg) { return path.join(cfg.appDir, 'node_modules', 'electron', 'dist', 'electron.exe'); }

// ------------------------------------------------------------
// 网络
// ------------------------------------------------------------
export async function httpJson(url, { method = 'GET', headers = {}, body = null, timeout = 6000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, json, text: txt };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String((e && e.message) || e), netErr: true };
  } finally { clearTimeout(t); }
}

export async function health(cfg, port) {
  return httpJson(`http://127.0.0.1:${port || cfg.port}/api/health`, { timeout: 4000 });
}

/** 探测哪个端口可用(返回 {port, data}) */
export async function findLivePort(cfg) {
  for (const p of cfg.ports) {
    const h = await health(cfg, p);
    if (h.ok && h.json && h.json.ok) return { port: p, data: h.json };
  }
  return null;
}

/** 8790 的监听进程 pid */
export function portListenerPid(port) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const pid = parseInt(String(out).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export function procInfo(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p.Name+'|'+$p.CommandLine}`],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const s = String(out).trim();
    const i = s.indexOf('|');
    if (i < 0) return null;
    return { name: s.slice(0, i), cmd: s.slice(i + 1) };
  } catch { return null; }
}

/** 该 pid 是否就是本 App 的桌面端 */
export function isOurApp(pid, cfg) {
  const info = procInfo(pid);
  if (!info) return false;
  const exe = electronExe(cfg).toLowerCase();
  const cmd = String(info.cmd || '').toLowerCase();
  return cmd.includes(exe) || cmd.includes(cfg.appDir.toLowerCase());
}

export async function waitPortFree(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!portListenerPid(port)) return true;
    await sleep(300);
  }
  return false;
}

export async function waitHealthy(cfg, port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await health(cfg, port);
    if (h.ok && h.json && h.json.ok) return h.json;
    await sleep(700);
  }
  return null;
}

/** 启动桌面端(默认 --hidden: 不弹主窗口, 托盘常驻) */
export function startApp(cfg, hidden = true) {
  const exe = electronExe(cfg);
  if (!existsSync(exe)) throw new Error('找不到 electron.exe: ' + exe);
  const args = hidden ? ['--hidden', cfg.appDir] : [cfg.appDir];
  const child = spawn(exe, args, { cwd: cfg.appDir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

export function stopApp(pid) {
  if (!pid) return false;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 25000 }); return true; }
  catch { return false; }
}

// ------------------------------------------------------------
// 数据
// ------------------------------------------------------------
export async function loadTodos(cfg) {
  const arr = await readJsonOr(cfg.todosFile, null);
  if (!Array.isArray(arr)) throw new Error('无法读取 todos.json(文件不存在或格式不对): ' + cfg.todosFile);
  return arr;
}

export async function backupFile(cfg, file, tag) {
  await fs.mkdir(cfg.backupsDir, { recursive: true });
  const dst = path.join(cfg.backupsDir, `${path.basename(file, '.json')}-${tag}-${stampName()}.json`);
  await fs.copyFile(file, dst);
  return dst;
}

/** 原子写(与 App 落盘方式一致: 临时文件 + rename) */
export async function writeTodos(cfg, arr) {
  const tmp = cfg.todosFile + '.fix-tmp';
  await fs.mkdir(path.dirname(cfg.todosFile), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(arr, null, 1), 'utf8');
  await fs.rename(tmp, cfg.todosFile);
}

export function summarize(arr) {
  const alive = arr.filter((t) => !t.deleted);
  const done = alive.filter((t) => t.status === 'done');
  const open = alive.filter((t) => t.status !== 'done');
  const rep = alive.filter((t) => t.rule || (t.repeat && t.repeat !== 'none'));
  return {
    total: arr.length, tombstones: arr.length - alive.length,
    alive: alive.length, open: open.length, done: done.length, repeat: rep.length,
  };
}

export function isRepeatItem(t) { return !!(t.rule || (t.repeat && t.repeat !== 'none')); }

/**
 * 清理"很旧的墓碑"(deleted:true 且很久没动过)。
 * 为什么墓碑要留一段时间: 同步是 LWW, 墓碑靠"时间戳更新"压住别的设备上的旧副本;
 * 刚删掉就把墓碑也清了, 别的设备一同步就会把它复活(实测踩过)。
 * 默认保留 90 天, 足够所有设备都同步过很多轮。
 */
export function pruneTombstones(arr, keepDays = 90) {
  const cutoff = Date.now() - Math.max(1, keepDays) * 86400000;
  const out = arr.filter((t) => !(t.deleted && Number.isFinite(t.updatedAt) && t.updatedAt < cutoff));
  return { todos: out, removed: arr.length - out.length };
}
export function ruleKey(t) {
  if (!t.rule) return '';
  try { const r = JSON.parse(t.rule); return String(r.id || t.rule); } catch { return String(t.rule); }
}
