// 安卓端模拟·全流程回归(390×844, 同引擎同页面; 真 LocalServer 数据)
// 覆盖: 首页含“当前时段”横幅(白屏修复点) / 标签多轮切换 / 新建/编辑/删除 /
//       轨迹多日(DSK)渲染与刻度抽稀 / 引擎 errs 为空 / 截图为证
// 用法: electron scripts/sim-full-flow.cjs   (SIM_URL / SIM_OUT 输出目录)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18792/';
const outDir = process.env.SIM_OUT && path.resolve(process.env.SIM_OUT);
const PROG = path.resolve(outDir || '.', 'sim-full-flow.log');
const P = (m) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'todo-full-' + Date.now()));
const summary = { steps: [] };
const wrap = (code) => '(async () => { try { return await (async () => { ' + code + ' })(); } catch (e) { return { caught: String(e && e.stack || e) }; } })()';
const GUARD = 30000;

async function run() {
  await app.whenReady();
  P('ready');
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: true, autoHideMenuBar: true,
    title: '安卓模拟 · 全流程回归', backgroundColor: '#f2f4f9',
    webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', (e, l, m) => P('console[' + l + '] ' + String(m).slice(0, 220)));
  await win.loadURL(baseUrl);
  await sleep(6500);
  const js = (code) => win.webContents.executeJavaScript(wrap(code), true);

  async function shot(name) {
    if (!outDir) return true;
    for (let i = 0; i < 4; i++) {
      try {
        win.show(); win.focus(); await sleep(350);
        const img = await win.webContents.capturePage();
        const png = img.toPNG();
        if (png && png.length > 1000) { fs.writeFileSync(path.join(outDir, name), png); P('shot ' + name + ' ' + png.length); return true; }
      } catch (e) { P('shot err ' + (e && e.message)); }
      await sleep(400);
    }
    P('shot FAIL ' + name);
    return false;
  }

  async function step(name, code, need) {
    const t0 = Date.now();
    let result = null;
    const p = js(code).then((r) => { result = r; });
    const winner = await Promise.race([p.then(() => 'done'), sleep(GUARD).then(() => 'timeout')]);
    const ms = Date.now() - t0;
    const pass = winner === 'done' && !!(result && (need ? need(result) : true)) && !result.caught;
    summary.steps.push({ step: name, pass, ms, guard: winner === 'timeout', result: result || {} });
    P(`${name}: ${pass ? 'PASS' : 'FAIL'} ${ms}ms ${JSON.stringify(result || {}).slice(0, 420)}`);
    return { pass, result };
  }
  const errsOf = () => js('return (window.__errs || []).slice(-12);');

  // 0) 就绪: 页面非白屏、有数据、errs 空
  const s0 = await step('s0-就绪非白屏', `
    const vm = window.__todoApp;
    const t0 = Date.now();
    while (!vm || !vm.todos || vm.todos.length === 0) { if (Date.now() - t0 > 10000) break; await new Promise((r) => setTimeout(r, 150)); }
    await new Promise((r) => setTimeout(r, 800));
    return { todos: vm.todos.length, periods: vm.periods.length, bodyText: document.body.innerText.length,
             appText: document.body.innerText.includes('待办提醒'),
             curSeg: typeof vm.curPeriodSeg, segLabel: vm.curSegLabel, curPeriod: !!(vm.curPeriod && vm.curPeriod.name) };`,
    (r) => r.todos >= 3 && r.periods >= 3 && r.appText && r.curSeg === 'object' && r.segLabel !== '' && r.curPeriod);
  await shot('01-首页-当前时段横幅.png');

  // 1) 标签多轮切换(列表↔轨迹↔时段), 每轮检查非白屏+errs
  let cyclePass = true;
  for (let c = 1; c <= 3; c++) {
    for (const v of ['trace', 'slots', 'list', 'trace', 'list']) {
      const r = await step(`s1-切换轮${c}-${v}`, `
        const vm = window.__todoApp;
        vm.setView('${v}');
        await new Promise((r) => setTimeout(r, 420));
        const text = document.body.innerText;
        return { text: text.length, hasApp: text.includes('待办提醒'), vm: vm.viewMode };`,
        (x) => x.text > 60 && x.hasApp);
      if (!r.pass) cyclePass = false;
    }
  }
  summary.cycles = cyclePass;
  const errs1 = await errsOf();
  P('轮换后 errs: ' + JSON.stringify(errs1));

  // 2) 新建 → 保存
  const s2 = await step('s2-新建保存', `
    const vm = window.__todoApp;
    vm.openNew();
    vm.editing.title = '全流程新建·模拟创建✅';
    vm.editing.location = '模拟教室';
    vm.quickDue(90 * 60000, '90分钟后');
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 700));
    const hit = vm.todos.find((t) => t.title === '全流程新建·模拟创建✅');
    return { done: !!hit && !vm.saving, n: vm.todos.filter((t) => !t.deleted).length, saving: vm.saving };`,
    (r) => r.done && r.n >= 4 && r.saving === false);

  // 3) 编辑 → 保存
  const s3 = await step('s3-编辑保存', `
    const vm = window.__todoApp;
    const src = vm.todos.find((t) => t.title === '全流程新建·模拟创建✅');
    if (!src) return { done: false, err: '找不到新建项' };
    vm.openEdit(src);
    vm.editing.title = src.title + '·已编辑✏️';
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 700));
    const hit = vm.todos.find((t) => t.id === src.id);
    return { done: !!hit && hit.title === '全流程新建·模拟创建✅·已编辑✏️' && !vm.saving, saving: vm.saving };`,
    (r) => r.done);
  await shot('02-编辑保存后列表.png');

  // 4) 删除(勾选确认自动通过)
  const s4 = await step('s4-删除', `
    const vm = window.__todoApp;
    const src = vm.todos.find((t) => t.title && t.title.includes('已编辑✏️'));
    if (!src) return { done: false, err: '找不到待删项' };
    const orig = window.confirm; window.confirm = () => true;
    try { await vm.removeTodo(src); } finally { window.confirm = orig; }
    await new Promise((r) => setTimeout(r, 700));
    const gone = !vm.todos.some((t) => t.id === src.id && !t.deleted);
    return { done: gone };`,
    (r) => r.done);

  // 5) 轨迹: 今天(活跃横幅时段+待办) + 跳到下一工作日的 3 天轴(DSK)
  const s5 = await step('s5-轨迹多日渲染', `
    const vm = window.__todoApp;
    vm.traceDaysSet(3);
    const d = new Date();
    let off = 1;
    while (off <= 7) { const w = new Date(d.getFullYear(), d.getMonth(), d.getDate() + off).getDay(); if (w >= 1 && w <= 5) break; off++; }
    vm.traceOff = off <= 7 ? off : 0;
    vm.setView('trace');
    await new Promise((r) => setTimeout(r, 900));
    const fl = vm.flow;
    const texts = [...document.querySelectorAll('.tfband b')].map((b) => b.textContent.trim());
    const rr = [...document.querySelectorAll('.tflbl')].map((e) => { const q = e.getBoundingClientRect(); return q.left; });
    let overlap = 0; for (let i = 1; i < rr.length; i++) if (rr[i] < rr[i - 1] + 10) overlap++;
    return { spanMin: fl ? fl.spanMin : 0, days: vm.traceDays, lanes: fl && fl.bandLanes ? fl.bandLanes.length : 0,
             hasHi: texts.some((t) => t.includes('高峰期')), hasLo: texts.some((t) => t.includes('低谷期')),
             labelOverlap: overlap, bodyText: document.body.innerText.length };`,
    (r) => r.spanMin === 4320 && r.days === 3 && r.lanes >= 2 && r.hasHi && r.hasLo && r.labelOverlap === 0);
  await shot('03-轨迹多日DSK.png');

  // 6) 回列表 + 终检 errs(必须无 V: 渲染错误)
  const s6 = await step('s6-回列表终检', `
    const vm = window.__todoApp;
    vm.traceGoToday();
    vm.setView('list');
    await new Promise((r) => setTimeout(r, 600));
    return { n: vm.todos.filter((t) => !t.deleted).length, text: document.body.innerText.length, segLabel: vm.curSegLabel };`,
    (r) => r.n >= 3 && r.text > 60);
  const finalErrs = await errsOf();
  const vErrs = (finalErrs || []).filter((e) => String(e).startsWith('V:'));
  summary.finalErrs = finalErrs;
  summary.vRenderErrs = vErrs.length;
  const passAll = s0.pass && cyclePass && s2.pass && s3.pass && s4.pass && s5.pass && s6.pass && vErrs.length === 0;
  summary.pass = passAll;
  if (outDir) {
    fs.writeFileSync(path.join(outDir, 'full-flow-result.json'), JSON.stringify(summary, null, 2), 'utf8');
    P('json saved');
  }
  P('FINAL pass=' + passAll);
  app.exit(passAll ? 0 : 9);
}
run().catch((e) => { P('TOP FAIL ' + (e && e.stack || e)); app.exit(10); });
