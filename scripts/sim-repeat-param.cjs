// 重复参数 UI 行为验证(每周选周几 / 每月选几号)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18800/';
app.setPath('userData', path.join(os.tmpdir(), 'todo-rpt-' + Date.now()));
const wrap = (c) => '(async()=>{try{return JSON.stringify(await (async()=>{' + c + '})());}catch(e){return JSON.stringify({caught:String(e&&e.stack||e)})}})()';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(baseUrl);
  await sleep(6000);
  const js = (c) => win.webContents.executeJavaScript(wrap(c), true).then((s) => JSON.parse(s));
  const r = await js(`
    const vm = window.__todoApp;
    // 新建并给一个明确时间(明天 09:30)
    vm.openNew();
    vm.editing.title = '重复参数测试';
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 30, 0, 0);
    vm.editing.dueAt = t.getTime();
    // 每周
    vm.setRepeat('weekly');
    await new Promise((r) => setTimeout(r, 120));
    const chipsShown = !!document.querySelector('.subparam');
    vm.pickRepeatWeekday(6); // 周六
    const wd6 = vm.dueIsoWd(vm.editing.dueAt) === 6;
    const lab = (document.querySelector('.subparam .segs') || {}).textContent || '';
    // 每月 15 号
    vm.setRepeat('monthly');
    await new Promise((r) => setTimeout(r, 120));
    vm.pickRepeatMonthDay(15);
    const day15 = new Date(vm.editing.dueAt).getDate() === 15 && vm.editing.repeat === 'monthly';
    const monthLabel = (document.querySelector('.subparam select') || {}).value || '';
    vm.closeEditor();
    return { chipsShown, wd6, day15, monthLabel, repeat: vm.editing ? vm.editing.repeat : null };
  `);
  fs.writeFileSync(path.resolve('shots/repeat-param.json'), JSON.stringify(r, null, 2), 'utf8');
  console.log(JSON.stringify(r));
  app.exit(0);
}
run().catch((e) => { console.log('TOP', e); app.exit(1); });
