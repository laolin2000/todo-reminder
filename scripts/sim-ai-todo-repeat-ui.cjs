// AI 日常识别 UI 实测: 📋日常 识别“每周三+市游泳馆” → 检查字段落位 → 截图
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18800/';
const outDir = process.env.SIM_OUT && path.resolve(process.env.SIM_OUT);
const P = (m) => { try { fs.appendFileSync(path.join(outDir, 'ai-todo-repeat.log'), m + '\n'); } catch { /* */ } };
app.setPath('userData', path.join(os.tmpdir(), 'todo-aiui-' + Date.now()));
const wrap = (c) => '(async()=>{try{return JSON.stringify(await (async()=>{' + c + '})());}catch(e){return JSON.stringify({caught:String(e&&e.stack||e)})}})()';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(win, file) {
  for (let i = 0; i < 4; i++) {
    try { win.show(); win.focus(); await sleep(350);
      const img = await win.webContents.capturePage(); const png = img.toPNG();
      if (png && png.length > 1000) { fs.writeFileSync(path.join(outDir, file), png); P('shot ' + file); return true; }
    } catch (e) { P('shot err'); }
    await sleep(300);
  }
  return false;
}
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(baseUrl);
  await sleep(6500);
  const js = (c) => win.webContents.executeJavaScript(wrap(c), true).then((s) => JSON.parse(s));
  const b64 = fs.readFileSync('shots/todo-repeat.png').toString('base64');
  const res = await js(`
    const vm = window.__todoApp;
    vm.aiMode = 'todo';
    const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    await vm.onAiImage(new File([bin], 't.png', { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 800));
    const e = vm.editing || {};
    const locInput = [...document.querySelectorAll('input')].find((i) => i.value === e.location && e.location);
    return {
      editorOpen: !!vm.editorOpen,
      title: e.title,
      location: e.location,
      locationFilled: !!(e.location && document.body.innerText.includes(e.location)),
      repeat: e.repeat,
      repeatBtnOn: !!(e.repeat === 'weekly' && document.body.innerText.includes('每周')),
      notes: e.notes,
      dueAt: e.dueAt ? new Date(e.dueAt).toString() : null,
    };`);
  P('editor ' + JSON.stringify(res));
  fs.writeFileSync(path.join(outDir, 'ai-todo-repeat-editor.json'), JSON.stringify(res, null, 2), 'utf8');
  await shot(win, 'AI日常-识别后编辑器.png');
  // 保存 → 列表
  const saved = await js(`
    const vm = window.__todoApp;
    await vm.saveTodo();
    await new Promise((r) => setTimeout(r, 900));
    const hit = vm.todos.find((t) => t.title === (vm.todos.find((x) => x.location === '市游泳馆') || {}).title);
    const item = vm.todos.find((t) => !t.deleted && t.location === '市游泳馆');
    return { saved: !!item, title: item ? item.title : '', repeat: item ? item.repeat : '', dueAt: item ? new Date(item.dueAt).toString() : null };`);
  P('saved ' + JSON.stringify(saved));
  fs.writeFileSync(path.join(outDir, 'ai-todo-repeat-saved.json'), JSON.stringify(saved, null, 2), 'utf8');
  await js(`const vm=window.__todoApp; vm.setConn('synced'); return 1;`);
  await shot(win, 'AI日常-保存后列表.png');
  const summary = { editor: res, saved, pass: !!res.editorOpen && res.location === '市游泳馆' && res.repeat === 'weekly' && !!saved.saved };
  fs.writeFileSync(path.join(outDir, 'ai-todo-repeat-result.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('pass=' + summary.pass);
  app.exit(summary.pass ? 0 : 1);
}
run().catch((e) => { P('TOP ' + (e && e.stack || e)); app.exit(2); });
