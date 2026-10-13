// 供 electron/main.js 的 runUiQa 注入渲染器执行的视图探针(独立文件避免嵌套转义)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vm = window.__todoApp;
  const out = {};
  if (!window.__errs) window.__errs = [];
  try {
    if (vm.$appContext && !window.__ehInstalled) {
      window.__ehInstalled = true;
      vm.$appContext.config.errorHandler = (err, _inst, info) => {
        window.__errs.push('EH:' + info + '::' + (err && err.message));
        const st = String((err && err.stack) || '');
        window.__errs.push('ST:' + st.split(String.fromCharCode(10)).slice(0, 5).join(' | '));
      };
    }
  } catch (e) { out.ehInstall = String(e); }
  let t1 = null;
  try { t1 = (vm.flow ? vm.flow.rows.length + 'x' + vm.flow.todos.length : 'NOFLOW'); } catch (e) { t1 = 'ERR:' + e.message; }
  out.t1 = t1;
  try {
    vm.setView('trace'); await sleep(400);
    out.mode = vm.viewMode;
    out.hasTraceWrap = !!document.querySelector('.tracewrap');
    out.lanes = [];
    out.laneCount = document.querySelectorAll('.tfrow').length;
    out.blocks = document.querySelectorAll('.tfblk').length;
    out.bandNames0 = [...document.querySelectorAll('.tfband b')].map((b) => b.textContent || '');
    out.oT = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  } catch (e) { out.stage1 = String(e); }
  out.errsAfterTrace = (window.__errs || []).slice();
  try {
    vm.setView('slots'); await sleep(250);
    out.beforeSlots = document.querySelectorAll('.slotcard').length;
    // 监控引擎请求与推送脏数据量
    const origFetch = vm.engine._fetch.bind(vm.engine);
    vm.engine._fetch = async (...a) => {
      try { return await origFetch(...a); } catch (e) {
        out.fetchErrs = (out.fetchErrs || []).concat(String(e && e.message || e));
        throw e;
      }
    };
    const origPD = vm.engine.pushDirty.bind(vm.engine);
    vm.engine.pushDirty = async () => {
      const dt = vm.engine.todos().filter((t) => t.updatedAt > vm.engine.lastSynced).length;
      const dp = vm.engine.periods().filter((p) => p.updatedAt > vm.engine.lastSynced).length;
      out.pushLog = (out.pushLog || []).concat('T' + dt + 'P' + dp);
      try { return await origPD(); } catch (e) { out.pushLog.push('ERR:' + e.message); throw e; }
    };
    out.pre = { ls: vm.engine.lastSynced, skew: vm.engine.skew };
    vm.openSlotNew();
    vm.slotForm.name = '专注'; vm.slotForm.priority = 2; vm.slotForm.remindBeforeMin = 10;
    await vm.saveSlot(); await sleep(350);
    out.nSlots = vm.sortedPeriods.length;
    out.id1 = vm.sortedPeriods[0] ? vm.sortedPeriods[0].id : 'NONE';
    out.serverAfter1 = await (await fetch('/api/periods')).json().then((r) => (r.periods || []).map((p) => p.name));
    out.meta1 = { lastSynced: vm.engine.lastSynced, syncBak: vm.engine.skew, upd1: out.id1 === 'NONE' ? -1 : vm.sortedPeriods[0].updatedAt };
  } catch (e) { out.stage2 = String(e); }
  out.errsAfterSlots = (window.__errs || []).slice();
  try {
    // 频度: 每周(选今天, 保证今日生效)
    const jsDay = new Date().getDay();
    const todayW = jsDay === 0 ? 7 : jsDay;
    const otherW = todayW % 7 + 1;
    vm.openSlotNew();
    vm.slotForm.name = '每周复盘'; vm.slotForm.freq = 'weekly'; vm.slotForm.weekdays = [todayW];
    await vm.saveSlot(); await sleep(300);
    out.after2 = vm.sortedPeriods.map((p) => p.name + ':' + p.id.slice(0, 8));
    out.serverAfter2 = await (await fetch('/api/periods')).json().then((r) => (r.periods || []).map((p) => p.name));
    // 频度: 每年 1月1日~12月31日(全年命中)
    vm.openSlotNew();
    vm.slotForm.name = '年度段'; vm.slotForm.freq = 'yearly';
    vm.slotForm.startM = 1; vm.slotForm.startD = 1; vm.slotForm.endM = 12; vm.slotForm.endD = 31;
    await vm.saveSlot(); await sleep(300);
    // 频度: 每周(选一个非今日 => 今日不生效)
    vm.openSlotNew();
    vm.slotForm.name = '非今日周'; vm.slotForm.freq = 'weekly'; vm.slotForm.weekdays = [otherW];
    await vm.saveSlot(); await sleep(300);
    const names = vm.sortedPeriods.map((p) => p.name);
    out.names = names;
    out.freqs = vm.sortedPeriods.map((p) => p.freq + ':' + (p.weekdays || []).join(',') + ':' + (p.startMD || 0));
    out.lblWeekly = (function () { const p = vm.sortedPeriods.find((x) => x.name === '每周复盘'); return p ? p.freq + ':' + JSON.stringify(p.weekdays) : 'MISS'; })();
    out.lblYearly = (function () { const p = vm.sortedPeriods.find((x) => x.name === '年度段'); return p ? p.freq + ':' + p.startMD + '-' + p.endMD : 'MISS'; })();
    const cardsText = [...document.querySelectorAll('.slotcard')].map((c) => c.textContent || '');
    out.hasWeeklyLabel = cardsText.some((c) => c.includes('每周') && c.includes('复盘'));
    out.hasYearlyLabel = cardsText.some((c) => c.includes('每年1月1日–12月31日'));
    vm.setView('trace'); await sleep(300);
    const bandNames2 = [...document.querySelectorAll('.tfband b')].map((b) => b.textContent || '');
    out.lane2 = bandNames2;
    out.hasWeeklyLane = bandNames2.includes('每周复盘');
    out.hasYearlyLane = bandNames2.includes('年度段');
    out.noOtherDayLane = !bandNames2.includes('非今日周');
    vm.setView('list'); await sleep(150);
    const addBtn = document.querySelector('.adddesk, .fab');
    if (addBtn) addBtn.click();
    await sleep(250);
    const sel = [...document.querySelectorAll('.sheet select')].find((s) => (s.textContent || '').includes('未安排'));
    out.opts = sel ? sel.options.length : -1;
    const closeBtn = document.querySelector('.sheet .ibtn');
    if (closeBtn) closeBtn.click();
    await sleep(200);
    // ---- 色槽: 分配(按优先组) / 删除释放 / 新时段复用 ----
    const pf = (n) => vm.sortedPeriods.find((x) => x.name === n);
    const focusP = pf('专注');
    const weeklyP = pf('每周复盘');
    out.colorSlotFocus = focusP ? focusP.colorSlot : -1;
    out.colorSlotWeekly = weeklyP ? weeklyP.colorSlot : -1;
    const freedSlot = out.colorSlotFocus;
    window.confirm = () => true;
    await vm.removeSlot(focusP); await sleep(350);
    vm.openSlotNew();
    vm.slotForm.name = '新的高'; vm.slotForm.priority = 2; vm.slotForm.remindBeforeMin = 10;
    await vm.saveSlot(); await sleep(350);
    const newP = pf('新的高');
    out.colorSlotReuse = newP ? newP.colorSlot : -1;
    // 轨迹色块颜色(非透明即可: 未挂时段按重要度取色, 已挂时段用时段色)
    vm.setView('trace'); await sleep(300);
    const blkBg = document.querySelector('.tfblk') ? getComputedStyle(document.querySelector('.tfblk')).backgroundColor : 'NONE';
    out.blkBg = blkBg;
    vm.setView('list'); await sleep(150);
    // ---- 时段色覆盖影响空间: 列表卡片挂时段 → 左色条 + 徽章 ----
    const rgbOf = (hex) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
      if (!m) return 'NONE';
      const n = parseInt(m[1], 16);
      return 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')';
    };
    const slotTodo = vm.todos.find((x) => !x.deleted && !x.slotId && x.status !== 'done');
    if (slotTodo && weeklyP) {
      const rec = vm.M.normalize({ ...slotTodo, slotId: weeklyP.id });
      vm.M.stamp(rec, vm.engine.skew);
      await vm.engine.commit(rec); await sleep(300);
      const cardEl = [...document.querySelectorAll('.card')].find((c) => (c.textContent || '').includes(slotTodo.title));
      const computed = cardEl ? getComputedStyle(cardEl).borderLeftColor : 'NOCARD';
      const deep = vm.M.periodColor(weeklyP).deep;
      out.cardBorderIsSlot = computed === rgbOf(deep);
      out.cardBorder = computed;
      const badge = cardEl ? cardEl.querySelector('.slotb') : null;
      out.hasSlotBadge = !!badge && (badge.textContent || '').includes('每周复盘');
    } else {
      out.cardBorderIsSlot = false;
      out.hasSlotBadge = false;
    }
    // ---- 时段浅色背景带(整条按分钟铺底) ----
    vm.setView('trace'); await sleep(300);
    const bandEls = [...document.querySelectorAll('.tfband')];
    out.laneBgs = bandEls.map((el) => getComputedStyle(el).backgroundColor);
    vm.setView('list'); await sleep(150);
    // ---- 0.3.0: 主页时段横幅 + 逾期剔除已完成 + 轨迹拖拽冒烟 ----
    out.hasNowPeriod = !!document.querySelector('.nowperiod');
    // 已完成任务从“已逾期”移除
    const zt = vm.todos.find((x) => x.title === '提交周报');
    if (zt && vm.st(zt) === 'overdue') {
      await vm.toggleDone(zt); await sleep(400);
      vm.tab = 'overdue'; await sleep(250);
      out.overdueAfterDone = [...document.querySelectorAll('.card .title')].map((x) => x.textContent || '');
      vm.tab = 'all'; await sleep(150);
      const zt2 = vm.todos.find((x) => x.title === '提交周报');
      if (zt2 && zt2.status === 'done') { await vm.toggleDone(zt2); await sleep(350); }
    } else out.overdueAfterDone = 'SKIP';
    // 轨迹拖拽冒烟: 按下(未移动)即抬起 → 不落库、无异常
    vm.setView('trace'); await sleep(300);
    const blk = document.querySelector('.tfblk');
    out.dragSmoke = 'NOBLK';
    if (blk) {
      blk.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: 40, clientY: 40 }));
      await sleep(80);
      const started = !!(vm.drag && vm.drag.id);
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, clientX: 40, clientY: 40 }));
      await sleep(150);
      out.dragSmoke = started && vm.drag === null ? 'ok' : 'no-drag';
    }
    vm.setView('list'); await sleep(150);
    // ---- 时段编辑: 多节点行 + 刷选 + 一键空隙(0.5) ----
    try {
      // 清空已有时段, 让“未命名空隙”= 全天
      for (const p of [...vm.periods]) if (!p.deleted) { await vm.removeSlot(p); await sleep(60); }
      vm.setView('slots'); await sleep(150);
      vm.openSlotNew();
      vm.setSlotMulti(true); // 新编辑器默认“单段”, 多段/刷选测试需先切到多段形态
      vm.slotForm.name = '空隙测';
      await sleep(150); // 等 slotform 渲染, $refs 才可用
      const before = (vm.slotForm.nodes || []).length;           // 默认 1 段
      vm.addSlotNode();                                          // 行添加 → 2 段
      const afterAdd = (vm.slotForm.nodes || []).length;
      const bar = vm.$refs.brushbar;
      let afterBrush = afterAdd;
      let brushDbg = { hasBar: !!bar };
      if (bar) {
        const r = bar.getBoundingClientRect();
        brushDbg.w = Math.round(r.width);
        brushDbg.h = Math.round(r.height);
        const mk = (type, frac) => new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerType: 'mouse', button: 0,
          clientX: r.left + r.width * frac, clientY: r.top + 12,
        });
        bar.dispatchEvent(mk('pointerdown', 0.30));
        await sleep(40);
        brushDbg.draftAfterDown = vm.brushDraft ? (vm.brushDraft.startMin + '-' + vm.brushDraft.endMin) : null;
        window.dispatchEvent(mk('pointermove', 0.46));
        await sleep(40);
        brushDbg.draftAfterMove = vm.brushDraft ? (vm.brushDraft.startMin + '-' + vm.brushDraft.endMin) : null;
        window.dispatchEvent(mk('pointerup', 0.46));
        await sleep(150);
        afterBrush = (vm.slotForm.nodes || []).length;
        brushDbg.draftCleared = vm.brushDraft === null;
      } else {
        brushDbg.w = -1;
      }
      vm.pickUnnamedGaps();                                      // 空隙并入
      await sleep(80);
      const afterGaps = (vm.slotForm.nodes || []).length;
      const allFine = (vm.slotForm.nodes || []).every((n) => Number.isFinite(n.startMin) && Number.isFinite(n.endMin));
      out.nodeTest = { before, afterAdd, afterBrush, afterGaps, allFine, dbg: brushDbg };
      vm.cancelSlot();
    } catch (e) { out.nodeTest = 'ERR:' + e.message; }
    // ---- 轨迹: 真实横向拖动(改时间) ----
    try {
      vm.setView('trace'); await sleep(300);
      const first = vm.flow && vm.flow.rows[0] && vm.flow.rows[0][0];
      const el0 = document.querySelector('.tfblk');
      out.dragMove = 'NOBLK';
      if (first && el0) {
        const beforeDue = first.todo.dueAt;
        const r0 = el0.getBoundingClientRect();
        const mk = (type, x) => new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerType: 'mouse', button: 0,
          clientX: x, clientY: r0.top + r0.height / 2,
        });
        el0.dispatchEvent(mk('pointerdown', r0.left + 12));
        await sleep(40);
        window.dispatchEvent(mk('pointermove', r0.left + 12 + 140));
        await sleep(40);
        window.dispatchEvent(mk('pointerup', r0.left + 12 + 140));
        let after = null;
        for (let i = 0; i < 15; i++) {
          after = vm.todos.find((x) => x.id === first.todo.id);
          if (after && beforeDue && after.dueAt !== beforeDue) break;
          await sleep(200);
        }
        const dms = after && beforeDue ? (after.dueAt - beforeDue) / 60000 : null;
        out.dragMove = (after && dms != null && Math.abs(dms) >= 5 && Math.abs(dms) <= 240) ? 'ok+' + Math.round(dms) : 'no-move';
      }
      vm.setView('list'); await sleep(150);
    } catch (e) { out.dragMove = 'ERR:' + e.message; }
    // ---- 轨迹: 日期切换(后一天/回今天, 可预览任意一天) ----
    try {
      vm.setView('trace'); await sleep(300);
      const lbl0 = vm.traceDateLabel;
      const dayMs0 = vm.flow ? vm.flow.dayMs : 0;
      vm.traceShift(1); await sleep(350);
      const lbl1 = vm.traceDateLabel;
      const dayMs1 = vm.flow ? vm.flow.dayMs : 0;
      const items1 = vm.flow ? vm.flow.todos.length : -1;
      const bandCount1 = vm.flow ? vm.flow.bands.length : -1;
      vm.traceGoToday(); await sleep(300);
      const backToday = vm.traceDateLabel;
      out.dayNav = {
        ok: !!lbl0 && !!lbl1 && lbl0 !== lbl1 && dayMs1 > dayMs0 && items1 >= 0 && backToday === lbl0,
        lbl0, lbl1, items1, bandCount1,
      };
      vm.setView('list'); await sleep(150);
    } catch (e) { out.dayNav = 'ERR:' + e.message; }
    // ---- 主题切换 ----
    vm.setThemePref('dark'); await sleep(300);
    out.darkSet = document.documentElement.getAttribute('data-theme');
    out.darkBg = getComputedStyle(document.body).backgroundColor;
    vm.setThemePref('light'); await sleep(300);
    out.lightSet = document.documentElement.getAttribute('data-theme');
    out.lightBg = getComputedStyle(document.body).backgroundColor;
  } catch (e) { out.stage3 = String(e); }
  return out;
})();
