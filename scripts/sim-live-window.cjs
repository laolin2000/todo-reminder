// sim-live-window.cjs — 可交互“安卓端模拟窗口”(390×844)
// 加载 SIM_URL(默认真 LocalServer 模拟 18792); 可选自动截图 SIM_SHOT_LIST/SIM_SHOT_TRACE
// 窗口保持打开可点可滑; 关闭窗口即退出。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18792/';
const shotList = process.env.SIM_SHOT_LIST && path.resolve(process.env.SIM_SHOT_LIST);
const shotTrace = process.env.SIM_SHOT_TRACE && path.resolve(process.env.SIM_SHOT_TRACE);
const LOG = process.env.SIM_LOG && path.resolve(process.env.SIM_LOG);
const P = (m) => { if (LOG) { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* */ } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'todo-live-' + Date.now()));

async function shot(win, file) {
  for (let i = 0; i < 4; i++) {
    try { win.show(); win.focus(); await sleep(300);
      const img = await win.webContents.capturePage(); const png = img.toPNG();
      if (png && png.length > 1000) { fs.writeFileSync(file, png); P('shot ' + file + ' ' + png.length); return; }
    } catch (e) { P('shot err ' + (e && e.message)); }
    await sleep(300);
  }
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 390, height: 844, useContentSize: true, show: true, autoHideMenuBar: true,
    title: '待办提醒 · 安卓端模拟(390×844)', backgroundColor: '#f2f4f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.webContents.on('console-message', (e, l, m) => P('console[' + l + '] ' + String(m).slice(0, 220)));
  await win.loadURL(baseUrl);
  P('loaded ' + baseUrl);
  await sleep(7000);
  try {
    const js = (c) => win.webContents.executeJavaScript(
      '(async()=>{try{return JSON.stringify(await (async()=>{' + c + '})());}catch(e){return JSON.stringify({caught:String(e&&e.stack||e)})}})()', true)
      .then((s) => (typeof s === 'string' ? JSON.parse(s) : s));
    const st = await js(`const vm=window.__todoApp; vm.setConn('synced'); return {todos:vm.todos.length, periods:vm.periods.length};`);
    P('state ' + JSON.stringify(st));
    if (shotList) { await shot(win, shotList); }
    if (shotTrace) {
      await js(`const vm=window.__todoApp; vm.setView('trace'); await new Promise(r=>setTimeout(r,600)); return 1;`);
      await shot(win, shotTrace);
      await js(`const vm=window.__todoApp; vm.setView('list'); return 1;`);
    }
  } catch (e) { P('init err ' + (e && e.stack || e)); }
  P('interactive ready — 窗口保持打开, 关闭即退出');
}
run().catch((e) => { P('TOP ' + (e && e.stack || e)); app.exit(1); });
