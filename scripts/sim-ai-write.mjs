// ============================================================
// sim-ai-write.mjs — 把 AI 配置写入「隔离新手机」实例(端口18800)
// 内容与电脑端 ai.json / 手机 AiKit 内置默认完全一致, 写入后校验回读。
// 用法: node scripts/sim-ai-write.mjs
// ============================================================
const BASE = process.env.TODO_SIM_BASE || 'http://127.0.0.1:18800';

const CFG = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash-vision-exp',
  apiKey: <FILL_ME>
  periodTable: [
    '第1节 08:50-09:10',
    '第2节 09:15-09:55',
    '第3节 10:20-11:00',
    '第4节 11:05-11:45',
    '第5节 13:50-14:30',
    '第6节 14:55-15:15',
    '第7节 15:50-16:10',
    '第8节 16:15-16:55',
    '第9节 18:50-19:10',
    '第10节 19:15-19:55',
    '第11节 20:10-20:50',
  ].join('\n'),
  courseFix: '周三|大数据导论|18:50-19:55',
};

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

if (!(await waitReady())) {
  console.error('✗ 18800 实例未就绪');
  process.exit(1);
}

// 写入(与手机端 WebView 同路: POST /api/ai)
const put = await fetch(`${BASE}/api/ai`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(CFG),
});
const putJ = await put.json().catch(() => null);
console.log('POST /api/ai →', put.status, putJ?.ok === true ? 'ok' : JSON.stringify(putJ).slice(0, 200));
if (!putJ?.ok) process.exit(1);

// 回读校验
const got = await (await fetch(`${BASE}/api/ai`)).json();
const c = got.config || {};
const codes = (s) => [...s].map((ch) => ch.codePointAt(0).toString(16));
const exp = {
  baseUrl: CFG.baseUrl, model: CFG.model, hasKey: true,
  periodTable: CFG.periodTable, courseFix: CFG.courseFix,
};
const ok =
  c.baseUrl === exp.baseUrl && c.model === exp.model && c.hasKey === exp.hasKey &&
  c.periodTable === exp.periodTable && c.courseFix === exp.courseFix;

console.log('回读校验:');
console.log('  baseUrl      =', c.baseUrl);
console.log('  model        =', c.model);
console.log('  hasKey       =', c.hasKey);
console.log('  periodTable 行数 =', (c.periodTable || '').split('\n').length);
console.log('  periodTable 首行 =', (c.periodTable || '').split('\n')[0], '(码', codes('第'), ')');
console.log('  courseFix    =', c.courseFix);
console.log('  courseFix 码 =', codes(c.courseFix || '').slice(0, 6).join(','));
console.log(ok ? '\n✅ 写入且回读完全一致' : '\n❌ 不一致!', JSON.stringify(c).slice(0, 300));
process.exit(ok ? 0 : 1);
