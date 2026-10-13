// AI 三模式 UI 端到端(安卓模拟 390×844, 真 AI 调用)
// 自动→todo / 课表→timetable 写入 / 节次表→弹层编辑并保存(回写服务器 periodTable)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18800/';
const outDir = process.env.SIM_OUT && path.resolve(process.env.SIM_OUT);
const P = (m) => { try { fs.appendFileSync(path.resolve(outDir || '.', 'ai-modes-ui.log'), `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'todo-aimodes-' + Date.now()));
const summary = { steps: [] };
const wrap = (code) => '(async () => { try { return await (async () => { ' + code + ' })(); } catch (e) { return { caught: String(e && e.stack || e) }; } })()';
const GUARD = 60000;

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: true, autoHideMenuBar: true,
    title: 'AI 模式验证', backgroundColor: '#f2f4f9', webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(baseUrl);
  await sleep(6500);
  const js = async (code) => {
    try {
      const full = '(async () => { try { return JSON.stringify(await (async () => { ' + code + ' })()); } catch (e) { return JSON.stringify({ caught: String(e && e.stack || e) }); } })()';
      const s = await win.webContents.executeJavaScript(full, true);
      return typeof s === 'string' ? JSON.parse(s) : s;
    } catch (e) {
      P('js ERR ' + (e && e.message) + ' :: ' + String(code).slice(0, 120));
      return { caught: String(e && e.message || e) };
    }
  };
  async function shot(name) {
    for (let i = 0; i < 4; i++) {
      try { win.show(); win.focus(); await sleep(300);
        const img = await win.webContents.capturePage(); const png = img.toPNG();
        if (png && png.length > 1000) { fs.writeFileSync(path.join(outDir, name), png); return true; } } catch (e) { P('shot err'); }
      await sleep(300);
    }
    return false;
  }
  async function step(name, code, need) {
    const t0 = Date.now(); let res = null;
    const p = js(code).then((r) => { res = r; });
    const w = await Promise.race([p.then(() => 'done'), sleep(GUARD).then(() => 'timeout')]);
    const ms = Date.now() - t0;
    const pass = w === 'done' && !!(res && (need ? need(res) : true)) && !res.caught;
    summary.steps.push({ step: name, pass, ms, guard: w === 'timeout', result: res || {} });
    P(`${name}: ${pass ? 'PASS' : 'FAIL'} ${ms}ms ${JSON.stringify(res || {}).slice(0, 300)}`);
    return { pass, res };
  }
  const b64 = (p) => fs.readFileSync(p).toString('base64');
  await step('m0-模式条可见', `
    const vm = window.__todoApp; vm.setView('list'); await new Promise((r) => setTimeout(r, 400));
    return { mode: vm.aiMode, desc: vm.aiModeDesc, chips: !!document.querySelector('.aimodes'), errs: (window.__errs||[]).length };`,
    (r) => r.chips && r.mode === 'auto' && r.errs === 0);

  // 日常模式: todo-msg → 编辑器预填
  await step('m1-日常识别', `
    const vm = window.__todoApp; vm.aiMode = 'todo';
    const bin = Uint8Array.from(atob(${JSON.stringify(b64('shots/todo-msg.png'))}), (c) => c.charCodeAt(0));
    window.confirm = () => true;
    await vm.onAiImage(new File([bin], 't.png', { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 500));
    const ok = vm.editorOpen && !!vm.editing && (vm.editing.title || '').length > 0;
    vm.closeEditor();
    return { ok, title: vm.editing ? vm.editing.title : '' };`,
    (r) => r.ok);
  await shot('AI模式-1日常.png');

  // 课表模式: timetable 图 → 确认写入
  await step('m2-课表识别', `
    const vm = window.__todoApp; vm.aiMode = 'timetable';
    const bin = Uint8Array.from(atob(${JSON.stringify(b64('shots/ai-test-timetable.png'))}), (c) => c.charCodeAt(0));
    window.confirm = () => true;
    await vm.onAiImage(new File([bin], 't.png', { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 600));
    const added = vm.todos.filter((t) => (t.title || '').includes('大数据导论') || (t.title || '').includes('大学英语') || (t.title || '').includes('管理') || (t.title || '').includes('思想'));
    return { ok: added.length >= 3, added: added.length };`,
    (r) => r.ok);
  await shot('AI模式-2课表写入.png');

  // 节次表模式: 识别 → 弹层 → 改第一行 → 保存 → 服务端回读
  const s3 = await step('m3-节次表识别弹层', `
    const vm = window.__todoApp; vm.aiMode = 'periodtable';
    const bin = Uint8Array.from(atob(${JSON.stringify(b64('shots/pt-table.png'))}), (c) => c.charCodeAt(0));
    window.confirm = () => true;
    await vm.onAiImage(new File([bin], 't.png', { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 400));
    return { open: !!vm.aiPt, text: vm.aiPtText, rows: vm.aiPtRows() };`,
    (r) => r.open && r.rows >= 5 && (r.text || '').includes('第1节'));
  await shot('AI模式-3节次表弹层.png');
  await step('m3b-修改并保存节次表', `
    const vm = window.__todoApp;
    vm.aiPtText = (vm.aiPtText || '').replace('第1节 08:00-08:45', '第1节 08:10-08:55');
    await vm.savePtLines();
    await new Promise((r) => setTimeout(r, 500));
    return { closed: !vm.aiPt, busy: vm.aiBusy };`,
    (r) => r.closed && !r.busy);
  await shot('AI模式-4节次表已保存.png');

  // 服务端回读 periodTable 首行应为修改值
  const srv = await fetch(baseUrl + 'api/ai').then((r) => r.json()).catch(() => null);
  const cfg = srv && srv.config ? srv.config : null;
  const first = cfg && cfg.periodTable ? cfg.periodTable.split('\n')[0] : '';
  summary.serverPeriodFirst = first;
  const s3c = first === '第1节 08:10-08:55';
  summary.steps.push({ step: 'm3c-服务端回读', pass: s3c, result: { first } });
  P('服务端回读: ' + first);
  const errs = await js('return (window.__errs || []).slice(-8);');
  summary.finalErrs = errs;
  const vErrs = (errs || []).filter((e) => String(e).startsWith('V:')).length;
  summary.pass = summary.steps.every((s) => s.pass) && s3c && vErrs === 0;
  fs.writeFileSync(path.join(outDir, 'ai-modes-result.json'), JSON.stringify(summary, null, 2), 'utf8');
  P('FINAL pass=' + summary.pass);
  app.exit(summary.pass ? 0 : 11);
}
run().catch((e) => { P('TOP FAIL ' + (e && e.stack || e)); app.exit(12); });
