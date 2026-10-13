// 注入“多时间点(多节点)时段”演示数据: 一天两个激活窗口 + 窗口间空闲态
// 用法: node scripts/sim-seed-multinode.mjs [port]
const port = Number(process.argv[2] || 18800);
const BASE = `http://127.0.0.1:${port}`;
const now = new Date();
const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const t = (h, m) => dayStart + (h * 60 + m) * 60000;
const at = Date.now();

const todos = [
  { id: 'mn-t1', title: '上午冲刺任务', notes: '', location: '工位', dueAt: t(9, 5), importance: 1, materials: [], durationMin: 55, slotId: '', independent: true, status: 'todo', remindBeforeMin: 10, repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 1, deleted: false },
  { id: 'mn-t2', title: '下午整理笔记', notes: '', location: '', dueAt: t(14, 20), importance: 0, materials: [], durationMin: 40, slotId: '', independent: true, status: 'todo', remindBeforeMin: 10, repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 2, deleted: false },
];

function per(id, name, idleName, windows, colorSlot) {
  const nodes = windows.map(([s, e]) => ({ startMin: s, endMin: e }));
  const [s0, e0] = windows[0];
  return {
    id, name, idleName, startMin: s0, endMin: e0, nodes,
    env: '', priority: 1, remindBeforeMin: 10, freq: 'daily', weekdays: [],
    monthDay: null, startMD: null, endMD: null, colorSlot,
    createdAt: at, updatedAt: at + 10, deleted: false,
  };
}
const H = (h, m) => h * 60 + m;
const periods = [
  // 主演示: 多节点时段(两个激活窗口), idleName 用于窗口之间“未激活态”
  per('mn-p1', '开发冲刺', '中场休息·充电', [[H(9, 0), H(10, 30)], [H(14, 0), H(16, 0)]], 0),
  // 对照组: 与上午窗口重叠的独立短时段(用于看分行/协调)
  per('mn-p2', '站会', '', [[H(9, 10), H(9, 40)]], 4),
];

const r1 = await fetch(`${BASE}/api/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ todos }),
});
const j1 = await r1.json();
const r2 = await fetch(`${BASE}/api/periods/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ periods }),
});
const j2 = await r2.json();
console.log('seed todos:', j1.todos.length, 'periods:', j2.periods.length);
