// ============================================================
// core/remote-proxy.mjs — 待办提醒 · 公网隧道入口(应用自己的鉴权)
// ------------------------------------------------------------
// 为什么需要这一层(而不是让隧道直连守卫):
//   dsh-remote 的「守卫」是给多设备/多角色场景设计的, 它有自己的凭据体系
//   (长期链接 → cookie 会话 / 一次性配对码 / 设备令牌), 并且会**明确拒绝**
//   经隧道而来、不带它那套凭据的请求(实测: 手机一体包发 x-token 一律 401)。
//   而待办提醒是单用户单手机 —— 应用自己的连接码就是唯一凭据, 再套一层守卫
//   等于多一道不必要的关卡, 还会把手机的原生同步挡在门外。
//
// 本层做什么(只绑回环, 公网唯一入口是隧道):
//   · 校验应用连接码: 接受 x-token 头 或 ?token=(GET/POST 都收, 方便原生客户端)
//   · 通过后**剥掉**凭据再转发给上游应用(应用对回环本免鉴权, 双保险)
//   · 代理 /api/*、/ws(WebSocket 升级)、/dl/* 与静态资源
//   · 探活 /__remote/health(不鉴权, 给诊断/看门狗用)
// ============================================================
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const PROXY = {
  port: Number(process.env.TODO_REMOTE_PROXY_PORT || 8445),
  bind: '127.0.0.1',
  upstreamHost: '127.0.0.1',
  upstreamPort: Number(process.env.TODO_REMOTE_UPSTREAM_PORT || 8790),
  // 2026-10-14：原为明文常量，上传脱敏时留下裸占位符导致语法错误；
  // 改为从环境变量读取（未设置即空串，与 README「密钥一律留空」的政策一致）。
  token: process.env.TODO_REMOTE_TOKEN || '',
};

export const PROXY_PID_FILE = 'proxy.pid';

// ------------------------------------------------------------
// 鉴权
// ------------------------------------------------------------
function tokenFrom(req, url) {
  const h = req.headers['x-token'];
  if (typeof h === 'string' && h) return h;
  const q = url.searchParams.get('token');
  if (q) return q;
  // 允许 ?t=<应用连接码> —— 手机 / 浏览器书签都可能这样带
  const t = url.searchParams.get('t');
  if (t) return t;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

export function checkToken(req, url, expect = PROXY.token) {
  if (!expect) return { ok: false, reason: 'no-token-configured' };
  const got = tokenFrom(req, url);
  if (!got) return { ok: false, reason: 'missing' };
  // 定长比较, 避免时序侧信道(单用户场景也照做, 成本为零)
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expect));
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? { ok: true } : { ok: false, reason: 'mismatch' };
}

function deny(res, reason) {
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>待办提醒 · 需要连接码</title></head>
<body style="font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif;background:#f2f4f9;color:#333;padding:36px 22px;line-height:1.9">
<h2 style="margin:0 0 10px">🔒 需要连接码</h2>
<p style="margin:0 0 6px">这个入口只给「待办提醒」自己的设备用。</p>
<p style="margin:0 0 6px">请在打开地址后带上连接码, 或从电脑端设置页复制<b>手机链接</b>重新打开(链接里自带凭据)。</p>
<p style="color:#888;font-size:13px;margin-top:14px">原因: ${reason || 'unauthenticated'}</p>
</body></html>`);
}

// ------------------------------------------------------------
// 转发
// ------------------------------------------------------------
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardedHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP.has(key)) continue;
    if (key === 'x-token' || key === 'authorization') continue;   // 凭据不进业务层
    if (key === 'cookie') continue;                               // 本层不用 cookie 会话
    out[key] = v;
  }
  out.host = `${PROXY.upstreamHost}:${PROXY.upstreamPort}`;
  out['accept-encoding'] = 'identity';
  return out;
}

/** 去掉 URL 里的 token 参数后再转发(避免它出现在上游日志里) */
function cleanUrl(raw) {
  try {
    const u = new URL(raw, 'http://x');
    u.searchParams.delete('token');
    u.searchParams.delete('t');
    const q = u.searchParams.toString();
    return u.pathname + (q ? '?' + q : '');
  } catch { return raw; }
}

export function createProxy() {
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { url = new URL('/', 'http://x'); }

    // 探活(不鉴权): 给诊断与看门狗用
    if (url.pathname === '/__remote/health') {
      const body = JSON.stringify({ ok: true, role: 'todo-remote-proxy', upstreamPort: PROXY.upstreamPort, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    const auth = checkToken(req, url);
    if (!auth.ok) { deny(res, auth.reason); return; }

    const up = http.request({
      host: PROXY.upstreamHost, port: PROXY.upstreamPort,
      method: req.method, path: cleanUrl(req.url), headers: forwardedHeaders(req),
    }, (ur) => {
      const h = { ...ur.headers };
      delete h['set-cookie'];
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
    });
    up.on('error', (e) => {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '上游应用不可达: ' + e.message }));
    });
    req.pipe(up);
  });

  // WebSocket / 其它升级请求: 直接透传字节流
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    const auth = checkToken(req, url);
    if (!auth.ok) {
      // 规范化: 无有效凭据的升级请求回 401(而不是让上游应用给出 500)
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      socket.destroy();
      return;
    }

    const upstream = net.connect(PROXY.upstreamPort, PROXY.upstreamHost, () => {
      const lines = [`${req.method} ${cleanUrl(req.url)} HTTP/1.1`];
      const hdrs = forwardedHeaders(req);
      hdrs.host = `${PROXY.upstreamHost}:${PROXY.upstreamPort}`;
      hdrs.connection = 'Upgrade';
      hdrs.upgrade = req.headers.upgrade || 'websocket';
      for (const [k, v] of Object.entries(hdrs)) lines.push(`${k}: ${v}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
    socket.on('error', () => { try { upstream.destroy(); } catch { /* ignore */ } });
  });

  return server;
}

export function startProxy({ port = PROXY.port, bind = PROXY.bind } = {}) {
  const server = createProxy();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => { server.off('error', reject); resolve(server); });
  });
}

// ------------------------------------------------------------
// 作为独立进程运行: node core/remote-proxy.mjs
// (由 core/remote.mjs 以「Electron 运行时当 Node 用」的方式拉起)
// ------------------------------------------------------------
const isMain = (() => {
  try {
    const self = fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
    const argv1 = String(process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    return self === argv1;
  } catch { return false; }
})();

if (isMain) {
  if (!PROXY.token) {
    process.stderr.write('[proxy] 缺少 TODO_REMOTE_TOKEN(应用连接码), 拒绝启动\n');
    process.exit(1);
  }
  try {
    const srv = await startProxy();
    process.stdout.write(`[proxy] 入口层就绪: http://${PROXY.bind}:${PROXY.port} → http://${PROXY.upstreamHost}:${PROXY.upstreamPort}\n`);
    // 收到终止信号就干净退出(不需要额外清理: 它只持有监听套接字)
    const bye = () => { try { srv.close(() => process.exit(0)); } catch { process.exit(0); } setTimeout(() => process.exit(0), 1500); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  } catch (e) {
    process.stderr.write('[proxy] 启动失败: ' + (e && e.message) + '\n');
    process.exit(1);
  }
}
