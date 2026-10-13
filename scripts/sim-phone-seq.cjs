// ============================================================
// sim-phone-seq.cjs — 手机 UI 保存序列压测(390×844, 自测用)
// 对着“安卓模拟环境”(android-sim: 真 LocalServer + NanoHTTPD on JVM)
// 走与手机 WebView 完全相同的页面与引擎, 复现用户操作:
//   新建→保存 → 再新建→保存 → 编辑已有→保存
// 每步 30s 看门狗: 卡死即判 FAIL(正常应 <3s)。参数走环境变量:
//   SIM_URL 页面地址; SIM_JSON 输出; SIM_SHOT 结束截图
// 用法: electron scripts/sim-phone-seq.cjs
// ============================================================
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18792/';
const outJson = process.env.SIM_JSON && path.resolve(process.env.SIM_JSON);
const outShot = process.env.SIM_SHOT && path.resolve(process.env.SIM_SHOT);
const PROG = path.resolve(outJson ? path.dirname(outJson) : '.', 'sim-phone-seq-progress.log');
const P = (m) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[sim-seq]', ...a);

app.setPath('userData', path.join(os.tmpdir(), 'todo-sim-seq-' + Date.now()));
const summary = { steps: [] };
const GUARD = 30000;

const wrap = (code) =>
  '(async () => { try { return await (async () => { ' + code + ' })(); } catch (e) { return { caught: String(e && e.stack || e) }; } })()';

async function run() {
  await app.whenReady();
  P('ready');
  const win = new BrowserWindow({
    width: 390, height: 844, useContentSize: true,
    show: true, autoHideMenuBar: true,
    title: '安卓模拟 · 保存序列压测',
    backgroundColor: '#f2f4f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.on('closed', () => {});
  win.webContents.on('console-message', (e, level, msg) => {
    P('console[' + level + '] ' + String(msg).slice(0, 200));
  });
  await win.loadURL(baseUrl);
  P('page loaded');
  await sleep(6000); // 首屏同步与渲染
  const js = (code) => win.webContents.executeJavaScript(wrap(code), true);

  // 每步执行 + 看门狗(不让 executeJavaScript 无限挂起页面 promise 无输出)
  async function step(name, code) {
    const started = Date.now();
    let result = null;
    const p = js(code).then((r) => { result = r; });
    // 看门狗: 30s 未返回即标记卡死(页面内 fetch 自身 25s 超时会先失败, 正常不会走到这)
    const winner = await Promise.race([
      p.then(() => 'done'),
      sleep(GUARD).then(() => 'timeout'),
    ]);
    const ms = Date.now() - started;
    const rec = { step: name, ms, guard: winner === 'timeout' };
    if (result) { rec.done = result.done; rec.err = result.err || null; rec.n = result.n; rec.saving = result.saving; }
    summary.steps.push(rec);
    P(`${name}: ${winner} ${ms}ms ${JSON.stringify(result || {}).slice(0, 300)}`);
    log(`${name}: ${winner} ${ms}ms`);
    await sleep(800);
    return rec;
  }

  // 0) 引擎就绪并已同步
  await js(`
    const t0 = Date.now();
    while (!window.__todoApp) {
      if (Date.now() - t0 > 10000) return { err: 'app 超时' };
      await new Promise((r) => setTimeout(r, 100));
    }
    const vm = window.__todoApp;
    const t1 = Date.now();
    while (vm.conn !== 'synced' && Date.now() - t1 < 15000) await new Promise((r) => setTimeout(r, 200));
    return { conn: vm.conn, n: vm.todos.filter((t) => !t.deleted).length };`);
  P('engine ready');

  // 1) 新建 → 保存(用户第一条)
  await step('op1-新建保存', `
    const vm = window.__todoApp;
    const rec = JSON.parse(JSON.stringify(vm.M.fresh()));
    rec.title = '手机端UI新建·第一件📱';
    rec.location = 'UI教室101';
    rec.notes = '安卓模拟·中文备注';
    vm.editorMode = 'new';
    vm.editing = rec;
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 600));
    const hit = vm.todos.find((t) => t.title === '手机端UI新建·第一件📱');
    return { done: !!hit && !vm.saving, n: vm.todos.filter((t) => !t.deleted).length, saving: vm.saving, err: null };`);

  // 2) 再新建 → 保存(用户第二条, 重点: 第二次保存是否卡)
  await step('op2-二次新建保存', `
    const vm = window.__todoApp;
    const rec = JSON.parse(JSON.stringify(vm.M.fresh()));
    rec.title = '第二条·数据优先存手机🔒';
    rec.location = '本地';
    vm.editorMode = 'new';
    vm.editing = rec;
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 600));
    const hit = vm.todos.find((t) => t.title === '第二条·数据优先存手机🔒');
    return { done: !!hit && !vm.saving, n: vm.todos.filter((t) => !t.deleted).length, saving: vm.saving, err: null };`);

  // 3) 编辑第一条 → 保存
  await step('op3-编辑保存', `
    const vm = window.__todoApp;
    const src = vm.todos.find((t) => t.title === '手机端UI新建·第一件📱');
    if (!src) return { done: false, err: '找不到第一条' };
    const rec = JSON.parse(JSON.stringify(src));
    rec.title = '第一件·已编辑✏️完成';
    vm.editorMode = 'edit';
    vm.editing = rec;
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 600));
    const hit = vm.todos.find((t) => t.id === src.id);
    return { done: !!hit && hit.title === '第一件·已编辑✏️完成' && !vm.saving,
             n: vm.todos.filter((t) => !t.deleted).length, saving: vm.saving, err: null };`);

  // 4) 再新建第三条 → 保存(连续第三次)
  await step('op4-三连新建保存', `
    const vm = window.__todoApp;
    const rec = JSON.parse(JSON.stringify(vm.M.fresh()));
    rec.title = '第三件·连续保存✅';
    vm.editorMode = 'new';
    vm.editing = rec;
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 600));
    const hit = vm.todos.find((t) => t.title === '第三件·连续保存✅');
    return { done: !!hit && !vm.saving, n: vm.todos.filter((t) => !t.deleted).length, saving: vm.saving, err: null };`);

  // 5) 引擎侧错误快照(应无超时/错误记录)
  const errs = await js(`return (window.__errs || []).slice(-10);`);
  summary.errs = errs || [];

  if (outShot) {
    try {
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      if (png && png.length > 1000) fs.writeFileSync(outShot, png);
    } catch (e) { P('shot err ' + (e && e.message)); }
  }

  const bad = summary.steps.filter((s) => s.guard || !s.done);
  summary.pass = bad.length === 0 && (!errs || errs.length === 0);
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  P('done pass=' + summary.pass);
  log('完成 pass=' + summary.pass);
  app.exit(summary.pass ? 0 : 3);
}

run().catch((e) => {
  P('TOP FAIL ' + (e && e.stack || e));
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  app.exit(4);
});
