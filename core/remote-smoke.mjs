// core/remote.mjs 真实冒烟测试: 起 → 探活 → 拿链接 → 关卡 → 验无孤儿
// 用法: node core/remote-smoke.mjs [waitMs]
import * as R from './remote.mjs';

const waitMs = Number(process.argv[2] || 150000);
R.setLogger((s) => console.log(s));
const line = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length)));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

line('0 前置');
const pre = R.preflight();
ok(pre.problems.length === 0, '依赖齐备(' + pre.ok.map((x) => x.name).join(', ') + ')');

line('1 启动');
const t0 = Date.now();
const r = await R.start({ upstreamPort: 8790, waitMs, onProgress: (p) => console.log('  … ' + p) });
console.log('  start 返回:', JSON.stringify({ ok: r.ok, running: r.running, error: r.error || '' }));
ok(await R.isPortListening(), '本地守卫在监听 ' + R.REMOTE.bind + ':' + R.REMOTE.port);
ok(!!(await R.health()), '守卫健康检查通过 /__guard/health');
console.log('  耗时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');

line('2 链接(不靠二维码/CLI, 直接拼)');
const link = R.currentLink();
console.log('  base =', link.base);
console.log('  url  =', link.url ? link.url.slice(0, 72) + '…' : '(空)');
ok(!!link.url, '已生成带 token 的手机链接');
ok(link.ready, '公网域名已就绪(而非仅本机)');

line('3 公网可达性(真打一次)');
if (link.base && /^https?:/.test(link.base)) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(link.base + '/__guard/health', { signal: ctl.signal });
    clearTimeout(t);
    const txt = await res.text();
    ok(res.ok && /ok/i.test(txt), `从本机回打公网入口 → HTTP ${res.status} ${txt.trim()}`);
  } catch (e) { ok(false, '公网回打失败: ' + e.message); }
  // 无凭据应被拒
  try {
    const res = await fetch(link.base + '/api/todos', { redirect: 'manual' });
    ok(res.status === 401 || res.status === 403, `无凭据访问 /api/todos → HTTP ${res.status}(应为 401/403)`);
  } catch (e) { ok(false, '鉴权探测失败: ' + e.message); }
}

line('4 隧道进程');
const tp = R.lastSpawnedTunnelPid();
ok(!!tp && await R.pidAlive(tp), 'cloudflared 在跑 pid=' + tp);

line('5 停止(验无孤儿)');
const rep = await R.stop();
console.log('  stop 报告:', JSON.stringify(rep));
ok(rep.intentCleared, '已关掉「想要隧道」意图(否则 10 秒后复活)');
ok(!(await R.isPortListening()), '守卫已停, 端口已释放');
ok(!tp || !(await R.pidAlive(tp)), 'cloudflared 已停, 没有孤儿隧道');
const conf = await import('node:fs').then((fs) => {
  try { return JSON.parse(fs.readFileSync(R.FILE.conf(), 'utf8')); } catch { return null; }
});
ok(conf && conf.superviseTunnel === false, '配置里 desired=false(superviseTunnel=false)');

line('6 再启动一次(验证幂等/可重复)');
const r2 = await R.start({ upstreamPort: 8790, waitMs: 60000, onProgress: (p) => console.log('  … ' + p) });
ok(r2.ok, '第二次启动成功(新域名)');
const link2 = R.currentLink();
console.log('  新 base =', link2.base);
await R.stop();
ok(!(await R.isPortListening()), '再次停止干净');

line('结果');
console.log(`  通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
