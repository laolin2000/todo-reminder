// 给安卓模拟环境注入“今天”的重叠时段与重叠待办(轨迹视图分行验证用)
// 用法: node scripts/sim-seed-trace.mjs [port]
const port = Number(process.argv[2] || 18792);
const BASE = `http://127.0.0.1:${port}`;

const now = new Date();
const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const t = (h, m) => dayStart + (h * 60 + m) * 60000;
const at = Date.now();

const todos = [
  { id: 'tr-a', title: '待办A·早间任务', notes: '', location: '教室101', dueAt: t(9, 10), importance: 1, materials: [], durationMin: 60, slotId: '', independent: true, status: 'todo', remindBeforeMin: 10, repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 1, deleted: false },
  { id: 'tr-b', title: '待办B·与A重叠', notes: '', location: '', dueAt: t(9, 45), importance: 2, materials: [], durationMin: 45, slotId: '', independent: true, status: 'todo', remindBeforeMin: 10, repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 2, deleted: false },
  { id: 'tr-c', title: '午间待办C', notes: '', location: '食堂', dueAt: t(12, 20), importance: 0, materials: [], durationMin: 30, slotId: '', independent: true, status: 'todo', remindBeforeMin: 5, repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 3, deleted: false },
];

function per(id, name, s, e, colorSlot) {
  return {
    id, name, idleName: '', startMin: s, endMin: e,
    nodes: [{ startMin: s, endMin: e }], env: '', priority: 1, remindBeforeMin: 10,
    freq: 'daily', weekdays: [], monthDay: null, startMD: null, endMD: null,
    colorSlot, createdAt: at, updatedAt: at + 10, deleted: false,
  };
}
const periods = [
  per('p-1', '早间自习室', 8 * 60, 10 * 60, 0),
  per('p-2', '操作系统课', 9 * 60, 11 * 60 + 30, 3),   // 与 p-1 重叠 → 应分行
  per('p-3', '午间休息', 12 * 60, 13 * 60, 5),           // 单独, 应与 p-1 同行
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
