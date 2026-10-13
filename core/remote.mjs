// ============================================================
// core/remote.mjs — 待办提醒 · 内置远程访问(公网隧道)
// ------------------------------------------------------------
// 目标: 应用自己就把「手机在任何网络下都能连」这件事做好 ——
//   · 应用启动 → 自动拉起本地守卫 → 守卫自动拉起并保活 cloudflared 隧道
//   · 应用退出 → 先停隧道、再停守卫、兜底清孤儿(顺序不能反)
//   · 链接由本模块直接生成(读守卫状态文件), 不需要二维码/手工步骤
//
// 复用已在跑的 dsh-remote 守卫(guard.mjs): 它是纯 Node 内置模块实现,
// 没有第三方依赖, 所以可以用 Electron 自带的运行时(ELECTRON_RUN_AS_NODE)
// 直接执行 —— 应用不依赖系统里是否装了 Node。
//
// 只用 node: 内置模块, 因此 tools/fix(零依赖工具)也能直接复用本文件。
// ============================================================
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { PROXY, PROXY_PID_FILE } from './remote-proxy.mjs';

// ------------------------------------------------------------
// 可调参数(环境变量优先, 便于测试隔离)
// ------------------------------------------------------------
/** cloudflared 自动探测: 环境变量 → 几个已知位置 → PATH */
function detectCloudflared() {
  if (process.env.TODO_REMOTE_CLOUDFLARED) return process.env.TODO_REMOTE_CLOUDFLARED;
  const cands = [
    'D:\\toolresources\\DSHStool\\remote\\cloudflared.exe',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
  ];
  for (const c of cands) { try { if (c && existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0]; // 都没找到时保留第一个作为"期望路径", 报错信息里会显示它
}

export const REMOTE = {
  port: Number(process.env.TODO_REMOTE_PORT || 8444),
  bind: '127.0.0.1',
  guardPath: process.env.TODO_REMOTE_GUARD || 'C:\\Users\\reskipeer\\dsh-remote\\guard\\guard.mjs',
  cloudflared: detectCloudflared(),
  stateDir: process.env.TODO_REMOTE_DIR || 'D:\\toolresources\\Ztool\\待办提醒-远程连接\\state',
  cookieName: process.env.TODO_REMOTE_COOKIE || 'todo_remote_sid',
  /** 应用数据目录(读连接码用): 默认取 Electron 的 userData/待办提醒/data */
  dataDir: process.env.TODO_REMOTE_DATADIR
    || path.join(process.env.APPDATA || '', '待办提醒', 'data'),
};

export const FILE = {
  conf: () => path.join(REMOTE.stateDir, 'guard.json'),
  url: () => path.join(REMOTE.stateDir, 'public-url.txt'),
  tunnel: () => path.join(REMOTE.stateDir, 'tunnel.json'),
  log: () => path.join(REMOTE.stateDir, 'cloudflared.log'),
  guardLog: () => path.join(REMOTE.stateDir, 'guard.log'),
  audit: () => path.join(REMOTE.stateDir, 'audit.jsonl'),
};

/** 本模块持有的守卫子进程(仅当由本进程拉起时非 null) */
let guardChild = null;
let lastError = '';
let startedAt = 0;
let onLog = () => {};
// 2026-10-14: hbTimer 随宿主心跳一并移除

export function setLogger(fn) { if (typeof fn === 'function') onLog = fn; }
function log(msg) { try { onLog('[remote] ' + msg); } catch { /* ignore */ } }

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ------------------------------------------------------------
// 宿主心跳（2026-10-14 已移除）
//
// 原先本模块每 15 秒写一次 host.heartbeat / host.alive，供守卫侧补丁
// （shots/patch-guard-host-liveness.mjs）判断"拉起我的那个应用还在不在"，
// 以便在应用被强杀后把孤儿隧道收掉。
// 按用户要求，这个「存活检查」机制已整体停用：不再有任何进程写心跳文件，
// 守卫侧也就无法再据此判定孤儿。下面的路径函数与 hostLiveness() 保留，
// 仅用于诊断显示（此时恒为"未知"）。
// ------------------------------------------------------------
export function heartbeatFile() { return path.join(REMOTE.stateDir, 'host.heartbeat'); }
/** 存活标记路径（原先由本进程每 15 秒触碰，现已不再写入）。 */
export function aliveFile() { return path.join(REMOTE.stateDir, 'host.alive'); }

/** 宿主存活判定(供诊断显示): 心跳年龄 + 本进程是否在照看入口 */
export function hostLiveness() {
  let hbAgeMs = null, aliveAgeMs = null;
  try {
    const ts = Number(readTextSafe(heartbeatFile()));
    if (Number.isFinite(ts) && ts > 0) hbAgeMs = Date.now() - ts;
  } catch { /* ignore */ }
  try {
    const ts = Number(readTextSafe(aliveFile()));
    if (Number.isFinite(ts) && ts > 0) aliveAgeMs = Date.now() - ts;
  } catch { /* ignore */ }
  return {
    hostPid: process.pid,
    heartbeatAgeMs: hbAgeMs,
    aliveAgeMs,
    managedByMe: aliveAgeMs != null && aliveAgeMs < 90000,
  };
}

// ------------------------------------------------------------
// 文件读取小工具
// ------------------------------------------------------------
function readJsonSafe(file, dflt = null) {
  try {
    let raw = readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return dflt; }
}
function readTextSafe(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

// ------------------------------------------------------------
// 环境自检: 依赖是否齐备(缺什么要说清怎么补)
// ------------------------------------------------------------
export function preflight({ upstreamPort = 8790 } = {}) {
  const problems = [];
  const ok = [];
  if (existsSync(REMOTE.guardPath)) ok.push({ name: '守卫程序', detail: REMOTE.guardPath });
  else problems.push({
    name: '守卫程序', detail: REMOTE.guardPath,
    fix: '找不到 guard.mjs —— 设置环境变量 TODO_REMOTE_GUARD 指向它, 或确认 dsh-remote 还在原位',
  });
  if (existsSync(REMOTE.cloudflared)) ok.push({ name: 'cloudflared', detail: REMOTE.cloudflared });
  else problems.push({
    name: 'cloudflared', detail: REMOTE.cloudflared,
    fix: '找不到 cloudflared.exe —— 设置环境变量 TODO_REMOTE_CLOUDFLARED 指向它(可从 cloudflare 官网下载)',
  });
  return { ok, problems, upstreamPort };
}

// ------------------------------------------------------------
// 守卫进程管理
// ------------------------------------------------------------
export function guardArgs() {
  return [
    REMOTE.guardPath, 'serve',
    '--port', String(REMOTE.port),
    '--bind', REMOTE.bind,
    '--cookie-name', REMOTE.cookieName,
    '--inject-panel', '0',
  ];
}

export function guardEnv(extra = {}) {
  return {
    ...process.env,
    DSH_REMOTE_DIR: REMOTE.stateDir,   // 独立状态目录: 绝不与 DSH 那套混用
    // 让守卫把隧道指向**待办自己的入口层**(而不是守卫自己):
    // 守卫那套凭据模型是给 DSH 多设备场景的, 会拒掉手机一体包的原生请求;
    // 待办是单用户单手机, 用应用自己的连接码鉴权即可(见 core/remote-proxy.mjs)。
    TODO_REMOTE_TUNNEL_PORT: String(PROXY.port),
    ...extra,
  };
}

// ------------------------------------------------------------
// 入口层(公网隧道指向它): 自己起、自己收
// ------------------------------------------------------------
export function proxyPidFile() { return path.join(REMOTE.stateDir, PROXY_PID_FILE); }

function proxyFile() { return path.join(REMOTE.stateDir, 'proxy.log'); }

/** 应用自己的连接码(从数据目录的 config.json 读) —— 入口层用它做鉴权 */
export function appToken() {
  if (PROXY.token) return PROXY.token;
  try {
    const c = readJsonSafe(path.join(REMOTE.dataDir || '', 'config.json'), null);
    if (c && c.token) return String(c.token);
  } catch { /* ignore */ }
  return '';
}

export async function proxyHealth(port = PROXY.port, timeoutMs = 3000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://${PROXY.bind}:${port}/__remote/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json().catch(() => ({}));
  } catch { return null; }
}

export function proxyPidOnDisk() {
  try {
    const n = parseInt(readTextSafe(proxyPidFile()), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** 启动入口层(独立进程: 用 Electron 运行时当 Node 用, 不依赖系统 Node) */
export async function startProxy({ upstreamPort = 8790 } = {}) {
  if (await proxyHealth()) return { ok: true, already: true, port: PROXY.port };
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote-proxy.mjs');
  if (!existsSync(script)) return { ok: false, error: '找不到入口层脚本: ' + script };
  const tok = appToken();
  if (!tok) return { ok: false, error: '读不到应用连接码(数据目录 config.json), 无法启动入口层' };
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      TODO_REMOTE_PROXY_PORT: String(PROXY.port),
      TODO_REMOTE_UPSTREAM_PORT: String(upstreamPort),
      TODO_REMOTE_TOKEN: tok,
    },
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', (e) => { lastError = '入口层启动失败: ' + e.message; log(lastError); });
  child.unref?.();
  await fs.mkdir(REMOTE.stateDir, { recursive: true }).catch(() => {});
  try { await fs.writeFile(proxyPidFile(), String(child.pid), 'utf8'); } catch { /* ignore */ }
  for (let i = 0; i < 20; i++) {
    if (await proxyHealth(PROXY.port, 1500)) return { ok: true, pid: child.pid, port: PROXY.port };
    await sleep(400);
  }
  return { ok: false, pid: child.pid, error: '入口层起来了但探活超时(看 ' + proxyFile() + ')' };
}

async function stopProxy() {
  const pid = proxyPidOnDisk();
  if (pid) await killPid(pid);
  try { await fs.rm(proxyPidFile(), { force: true }); } catch { /* ignore */ }
}

/** 用「Electron 运行时当 Node 用」执行 guard.mjs —— 不依赖系统装了 Node。
 *
 *  detached 必须为 **true**,原因(实测踩过):
 *   false 时子进程与宿主共享控制台, 宿主被**强制结束**(任务管理器/崩溃)时
 *   控制台对象一起销毁 → **守卫会跟着死**。守卫一死, 那条 detached 的 cloudflared
 *   就再没人管, 变成"域名还在、后端已死"的孤儿入口。
 *   改成 true 后守卫独立存活, 于是它能在下一个守护周期里通过
 *   「宿主心跳 + 宿主进程」双重判断发现自己成了孤儿, 主动把隧道收掉再退出
 *   (守卫侧补丁见 shots/patch-guard-host-liveness.mjs)。
 *   生命周期仍由应用掌控: 正常退出走 core/remote.mjs 的 stop()/stopFast()。 */
export function spawnGuard({ parentPid = 0 } = {}) {
  if (!existsSync(REMOTE.guardPath)) throw new Error('找不到守卫程序: ' + REMOTE.guardPath);
  // 2026-10-14: 原「心跳先就位, 守卫一起来就能看到」已移除（不再写入宿主存活标记）
  const child = spawn(process.execPath, guardArgs(), {
    env: guardEnv(parentPid ? { TODO_REMOTE_HOST_PID: String(parentPid) } : {}),
    detached: true,           // 见上: 必须独立存活, 否则宿主被硬杀时守卫一起死
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(REMOTE.guardPath),
  });
  child.unref?.();            // 不阻塞应用退出(退出时显式收干净)
  child.on('error', (e) => { lastError = '守卫启动失败: ' + e.message; log(lastError); });
  child.on('exit', (code) => { if (guardChild === child) guardChild = null; log(`守卫退出 code=${code}`); });
  guardChild = child;
  log(`已拉起守卫 pid=${child.pid} → ${REMOTE.bind}:${REMOTE.port}`);
  return child;
}

export function isGuardRunning() {
  const c = guardChild;
  return !!(c && c.exitCode == null && !c.killed);
}

/** 读取拉起守卫时记录的 cloudflared pid */
export function lastSpawnedTunnelPid() {
  const t = readJsonSafe(FILE.tunnel(), null);
  return t && Number.isFinite(t.pid) && t.pid > 0 ? t.pid : null;
}

/** 端口上有东西在监听吗(不依赖本进程是否拉起过守卫) */
export async function isPortListening(port = REMOTE.port) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(!err && parseInt(String(stdout).trim(), 10) > 0));
  });
}

export async function health(port = REMOTE.port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`http://${REMOTE.bind}:${port}/__guard/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json().catch(() => ({}));
  } catch { return null; }
}

/** 等守卫就绪 */
export async function waitGuardReady(ms = 12000, port = REMOTE.port) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await health(port)) return true;
    await sleep(400);
  }
  return false;
}

// ------------------------------------------------------------
// 链接生成(不需要二维码/CLI: token 明文在 guard.json 的 links 里)
// ------------------------------------------------------------
export function publicBase() {
  const u = readTextSafe(FILE.url());
  return u ? u.replace(/\/+$/, '') : '';
}

export function localBase() {
  return `http://${REMOTE.bind}:${REMOTE.port}`;
}

/** 当前手机链接; ready=false 表示还在等公网域名, 此时给的是本机地址 */
export function currentLink() {
  const conf = readJsonSafe(FILE.conf(), {}) || {};
  const owner = conf.links && conf.links.owner;
  let base = publicBase();
  let local = false;
  if (!base) { base = localBase(); local = true; }
  return {
    base,
    ready: !local && !!owner,
    local,
    url: owner && owner.token ? `${base}/?t=${owner.token}` : '',
    token: owner.token ? String(owner.token).slice(0, 6) + '…' : '',
    createdAt: owner && owner.createdAt ? owner.createdAt : '',
    name: owner && owner.name ? owner.name : '',
  };
}

/** 确保守卫里有一条长期 owner 链接。
 *  为什么需要: 守卫只在"被要求"时才写 conf.links(CLI 的 pair/link 或控制面),
 *  刚起的守卫 links 是空的 —— 那样手机链接拼不出来。
 *  走控制面而不是直接改文件: 守卫在内存里持有配置, 直接改文件会被它回写覆盖。 */
export async function ensureLink({ retries = 6 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`http://${REMOTE.bind}:${REMOTE.port}/__guard/link?role=owner`, { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok && j.url) return { ok: true, link: j };
    } catch { /* 守卫可能还没起来, 重试 */ }
    await sleep(700);
  }
  return { ok: false, error: '守卫没给出链接(控制面 /__guard/link 不可用)' };
}

/** 公网入口是否真的可用(域名已注册 + 能应答)。
 *  为什么必须真打一次: cloudflared 会**先**在日志里写出分配到的域名, **后**才完成
 *  隧道建连与 DNS 注册 —— 实测这段时间里域名是 ENOTFOUND 的。
 *  探活路径用**入口层自己的**健康端点(不鉴权), 因为隧道现在指向入口层而不是守卫。 */
export async function probePublic(base, timeoutMs = 12000) {
  if (!base) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(base.replace(/\/+$/, '') + '/__remote/health', { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const txt = await r.text();
    return /todo-remote-proxy/.test(txt) || /"ok"\s*:\s*true/.test(txt);
  } catch { return false; }
}

/** 等公网域名出现 **且真的可应答**。
 *  必须真的打一次: cloudflared 会先在日志里写出分配到的域名, 之后才完成建连与
 *  DNS 注册 —— 中间这段时间域名是 ENOTFOUND/530 的。而且状态目录里可能残留
 *  上一轮(已被强杀时)留下的旧域名文件, 只看"文件里有域名"会误判成就绪。 */
export async function waitPublicUrl(ms = 150000, { onTick = () => {} } = {}) {
  const t0 = Date.now();
  let lastSeen = '';
  while (Date.now() - t0 < ms) {
    const u = publicBase();
    if (u && /^https?:\/\//i.test(u)) {
      if (u !== lastSeen) { lastSeen = u; onTick(u); }
      if (await probePublic(u, 10000)) return u;
    }
    await sleep(2000);
  }
  return '';
}

// ------------------------------------------------------------
// 生命周期
// ------------------------------------------------------------
export async function start({ upstreamPort = 8790, waitMs = 150000, onProgress = () => {} } = {}) {
  lastError = '';
  const pre = preflight({ upstreamPort });
  if (pre.problems.length) {
    lastError = pre.problems.map((p) => p.name + ': ' + p.detail).join('; ');
    return { ok: false, running: false, error: lastError, problems: pre.problems };
  }

  // 先确保状态目录里有一份指向本应用的配置(端口/上游/关注入)
  await ensureStateConf(upstreamPort);

  // ① 入口层(公网隧道指向它, 用应用自己的连接码鉴权)
  onProgress('启动入口层…');
  const px = await startProxy({ upstreamPort });
  if (!px.ok) {
    lastError = px.error || '入口层启动失败';
    return { ok: false, running: false, error: lastError };
  }

  // ② 守卫(它只负责把隧道拉起来并保活)
  if (!(await isPortListening())) {
    try { spawnGuard({ parentPid: process.pid }); } catch (e) { lastError = e.message; return { ok: false, running: false, error: lastError }; }
  } else {
    log('守卫已在运行, 复用');
  }

  onProgress('等待守卫就绪…');
  const ready = await waitGuardReady(12000);
  if (!ready) {
    lastError = '守卫起来了但没有就绪 —— 看 ' + FILE.guardLog();
    return { ok: false, running: false, error: lastError };
  }
  startedAt = startedAt || Date.now();

  onProgress('等待公网域名生效(首次约 20–90 秒)…');
  // 先清掉可能残留的旧域名文件 —— 上一轮被强杀时它会留在磁盘上, 会让"就绪"判断失真
  try {
    const stale = publicBase();
    if (stale && !(await probePublic(stale, 8000))) await fs.rm(FILE.url(), { force: true });
  } catch { /* ignore */ }
  let url = await waitPublicUrl(waitMs, {
    onTick: (u) => onProgress('已分配域名, 正在等它生效: ' + u),
  });
  // 还没好就主动让守卫重起一次隧道(可能拿到了一个失效域名)
  if (!url) {
    onProgress('域名仍未生效, 让守卫重起一次隧道…');
    try {
      const st = lastSpawnedTunnelPid();
      if (st) await killPid(st);               // 守卫守护会在几秒内拉起一条新隧道
    } catch { /* ignore */ }
    url = await waitPublicUrl(Math.max(90000, waitMs), {
      onTick: (u) => onProgress('新域名分配中: ' + u),
    });
  }
  if (!url) {
    lastError = '隧道还没拿到可用域名 —— 看 ' + FILE.log();
    return { ok: false, running: true, error: lastError, ...status() };
  }

  // 让守卫把长期 owner 链接落进配置(否则 links 是空的, 手机链接拼不出来)
  onProgress('生成手机链接…');
  const lk = await ensureLink();
  if (!lk.ok) {
    lastError = lk.error;
    return { ok: false, running: true, error: lastError, ...status() };
  }

  onProgress('已就绪');
  return { ok: true, running: true, ...status() };
}

/** 写/修状态目录里的守卫配置(只在缺失或被改坏时写) */
export async function ensureStateConf(upstreamPort = 8790) {
  await fs.mkdir(REMOTE.stateDir, { recursive: true });
  const want = {
    port: REMOTE.port,
    bind: REMOTE.bind,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    cookieName: REMOTE.cookieName,
    cloudflared: REMOTE.cloudflared,
    urlFile: FILE.url(),
    tunnelLog: FILE.log(),
    superviseTunnel: true,
    audit: true,
    injectPanel: false,
  };
  const cur = readJsonSafe(FILE.conf(), null);
  let changed = false;
  const next = cur && typeof cur === 'object' ? { ...cur } : { devices: [], pairings: [], sessions: [] };
  for (const [k, v] of Object.entries(want)) {
    if (next[k] !== v) { next[k] = v; changed = true; }
  }
  if (!next.devices) next.devices = [];
  if (!next.pairings) next.pairings = [];
  if (!next.sessions) next.sessions = [];
  if (!next.links) next.links = {};
  // 隧道守护的"意图"标志: 应用开着就应该想要入口
  if (next.superviseTunnel !== true) { next.superviseTunnel = true; changed = true; }
  if (changed) await fs.writeFile(FILE.conf(), JSON.stringify(next, null, 2), 'utf8');
  return { changed, file: FILE.conf() };
}

/** 把配置里的「想要隧道」意图写成 false —— 必须先做这一步, 否则守卫守护进程
 *  每 10 秒就会把刚停掉的隧道重新拉起来(实测: 12 秒后原地复活)。
 *  注意: 守卫的控制面**没有** tunnel/down 端点(只有 health/link/links/reset/
 *  devices/revoke/doctor/qr/pair/whoami/ui.js), 所以这里直接改状态文件。 */
export async function clearTunnelIntent() {
  const conf = readJsonSafe(FILE.conf(), null);
  if (!conf) return false;
  if (conf.superviseTunnel === false) return true;
  conf.superviseTunnel = false;
  await fs.writeFile(FILE.conf(), JSON.stringify(conf, null, 2), 'utf8');
  return true;
}

async function killPid(pid) {
  if (!pid) return false;
  try { await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']); return true; } catch { return false; }
}

/** 快速收尾(给"应用正在退出"用): 不等待守卫的守护周期, 直接按 pid 清干净。
 *  与 stop() 的区别: stop() 走"优雅"路径(先关意图、等守卫自己收), 适合用户点「关闭」;
 *  本函数只求快 —— 退出时时间有限, 剩下的兜底交给守卫侧的心跳检查补丁。 */
export async function stopFast() {
  const report = { tunnelKilled: false, guardKilled: false, proxyKilled: false };
  await clearTunnelIntent();                       // 关掉意图, 免得守护又拉起来
  const tp = lastSpawnedTunnelPid();
  if (tp && await killPid(tp)) report.tunnelKilled = true;
  for (const pid of await listeningPids(REMOTE.port)) {
    if (await killPid(pid)) report.guardKilled = true;
  }
  guardChild = null;
  const pp = proxyPidOnDisk();
  if (pp && await killPid(pp)) report.proxyKilled = true;
  try { await fs.rm(proxyPidFile(), { force: true }); } catch { /* ignore */ }
  try { await fs.writeFile(FILE.tunnel(), JSON.stringify({ pid: null, url: null, startedAt: null, desired: false }), 'utf8'); } catch { /* ignore */ }
  try { await fs.rm(FILE.url(), { force: true }); } catch { /* ignore */ }
  // 2026-10-14: 心跳已移除, 无需再 stopHeartbeat()
  return report;
}

/** 收干净: ① 关掉「想要隧道」意图(守卫保活时它会顺手停掉 cloudflared)
 *          ② 等它自己停; 停不掉就直接杀隧道 pid
 *          ③ 杀守卫(带 /T 连子树)
 *          ④ 兜底再清一次隧道孤儿
 *  顺序不能反 —— 守卫死了就没人执行第 ① 步的保活逻辑了。 */
export async function stop({ timeoutMs = 14000 } = {}) {
  const report = { intentCleared: false, tunnelStopped: false, guardKilled: false, orphanKilled: false };
  const tunnelPidBefore = lastSpawnedTunnelPid();

  // ① 关掉意图
  report.intentCleared = await clearTunnelIntent();

  // ② 等守卫自己收掉隧道(它的守护每 10 秒一跑); 超时就直接杀
  const t0 = Date.now();
  while (Date.now() - t0 < Math.min(timeoutMs, 13000)) {
    if (!tunnelPidBefore || !(await pidAlive(tunnelPidBefore))) { report.tunnelStopped = true; break; }
    await sleep(800);
  }
  if (!report.tunnelStopped) {
    report.tunnelStopped = await killPid(tunnelPidBefore);
  }

  // ③ 杀守卫。
  //    注意: Windows 上子进程的 kill() 可能被忽略(实测: 应用退出时守卫照样活着),
  //    所以不能只靠 kill(), 必须带 pid 强杀兜底 —— 否则退出流程会一直等下去。
  if (isGuardRunning()) {
    try { guardChild.kill(); } catch { /* ignore */ }
    await sleep(200);
  }
  for (const pid of await listeningPids(REMOTE.port)) {
    if (await killPid(pid)) report.guardKilled = true;
  }
  guardChild = null;

  // ④ 兜底: 隧道是 detached 启动的, 守卫死了它可能还活着
  const tstate = readJsonSafe(FILE.tunnel(), null);
  if (tstate && tstate.pid && await pidAlive(tstate.pid)) {
    report.orphanKilled = await killPid(tstate.pid);
  }
  try { await fs.writeFile(FILE.tunnel(), JSON.stringify({ pid: null, url: null, startedAt: null, desired: false }), 'utf8'); } catch { /* ignore */ }
  try { await fs.rm(FILE.url(), { force: true }); } catch { /* ignore */ }
  await stopProxy();                       // 入口层最后收(隧道已停, 没人再打它)
  // 2026-10-14: 心跳已移除, 无需再 stopHeartbeat()
  log('已停止远程访问: ' + JSON.stringify(report));
  return report;
}

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

export async function listeningPids(port = REMOTE.port) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) -join ','`],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout).trim().split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0));
      });
  });
}

/** 找出**没有被 tunnel.json 登记**、但指向本入口端口的 cloudflared 进程(孤儿隧道)。
 *  为什么需要: 应用被强制结束(任务管理器/taskkill /F)时, before-quit 不会跑,
 *  隧道是 detached 启动的 → 它会活下来, 而状态文件里已经没有它的 pid 了。
 *  修复功能必须能识别这种情况, 否则"入口看起来在、其实指向一个死掉的守卫"。 */
export async function findOrphanTunnels() {
  const registered = lastSpawnedTunnelPid();
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -like '*127.0.0.1:${REMOTE.port}*' } | ForEach-Object { $_.ProcessId }`],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        const pids = String(stdout).trim().split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
        resolve(pids.filter((p) => p !== registered));
      });
  });
}

// ------------------------------------------------------------
// 状态
// ------------------------------------------------------------
export function status() {
  const t = readJsonSafe(FILE.tunnel(), null);
  const link = currentLink();
  // "归我管"的判断: 存活标记文件新鲜(15 秒写一次, 容忍 90 秒) —— 而不是看进程内是否有子进程句柄
  let aliveMarker = false;
  let aliveness = null;
  try {
    const raw = readTextSafe(aliveFile());
    const ts = Number(raw);
    if (Number.isFinite(ts) && ts > 0) {
      aliveness = Date.now() - ts;
      aliveMarker = aliveness < 90000;
    }
  } catch { /* ignore */ }
  return {
    running: aliveMarker,
    managed: aliveMarker,
    port: REMOTE.port,
    stateDir: REMOTE.stateDir,
    guardUp: !!readJsonSafe(FILE.conf(), null),
    tunnelPid: t && t.pid ? t.pid : null,
    tunnelRestarts: t && Number.isFinite(t.restarts) ? t.restarts : 0,
    desired: t ? t.desired !== false : null,
    base: link.base,
    linkUrl: link.url,
    linkReady: link.ready,
    linkLocal: link.local,
    linkCreatedAt: link.createdAt,
    startedAt: startedAt || null,
    uptimeSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    aliveAgeMs: aliveness,
    lastError,
  };
}

// ------------------------------------------------------------
// 诊断与修复(供应用设置页与「待办提醒修复工具」共用)
// ------------------------------------------------------------
export async function check({ upstreamPort = 8790, publicTimeoutMs = 12000 } = {}) {
  const steps = [];
  const add = (name, ok, detail, fix) => steps.push({ name, ok, detail, fix: ok ? '' : (fix || '') });

  // 1) 上游应用
  let upstreamOk = false, upstreamDetail = '';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`http://127.0.0.1:${upstreamPort}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    upstreamOk = r.ok && j && j.ok;
    upstreamDetail = upstreamOk ? `记录 ${j.total} 条 · ${j.app} ${j.version}` : `HTTP ${r.status}`;
  } catch (e) { upstreamDetail = e.message; }
  add('上游应用', upstreamOk, upstreamDetail, `电脑上的待办提醒没在运行(端口 ${upstreamPort} 无响应)`);

  // 2) 依赖
  const pre = preflight({ upstreamPort });
  add('依赖(守卫/cloudflared)', pre.problems.length === 0,
    pre.problems.length ? pre.problems.map((p) => p.name).join(', ') + ' 缺失' : '齐备',
    pre.problems.map((p) => p.fix).join(' ; '));

  // 2b) 守卫的「宿主存活检查」补丁
  // 2026-10-14：宿主心跳已按用户要求移除，本应用不再写存活标记，
  // 因此这一项无法再判定"当前是否有人照看入口"，仅如实报告补丁是否装上。
  let patched = false;
  try {
    const src = readFileSync(REMOTE.guardPath, 'utf8');
    patched = src.includes('TODO_HOST_LIVENESS_PATCH');
  } catch { /* ignore */ }
  add('宿主存活保护', false,
    patched ? '补丁已装，但宿主心跳机制已于 2026-10-14 移除 —— 该保护实际不生效' : '守卫缺少宿主存活检查补丁（心跳机制已移除，此项已无意义）',
    '应用被强制结束时会留下孤儿隧道；原先靠宿主心跳 + 守卫补丁自动回收，现需手动停止远程访问');

  // 3) 守卫
  const portUp = await isPortListening();
  const h = portUp ? await health() : null;
  add('本地守卫', portUp, portUp ? `${REMOTE.bind}:${REMOTE.port} 监听中` : `${REMOTE.port} 无监听`,
    '入口服务没起来 —— 点「启动远程访问」, 或用修复工具的连接修复');

  // 3b) 入口层(公网隧道实际指向它; 用应用连接码鉴权)
  const pxh = await proxyHealth();
  add('手机入口层', !!pxh,
    pxh ? `${PROXY.bind}:${PROXY.port} 就绪(用应用连接码鉴权)` : `${PROXY.port} 无响应`,
    '入口层没起来 —— 点「重启远程访问」(隧道会指向它, 少了这层手机的原生同步会被拒)');

  // 4) 隧道进程
  const t = readJsonSafe(FILE.tunnel(), null);
  const tunnelAlive = !!(t && t.pid && await pidAlive(t.pid));
  add('隧道进程', tunnelAlive, tunnelAlive ? `cloudflared pid ${t.pid} · 重启 ${t.restarts || 0} 次` : '没有在跑的 cloudflared',
    '隧道没起来 —— 点「重启远程访问」; 若反复失败检查 cloudflared 路径');

  // 4b) 孤儿隧道(没被状态文件登记、却还指着本入口)
  const orphans = await findOrphanTunnels();
  add('无残留孤儿隧道', orphans.length === 0,
    orphans.length ? `发现 ${orphans.length} 个未登记的隧道进程(pid ${orphans.join(', ')})` : '无',
    '存在孤儿隧道 —— 点「一键修复」清掉(否则旧域名可能指向已停的入口)');

  // 5) 公网域名
  const base = publicBase();
  add('公网入口', !!base, base || '还没有公网域名(首次启动需要 5–30 秒)',
    '域名还没分配 —— 稍等或点「重启远程访问」');

  // 6) 公网可达性(真的打一次 —— 打入口层自己的健康端点, 它不鉴权)
  let reach = { ok: false, detail: '未测(还没有公网域名)' };
  if (base) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), publicTimeoutMs);
      const r = await fetch(base + '/__remote/health', { signal: ctl.signal });
      clearTimeout(timer);
      const body = (await r.text().catch(() => '')).trim().slice(0, 60);
      const okBody = /todo-remote-proxy/.test(body) || /"ok"\s*:\s*true/.test(body);
      reach = { ok: r.ok && okBody, detail: `HTTP ${r.status} ${body}` };
      if (!r.ok || !okBody) {
        reach.detail += ' —— 公网这一跳打到了但没打到入口层';
        reach.fix = '隧道可能还指向旧目标(守卫)或域名已过期 —— 点「重启远程访问」重新分配';
      }
    } catch (e) {
      reach = { ok: false, detail: '打不通: ' + (e.cause?.code || e.message), fix: '域名可能刚分配还没生效 —— 稍等再刷新; 若一直不行点「重启远程访问」' };
    }
  }
  add('公网可达', reach.ok, reach.detail, reach.fix || '');

  // 7) 手机链接
  const link = currentLink();
  add('手机链接', !!link.url && link.ready, link.ready ? link.base : (link.url ? '(仅本机可用)' : '未生成'),
    '链接未就绪 —— 等公网域名分配完成; 已分配则点「重置链接」重新生成');

  // 8) 鉴权边界: 必须从**公网**测
  let authOk = false, authDetail = '';
  if (base) {
    try {
      const r = await fetch(base + '/api/todos', { redirect: 'manual' });
      authOk = r.status === 401 || r.status === 403;
      authDetail = `公网无凭据访问 → HTTP ${r.status}` + (authOk ? '' : '(应为 401/403)');
    } catch (e) { authDetail = '公网鉴权探测失败: ' + (e.cause?.code || e.message); }
  } else if (portUp) {
    authOk = true;
    authDetail = '还没有公网域名, 未测(本机直连信任属设计)';
  } else { authDetail = '守卫未运行, 未测'; }
  add('鉴权边界(公网无凭据应被拒)', authOk, authDetail,
    '公网无凭据竟然能访问 —— 检查守卫配置(是否把上游直接暴露了)');

  // 9) 手机那条路能不能真的同步: 用**应用连接码**经公网打一次 /api/sync。
  //    这一步是最贴近真机的验证 —— 手机一体包就是这么发的(x-token 头)。
  let phoneOk = false, phoneDetail = '';
  const tok = appToken();
  if (base && tok) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(base + '/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-token': tok },
        body: JSON.stringify({ todos: [] }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const j = await r.json().catch(() => null);
      const n = j && Array.isArray(j.todos) ? j.todos.filter((x) => !x.deleted).length : -1;
      phoneOk = r.ok && n >= 0;
      phoneDetail = phoneOk ? `HTTP ${r.status} · 读到 ${n} 条有效记录` : `HTTP ${r.status}(手机这样发会被拒)`;
    } catch (e) { phoneDetail = '打不通: ' + (e.cause?.code || e.message); }
  } else { phoneDetail = tok ? '还没有公网域名, 未测' : '读不到应用连接码, 未测'; }
  add('手机同步路径(经公网 + 连接码)', phoneOk, phoneDetail,
    '手机经公网同步被拒 —— 检查入口层是否在跑(它负责用应用连接码鉴权并转发)');

  return {
    ok: steps.every((s) => s.ok),
    steps,
    status: status(),
    link: currentLink(),
  };
}

export async function pidAlive(pid) {
  if (!pid) return false;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'y' }`],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => resolve(!err && String(stdout).trim() === 'y'));
  });
}

/** 上游应用(待办桌面端)的健康探测 */
export async function upstreamAlive(upstreamPort = 8790, timeoutMs = 3000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${upstreamPort}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

/** 从本模块位置推断应用根目录(core/remote.mjs 的上一级) */
function inferAppDir() {
  try {
    if (process.env.TODO_REMOTE_APPDIR) return process.env.TODO_REMOTE_APPDIR;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.resolve(here, '..');
    return existsSync(path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')) ? dir : null;
  } catch { return null; }
}

/** 把待办桌面端拉起来(隐藏窗口)。
 *  为什么必须做: 远程入口再健康也没用 —— 上游应用自己没在跑, 手机连上也只会 502。
 *  修复要一路修到"应用也在运行", 否则就是"修了但还是连不上"。 */
export async function ensureUpstream(upstreamPort = 8790, { appDir = null, timeoutMs = 90000 } = {}) {
  if (await upstreamAlive(upstreamPort)) return { started: false, already: true };
  const dir = appDir || inferAppDir();
  if (!dir) return { started: false, error: '无法推断应用目录(可设 TODO_REMOTE_APPDIR)' };
  const exe = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(exe)) return { started: false, error: '找不到 electron.exe: ' + exe };
  log('上游应用没在跑 → 拉起它: ' + exe);
  const child = spawn(exe, ['--hidden', dir], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref?.();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await upstreamAlive(upstreamPort, 2000)) return { started: true, pid: child.pid };
    await sleep(1500);
  }
  return { started: true, pid: child.pid, error: '应用已拉起但健康检查超时(可能还在初始化)' };
}

/** 一键修复: 拉应用 → 清孤儿 → 重启守卫/隧道 → 复诊 */
export async function repair({ upstreamPort = 8790, onProgress = () => {}, appDir = null } = {}) {
  const before = await check({ upstreamPort });
  const actions = [];

  // 0) 上游应用没在跑 → 先拉起来。顺序很重要: 应用不在, 后面全白修。
  const upStep = before.steps.find((s) => s.name.includes('上游应用'));
  if (!upStep || !upStep.ok) {
    onProgress('上游应用没在跑, 先拉起桌面应用…');
    const r = await ensureUpstream(upstreamPort, { appDir });
    actions.push(r.already ? '上游应用已在运行'
      : r.error ? ('拉起上游应用: ' + r.error)
        : ('已拉起桌面应用(pid ' + r.pid + ')'));
  }

  // 孤儿守卫: 端口有东西在监听, 但本进程没拉起过它 → 先收干净再重来
  if (!isGuardRunning() && (await isPortListening())) {
    onProgress('发现无主守卫, 先清理…');
    const pids = await listeningPids();
    for (const pid of pids) { try { await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* ignore */ } }
    actions.push(`清理无主守卫(pid ${pids.join(',')})`);
  }
  // 孤儿隧道(没登记但还指着入口)
  const orphans = await findOrphanTunnels();
  if (orphans.length) {
    onProgress(`清理 ${orphans.length} 个孤儿隧道…`);
    for (const pid of orphans) { await killPid(pid); }
    actions.push(`清理孤儿隧道(pid ${orphans.join(', ')})`);
  }
  // 登记在案但已失效的隧道状态
  const t = readJsonSafe(FILE.tunnel(), null);
  if (t && t.pid && !(await pidAlive(t.pid))) {
    actions.push('清理失效的隧道状态');
    try { await fs.writeFile(FILE.tunnel(), JSON.stringify({ pid: null, url: null, startedAt: null, desired: true }), 'utf8'); } catch { /* ignore */ }
  }

  onProgress('重启入口服务…');
  await stop({ timeoutMs: 3000 });
  const r = await start({ upstreamPort, onProgress });
  actions.push(r.ok ? '已重新拉起守卫与隧道' : '拉起失败: ' + (r.error || ''));

  const after = await check({ upstreamPort, publicTimeoutMs: 15000 });
  return { ok: after.ok, actions, before, after };
}

/** 重置手机链接(旧链接立刻作废)。
 *  守卫在跑时走它的控制面 POST /__guard/reset —— 必须这样, 因为守卫
 *  在内存里持有配置、60 秒节流回写, 直接改文件会和它互相覆盖。 */
export async function resetLink() {
  if (await isPortListening()) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`http://${REMOTE.bind}:${REMOTE.port}/__guard/reset`, { method: 'POST', signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) return { ok: true, via: 'guard', link: currentLink() };
    } catch { /* 控制面不通 → 落到文件方式 */ }
  }
  // 守卫没跑: 直接改状态文件(没有内存副本, 安全)
  const conf = readJsonSafe(FILE.conf(), null);
  if (!conf) return { ok: false, error: '读不到守卫配置: ' + FILE.conf() };
  const tok = () => {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString('base64url');
  };
  conf.links = conf.links || {};
  conf.links.owner = { token: tok(), role: 'owner', name: '我的手机', createdAt: new Date().toISOString() };
  conf.links.readonly = { token: tok(), role: 'readonly', name: '只读设备', createdAt: new Date().toISOString() };
  conf.devices = [];   // 旧设备凭据一并作废
  conf.sessions = [];
  await fs.writeFile(FILE.conf(), JSON.stringify(conf, null, 2), 'utf8');
  return { ok: true, via: 'file', link: currentLink() };
}

/** 读取最近的守卫/隧道日志尾部(排障用) */
export async function tailLogs(lines = 12) {
  const out = {};
  for (const [k, f] of [['guard', FILE.guardLog()], ['tunnel', FILE.log()]]) {
    try {
      const txt = await fs.readFile(f, 'utf8');
      out[k] = txt.trim().split(/\r?\n/).slice(-lines);
    } catch { out[k] = []; }
  }
  return out;
}
