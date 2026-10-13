// 轨迹视图·时段重叠分行验证(390×844): 断言分行布局 + 截图
// 用法: electron scripts/sim-trace-view.cjs  (环境变量 SIM_URL / SIM_JSON / SIM_SHOT)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18792/';
const outJson = process.env.SIM_JSON && path.resolve(process.env.SIM_JSON);
const outShot = process.env.SIM_SHOT && path.resolve(process.env.SIM_SHOT);
const PROG = path.resolve(outJson ? path.dirname(outJson) : '.', 'sim-trace-progress.log');
const P = (m) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'todo-trace-view-' + Date.now()));

const wrap = (code) =>
  '(async () => { try { return await (async () => { ' + code + ' })(); } catch (e) { return { caught: String(e && e.stack || e) }; } })()';

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 390, height: 844, useContentSize: true, show: true, autoHideMenuBar: true,
    title: '轨迹·重叠分行验证', backgroundColor: '#f2f4f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.webContents.on('console-message', (e, l, m) => P('console[' + l + '] ' + String(m).slice(0, 200)));
  await win.loadURL(baseUrl);
  P('loaded');
  await sleep(6000);
  const js = (code) => win.webContents.executeJavaScript(wrap(code), true);

  const res = await js(`
    const vm = window.__todoApp;
    vm.traceGoToday();
    vm.setView('trace');
    await new Promise((r) => setTimeout(r, 900));
    const body = document.querySelector('.tfbody');
    const rows = [...document.querySelectorAll('.tfbandrow')];
    const bandsAll = [...document.querySelectorAll('.tfband')];
    const info = {
      viewMode: vm.viewMode,
      bandLanes: vm.flow && vm.flow.bandLanes ? vm.flow.bandLanes.length : 0,
      todoRows: vm.flow ? vm.flow.rows.length : 0,
      bodyH: vm.flow ? vm.flow.bodyH : 0,
      bandrowCount: rows.length,
      bandCount: bandsAll.length,
      bandTexts: bandsAll.map((b) => b.textContent.trim()).filter((x) => x),
    };
    // 行矩形: 断言各时段行纵向不重叠
    const rects = rows.map((r) => { const q = r.getBoundingClientRect(); return { top: Math.round(q.top), h: Math.round(q.height), w: Math.round(q.width) }; });
    let rowsOk = true;
    for (let i = 1; i < rects.length; i++) if (rects[i].top < rects[i - 1].top + rects[i - 1].h - 2) rowsOk = false;
    info.rowsRect = rects; info.rowsSeparated = rowsOk;
    // 文本可见性: 每个 .tfband b/em 应非 0 尺寸
    const txts = [...document.querySelectorAll('.tfband b,.tfband em')].map((el) => { const q = el.getBoundingClientRect(); return { t: el.textContent.trim(), w: Math.round(q.width), h: Math.round(q.height) }; });
    const txtOk = txts.length > 0 && txts.every((x) => x.w > 4 && x.h > 4);
    info.texts = txts; info.textsVisible = txtOk;
    info.pass = info.bandLanes >= 2 && info.bandrowCount >= 2 && rowsOk && txtOk && info.bandTexts.some((s) => s.includes('早间自习室')) && info.bandTexts.some((s) => s.includes('操作系统课'));
    // 截取时把视图滚回最左
    document.querySelector('.tflowwrap') && (document.querySelector('.tflowwrap').scrollLeft = 0);
    return info;`);
  P('结果: ' + JSON.stringify(res).slice(0, 800));

  if (outShot) {
    try {
      for (let i = 0; i < 4; i++) {
        await sleep(500);
        win.show(); win.focus();
        const img = await win.webContents.capturePage();
        const png = img.toPNG();
        if (png && png.length > 1000) { fs.writeFileSync(outShot, png); P('shot saved ' + png.length); break; }
        P('shot empty retry ' + (i + 1));
      }
    } catch (e) { P('shot err ' + (e && e.message)); }
  }
  const summary = { result: res, pass: !!(res && res.pass) };
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  P('done pass=' + summary.pass);
  app.exit(summary.pass ? 0 : 5);
}
run().catch((e) => { P('TOP FAIL ' + (e && e.stack || e)); app.exit(6); });
