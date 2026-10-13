// 实时同步验证: 经公网 WS 连接 → 本机改一条待办 → 看是否收到 todos-changed
// 凭据用**应用连接码**(手机一体包 / 浏览器都这么带), 不再走守卫的 cookie 会话
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';

const DATA = process.env.APPDATA + '\\待办提醒\\data';
const STATE = 'D:\\toolresources\\Ztool\\待办提醒-远程连接\\state';
const base = (await fs.readFile(STATE + '\\public-url.txt', 'utf8')).trim().replace(/\/+$/, '');
const cfg = JSON.parse(await fs.readFile(DATA + '\\config.json', 'utf8'));
const token = cfg.token;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

// 取一条未完成待办(用于做一次无害改动: 改备注再改回来)
const local = JSON.parse(await fs.readFile(DATA + '\\todos.json', 'utf8'));
const target = local.filter((t) => !t.deleted && t.status !== 'done')[0];
ok(!!target, '找到用于测试的待办: ' + (target && target.title));

console.log('\n连接公网 WebSocket…');
const wsUrl = base.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
console.log('  ' + wsUrl.replace(/token=[^&]+/, 'token=***'));

const received = await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl);
  const got = [];
  const done = () => { try { ws.close(); } catch { /* ignore */ } resolve(got); };
  const t = setTimeout(done, 25000);
  ws.on('open', async () => {
    console.log('  ✅ WS 已连接(经隧道)');
    // 触发一次改动: 直接走本机服务器的同步接口改一条并改回
    const stamp = Date.now();
    const body = { todos: [{ ...target, notes: (target.notes || '') + '', updatedAt: stamp }] };
    await fetch('http://127.0.0.1:8790/api/sync', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': '' }, body: JSON.stringify(body),
    }).catch(() => {});
  });
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw));
      got.push(m.type || '?');
      if (m.type === 'todos-changed') { clearTimeout(t); done(); }
    } catch { /* ignore */ }
  });
  ws.on('error', (e) => { console.log('  WS 错误: ' + e.message); clearTimeout(t); done(); });
});

console.log('  收到消息类型:', JSON.stringify(received));
ok(received.includes('hello'), '收到 hello(连接握手)');
ok(received.includes('todos-changed'), '收到 todos-changed(实时广播穿透隧道)');

console.log(`\n结果: 通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
