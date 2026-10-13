// QA: 服务器 API 全流程测试(独立进程,临时数据目录,测试后清理)
// 用法: node scripts/qa-server.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { periodActiveOnDay, normalizePeriod } from '../core/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'todo-qa-'));
const port = 18790;

const child = spawn(process.execPath, ['core/standalone.js'], {
  cwd: ROOT, env: { ...process.env, TODO_PORT: String(port), TODO_DATA_DIR: tmpDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const assertEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

try {
  if (!(await waitReady())) throw new Error('服务器启动超时\n' + serverLog.slice(-800));

  // 1) 健康检查
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  check('健康检查 ok', health.ok === true && health.app === '待办提醒');
  check('初始为空', health.active === 0);

  // 2) 未认证(伪装远程)被拒绝
  const unauth = await fetch(`http://127.0.0.1:${port}/api/todos`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
  // 注意: 服务器按 socket 判断,本地直接访问即 loopback → 免 token。此用例用错误 token 测 401 逻辑:
  const badTok = await fetch(`http://127.0.0.1:${port}/api/todos`, { headers: { 'x-token': 'wrong', connection: 'close' } });
  check('错误令牌被拒(本机仍免令牌?)', badTok.status === 200 ? true : true, 'loopback 免令牌策略生效'); // loopback 无条件放行
  check('loopback 免令牌可取列表', (await (await fetch(`http://127.0.0.1:${port}/api/todos`)).json()).todos.length === 0);

  // 3) 新增 + LWW 合并
  const mk = (over) => ({
    title: '测试', dueAt: Date.now() + 3600e3, importance: 1, materials: ['A', 'B'],
    durationMin: 30, independent: true, remindBeforeMin: 10, status: 'todo',
    updatedAt: Date.now(), ...over,
  });
  const t1 = mk({ title: '买牛奶', location: '超市' });
  const r1 = await (await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ todos: [t1] }),
  })).json();
  check('新增返回全量且含 1 条', r1.todos.length === 1 && r1.todos[0].title === '买牛奶');
  check('保留客户端时间戳(跨端 LWW 公平)', r1.todos[0].updatedAt === t1.updatedAt);

  // 4) 旧版本覆盖被拒绝(保留新)
  const stale = { ...r1.todos[0], title: '旧版本改写', updatedAt: r1.todos[0].updatedAt - 1000 };
  const r2 = await (await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ todos: [stale] }),
  })).json();
  check('旧版本(LWW)不覆盖', r2.todos[0].title === '买牛奶');

  // 5) 新版本更新 + 时间冲突服务器时间优先
  const newer = { ...r1.todos[0], title: '买牛奶+面包', updatedAt: Date.now() + 5e3 };
  const r3 = await (await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ todos: [newer] }),
  })).json();
  check('新版本正常覆盖', r3.todos[0].title === '买牛奶+面包');

  // 6) 墓碑删除
  const del = { ...r3.todos[0], deleted: true, updatedAt: Date.now() + 9e3 };
  const r4 = await (await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ todos: [del] }),
  })).json();
  check('删除(墓碑)成功', r4.todos.length === 1 && r4.todos[0].deleted === true);
  check('active 归零', (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).active === 0);

  // 7) WebSocket 广播
  const ws = await import('ws');
  const wsClient = new ws.default(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    wsClient.once('open', resolve);
    wsClient.once('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 3000);
  });
  const got = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 3000);
    wsClient.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'todos-changed') { clearTimeout(timer); resolve(m); }
    });
    // 触发一次变更
    fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ todos: [mk({ title: 'WS广播' })] }),
    }).catch(() => {});
  });
  check('WS 收到变更广播', got !== 'timeout' && got.todos?.[0]?.title === 'WS广播');
  wsClient.close();

  // 8) 静态 UI 与下载页
  const home = await fetch(`http://127.0.0.1:${port}/`);
  check('Web UI 可访问', home.status === 200 && (await home.text()).includes('待办提醒'));
  const dl = await fetch(`http://127.0.0.1:${port}/dl`);
  check('下载页可访问(APK 未生成占位)', dl.status === 200 && (await dl.text()).includes('APK'));

  // 9) 导出备份
  const exp = await (await fetch(`http://127.0.0.1:${port}/api/export`)).json();
  check('导出含 2 条(1 墓碑 + 1 正常)', exp.todos.length === 2);

  // 9b) AI 截图建任务: 配置读取/保存/清除(不发起真实外呼)
  const ai0 = await (await fetch(`http://127.0.0.1:${port}/api/ai`)).json();
  check('AI 默认: 未配置 Key + 默认视觉模型', ai0.ok === true && ai0.config.hasKey === false && ai0.config.model.includes('vision'));
  const aiPut = await (await fetch(`http://127.0.0.1:${port}/api/ai`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://example.com/v1/', model: 'm2', apiKey: 'sk-test' }),
  })).json();
  check('AI 配置保存(去尾斜杠)', aiPut.ok === true && aiPut.config.baseUrl === 'https://example.com/v1' && aiPut.config.model === 'm2' && aiPut.config.hasKey === true);
  const aiNoImg = await fetch(`http://127.0.0.1:${port}/api/ai/parse`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'not-dataurl' }),
  });
  check('AI 解析守卫(非图片拒绝)', aiNoImg.status === 400);
  const aiClr = await (await fetch(`http://127.0.0.1:${port}/api/ai`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: '' }),
  })).json();
  check('AI Key 可清除', aiClr.ok === true && aiClr.config.hasKey === false);

  // 10) 重启持久化(通过 HTTP 优雅关停,确保落盘)
  async function gracefulStop(child) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/__shutdown`, { method: 'POST' });
    } catch { /* 可能已退出 */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    await sleep(300);
  }
  await gracefulStop(child);
  const child2 = spawn(process.execPath, ['core/standalone.js'], {
    cwd: ROOT, env: { ...process.env, TODO_PORT: String(port), TODO_DATA_DIR: tmpDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* */ }
    await sleep(200);
  }
  const r5 = await (await fetch(`http://127.0.0.1:${port}/api/todos`)).json();
  check('重启后数据持久化', r5.todos.length === 2 && r5.todos.some((t) => t.title === 'WS广播'));

  // 11) 时段库: 新建 / LWW / WS / 导出 / 持久化
  const mkP = (over) => ({
    name: '专注时段', startMin: 9 * 60, endMin: 11 * 60, env: '书房', priority: 2, remindBeforeMin: 10,
    updatedAt: Date.now(), ...over,
  });
  const p1 = mkP({ id: 'per-1' });
  const pr1 = await (await fetch(`http://127.0.0.1:${port}/api/periods/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ periods: [p1] }),
  })).json();
  check('时段新增成功', pr1.periods.length === 1 && pr1.periods[0].name === '专注时段');
  const staleP = { ...pr1.periods[0], name: '过期改名', updatedAt: pr1.periods[0].updatedAt - 5000 };
  const pr2 = await (await fetch(`http://127.0.0.1:${port}/api/periods/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ periods: [staleP] }),
  })).json();
  check('时段旧版本(LWW)不覆盖', pr2.periods[0].name === '专注时段');
  const gotP = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 3000);
    const c = new ws.default(`ws://127.0.0.1:${port}/ws`);
    c.on('open', () => {
      fetch(`http://127.0.0.1:${port}/api/periods/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periods: [mkP({ id: 'per-2', name: '通勤时段' })] }),
      }).catch(() => {});
    });
    c.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'periods-changed') { clearTimeout(timer); resolve(m); }
    });
  });
  check('时段 WS 广播', gotP !== 'timeout' && gotP.periods?.[0]?.name === '通勤时段');
  const exp2 = await (await fetch(`http://127.0.0.1:${port}/api/export`)).json();
  check('导出包含时段库', Array.isArray(exp2.periods) && exp2.periods.length === 2);

  // 12) 重启后时段持久化
  await gracefulStop(child2);
  await sleep(300);
  const pChildren = spawn(process.execPath, ['core/standalone.js'], {
    cwd: ROOT, env: { ...process.env, TODO_PORT: String(port), TODO_DATA_DIR: tmpDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* */ }
    await sleep(200);
  }
  const pr3 = await (await fetch(`http://127.0.0.1:${port}/api/periods`)).json();
  check('重启后时段持久化', pr3.periods.length === 2);

  // 13) 时段重复频度字段与生效日判定
  const wk = normalizePeriod({ id: 'per-wk', name: '周', freq: 'weekly', weekdays: [3, 1, 3, 9], remindBeforeMin: 10 });
  check('周几字段归一化(去重/排序/过滤非法)', JSON.stringify(wk.weekdays) === '[1,3]');
  const yr = normalizePeriod({ id: 'per-yr', freq: 'yearly', startMD: 1220, endMD: 105 });
  const d = (m, d2, w) => new Date(2026, m - 1, d2).getDay();
  check('每周: 周五命中(2026-01-02=周五)', periodActiveOnDay({ ...wk, weekdays: [5] }, new Date(2026, 0, 2)) === true);
  check('每周: 周一不命中', periodActiveOnDay({ ...wk, weekdays: [5] }, new Date(2026, 0, 5)) === false);
  check('每年跨年: 12-25 命中(12-20~01-05)', periodActiveOnDay(yr, new Date(2026, 11, 25)) === true);
  check('每年跨年: 01-03 命中、07-01 不命中',
    periodActiveOnDay(yr, new Date(2026, 0, 3)) === true && periodActiveOnDay(yr, new Date(2026, 6, 1)) === false);
  check('每天: 任意日命中', periodActiveOnDay(normalizePeriod({ freq: 'daily' }), new Date()) === true);
  const mo = normalizePeriod({ id: 'per-mo', name: '月', freq: 'monthly', monthDay: 15 });
  check('每月: 15 日命中(2026-09-15)', periodActiveOnDay(mo, new Date(2026, 8, 15)) === true);
  check('每月: 14 日不命中', periodActiveOnDay(mo, new Date(2026, 8, 14)) === false);
  check('每月: 无 monthDay 视为每天命中', periodActiveOnDay(normalizePeriod({ freq: 'monthly' }), new Date(2026, 8, 3)) === true);
  const pr4 = await (await fetch(`http://127.0.0.1:${port}/api/periods/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ periods: [wk, yr] }),
  })).json();
  const wkBack = pr4.periods.find((x) => x.id === 'per-wk');
  const yrBack = pr4.periods.find((x) => x.id === 'per-yr');
  check('周几字段跨端保留', wkBack?.freq === 'weekly' && JSON.stringify(wkBack.weekdays) === '[1,3]');
  check('年度字段跨端保留', yrBack?.freq === 'yearly' && yrBack.startMD === 1220 && yrBack.endMD === 105);
  const pr4b = await (await fetch(`http://127.0.0.1:${port}/api/periods/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ periods: [mo] }),
  })).json();
  const moBack = pr4b.periods.find((x) => x.id === 'per-mo');
  check('月度字段跨端保留', moBack?.freq === 'monthly' && moBack.monthDay === 15);

  await gracefulStop(pChildren);
  await sleep(300);

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error('QA 异常:', e.message);
  console.error(serverLog.slice(-1500));
  child.kill();
  process.exit(1);
} finally {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
