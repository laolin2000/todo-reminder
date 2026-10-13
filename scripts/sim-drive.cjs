// ============================================================
// sim-drive.cjs — 「手机端」模拟自动化(390×844, 自测用)
//   1) 打开 ⚙设置 → AI 建任务区滚动入屏 → 截图(证明 AI 配置已写入并显示)
//   2) 回到列表, 在页面内直接走“🖼 AI 截图”同款路径(vm.onAiImage)
//      对真实截图文件做 AI 识图 → 课表写入待办 → 截图(证明手机端跑通)
//
// 注意: electron CLI 对「路径样式的多余参数」会启动崩溃, 故全部参数走环境变量:
//   SIM_URL=页面地址  SIM_IMG=截图文件  SIM_SETTINGS_PNG / SIM_IMPORT_PNG / SIM_JSON=输出
// 用法: electron scripts/sim-drive.cjs
//
// 陷阱备忘: 注入页面的代码若写在模板串里, 其中的 \n 会被模板求值提前换成真换行,
// 导致页面侧字符串字面量语法错误 —— 一律用 String.fromCharCode(10), 且先本地预检。
// ============================================================
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18800/';
const imgPng = process.env.SIM_IMG;
const outSettings = process.env.SIM_SETTINGS_PNG && path.resolve(process.env.SIM_SETTINGS_PNG);
const outImport = process.env.SIM_IMPORT_PNG && path.resolve(process.env.SIM_IMPORT_PNG);
const outJson = process.env.SIM_JSON && path.resolve(process.env.SIM_JSON);
const PROG = path.resolve(outJson ? path.dirname(outJson) : '.', 'sim-drive-progress.log');
const P = (m) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* 忽略 */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[sim-drive]', ...a);

P('m1 start, url=' + baseUrl);
app.setPath('userData', path.join(os.tmpdir(), 'todo-sim-drive-' + Date.now()));
P('m2 setPath done');

let win = null;
const summary = { steps: [] };

async function shot(file) {
  for (let i = 0; i < 4; i++) {
    try {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      await sleep(250);
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      if (png && png.length > 1000) {
        fs.writeFileSync(file, png);
        log('截图已存:', file, png.length);
        return true;
      }
      P('shot 空帧重试 ' + (i + 1));
    } catch (e) { P('shot err ' + (e && e.message)); }
    await sleep(500);
  }
  P('shot 最终失败: ' + file);
  return false;
}

const NL = 'String.fromCharCode(10)';
const wrap = (code) =>
  '(async () => { try { return await (async () => { ' + code + ' })(); } catch (e) { return { caught: String(e && e.stack || e) }; } })()';

/** 页面内执行: 先本地预检语法, 再注入; 脚本自捕错误不抛给 executeJavaScript */
function js(code, label) {
  try { new Function('return ' + wrap(code)); }
  catch (e) { P(label + ' PREFLIGHT SYNTAX FAIL: ' + e.message); throw new Error(label + ' 注入脚本语法错误: ' + e.message); }
  return win.webContents.executeJavaScript(wrap(code), true);
}

async function run() {
  await app.whenReady();
  P('whenReady ok');
  win = new BrowserWindow({
    width: 390, height: 844, useContentSize: true,
    show: true, autoHideMenuBar: true,
    title: '手机端模拟 390×844 · AI 跑通检测',
    backgroundColor: '#f2f4f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('console-message', (e, level, msg) => {
    P('console[' + level + '] ' + String(msg).slice(0, 300));
  });

  await win.loadURL(baseUrl);
  P('page loaded: ' + baseUrl);
  await sleep(5000); // 引擎首屏同步与渲染
  P('settle wait done');

  // ---------- 回归模式: 空 Key 保存不得清掉已存配置 ----------
  if (process.env.SIM_BLANK_SAVE === '1') {
    const rs = await js(`
      const vm = window.__todoApp;
      vm.openSettings(false);
      await new Promise((r) => setTimeout(r, 300));
      const r0 = await fetch('/api/ai');
      const j0 = await r0.json();
      vm.aiCfg = j0.config;
      vm.aiKey = '';
      await vm.saveAiCfg();            // 页面旧逻辑会发 apiKey:'' → 误清; 修复后不应清
      await new Promise((r) => setTimeout(r, 600));
      const r1 = await fetch('/api/ai');
      const j1 = await r1.json();
      return { before: j0.config.hasKey, after: j1.config.hasKey, ok: j1.config.hasKey === true };`, 'blank-save');
    summary.steps.push({ step: 'blank-save-guard', ...rs });
    P('blank-save 结果: ' + JSON.stringify(rs));
    if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
    app.exit(rs && rs.ok ? 0 : 2);
    return;
  }

  // ---------- 步骤1: 打开设置 → AI 配置区滚入屏 → 截图 ----------
  const STEP1 = `
      const vm = window.__todoApp;
      vm.openSettings(false);
      await new Promise((r) => setTimeout(r, 300));
      if (!vm.aiCfg) { const r = await fetch('/api/ai'); vm.aiCfg = (await r.json()).config || vm.aiCfg; }
      await new Promise((r) => setTimeout(r, 500));
      const h3 = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').includes('AI 建任务'));
      if (!h3) return { err: '未找到 AI 建任务区块' };
      let c = h3.parentElement, sc = null;
      while (c && c !== document.body) {
        const oy = getComputedStyle(c).overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && c.scrollHeight > c.clientHeight + 8) { sc = c; break; }
        c = c.parentElement;
      }
      if (sc) {
        sc.scrollTop = Math.max(0, h3.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 64);
      } else {
        window.scrollTo(0, Math.max(0, h3.getBoundingClientRect().top - 56));
      }
      await new Promise((r) => setTimeout(r, 600));
      const st = [...document.querySelectorAll('.setsec b')].find((b) => /已配置|未配置/.test(b.textContent || ''));
      const pt = (vm.aiCfg && vm.aiCfg.periodTable) || '';
      const ov = document.querySelector('.overlay');
      return {
        ok: true,
        viewMode: vm.viewMode, settingsOpen: vm.settingsOpen,
        overlayInDom: !!ov, overlayRect: ov ? ov.getBoundingClientRect().toJSON() : null,
        sheetScrollTop: ov ? (ov.querySelector('.sheet-bd') || {}).scrollTop : null,
        hasKey: !!(vm.aiCfg && vm.aiCfg.hasKey),
        baseUrl: (vm.aiCfg && vm.aiCfg.baseUrl) || '',
        model: (vm.aiCfg && vm.aiCfg.model) || '',
        ptLines: pt.split(${NL}).filter(Boolean).length,
        ptHead: pt.split(${NL})[0] || '',
        statusText: st ? st.textContent.trim() : '',
      };`;

  try {
    P('step1 begin');
    const p1 = await js(STEP1, 'step1');
    summary.steps.push({ step: 'open-ai-settings', ...p1 });
    log('设置页信息:', JSON.stringify(p1).slice(0, 500));
    P('step1 done: ' + JSON.stringify(p1).slice(0, 500));
    if (outSettings && p1 && p1.ok && !p1.caught) {
      await shot(outSettings);
      await sleep(1200);
      const ovNow = await js('return !!document.querySelector(".overlay")', 'recheck').catch(() => null);
      P('shot1 后 overlay 仍在: ' + ovNow);
      if (ovNow === false) { // 弹层被意外关闭 → 重新打开再补拍
        await js('window.__todoApp.openSettings(false); await new Promise((r) => setTimeout(r, 900));', 'reopen');
        await shot(outSettings);
      }
    } else P('step1 截图跳过: ' + JSON.stringify(p1).slice(0, 300));
  } catch (e) {
    summary.steps.push({ step: 'open-ai-settings', err: String(e && e.message || e) });
    P('step1 FAILED: ' + (e && e.message));
  }

  // ---------- 步骤2: 页面内真实 AI 识图(与“🖼 AI 截图”同路径) → 课表导入 → 截图 ----------
  const STEP2 = `
      const vm = window.__todoApp;
      vm.closeSettings();
      await new Promise((r) => setTimeout(r, 300));
      const origConfirm = window.confirm;
      window.confirm = () => true; // 自动化: 直接确认“按具体日期写入待办”
      let err = null, phase = '';
      try {
        phase = 'onAiImage';
        const bin = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(imgPng).toString('base64'))}), (ch) => ch.charCodeAt(0));
        const f = new File([bin], 'timetable.png', { type: 'image/png' });
        await vm.onAiImage(f);
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) {
        err = String(e && e.message || e);
      }
      const t0 = Date.now();
      while (vm.aiBusy && Date.now() - t0 < 150000) await new Promise((r) => setTimeout(r, 500));
      await new Promise((r) => setTimeout(r, 900)); // 等 toast 与列表重绘
      window.confirm = origConfirm;
      const acts = vm.todos.filter((t) => !t.deleted).map((t) => ({
        title: t.title, dueAt: t.dueAt, location: t.location || '', status: t.status,
      }));
      return {
        ok: !err, err, phase,
        viewMode: vm.viewMode, editorOpen: !!vm.editorOpen,
        n: acts.length, todos: acts,
      };`;

  try {
    P('step2 begin');
    const p2 = await js(STEP2, 'step2');
    summary.steps.push({ step: 'ai-parse-import', ...p2 });
    log('识图结果:', JSON.stringify(p2).slice(0, 1200));
    P('step2 done: ok=' + p2.ok + ' n=' + p2.n + ' err=' + (p2.err || ''));
    if (outImport) await shot(outImport);
  } catch (e) {
    summary.steps.push({ step: 'ai-parse-import', err: String(e && e.message || e) });
    P('step2 FAILED: ' + (e && e.message));
    try { if (outImport) await shot(outImport); } catch { /* 忽略 */ }
  }

  // ---------- 汇总: 服务端视角 ----------
  try {
    const health = await (await fetch(baseUrl + 'api/health')).json();
    const ai = await (await fetch(baseUrl + 'api/ai')).json();
    summary.server = {
      health: { ok: health.ok, total: health.total, active: health.active },
      ai: ai.config ? { baseUrl: ai.config.baseUrl, model: ai.config.model, hasKey: ai.config.hasKey } : null,
    };
  } catch (e) {
    summary.server = { err: String(e && e.message || e) };
  }

  if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  P('done, json written');
  log('完成 →', outJson);
  app.exit(0);
}

run().catch((e) => {
  P('RUN TOP-LEVEL FAIL: ' + (e && e.stack || e));
  log('驱动异常:', e && e.stack || e);
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  app.exit(1);
});
