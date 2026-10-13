// 安卓模拟全流程回归种子: 含“当前时段”激活横幅所需时段(08-22 跨现在)、
// DSK 合并时段(跨夜)、多类型待办(现在/重叠/明天)
const port = Number(process.argv[2] || 18792);
const BASE = `http://127.0.0.1:${port}`;
const now = new Date();
const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const at = Date.now();
const H = (h, m) => h * 60 + m;
const min = (n) => today0.getTime() + n * 60000;

const periods = [
  // 活跃中(08:00–22:00): 让列表顶部“当前时段”横幅真实渲染(curPeriodSeg 修复点)
  { id: 'ff-act', name: '专注时段(活跃中)', idleName: '', startMin: H(8, 0), endMin: H(22, 0),
    nodes: [{ startMin: H(8, 0), endMin: H(22, 0) }], env: '书桌', priority: 2, remindBeforeMin: 10,
    freq: 'daily', weekdays: [], monthDay: null, startMD: null, endMD: null, colorSlot: 2,
    createdAt: at, updatedAt: at + 1, deleted: false },
  // DSK 合并(周一~五, 跨夜低谷)
  { id: 'ff-hi', name: 'DSK 高峰期', idleName: '', startMin: H(9, 0), endMin: H(12, 0),
    nodes: [{ startMin: H(9, 0), endMin: H(12, 0) }, { startMin: H(14, 0), endMin: H(18, 0) }],
    env: '宿舍', priority: 1, remindBeforeMin: 10, freq: 'weekly', weekdays: [1, 2, 3, 4, 5],
    monthDay: null, startMD: null, endMD: null, colorSlot: 3, createdAt: at, updatedAt: at + 2, deleted: false },
  { id: 'ff-lo', name: 'DSK 低谷期', idleName: '', startMin: H(12, 0), endMin: H(14, 0),
    nodes: [{ startMin: H(12, 0), endMin: H(14, 0) }, { startMin: H(18, 0), endMin: H(9, 0) }],
    env: '宿舍', priority: 1, remindBeforeMin: 10, freq: 'weekly', weekdays: [1, 2, 3, 4, 5],
    monthDay: null, startMD: null, endMD: null, colorSlot: 4, createdAt: at, updatedAt: at + 3, deleted: false },
];

const nowMin = now.getHours() * 60 + now.getMinutes();
const mk = (id, title, dueMinFromNow, dur, location, importance) => ({
  id, title, notes: '备注·全流程回归🔁', location: location || '工位',
  dueAt: Date.now() + dueMinFromNow * 60000, importance, materials: ['材料甲📦'],
  durationMin: dur, slotId: '', independent: true, status: 'todo', remindBeforeMin: 10,
  repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 10, deleted: false,
});
const todos = [
  mk('ff-t1', '今天稍后任务·活页夹📎', 40, 60, '图书馆', 1),
  mk('ff-t2', '与t1重叠的任务', 70, 45, '会议室A', 2),   // 与 t1 部分重叠
  mk('ff-t3', '明天的事项预览', 24 * 60 + 30, 30, '', 0),
];

const r1 = await fetch(`${BASE}/api/periods/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ periods }),
});
const r2 = await fetch(`${BASE}/api/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ todos }),
});
const j1 = await r1.json(), j2 = await r2.json();
console.log('seed ok periods=' + j1.periods.length + ' todos=' + j2.todos.length + ' nowMin=' + nowMin);
