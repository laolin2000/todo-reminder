// 本地即时保存性能验证: 每次保存的提交耗时 + 后台落盘确认
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18800/';
const out = process.env.SIM_OUT_FILE || path.resolve('shots/save-perf.json');
const P = (m) => { try { fs.appendFileSync(path.resolve('shots/save-perf.log'), m + '\n'); } catch { /* */ } };
app.setPath('userData', path.join(os.tmpdir(), 'todo-saveperf-' + Date.now()));
const wrap = (c) => '(async()=>{try{return JSON.stringify(await (async()=>{' + c + '})());}catch(e){return JSON.stringify({caught:String(e&&e.stack||e)})}})()';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(baseUrl);
  await sleep(6000);
  const js = (c) => win.webContents.executeJavaScript(wrap(c), true).then((s) => JSON.parse(s));
  const results = [];
  async function one(name, title) {
    const r = await js(`
      const vm = window.__todoApp;
      const t0 = performance.now();
      vm.openNew();
      vm.editing.title = ${JSON.stringify(title)};
      vm.quickDue(60 * 60000, '1小时后');
      await vm.saveTodo();            // 本地即时: 应极快返回
      const t1 = performance.now();
      await new Promise((r) => setTimeout(r, 1200)); // 等后台推送完成
      const hit = vm.todos.find((t) => t.title === ${JSON.stringify(title)});
      return { ms: Math.round(t1 - t0), hit: !!hit, saving: vm.saving };`);
    results.push({ name, ...r });
    P(name + ' ' + JSON.stringify(r));
  }
  await one('新建保存1', '即时保存测试A·快');
  await one('新建保存2', '即时保存测试B·更快');
  const r3 = await js(`
    const vm = window.__todoApp;
    const src = vm.todos.find((t) => t.title === '即时保存测试A·快');
    const t0 = performance.now();
    vm.openEdit(src);
    vm.editing.title = '即时保存测试A·已改';
    await vm.saveTodo();
    const t1 = performance.now();
    return { ms: Math.round(t1 - t0) };`);
  results.push({ name: '编辑保存', ms: r3.ms });
  P('edit ' + JSON.stringify(r3));
  fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
  P('done');
  app.exit(0);
}
run().catch((e) => { P('TOP ' + (e && e.stack || e)); app.exit(1); });
