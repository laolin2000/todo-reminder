// 一次性真实数据迁移: 把旧的 4 个 DSK 分段时段合并为 2 个多节点时段
//   DSK 高峰期 = 09:00–12:00 + 14:00–18:00 (周一~五)
//   DSK 低谷期 = 12:00–14:00 + 18:00 → 次日 09:00 (跨午夜, 周一~五)
// 旧的 4 个时段置墓碑(不硬删, 保留历史); 图书馆等其它时段不动。
import crypto from 'node:crypto';
const BASE = 'http://127.0.0.1:8790';

const now = Date.now();
const OLD_IDS = [
  'ebe6c6fd-b398-4be2-b7be-d21192f5f93c', // DSK 高峰期 09-12
  '62cd1ae3-d178-43b2-aaca-ba31b18800d6', // DSK 低谷期 12-14
  '28fa0517-273c-4303-97f0-3f22e51c0a5c', // DSK 高峰期 14-18
  'a3b4e478-dd75-435c-ac7f-507ff49ddbb7', // DSK 低估期 18-18:30(并入低谷期)
];
const H = (h, m) => h * 60 + m;

const periods = [];
// 墓碑旧时段
for (const id of OLD_IDS) {
  periods.push({ id, deleted: true, updatedAt: now + 1, createdAt: now });
}
// 新合并时段(字段与真实数据一致)
periods.push({
  id: crypto.randomUUID(), name: 'DSK 高峰期', idleName: '', env: '宿舍', priority: 1,
  remindBeforeMin: 10, freq: 'weekly', weekdays: [1, 2, 3, 4, 5], colorSlot: 3,
  startMin: H(9, 0), endMin: H(12, 0),
  nodes: [{ startMin: H(9, 0), endMin: H(12, 0) }, { startMin: H(14, 0), endMin: H(18, 0) }],
  createdAt: now, updatedAt: now + 2, deleted: false,
});
periods.push({
  id: crypto.randomUUID(), name: 'DSK 低谷期', idleName: '', env: '宿舍', priority: 1,
  remindBeforeMin: 10, freq: 'weekly', weekdays: [1, 2, 3, 4, 5], colorSlot: 4,
  startMin: H(12, 0), endMin: H(14, 0),
  nodes: [{ startMin: H(12, 0), endMin: H(14, 0) }, { startMin: H(18, 0), endMin: H(9, 0) }], // 1080→540 跨午夜
  createdAt: now, updatedAt: now + 3, deleted: false,
});

const r = await fetch(`${BASE}/api/periods/sync`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ periods }),
});
const j = await r.json();
console.log('HTTP', r.status, 'periods total:', j.periods.length);
for (const p of j.periods) {
  if (p.deleted) continue;
  console.log(`- ${p.name} | slot=${p.colorSlot} | nodes=${JSON.stringify(p.nodes)} | wd=${JSON.stringify(p.weekdays)}`);
}
const dsks = j.periods.filter((p) => !p.deleted && String(p.name).includes('DSK'));
console.log('活跃 DSK 时段数:', dsks.length, '(期望 2)');
process.exit(dsks.length === 2 ? 0 : 2);
