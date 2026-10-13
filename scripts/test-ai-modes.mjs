// 四种 AI 模式端到端验证(电脑端 8790)
import fs from 'node:fs';
const B = 'http://127.0.0.1:8790';
const img = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
const cases = [
  ['mode=timetable(课表)', 'shots/ai-test-timetable.png', { mode: 'timetable' }],
  ['mode=todo(日常事项)', 'shots/todo-msg.png', { mode: 'todo' }],
  ['mode=periodtable(节次表)', 'shots/pt-table.png', { mode: 'periodtable' }],
  ['mode=auto(默认)', 'shots/todo-msg.png', {}],
];
for (const [name, p, extra] of cases) {
  const t0 = Date.now();
  const r = await fetch(`${B}/api/ai/parse`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': '7m1bRHHkY6KU' },
    body: JSON.stringify({ image: img(p), ...extra }),
  });
  const j = await r.json();
  const f = j.fields || {};
  const info = f.kind === 'periodTable'
    ? 'lines=' + JSON.stringify(f.lines || [], null, 1)
    : f.kind === 'timetable'
      ? 'courses=' + (f.courses || []).length
      : f.kind === 'todo' ? 'title=' + (f.title || '') : JSON.stringify(f).slice(0, 180);
  console.log(`${name}: HTTP ${r.status} ok=${j.ok} kind=${f.kind} (${Date.now() - t0}ms) ${info}`);
  console.log(j.ok ? '' : '  err=' + (j.error || ''));
  console.log('');
}
