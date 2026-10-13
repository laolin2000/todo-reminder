// 轨迹·重叠分行“界面截图”专用: 可控缩放/滚动拍两张(390×844)
// 用法: electron scripts/sim-trace-shot.cjs
//   SIM_URL / SIM_ZOOM_H(小时跨度,默认6) / SIM_SHOT1(近景) / SIM_SHOT2(24h全景) / SIM_JSON
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const baseUrl = process.env.SIM_URL || 'http://127.0.0.1:18800/';
const zoomH = Number(process.env.SIM_ZOOM_H || 6);
const scrollMin = Number(process.env.SIM_SCROLL_MIN || (7 * 60 + 40));
const daysN = Number(process.env.SIM_DAYS || 0);
const fitAxis = process.env.SIM_FIT === 'axis';
const shot1 = process.env.SIM_SHOT1 && path.resolve(process.env.SIM_SHOT1);
const shot2 = process.env.SIM_SHOT2 && path.resolve(process.env.SIM_SHOT2);
const outJson = process.env.SIM_JSON && path.resolve(process.env.SIM_JSON);
const PROG = path.resolve(outJson ? path.dirname(outJson) : '.', 'sim-trace-shot-progress.log');
const P = (m) => { try { fs.appendFileSync(PROG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'todo-trace-shot-' + Date.now()));

const wrap = (code) =>
  '(async () => { try { return await (async () => { ' + code + ' })(); } catch (e) { return { caught: String(e && e.stack || e) }; } })()';

async function capture(win, file, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      win.show(); win.focus();
      await sleep(350);
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      if (png && png.length > 1000) { fs.writeFileSync(file, png); P('shot ' + file + ' ' + png.length); return true; }
    } catch (e) { P('shot err ' + (e && e.message)); }
    await sleep(400);
  }
  P('shot FAIL ' + file);
  return false;
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 390, height: 844, useContentSize: true, show: true, autoHideMenuBar: true,
    title: '轨迹·重叠分行 界面模拟', backgroundColor: '#f2f4f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await win.loadURL(baseUrl);
  win.webContents.on('console-message', (e, l, m) => P('console[' + l + '] ' + String(m).slice(0, 300)));
  await sleep(6000);
  const js = (code) => win.webContents.executeJavaScript(wrap(code), true);

  const info = await js(`
    const vm = window.__todoApp;
    vm.setConn('synced'); // 模拟环境无 WS, 手动置顶已同步, 让截图状态条正常
    vm.setView('trace');
    // 可选: 跳到下一个周一~周五(DSK 时段仅工作日生效)
    const nextWk = ${process.env.SIM_NEXT_WEEKDAY === '1' ? 'true' : 'false'};
    if (nextWk) {
      const d = new Date();
      let off = 1;
      while (off <= 7) { const w = new Date(d.getFullYear(), d.getMonth(), d.getDate() + off).getDay(); if (w >= 1 && w <= 5) break; off++; }
      vm.traceOff = off <= 7 ? off : 0;
    } else {
      vm.traceGoToday();
    }
    await new Promise((r) => setTimeout(r, 600));
    // 可选: 设置轴天数 / 整轴铺屏
    const daysN = ${daysN};
    if (daysN >= 1 && daysN <= 7) { vm.traceDaysSet(daysN); await new Promise((r) => setTimeout(r, 500)); }
    let dump = null;
    if (${process.env.SIM_DUMP === '1' ? 'true' : 'false'} && vm.flow) {
      const fl = vm.flow;
      dump = {
        spanMin: fl.spanMin,
        daysMeta: fl.daysMeta,
        bandRaw: (fl.bands || []).map((b) => ({ n: b.name, s: b.s, e: b.e, idle: !!b.idle })),
        bandLanes: fl.bandLanes ? fl.bandLanes.map((row) => row.map((b) => ({ n: b.name, s: b.s, e: b.e, idle: !!b.idle }))) : null,
      };
    }
    // 视图: 整轴铺满一屏 或 按 SIM_ZOOM_H 小时铺屏后滚动到指定绝对分钟
    ${fitAxis ? 'vm.traceFitAxis();' : 'vm.traceFitHours(' + zoomH + ');'}
    await new Promise((r) => setTimeout(r, 500));
    const px = vm.flow ? vm.flow.pxPerMin : 0;
    const wrap = document.querySelector('.tflowwrap');
    if (wrap && px) wrap.scrollLeft = ${fitAxis ? 0 : 'Math.max(0, (' + scrollMin + ') * px - 10)'};
    await new Promise((r) => setTimeout(r, 700));
    const info1 = {
      zoomSpan: vm.flow ? vm.flow.bodyH : 0,
      bandLanes: vm.flow && vm.flow.bandLanes ? vm.flow.bandLanes.length : 0,
      todoRows: vm.flow ? vm.flow.rows.length : 0,
      pxPerMin: px,
      days: vm.traceDays,
      spanLabel: vm.traceDateLabel,
      nowPct: vm.nowPct,
    };
    // 每个时段行的文本(用于断言)
    const bandTexts = [...document.querySelectorAll('.tfband b')].map((b) => b.textContent.trim());
    let lbl = null;
    if (${process.env.SIM_DUMP === '1' ? 'true' : 'false'}) {
      const rr = [...document.querySelectorAll('.tflbl')].map((e) => { const q = e.getBoundingClientRect(); return { t: e.textContent.trim(), l: Math.round(q.left), r: Math.round(q.right) }; });
      let overlapped = 0;
      for (let i = 1; i < rr.length; i++) if (rr[i].l < rr[i - 1].r - 2) overlapped++;
      lbl = { count: rr.length, overlapped, sample: rr.slice(0, 14), lineHours: vm.flow ? vm.flow.lineHours.length : 0 };
    }
    return { info1, bandTexts, lbl, dump, scrollLeft: wrap ? Math.round(wrap.scrollLeft) : -1 };`);
  P('近景信息: ' + JSON.stringify(info).slice(0, 500));
  const pass1 = await capture(win, shot1);

  // 全景(整轴: 多日时铺满整个连续轴)
  const full = await js(`
    const vm = window.__todoApp;
    ${daysN >= 1 ? 'vm.traceFitAxis();' : 'vm.traceFitHours(24);'}
    await new Promise((r) => setTimeout(r, 500));
    const wrap = document.querySelector('.tflowwrap');
    if (wrap) wrap.scrollLeft = 0;
    await new Promise((r) => setTimeout(r, 700));
    return { bandLanes: vm.flow && vm.flow.bandLanes ? vm.flow.bandLanes.length : 0,
             spanMin: vm.flow ? vm.flow.spanMin : 0,
             scrollLeft: wrap ? Math.round(wrap.scrollLeft) : -1 };`);
  P('全景信息: ' + JSON.stringify(full));
  const pass2 = await capture(win, shot2);

  const summary = { near: info, full, shots: { near: pass1, full: pass2 },
    pass: pass1 && pass2 && !!(info && info.info1 && info.info1.bandLanes >= 2) };
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8');
  P('done pass=' + summary.pass);
  app.exit(summary.pass ? 0 : 7);
}
run().catch((e) => { P('TOP FAIL ' + (e && e.stack || e)); app.exit(8); });
