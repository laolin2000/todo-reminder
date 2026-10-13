const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const out = process.env.SIM_PROBE_OUT || path.resolve('shots/probe-page.log');
const P = (m) => fs.appendFileSync(out, m + '\n');
app.setPath('userData', path.join(os.tmpdir(), 'todo-probe-' + Date.now()));
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', (e, l, m) => P('console[' + l + '] ' + String(m).slice(0, 400)));
  await win.loadURL(process.env.SIM_URL || 'http://127.0.0.1:18800/');
  await new Promise((r) => setTimeout(r, 8000));
  try {
    const r = await win.webContents.executeJavaScript('({s: 1 + 1, hasApp: !!window.__todoApp, body: document.body ? document.body.innerText.slice(0, 160) : null})', true);
    P('PROBE ' + JSON.stringify(r));
  } catch (e) { P('PROBE ERR ' + String(e && e.message || e)); }
  app.exit(0);
}
run().catch((e) => { P('TOP ' + String(e && e.stack || e)); app.exit(1); });
