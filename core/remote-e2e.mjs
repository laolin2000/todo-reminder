// 端到端(适配新的入口层架构): 公网入口 + 应用连接码 → 读/写/实时都通
// 手机一体包就是这么连的: x-token 头(原生)或 ?token=(浏览器)
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';

const STATE = 'D:\\toolresources\\Ztool\\待办提醒-远程连接\\state';
const base = (await fs.readFile(STATE + '\\public-url.txt', 'utf8')).trim().replace(/\/+$/, '');
const cfg = JSON.parse(await fs.readFile(process.env.APPDATA + '\\待办提醒\\data\\config.json', 'utf8'));
const token = cfg.token;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

console.log('入口 =', base);

console.log('\n── 1 无凭据必须被拒(入口层鉴权) ──');
{
  const r = await fetch(base + '/api/todos', { redirect: 'manual' });
  ok(r.status === 401 || r.status === 403, `无凭据 /api/todos → HTTP ${r.status}(应 401/403)`);
  const bad = await fetch(base + '/api/todos', { headers: { 'x-token': 'definitely-wrong' } });
  ok(bad.status === 401 || bad.status === 403, `错误连接码 → HTTP ${bad.status}(应 401/403)`);
}

console.log('\n── 2 手机包的写法: x-token 头 ──');
{
  const r = await fetch(base + '/api/todos', { headers: { 'x-token': token } });
  const j = await r.json();
  const n = Array.isArray(j.todos) ? j.todos.filter((t) => !t.deleted).length : -1;
  ok(r.ok && n >= 0, `/api/todos + x-token → HTTP ${r.status} · 有效记录 ${n}`);

  const s = await fetch(base + '/api/sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token },
    body: JSON.stringify({ todos: [] }),
  });
  const sj = await s.json();
  ok(s.ok && Array.isArray(sj.todos), `POST /api/sync + x-token → HTTP ${s.status}`);
  ok(!!(sj.remote && sj.remote.publicUrl), '  └ 响应里带 remote.publicUrl(手机据此自动学习地址)');

  const p = await fetch(base + '/api/phone/update', { headers: { 'x-token': token } });
  const pj = await p.json();
  ok(p.ok && pj.latest && pj.latest.version, `GET /api/phone/update → 最新包 ${pj.latest && pj.latest.version}(versionCode ${pj.latest && pj.latest.versionCode})`);
}

console.log('\n── 3 浏览器写法: ?token= ──');
{
  const r = await fetch(base + '/?token=' + encodeURIComponent(token));
  ok(r.ok, `打开界面(带连接码)→ HTTP ${r.status}`);
  const t = await fetch(base + '/api/todos?token=' + encodeURIComponent(token));
  ok(t.ok, `/api/todos?token= → HTTP ${t.status}`);
}

console.log('\n── 4 确实是"原样转发到应用"(不是入口层自己应答) ──');
{
  const r = await fetch(base + '/api/definitely-not-a-route', { headers: { 'x-token': token } });
  const txt = await r.text();
  ok(r.status === 404 || /404/.test(txt), `未知路径 → HTTP ${r.status}(说明请求确实到了应用)`);
}

console.log('\n── 5 WebSocket(实时同步)经隧道 ──');
{
  const host = new URL(base).hostname;
  const ip = (await new Promise((r) => execFile('powershell.exe', ['-NoProfile', '-Command',
    `(Resolve-DnsName -Name '${host}' -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) -join ','`],
    { windowsHide: true, timeout: 15000 }, (e, o) => r(String(o || '').trim())))).split(',')[0];
  const mk = (tok) => `
import tls from 'node:tls';
const hn=process.argv[2], ip=process.argv[3];
const sock=tls.connect({host:ip,port:443,servername:hn},()=>{
  sock.write(['GET /ws?token=${tok} HTTP/1.1','Host: '+hn,'Upgrade: websocket','Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version: 13','',''].join('\\r\\n'));
});
let buf='';
const t=setTimeout(()=>{console.log('timeout');sock.destroy();process.exit(0)},20000);
sock.on('data',(d)=>{buf+=d.toString('latin1');if(buf.includes('\\r\\n\\r\\n')){clearTimeout(t);console.log(buf.split('\\r\\n')[0]);sock.destroy();process.exit(0)}});
sock.on('error',(e)=>{clearTimeout(t);console.log('error '+e.message);process.exit(0)});
`;
  const f1 = STATE + '\\_ws-ok.mjs', f2 = STATE + '\\_ws-bad.mjs';
  await fs.writeFile(f1, mk(token), 'utf8');
  await fs.writeFile(f2, mk('wrong'), 'utf8');
  const run = (f) => new Promise((r) => execFile(process.execPath, [f, host, ip],
    { windowsHide: true, timeout: 25000 }, (e, o) => r(String(o || '').trim())));
  // 刚建好的隧道在 Cloudflare 边缘生效需要一点时间, 升级可能瞬时失败 → 重试几次
  let good = '';
  for (let i = 0; i < 4; i++) {
    good = await run(f1);
    if (/101/.test(good)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const bad = await run(f2);
  await fs.rm(f1, { force: true });
  await fs.rm(f2, { force: true });
  console.log('  有效凭据 → ' + good);
  console.log('  错误凭据 → ' + bad);
  ok(/101/.test(good), 'WebSocket 升级成功(HTTP 101)');
  ok(/401/.test(bad) || /error/i.test(bad), 'WebSocket 无有效凭据被拒');
}

console.log(`\n结果: 通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
