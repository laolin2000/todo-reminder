// 合并用户真实 DSK 时段(高峰期×2 + 低谷期/低估期×2)为两个多节点时段,
// 注入模拟环境供截图。保留图书馆(可选)。用法: node scripts/sim-seed-dsk-merge.mjs [port] [lib=1]
const port = Number(process.argv[2] || 18800);
const includeLib = process.argv[3] === '1';
const BASE = `http://127.0.0.1:${port}`;
const at = Date.now();
const H = (h, m) => h * 60 + m;

function wkdayPeriod(id, name, idleName, windows, colorSlot, priority = 1) {
  const nodes = windows.map(([s, e]) => ({ startMin: s, endMin: e }));
  const [s0, e0] = windows[0];
  return {
    id, name, idleName, startMin: s0, endMin: e0, nodes,
    env: '宿舍', priority, remindBeforeMin: 10, freq: 'weekly', weekdays: [1, 2, 3, 4, 5],
    monthDay: null, startMD: null, endMD: null, colorSlot,
    createdAt: at, updatedAt: at + 10, deleted: false,
  };
}

// 与用户真实数据一致(合并后, 低谷期连成跨夜一条龙):
//   DSK 高峰期 = 09:00–12:00 + 14:00–18:00
//   DSK 低谷期 = 12:00–14:00 + 18:00 → 次日 09:00(跨午夜单节点, 视图自动拆 18–24 与 0–9)
const periods = [
  wkdayPeriod('dsk-hi', 'DSK 高峰期', '', [[H(9, 0), H(12, 0)], [H(14, 0), H(18, 0)]], 3),
  wkdayPeriod('dsk-lo', 'DSK 低谷期', '', [[H(12, 0), H(14, 0)], [H(18, 0), H(9, 0)]], 4), // 1080→540 跨午夜
];
if (includeLib) {
  periods.push({
    id: 'lib-1', name: '图书馆', idleName: '', startMin: 480, endMin: 1200,
    nodes: [{ startMin: 480, endMin: 1200 }], env: '安静', priority: 2, remindBeforeMin: 10,
    freq: 'weekly', weekdays: [1, 2, 3, 4, 5], monthDay: null, startMD: null, endMD: null,
    colorSlot: 0, createdAt: at, updatedAt: at + 10, deleted: false,
  });
}

const r2 = await fetch(`${BASE}/api/periods/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ periods }),
});
const j2 = await r2.json();

// 轨迹时间轴需要有带时间的待办才渲染: 在下一个工作日 09:30 放一条
const d0 = new Date();
let off = 1;
while (off <= 7) { const w = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + off).getDay(); if (w >= 1 && w <= 5) break; off++; }
const dayStart = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + off).getTime();
const todo = {
  id: 'dsk-t1', title: '高峰时段任务·示例', notes: '', location: '宿舍', dueAt: dayStart + H(9, 30) * 60000,
  importance: 1, materials: [], durationMin: 45, slotId: '', independent: true, status: 'todo',
  remindBeforeMin: 10, repeat: 'none', fuzzy: false, createdAt: at, updatedAt: at + 1, deleted: false,
};
const r1 = await fetch(`${BASE}/api/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ todos: [todo] }),
});
const j1 = await r1.json();
console.log('seed periods:', j2.periods.length, 'todos:', j1.todos.length, 'includeLib=', includeLib, 'dayOff=', off);
