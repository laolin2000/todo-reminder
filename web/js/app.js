// ============================================================
// app.js — 待办提醒 Web 界面(自适应: 桌面窗口 / 手机浏览器 / 平板)
// 依赖: index.html 先加载 vendor/vue.global.prod.js(全局 Vue)
// ============================================================
import { SyncEngine } from './api.js';
import * as M from './model.js';

const { createApp } = window.Vue;
const host = window.todoHost || null; // Electron 桌面注入;浏览器为 null

/** 图片文件 → 缩小后的 dataURL(jpeg ≤1024px), 减小 AI 请求体 */
function fileToSmallDataUrl(file, maxW = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const sc = Math.min(1, maxW / img.width);
        const w = Math.max(1, Math.round(img.width * sc));
        const h = Math.max(1, Math.round(img.height * sc));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

export function boot() {
  const app = createApp({
    data() {
      return {
        M,
        host,
        onePkg: !!window.__NO_WS__, // 内嵌一体包(手机 APK): 本地服务器注入, 无桌面 preload
        batteryText: '后台运行: 查询中…',
        todos: [],                  // 展示列表源(不含墓碑)
        engine: null,
        conn: 'connecting',         // connecting/syncing/synced/offline/auth
        lastSyncText: '',
        // ---- 列表状态 ----
        tab: 'all',                 // all/today/todo/done/overdue
        search: '',
        impFilter: [],              // 重要程度多选
        indepFilter: 'all',         // all/independent/dependent
        sortBy: 'dueAt',
        sortDir: 1,                 // 1 asc / -1 desc
        groupBy: 'date',            // none/date/location/importance/independence/status
        collapsed: {},
        // ---- 编辑器 ----
        editing: null,              // 编辑中的记录副本
        editorOpen: false,
        editorMode: 'new',
        materialInput: '',
        // ---- 其他 ----
        settingsOpen: false,
        filterOpen: false,
        authNote: '',
        tokenInput: '',
        apkFiles: [],
        toasts: [],
        saving: false,
        nowTick: Date.now(),
        perfText: '',               // 诊断面板: 最近一条性能记录(仅在面板打开时更新)
        autostartOn: false,
        desktopInfo: null,
        authTab: false,
        locOrigin: location.origin,
        durationCustom: null,
        // 历史输入联想(类似浏览器搜索历史; 时间选项不参与)
        hist: { show: null, items: [] },
        histBlurTimer: null,
        // 时段库(自定义时段, 按优先度排列)
        periods: [],
        viewMode: 'list',           // list / trace / slots
        slotForm: null,             // 新建/编辑中的时段表单
        slotEditing: false,
        themePref: 'system',        // light / dark / neo / system(跟随系统) — 设备本地显示偏好, 不参与同步
        perfLite: (() => {
          const v = window.localStorage.getItem('tr:lite');
          return v === '1';
        })(),                       // 流畅模式: 关闭阴影/动效等绘制开销(低配机更跟手)
        drag: null,                 // 轨迹视图拖拽状态
        // 查重: 同一件事改了时间 → 保存时自动替换旧的那条(默认开; 设置里可关)
        dedupePref: (() => { try { return localStorage.getItem('tr:dedupe') !== '0'; } catch { return true; } })(),
        dupeDraft: [],              // 编辑器: 命中「同一件事」的现有条目(仅用于提示)
        dupeDraftTime: false,       // 命中项与新内容的时间是否不同
        // 潜在重复「扫描 → 勾选处理」(v1.0.66)
        ptOpen: false,              // 处理面板(针对当前编辑内容)
        ptNew: null,                // 当前比较用的“新内容”快照
        ptRows: [],                 // 扫描结果行 {old, score, reasons, oldHl, newHl, checked}
        ptConflicts: [],            // 与“重复机制”事项的极高相似度冲突(只提出, 不处理)
        ptSharedAll: [],            // 高亮用词
        ptSaveAfter: false,         // 确认后是否顺便保存
        ptTopOpen: false,           // 全库自查面板
        ptTopRows: [],              // 全库自查结果 {a,b,score,reasons,keep}
        ptTopSkippedRepeat: 0,      // 全库自查跳过的重复机制事项数
        _undoPayload: null,         // 最近一次删除(供撤销)
        aiCfg: null,                // {baseUrl, model, hasKey, periodTable, periodTableAt}
        aiKey: '',
        aiBusy: false,
        // ---------- 远程访问(手机入口) ----------
        remoteStatus: null,         // core/remote.mjs 的 status() 快照
        remoteBusy: false,
        remoteBusyText: '',
        remoteStarting: false,      // 正在首次启动(耗时较长, 提示文案不同)
        remoteErr: '',
        remoteSteps: [],            // 诊断逐环节结果
        _remoteTimer: null,
        aiMode: 'auto',             // AI 截图模式: auto / timetable / periodtable / todo
        aiPt: false,                // 节次对照表识别结果弹层
        aiPtText: '',
        editingRuleRepeat: 'none',  // 编辑对象原有的重复方式(模式切换时保护“每天”)
        ptAt: 0,                    // 节次表最后录入时间(用于显示“上次更新”)
        brushDraft: null,           // 时段编辑: 正在刷选的新时间段
        traceHourW: (() => {
          const v = Number(window.localStorage.getItem('tr:traceZoom'));
          return v >= 2 && v <= 520 ? v : 92; // X轴每小时像素宽(跨度; 小值可把多日整轴铺进一屏)
        })(),
        traceDays: (() => {
          const v = Number(window.localStorage.getItem('tr:traceDays'));
          return Number.isFinite(v) && v >= 1 && v <= 7 ? v : 3; // 轨迹时间轴横跨几天(打通相邻天时段)
        })(),
        traceOff: 0,                          // 轨迹起始日: 相对今天的偏移天数(0=今天; 可翻页预览)
      };
    },
    computed: {
      counts() {
        const c = { all: 0, today: 0, todo: 0, done: 0, overdue: 0 };
        const now = this.nowTick;
        for (const t of this.todos) {
          const l = M.lifeStatus(t, now);
          if (l === 'done') { c.done++; continue; }
          c.all++; c.todo++;
          if (l === 'overdue') c.overdue++;
          if (t.dueAt && M.dateBucket(t.dueAt, new Date(now)) === 'today') c.today++; // 今天含已超时的(它们也出现在已逾期)
          if (!t.dueAt) c.today++; // 不定时: 也计入「今天」(用户约定: 除已完成/已逾期外都可见)
        }
        return c;
      },
      filtered() {
        let list = this.todos.filter((t) => !t.deleted);
        const now = this.nowTick;
        // 状态 / 时间桶(状态为派生: 到开始→进行中, 过结束→已逾期; 已完成不再出现在逾期)
        list = list.filter((t) => {
          const l = M.lifeStatus(t, now);
          const bucket = t.dueAt ? M.dateBucket(t.dueAt, new Date(now)) : 'none';
          if (this.tab === 'done') return l === 'done';
          if (this.tab === 'todo') return l !== 'done';
          if (this.tab === 'overdue') return l === 'overdue';
          if (this.tab === 'today') return l !== 'done' && (bucket === 'today' || !t.dueAt); // 今天: 到期+不定时
          return true;
        });
        // 重要程度 / 独立性
        if (this.impFilter.length) list = list.filter((t) => this.impFilter.includes(t.importance));
        if (this.indepFilter !== 'all') list = list.filter((t) => (this.indepFilter === 'independent') === t.independent);
        // 搜索: 标题/备注/地点/材料
        const q = this.search.trim().toLowerCase();
        if (q) {
          list = list.filter((t) =>
            [t.title, t.notes, t.location, ...(t.materials || [])].join(' ').toLowerCase().includes(q));
        }
        return list;
      },
      sorted() {
        const dir = this.sortDir;
        const by = this.sortBy;
        const val = (t) => {
          switch (by) {
            case 'importance': return t.importance;
            case 'durationMin': return t.durationMin == null ? (dir > 0 ? Infinity : -Infinity) : t.durationMin;
            case 'location': return (t.location || '').toLowerCase();
            case 'createdAt': return t.createdAt;
            case 'dueAt': return t.dueAt == null ? (dir > 0 ? Infinity : -Infinity) : t.dueAt;
            default: return t.dueAt ?? Infinity;
          }
        };
        const list = [...this.filtered].sort((a, b) => {
          const va = val(a); const vb = val(b);
          if (va !== vb) {
            if (typeof va === 'string') return va.localeCompare(vb, 'zh') * dir;
            return (va - vb) * dir;
          }
          // 稳定次排序: 重要程度高的在前、时间早的在前
          const ia = a.importance, ib = b.importance;
          if (ia !== ib) return ib - ia;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        return list;
      },
      grouped() {
        const keyFn = {
          none: () => 'all',
          date: (t) => (t.status === 'done' ? 'done' : (t.dueAt ? M.dateBucket(t.dueAt, new Date(this.nowTick)) : 'none')),
          location: (t) => (t.location || '').trim() || '∅',
          importance: (t) => String(t.importance),
          independence: (t) => (t.independent ? '1' : '0'),
          status: (t) => M.lifeStatus(t, this.nowTick),
        }[this.groupBy] || (() => 'all');
        const order = {
          none: ['all'],
          date: ['overdue', 'none', 'today', 'tomorrow', 'week', 'later', 'done'], // 不定时紧随已逾期
          importance: ['4', '3', '2', '1', '0'],
          independence: ['1', '0'],
          status: ['todo', 'doing', 'overdue', 'done'],
        }[this.groupBy];
        const groups = new Map();
        for (const t of this.sorted) {
          const k = keyFn(t);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(t);
        }
        let keys = [...groups.keys()];
        if (order) keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        if (this.groupBy === 'location') {
          keys.sort((a, b) => (a === '∅' ? 1 : b === '∅' ? -1 : a.localeCompare(b, 'zh')));
        }
        return keys.map((k) => ({ key: k, label: this.groupLabel(k), items: groups.get(k), count: groups.get(k).length }));
      },
      groupLabel() {
        return (k) => {
          if (this.groupBy === 'date') return k === 'done' ? '✅ 已完成' : (M.BUCKET_LABEL[k] || k);
          if (this.groupBy === 'location') return k === '∅' ? '📍 未填地点' : `📍 ${k}`;
          if (this.groupBy === 'importance') return `⭐ ${M.imp(k).label}`;
          if (this.groupBy === 'independence') return k === '1' ? '🔗 独立事项' : '🔗 依赖他人/前置条件';
          if (this.groupBy === 'status') return M.STATUS_LABEL[k] || k;
          return '全部事项';
        };
      },
      dueTitle() {
        return {
          dueAt: '按时间', importance: '按重要程度', durationMin: '按所需时间',
          location: '按地点', createdAt: '按创建时间',
        }[this.sortBy] + (this.sortDir === 1 ? ' ↑' : ' ↓');
      },
      connMeta() {
        return {
          connecting: ['连接中…', '#8a94a6'],
          syncing: ['同步中…', '#c07a12'],
          synced: ['已同步', '#1f9d55'],
          offline: ['离线', '#d33f49'],
          auth: ['需要连接码', '#d33f49'],
        }[this.conn] || ['未知', '#8a94a6'];
      },
      isDesktop() { return !!host; },
      sortKey() { return this.sortBy; },
      // ---------- 时段库 / 轨迹视图 ----------
      /** 时段按优先度(高→低)排列, 同优先度按开始时间 */
      sortedPeriods() {
        return [...this.periods]
          .sort((a, b) => (b.priority - a.priority) || ((a.startMin ?? 1440) - (b.startMin ?? 1440)));
      },
      timeOptions() {
        const out = [];
        for (let m = 0; m < 1440; m += 15) out.push({ v: m, label: M.fmtMin(m) });
        return out;
      },
      endTimeOptions() {
        return [...this.timeOptions, { v: 1440, label: '24:00' }];
      },
      /** 轨迹当前轴内包含的日期范围(连续多天: 不只看一天) */
      traceRangeObj() {
        const b = new Date(this.nowTick);
        const d0 = new Date(b.getFullYear(), b.getMonth(), b.getDate() + (this.traceOff || 0));
        const d1 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + (this.traceDays || 1) - 1);
        return { d0, d1 };
      },
      traceIsToday() {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const r = this.traceRangeObj; // computed 间引用用属性, 不加括号
        const s = new Date(r.d0.getFullYear(), r.d0.getMonth(), r.d0.getDate()).getTime();
        return today >= s && today < s + (this.traceDays || 1) * 86400000;
      },
      traceDateLabel() {
        const r = this.traceRangeObj;
        const wk = '日一二三四五六'[r.d0.getDay()];
        const n = this.traceDays || 1;
        if (n === 1) {
          const rel = !this.traceOff ? '今天' : this.traceOff === 1 ? '明天' : this.traceOff === -1 ? '昨天' : '';
          return `${r.d0.getFullYear()}年${r.d0.getMonth() + 1}月${r.d0.getDate()}日 周${wk}${rel ? ' · ' + rel : ''}`;
        }
        const wk1 = '日一二三四五六'[r.d1.getDay()];
        return `${r.d0.getMonth() + 1}月${r.d0.getDate()}日(周${wk}) 起 ${n} 天 → ${r.d1.getMonth() + 1}月${r.d1.getDate()}日(周${wk1})`;
      },
      nowPct() {
        // “现在”在连续多日轴上的百分比位置; 今天不在轴内时返回 -999(隐藏红线)
        const f = this.flow;
        if (!f || !f.spanMin || f.nowMinAbs == null || f.nowMinAbs < 0) return -999;
        return (f.nowMinAbs / f.spanMin * 100).toFixed(2);
      },
      /**
       * 轨迹视图泳道: 每泳道=一个时段(按优先度排列, 仅今日生效)+「未安排」,
       * 泳道内方块=当天到期的待办, 位置按时刻、宽度按所需时间。
       * 与 DSH 轨迹视图同构: 左标签列 + 横向时间轴 + 彩色块。
       */
      traceLanes() {
        const now = new Date(this.nowTick);
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const dayEnd = dayStart + 86400000;
        const items = this.todos.filter((t) =>
          !t.deleted && t.status !== 'done' && t.dueAt != null && t.dueAt >= dayStart && t.dueAt < dayEnd);
        const block = (t) => {
          const startH = (t.dueAt - dayStart) / 3600000;
          const durH = Math.max((t.durationMin || 20) / 60, 0.33);
          const w = Math.min(durH, 24 - startH);
          return { todo: t, left: (startH / 24 * 100).toFixed(2), width: (w / 24 * 100).toFixed(2) };
        };
        const lanes = [];
        for (const p of this.sortedPeriods) {
          if (!M.periodActiveOnDay(p, now)) continue; // 仅展示今日生效的时段
          lanes.push({ kind: 'slot', p, items: items.filter((t) => t.slotId === p.id).map(block) });
        }        const orphanIds = [...new Set(items.filter((t) => t.slotId).map((t) => t.slotId))]
          .filter((id) => !this.sortedPeriods.some((p) => p.id === id));
        for (const oid of orphanIds) {
          lanes.push({ kind: 'gone', p: { id: oid, name: '时段已删除', env: '' }, items: items.filter((t) => t.slotId === oid).map(block) });
        }
        lanes.push({ kind: 'none', p: null, items: items.filter((t) => !t.slotId).map(block) });
        return lanes.map((l) => ({
          ...l,
          blocks: l.items,
          col: l.kind === 'slot' ? M.periodColor(l.p) : M.NONE_SLOT_COLOR,
        }));
      },
      /**
       * 历史词条: 从全部(含已完成)待办中提取 标题/地点/材料/备注 去重,
       * 按「出现次数 → 最近使用」排序, 用于编辑器输入联想。
       * @returns {{title:any[], location:any[], materials:any[], notes:any[]}}
       */
      // ---------- 当前时段(主页横幅数据: 同时进行可多条) ----------
      todayPeriods() {
        const now = new Date(this.nowTick);
        return this.periods
          .filter((p) => !p.deleted && (p.nodes || []).length && M.periodActiveOnDay(p, now))
          .sort((a, b) => {
            const sa = M.periodDaySegments(a)[0]?.startMin ?? 1440;
            const sb = M.periodDaySegments(b)[0]?.startMin ?? 1440;
            return (b.priority - a.priority) || (sa - sb);
          });
      },
      /**
       * 主页横幅: 当前“正在进行”的所有时段(不只第一条), 每条含本段渲染数据。
       * 仅显示此刻激活的时段; 不激活即自动消失(nowTick 每分钟驱动)。
       */
      curPeriodViews() {
        const now = new Date(this.nowTick);
        const m = now.getHours() * 60 + now.getMinutes();
        const out = [];
        for (const p of this.todayPeriods) {
          if (!M.periodActiveAt(p, m)) continue;
          const seg = M.periodDaySegments(p).find((s) => m >= s.startMin && m < s.endMin);
          if (!seg) continue;
          out.push({
            p,
            col: M.periodColor(p),
            label: `${M.fmtMin(seg.startMin)}–${M.fmtMin(seg.endMin)}`,
            leftMin: Math.max(0, seg.endMin - m),
          });
        }
        return out;
      },
      nextPeriod() {
        const now = new Date(this.nowTick);
        const m = now.getHours() * 60 + now.getMinutes();
        let best = null;
        let bestStart = 1441;
        for (const p of this.todayPeriods) {
          for (const s of M.periodDaySegments(p)) {
            if (s.startMin > m && s.startMin < bestStart) {
              bestStart = s.startMin;
              best = p;
            }
          }
        }
        return best;
      },
      // ---------- 轨迹瀑布流(数据缓存, 避免每 20 秒重算/闪烁) ----------
      flow() {
        // —— 多日连续时间轴: 横跨 traceDays 天, 时段/待办按“轴起点起算的绝对分钟”排布,
        //    相邻天的同一时段自然接续(跨午夜节点也贴边连续), 不再只看一天 ——
        const N = Math.max(1, Math.min(7, this.traceDays || 1));
        const nowD = new Date(this.nowTick);
        const today0 = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
        const off = this.traceOff || 0;
        const dayMs = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() + off).getTime();
        const spanMs = N * 86400000;
        const spanMin = N * 1440;
        const sig = `off${off}|N${N}|z${this.traceHourW || 92}|` +
          this.todos.map((t) => `${t.id}:${t.updatedAt}`).join(',') + '|' +
          this.periods.map((p) => `${p.id}:${p.updatedAt}:${JSON.stringify(p.nodes || [])}`).join(',');
        if (this._flowSig === sig && this._flowVal) return this._flowVal;
        const items = this.todos
          .filter((t) => !t.deleted && t.status !== 'done' && t.dueAt != null && t.dueAt >= dayMs && t.dueAt < dayMs + spanMs)
          .map((t) => {
            const s = Math.max(0, Math.min(spanMin - 1, Math.floor((t.dueAt - dayMs) / 60000)));
            const dur = (t.durationMin && t.durationMin > 0 ? t.durationMin : 25);
            return { todo: t, s, e: Math.min(spanMin, Math.max(s + 18, s + dur)) };
          })
          .sort((a, b) => a.s - b.s);
        const rows = [];
        const rowEnds = [];
        for (const it of items) {
          let placed = false;
          for (let i = 0; i < rowEnds.length; i++) {
            if (rowEnds[i] <= it.s) { rowEnds[i] = it.e; rows[i].push(it); placed = true; break; }
          }
          if (!placed) { rowEnds.push(it.e); rows.push([it]); }
        }
        // 行排版: 固定行高(部分省略样式, 布局稳定)
        const hourPx = this.traceHourW || 92; // X轴每小时像素宽(可自由调)
        const rowTop = new Array(rows.length).fill(0);
        const rowH = new Array(rows.length).fill(42);
        let acc = 0;
        for (let ri = 0; ri < rows.length; ri++) {
          rowTop[ri] = acc;
          acc += 46;
        }
        const slotOf = (id) => (id ? this.periodById()[id] : null);
        const IMP_BLOCK = {
          2: { bg: '#f8c9cf', ln: '#d33f49' },
          1: { bg: '#f7e0bd', ln: '#b9762a' },
          0: { bg: '#cfe3ff', ln: '#3b6fd4' },
        };
        const colorize = (t) => {
          const p = slotOf(t.slotId);
          if (p) { const c = M.periodColor(p); return { bg: c.base, ln: c.deep }; }
          return IMP_BLOCK[t.importance] || IMP_BLOCK[1];
        };
        // —— 逐天展开时段到绝对分钟轴 ——
        const hours = [];
        const daysMeta = [];
        const bands = [];
        for (let i = 0; i < N; i++) {
          const di = new Date(dayMs + i * 86400000);
          daysMeta.push({ off: i * 1440, label: `${di.getMonth() + 1}/${di.getDate()} 周${'日一二三四五六'[di.getDay()]}` });
          const activePs = this.periods
            .filter((p) => !p.deleted && (p.nodes || []).length && M.periodActiveOnDay(p, di))
            .sort((a, b) => {
              const sa = M.periodDaySegments(a)[0]?.startMin ?? 1440;
              const sb = M.periodDaySegments(b)[0]?.startMin ?? 1440;
              return (b.priority - a.priority) || (sa - sb);
            });
          for (const p of activePs) {
            const col = M.periodColor(p);
            const activeName = (p.name || '').trim() || '时段';
            const dayBase = i * 1440;
            const segs = M.periodDaySegments(p)
              .map((sg) => ({ s: sg.startMin, e: sg.endMin }))
              .filter((x) => x.s != null && x.e != null && x.e > x.s);
            for (const sg of segs) {
              const a = Math.max(0, dayBase + sg.s);
              const b = Math.min(spanMin, dayBase + sg.e);
              if (b > a) bands.push({ s: a, e: b, col, name: activeName });
            }
            // 未激活(空闲)段: 填写了空闲名才在同日两激活窗口之间显示(更浅+虚线)
            if (segs.length >= 2) {
              const idleName = (p.idleName || '').trim();
              if (idleName) {
                for (let j = 1; j < segs.length; j++) {
                  const gapS = dayBase + segs[j - 1].e, gapE = dayBase + segs[j].s;
                  if (gapE - gapS >= 20 && gapE <= spanMin) {
                    bands.push({ s: Math.max(0, gapS), e: Math.min(spanMin, gapE), col, name: idleName, idle: true });
                  }
                }
              }
            }
          }
          for (let h = 0; h < 1440; h += 60) hours.push(i * 1440 + h);
        }
        // —— 时段重叠分行(全轴贪心区间着色) ——
        let bandLanes = null, bandLaneTop = null, bandLaneH = null, bandAreaH = 0;
        if (bands.length) {
          const bl = [];
          const ends = [];
          for (const bd of [...bands].sort((a, b) => (a.s - b.s) || (a.e - b.e))) {
            let placed = false;
            for (let i = 0; i < ends.length; i++) {
              if (ends[i] <= bd.s) { ends[i] = bd.e; bl[i].push(bd); placed = true; break; }
            }
            if (!placed) { ends.push(bd.e); bl.push([bd]); }
          }
          if (bl.length > 1) {
            bandLanes = bl;
            bandLaneTop = new Array(bl.length).fill(0);
            bandLaneH = new Array(bl.length).fill(40);
            let bacc = 0;
            for (let ri = 0; ri < bl.length; ri++) { bandLaneTop[ri] = bacc; bacc += 44; }
            bandAreaH = bacc - 4;
            for (let ri = 0; ri < rowTop.length; ri++) rowTop[ri] += bandAreaH + 6;
          }
        }
        const nowMinAbs = (() => {
          if (nowD.getTime() < dayMs || nowD.getTime() >= dayMs + spanMs) return -1;
          return Math.floor((nowD.getTime() - dayMs) / 60000);
        })();
        // —— 刻度自适应抽稀: 轴越长/每 px 越挤, 小时标签与竖线间隔越大, 避免互相重叠 ——
        const pxH = hourPx || 92; // 每小时像素宽
        const pickStep = (needPx) => [1, 2, 3, 4, 6, 8, 12, 24].find((s) => s * pxH >= needPx) || 24;
        const labelStep = pickStep(38); // 标签间隔: 至少 38px 才放一个“09:00”
        const lineStep = pickStep(9);   // 竖线间隔: 至少 9px 才画一条
        const labelHours = hours.filter((h) => {
          const wd = h % 1440;
          if (wd % (60 * labelStep) !== 0) return false;
          if (wd === 0 && N > 1) return false; // 日首交给日期标签, 不重复画 00:00
          return true;
        });
        const lineHours = hours.filter((h) => h % (60 * lineStep) === 0);
        const out = {
          todos: items,
          rows,
          rowTop,
          rowH,
          bodyH: (bandAreaH > 0 ? bandAreaH + 6 : 0) + acc + 2,
          bands,
          bandLanes,
          bandLaneTop,
          bandLaneH,
          hours,
          labelHours,
          lineHours,
          lineStep,
          daysMeta,
          spanMin,
          pxPerMin: hourPx / 60,
          dayMs,           // 轴起点 00:00(拖动落位按整个轴换算, 可跨日)
          nowMinAbs,
        };
        // 行上色(保持组件复用, 避免每帧重算)
        for (const row of rows) {
          for (const it of row) {
            const c = colorize(it.todo);
            it.bg = c.bg;
            it.ln = c.ln;
          }
        }
        this._flowSig = sig;
        this._flowVal = out;
        return out;
      },
      histRanked() {
        const agg = { title: new Map(), location: new Map(), materials: new Map(), notes: new Map() };
        const push = (kind, text, ts) => {
          const v = String(text).trim();
          if (!v) return;
          const e = agg[kind].get(v) || { text: v, count: 0, last: 0 };
          e.count++;
          if (ts > e.last) e.last = ts;
          agg[kind].set(v, e);
        };
        for (const t of this.todos) {
          if (t.deleted) continue;
          const ts = Math.max(t.updatedAt, t.createdAt || 0);
          push('title', t.title, ts);
          push('location', t.location, ts);
          for (const m of t.materials || []) push('materials', m, ts);
          push('notes', t.notes, ts);
        }
        const out = {};
        for (const k of Object.keys(agg)) {
          out[k] = [...agg[k].values()]
            .sort((a, b) => (b.count - a.count) || (b.last - a.last))
            .slice(0, 60);
        }
        return out;
      },
    },
    watch: {
      sortBy(v) { this.sortDir = v === 'dueAt' || v === 'location' || v === 'createdAt' ? 1 : v === 'importance' ? -1 : -1; },
      // 编辑器里改了标题/时间 → 实时重算“同一件事”提示(新建时才查重)
      'editing.title'() { if (this.editorOpen && this.editorMode === 'new') this._refreshDedupeHit(); },
      'editing.dueAt'() { if (this.editorOpen && this.editorMode === 'new') this._refreshDedupeHit(); },
    },
    methods: {
      toast(msg, kind = 'info') {
        const id = Date.now() + Math.random();
        this.toasts.push({ id, msg, kind });
        setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, 2600);
      },
      setConn(s) { this.conn = s; this.lastSyncText = s === 'synced' ? new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : this.lastSyncText; if (s === 'synced') this._offlineToastShown = false; },
      copy(text, label = '已复制') {
        navigator.clipboard?.writeText(text).then(() => this.toast(label)).catch(() => this.toast('复制失败'));
      },
      // ---------- 数据入口 ----------
      onData(list) { this.todos = list; this.tick(); },
      onAuth() { this.authNote = '当前连接需要连接码(在电脑端「设置 → 同步」中查看)'; this.openSettings(true); },
      async onManualSync() {
        if (!this.engine) return;
        try {
          await this.engine.sync();
          await this.ptSync(); // 节次表一起对齐(以“最后录入”为准)
          this.setConn('synced'); this.toast('已同步');
        } catch (e) {
          if (e.status === 401) this.onAuth(); else { this.setConn('offline'); this.toast('同步失败: ' + (e.message || ''), 'err'); }
        }
      },
      // ---------- 节次对照表(永久保存: 本机 localStorage + 服务端 ai.json, 带版本号) ----------
      _lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } },
      _lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
      _ptLocal() {
        const t = this._lsGet('tr:v1:pt');
        const at = Number(this._lsGet('tr:v1:ptAt') || 0) || 0;
        return { text: t == null ? null : String(t), at };
      },
      _ptLocalSet(text, at) {
        this._lsSet('tr:v1:pt', String(text || ''));
        this._lsSet('tr:v1:ptAt', String(Number(at) || 0));
      },
      /** 与服务器对齐节次表: 本机更新的推上去, 服务器更新的取回来(不会互相覆盖回旧内容) */
      async ptSync() {
        if (!this.aiCfg) await this.loadAiCfg();
        const loc = this._ptLocal();
        try {
          let r;
          if (loc.text != null && loc.at > 0) {
            r = await fetch('/api/ai/periodtable', {
              method: 'POST', headers: this.aiHeaders(),
              body: JSON.stringify({ periodTable: loc.text, periodTableAt: loc.at }),
            });
          } else {
            r = await fetch('/api/ai/periodtable', { headers: this.aiHeaders() });
          }
          if (!r.ok) return false;
          const j = await r.json().catch(() => null);
          if (!j || !j.ok) return false;
          const srvAt = Number(j.periodTableAt) || 0;
          if (loc.at > srvAt && loc.text != null) {
            // 本机更“新”但服务器没收(时钟异常/离线): 保留本机, 下次再推
          } else {
            this._ptLocalSet(j.periodTable || '', srvAt);
          }
          this.aiCfg = { ...(this.aiCfg || {}), periodTable: j.periodTable || '', periodTableAt: srvAt };
          return true;
        } catch (e) {
          this.engine && this.engine.recordErr && this.engine.recordErr('pt ' + ((e && e.message) || e));
          return false;
        }
      },
      /** 保存节次表(唯一入口: 截图识别保存 / 设置页保存都走这里) */      async savePeriodTable(text, opts = {}) {
        const clean = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30).join('\n');
        if (!clean) { this.toast('节次表内容为空', 'err'); return false; }
        const at = Date.now();
        // 先落本机(离线也不丢), 再推服务器
        this._ptLocalSet(clean, at);
        this.aiCfg = { ...(this.aiCfg || {}), periodTable: clean, periodTableAt: at };
        this.ptAt = at;
        try {
          const r = await fetch('/api/ai/periodtable', {
            method: 'POST', headers: this.aiHeaders(),
            body: JSON.stringify({ periodTable: clean, periodTableAt: at }),
          });
          const j = await r.json().catch(() => null);
          if (!j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          this._ptLocalSet(j.periodTable || clean, Number(j.periodTableAt) || at);
          this.aiCfg = { ...(this.aiCfg || {}), periodTable: j.periodTable || clean, periodTableAt: Number(j.periodTableAt) || at };
          if (!opts.silent) {
            const n = (j.periodTable || clean).split('\n').filter(Boolean).length;
            this.toast('✅ 节次对照表已永久保存(' + n + ' 行)');
          }
          return true;
        } catch (e) {
          this.toast('节次表已存本机, 同步到电脑失败: ' + ((e && e.message) || '网络异常'), 'err');
          return false;
        }
      },
      ptUpdatedText() {
        const at = Number((this.aiCfg && this.aiCfg.periodTableAt) || this.ptAt || 0);
        if (!at || at < 1000000000) return '';
        return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      },
      tick() {
        // 只在“分钟”变化时刷新, 避免无谓整页重绘(倒计时按分钟粒度即可)
        // 编辑/输入进行中不刷新 —— 防止输入时页面重算导致的闪烁
        if (this.editorOpen || document.hidden) return;
        const d = new Date();
        if (this._tickMin === d.getMinutes()) return;
        this._tickMin = d.getMinutes();
        this.nowTick = Date.now();
        this._perfIfChanged();
      },
      /** 诊断面板打开时才更新性能/诊断文本, 平时不做任何 DOM 写入(避免后台重绘) */
      _perfIfChanged() {
        if (!this.settingsOpen) return;
        const v = (window.__perf || []).slice(-1)[0] || '';
        if (v && v !== this.perfText) this.perfText = v;
      },
      /**
       * 闲置自动静止(手机降温核心): 12 秒无操作 → html.idle 暂停所有光效动画,
       * WebView 停止 60fps 出帧(实测 CPU 8.2% → 0.4%); 一碰立即恢复流动。
       */
      _bindIdle() {
        const doc = document.documentElement;
        const wake = () => {
          if (this._idle) {
            this._idle = false;
            doc.classList.remove('idle');
            doc.classList.add('live');
            clearTimeout(this._liveTimer);
            // 恢复后先“流动”片刻(切页/滚动时的光效), 再回到静止
            this._liveTimer = setTimeout(() => doc.classList.remove('live'), 900);
          }
          clearTimeout(this._idleTimer);
          this._idleTimer = setTimeout(() => {
            this._idle = true;
            doc.classList.remove('live');
            doc.classList.add('idle');
          }, 12000);
        };
        this._wake = wake;
        for (const ev of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel', 'scroll']) {
          window.addEventListener(ev, wake, { passive: true });
        }
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) { // 切后台/锁屏: 立刻静止, 不再出帧
            this._idle = true;
            doc.classList.remove('live');
            doc.classList.add('idle');
          } else wake();
        });
        wake();
      },
      /** 编辑状态时给 <html> 加标记: 输入期间暂停动画/毛玻璃, 消除闪烁并省电 */
      _syncEditingClass() {
        try { document.documentElement.classList.toggle('editing', !!this.editorOpen); } catch (e) { /* ignore */ }
      },
      /** 派生状态与剩余文案(供模板调用) */
      st(t) { return M.lifeStatus(t, this.nowTick); },
      stText(t) { return M.lifeText(t, this.nowTick); },
      blkClick(t) {
        if (this._justDragged) return; // 拖完松手不触发编辑
        this.openEdit(t);
      },
      // ---------- 瀑布流: 长按选中色块后横向拖动 = 改时间(5 分钟一格) ----------
      // 交互约定: 快速横滑 = 平移时间轴(块不响应); 按住 350ms 不动 = 选中该块
      // (高亮), 此后位移才拖动改时间; 拖到视口左/右边缘时视口自动向该方向延伸。
      tfDragStart(b, ev) {
        if (this.drag) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const px = this.flow.pxPerMin;
        if (!px) return;
        const drag = {
          id: b.todo.id, todo: b.todo, s0: b.s, x0: ev.clientX, y0: ev.clientY, px,
          moved: false, armed: false, cancelled: false, armTimer: null,
          block: ev.currentTarget, el: null, sl0: 0, lastX: ev.clientX, raf: 0,
        };
        this.drag = drag;
        // 注意: this.drag 已被 Vue reactive 包装, 定时器必须引用代理后的同一对象
        // (传原始对象会导致 _armTfDrag 的 this.drag !== drag 恒真而提前返回)
        drag.armTimer = setTimeout(() => this._armTfDrag(this.drag), 350);
        const move = (e) => this.tfDragMove(e);
        const up = () => {
          if (this.drag && this.drag.armTimer) clearTimeout(this.drag.armTimer);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          this.tfDragEnd();
        };
        window.addEventListener('pointermove', move, { passive: true });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        document.body.classList.add('dragging-body');
      },
      /** 长按判定成立: 高亮该块, 触摸下接管滚动 → 之后的位移全部归“拖块”, 并启动边缘延伸 */
      _armTfDrag(drag) {
        if (!this.drag || this.drag !== drag || drag.cancelled) return;
        drag.armed = true;
        drag.el = document.querySelector('.tflowwrap');
        drag.sl0 = drag.el ? drag.el.scrollLeft : 0;
        if (!this._stopScroll) {
          const stop = (e) => { if (e.cancelable) e.preventDefault(); };
          document.addEventListener('touchmove', stop, { passive: false });
          this._stopScroll = stop;
        }
        drag.raf = requestAnimationFrame(() => this._tfEdgeLoop());
      },
      /** 按手指的“内容坐标”计算落点(含视口滚动量), 更新块位置 */
      _tfApplyDrag(x) {
        const dr = this.drag;
        const f = this.flow;
        if (!dr || !f || !dr.armed) return;
        const el = dr.el;
        const px = f.pxPerMin;
        if (!el || !px) return;
        const span = f.spanMin || 1440;
        const delta = (x - dr.x0) + (el.scrollLeft - dr.sl0); // 相对起点的内容位移(px)
        if (!dr.moved && Math.abs(delta) < 6) return;
        dr.moved = true;
        const s = Math.max(0, Math.min(span - 18, Math.round((dr.s0 + delta / px) / 5) * 5));
        const blk = document.querySelector(`.tfblk[data-id="${dr.id}"]`);
        if (blk) blk.style.left = (s / span * 100) + '%';
      },
      /** 边缘延伸: 手指停在视口左/右边缘带内时, 每帧向该方向滚动并同步块位置 */
      _tfEdgeLoop() {
        const dr = this.drag;
        if (!dr || !dr.armed) { return; }
        const el = dr.el;
        const f = this.flow;
        if (el && f && f.pxPerMin) {
          const r = el.getBoundingClientRect();
          const EDGE = 46;
          let dir = 0;
          if (dr.lastX >= r.right - EDGE) dir = 1;
          else if (dr.lastX <= r.left + EDGE) dir = -1;
          if (dir) {
            const dist = dir > 0 ? (r.right - dr.lastX) : (dr.lastX - r.left);
            const speed = 6 + Math.max(0, Math.min(EDGE, dist)) / EDGE * 22; // 贴边快, 靠内慢
            const maxX = Math.max(0, (f.spanMin || 1440) * f.pxPerMin - el.clientWidth);
            const next = Math.max(0, Math.min(maxX, el.scrollLeft + Math.round(dir * speed)));
            if (next !== el.scrollLeft) {
              el.scrollLeft = next;
              this._tfApplyDrag(dr.lastX);
            }
          }
        }
        dr.raf = requestAnimationFrame(() => this._tfEdgeLoop());
      },
      tfDragMove(ev) {
        const dr = this.drag;
        if (!dr) return;
        if (!dr.armed) {
          // 尚未长按就大幅位移 → 本次手势是“平移视口”, 取消潜在长按并交给原生滚动
          if (Math.hypot(ev.clientX - dr.x0, ev.clientY - dr.y0) > 10) {
            dr.cancelled = true;
            if (dr.armTimer) { clearTimeout(dr.armTimer); dr.armTimer = null; }
            document.body.classList.remove('dragging-body');
          }
          return;
        }
        dr.lastX = ev.clientX;
        this._tfApplyDrag(ev.clientX);
      },
      async tfDragEnd() {
        const dr = this.drag;
        this.drag = null;
        document.body.classList.remove('dragging-body');
        if (dr && dr.raf) cancelAnimationFrame(dr.raf);
        if (this._stopScroll) {
          document.removeEventListener('touchmove', this._stopScroll);
          this._stopScroll = null;
        }
        if (!dr) return;
        if (dr.block && dr.block.classList) dr.block.classList.remove('armed');
        if (dr.cancelled) return; // 平移手势: 块未动, 直接放行
        if (dr.armed) {
          // 已长按选中(即使原地松手也不算普通点击, 避免误弹编辑框)
          this._justDragged = true;
          setTimeout(() => { this._justDragged = false; }, 250);
        }
        if (!dr.moved) return;
        const el = document.querySelector(`.tfblk[data-id="${dr.id}"]`);
        const left = el ? parseFloat(el.style.left) : null;
        if (left == null) return;
        const span = (this.flow && this.flow.spanMin) || 1440;
        const s = Math.round(left / 100 * span / 5) * 5;
        // 拖动落位按“轴起点 00:00”换算 → 可直接跨天(连续轴), 不会错误跳回今天
        const dayMs = (this.flow && this.flow.dayMs) || (() => { const dd = new Date(); dd.setHours(0, 0, 0, 0); return dd.getTime(); })();
        const next = { ...dr.todo, dueAt: dayMs + s * 60000 };
        M.stamp(next, this.engine.skew);
        try {
          await this.engine.commit(next);
          const dd = new Date(next.dueAt);
          const rel = dd.toDateString() === new Date().toDateString() ? '' :
            `(${dd.getMonth() + 1}/${dd.getDate()})`;
          this.toast(`已移到 ${M.fmtMin(s % 1440)}${rel}`);
        } catch (e) { this.onCommitErr(e); }
      },
      // ---------- 轨迹视图: 按住方块拖到新时刻 / 新泳道 ----------
      dragStart(todo, laneIdx, ev) {
        if (this.drag) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        ev.preventDefault();
        const track = this.laneTrackEl(laneIdx);
        if (!track) return;
        this.drag = { id: todo.id, todo, laneIdx, over: laneIdx, ms: null, moved: false, sx: ev.clientX, sy: ev.clientY };
        const move = (e) => this.dragMove(e);
        const end = (e) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', end);
          this.dragEnd();
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
        document.body.classList.add('dragging-body');
      },
      laneTrackEl(i) {
        const lanes = document.querySelectorAll('.trace .lane');
        return lanes[i] ? lanes[i].querySelector('.lanetrack') : null;
      },
      laneEls() { return document.querySelectorAll('.trace .lane'); },
      dragLaneAt(y) {
        const els = this.laneEls();
        for (let i = 0; i < els.length; i++) {
          const r = els[i].getBoundingClientRect();
          if (y >= r.top && y <= r.bottom) return i;
        }
        return -1;
      },
      dragMove(ev) {
        const d = this.drag;
        if (!d) return;
        if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 6) return;
        d.moved = true;
        const over = this.dragLaneAt(ev.clientY);
        if (over >= 0) d.over = over;
        const target = over >= 0 ? over : d.over;
        const track = this.laneTrackEl(target);
        if (!track) return;
        const r = track.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        const snap = 5 * 60000;
        d.ms = Math.round((x * 86400000) / snap) * snap;
        this._paintDrag(target, d.ms);
      },
      _paintDrag(laneIdx, ms) {
        const d = this.drag;
        const els = this.laneEls();
        for (let i = 0; i < els.length; i++) els[i].classList.toggle('over', i === laneIdx);
        const track = this.laneTrackEl(laneIdx);
        if (!track || !d) return;
        const durH = Math.max((d.todo.durationMin || 20) / 60, 0.33);
        let g = this._ghostEl;
        if (!g) {
          g = document.createElement('span');
          g.className = 'dragghost';
          this._ghostEl = g;
        }
        g.style.left = (ms / 86400000 * 100) + '%';
        g.style.width = (Math.min(durH, (86400000 - ms) / 86400000) * 100) + '%';
        g.style.background = (this.traceLanes[laneIdx] && this.traceLanes[laneIdx].col ? this.traceLanes[laneIdx].col.deep : '#5b7cfa');
        g.textContent = d.todo.title;
        if (g.parentElement !== track) track.appendChild(g);
      },
      async dragEnd() {
        const d = this.drag;
        this.drag = null;
        document.body.classList.remove('dragging-body');
        if (this._ghostEl) { this._ghostEl.remove(); this._ghostEl = null; }
        for (const el of this.laneEls()) el.classList.remove('over');
        if (!d || !d.moved || d.ms == null) return;
        this._justDragged = true;
        setTimeout(() => { this._justDragged = false; }, 250);
        const lane = this.traceLanes[d.over];
        if (!lane) return;
        const t = d.todo;
        const day = new Date();
        day.setHours(0, 0, 0, 0);
        const next = {
          ...t,
          dueAt: day.getTime() + d.ms,
          slotId: lane.kind === 'slot' ? lane.p.id : (lane.kind === 'none' ? '' : t.slotId),
        };
        M.stamp(next, this.engine.skew);
        try {
          await this.engine.commit(next);
          const where = next.slotId && lane.kind === 'slot' ? ` · ${lane.p.name}` : (lane.kind === 'none' ? ' · 未安排' : '');
          this.toast(`已移到 ${M.fmtMin(d.ms / 60000)}${where}`);
        } catch (e) { this.onCommitErr(e); }
      },
      async toggleDone(t) {
        const next = { ...t, status: t.status === 'done' ? 'todo' : 'done' };
        // 旧式单条重复(历史数据兜底): 勾选完成 → 自动滚到下一周期
        if (next.status === 'done' && t.repeat && t.repeat !== 'none' && t.dueAt) {
          const nxt = M.nextOccurrenceMs(t, Date.now());
          if (nxt != null && nxt > t.dueAt) next.dueAt = nxt;
          next.status = 'todo';
          this.toast(`已完成, 下次已排到 ${M.fmtDue(next.dueAt)}`);
        }
        M.stamp(next, this.engine.skew);
        try {
          await this.engine.commit(next);
          if (next.status === 'done') await this._afterInstanceDone(next); // 规则实例: 自动补下一条
        } catch (e) { this.onCommitErr(e); }
      },
      async toggleDoing(t) {
        const next = { ...t, status: t.status === 'doing' ? 'todo' : 'doing' };
        M.stamp(next, this.engine.skew);
        try { await this.engine.commit(next); } catch (e) { this.onCommitErr(e); }
      },
      async removeTodo(t) {
        if (!confirm(`删除「${t.title}」?`)) return;
        const next = { ...t, deleted: true };
        M.stamp(next, this.engine.skew);
        try { await this.engine.commit(next); this.toast('已删除'); } catch (e) { this.onCommitErr(e); }
      },
      // ---------- 「同一件事」查重(v1.0.64): 内容相同但时间变了 → 自动替换旧的 ----------
      /** 设定变更后勾选保存, 自动替换旧的那条(手机/电脑都会同步成只剩最新一条) */
      toggleDedupeOn() {
        this.dedupePref = !this.dedupePref;
        try { localStorage.setItem('tr:dedupe', this.dedupePref ? '1' : '0'); } catch { /* ignore */ }
        this.toast(this.dedupePref ? '已开启: 同一件事改了时间会自动替换旧的那条' : '已关闭自动查重');
      },
      /** 在现有待办里找「同一件事、但时间不一样」的旧条目(用于保存前提示/自动替换)。
       *  有「重复机制」的事项(每天/每周/每月/每天目标)一律排除 —— 它们不会被自动替换,
       *  只走 scanRepeatConflicts 以“提醒”形式单独提出。 */
      findSameTopic(todo) {
        if (!todo || !todo.title) return [];
        const out = [];
        for (const t of this.todos) {
          if (!t || t.deleted || t.id === todo.id) continue;
          if (M.hasRepeatMechanism(t)) continue;
          if (M.sameTopic(t, todo)) out.push(t);
        }
        return out;
      },
      /** 与「重复机制」事项的极高相似度冲突(只提示, 不处理) */
      scanRepeatConflicts(todo) {
        return M.scanRepeatConflicts(todo, this.todos, {
          skip: (t) => !M.isScanCandidate(t), strongMin: 0.82,
        });
      },
      /** 保存/识别时算出命中项(仅未删除, 不排除自己), 供提示与替换共用 */
      dedupeForSlot(rec) {
        if (rec && rec.id) return this.findSameTopic(rec);
        return this.findSameTopic(rec);
      },
      /** 编辑器里的排查结果(标题或时间改动时自动重算) */
      _refreshDedupeHit() {
        const e = this.editing;
        if (!e || !e.title || !e.title.trim()) {
          this.dupeDraft = []; this.dupeDraftTime = false; this.ptRows = []; this.ptConflicts = [];
          return;
        }
        const dupes = this.dedupeForSlot(e);
        this.dupeDraft = dupes.map((t) => ({ id: t.id, title: t.title }));
        // 时间是否与命中的旧条不同(有一条不同就算“变更”)
        this.dupeDraftTime = dupes.some((t) => M.timeChanged(t, e));
        // 潜在重复扫描(宽口径, 需要用户过目): 面板开着时实时刷新
        if (this.ptOpen) {
          this.ptNew = this._ptNewItem();
          this.ptRows = this._ptScanRows(this.ptNew, []);
          this.ptConflicts = this.scanRepeatConflicts(this.ptNew);
        }
      },
      /** 把命中的旧条目删除(墓碑), 保留刚刚输入/识别出的新内容。
       *  安全网: 有「重复机制」的旧条不在这里删(由 scanRepeatConflicts 单独提出)。 */
      async applyDedupe(dupes, rec) {
        const safe = (dupes || []).filter((d) => d && !M.hasRepeatMechanism(d));
        if (!safe.length) return { ok: true, removed: 0 };
        const list = [];
        for (const d of safe) {
          const next = { ...d, deleted: true };
          M.stamp(next, this.engine.skew);
          list.push(next);
        }
        try {
          await this.engine.commitMany(list);
          // 旧条若属于重复规则: 删掉后把窗口补齐, 避免“每天任务”少一条
          if (rec && rec.rule) {
            try { await this._ensureRuleWindow(rec); } catch { /* 下次自动补 */ }
          }
          return { ok: true, removed: list.length };
        } catch (e) {
          this.engine && this.engine.recordErr && this.engine.recordErr('dedupe ' + ((e && e.message) || e));
          return { ok: false, removed: 0, error: e };
        }
      },
      dedupeHintText() {
        const hit = this.dupeDraft || [];
        if (!hit.length) return '';
        const who = hit.length === 1 ? `「${hit[0].title}」` : `${hit.length} 条旧待办`;
        return this.dupeDraftTime
          ? `🔄 同一件事、时间已变更 → 保存后自动替换旧的 ${who}(旧条会被删除)`
          : `🔄 已存在同一件事 → 保存后旧的 ${who} 会被删除, 只留你现在这条`;
      },
      // ---------- 潜在重复「扫描 → 勾选处理」(v1.0.66) ----------
      /** 生成一条“新内容”的比较副本(标题+备注+材料) */
      _ptNewItem() {
        const e = this.editing;
        if (!e) return null;
        return { id: '__new__', title: e.title, notes: e.notes, location: e.location, materials: e.materials, dueAt: e.dueAt };
      },
      /** 扫描所有未完成/未逾期的事项, 找可能重复的(不只名字一样) */
      _ptScanRows(newItem, extraRows) {
        const cands = M.scanOverlaps(newItem, this.todos, { min: 0.5, skip: (t) => !M.isScanCandidate(t) });
        const rows = [];
        const seen = new Set();
        for (const c of cands) {
          if (seen.has(c.todo.id)) continue;
          seen.add(c.todo.id);
          rows.push({
            key: c.todo.id, old: c.todo, score: c.score, reasons: c.reasons || [], shared: c.shared || [],
            oldHl: M.highlightParts(c.todo.title || '', c.shared || []),
            newHl: M.highlightParts(newItem.title || '', c.shared || []),
            checked: false,
          });
        }
        rows.sort((a, b) => b.score - a.score);
        return rows;
      },
      /** 打开“潜在重复”处理面板; saveAfter=true 时确认后顺便保存当前内容 */
      _openDedupeReview(saveAfter = false) {
        const n = this._ptNewItem();
        if (!n || !String(n.title || '').trim()) { this.toast('请先填写标题', 'err'); return; }
        this.ptNew = n;
        this.ptSaveAfter = !!saveAfter;
        this.ptRows = this._ptScanRows(n, []);
        this.ptConflicts = this.scanRepeatConflicts(n); // 重复机制事项: 只提出, 不动
        if (!this.ptRows.length && this.ptConflicts.length) {
          this.toast('发现与「' + this.ptConflicts[0].label + '」重复的事项高度相似 — 请在上方提示里查看');
        }
        this.ptOpen = true;
      },
      /** 点「扫描可能重复」按钮 */
      scanDupes() { this._openDedupeReview(false); },
      /** 全库自查: 在所有“还在生效”的待办之间找互相重复的(不需要先写内容)。
       *  有「重复机制」的事项不参与清理(它们本来就该有多条实例), 只数出来告知。 */
      scanTop() {
        const all = this.todos.filter(M.isScanCandidate);
        const pool = all.filter((t) => !M.hasRepeatMechanism(t));
        const skippedRepeat = all.length - pool.length;
        const { df, total } = M.keywordDf(this.todos); // 词频用全库统计, 更能压掉通用前缀
        const res = [];
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const a = pool[i], b = pool[j];
            const hit = M.overlap(a, b, { df, total });
            if (hit && hit.score >= 0.6) {
              res.push({
                key: a.id + '|' + b.id, a, b, score: hit.score, reasons: hit.reasons || [],
                aHl: M.highlightParts(a.title || '', hit.shared || []),
                bHl: M.highlightParts(b.title || '', hit.shared || []),
                keep: '', // '' 不动 / 'a' 保留 a 删 b / 'b' 保留 b 删 a
              });
            }
          }
        }
        res.sort((x, y) => y.score - x.score);
        this.ptTopRows = res.slice(0, 40);
        this.ptTopSkippedRepeat = skippedRepeat;
        this.ptTopOpen = true;
        this.ptOpen = false;
        if (!res.length) this.toast('全部待办里没发现互相重复的 ✅' + (skippedRepeat ? '(已跳过 ' + skippedRepeat + ' 条重复机制事项)' : ''));
        else this.toast('发现 ' + res.length + ' 组可能重复, 请勾选要保留的一条' + (skippedRepeat ? '(已跳过 ' + skippedRepeat + ' 条重复机制事项)' : ''));
      },
      openTopReview() {
        if (!this.ptTopRows.length) return;
        this.ptOpen = false;
        this.ptTopOpen = true;
      },
      closeTopReview() { this.ptTopOpen = false; },
      /** 全库自查: 每组勾选“保留哪条”, 另一条删除 */
      async ptTopApply() {
        const kill = (this.ptTopRows || []).filter((r) => r.keep === 'a' || r.keep === 'b');
        if (!kill.length) { this.toast('还没有勾选要保留的条目'); return; }
        const list = [];
        const snapshots = [];
        for (const r of kill) {
          const d = r.keep === 'a' ? r.b : r.a;
          if (M.hasRepeatMechanism(d)) continue; // 双保险: 重复机制事项不删
          snapshots.push({ ...d, deleted: false });
          const n = { ...d, deleted: true };
          M.stamp(n, this.engine.skew);
          list.push(n);
        }
        if (!list.length) { this.toast('选中的都是「重复机制」事项, 已跳过不删', 'err'); return; }
        try {
          await this.engine.commitMany(list);
          this.ptTopRows = [];
          this.ptTopOpen = false;
          this._undoPayload = { kind: 'dedupe', snapshots };
          this.toast('已删除 ' + list.length + ' 条重复项(可点“撤销”恢复)');
        } catch (e) { this.onCommitErr(e); }
      },
      toggleTopKeep(row, side) {
        row.keep = row.keep === side ? '' : side;
      },
      ptCheckedCount() { return (this.ptRows || []).filter((r) => r.checked).length; },
      ptWhen(ms) {
        if (!ms) return '不定时';
        return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      },
      ptDiffText() {
        const n = this.ptNew, e = this.editing;
        if (!n || !e) return '';
        const parts = [];
        if (n.dueAt !== (e.dueAt || null)) parts.push('时间');
        return parts.length ? '含时间变更' : '';
      },
      ptHl(text) { return M.highlightParts(text, this.ptSharedAll); },
      toggleAllPtRows(on) { for (const r of this.ptRows) r.checked = on !== false; },
      ptCheckedCount() { return (this.ptRows || []).filter((r) => r.checked).length; },
      /** 确认: 删除勾选的旧条(按需随后保存新内容)。
       *  安全网: 勾选里若混入「重复机制」的事项(每天/每周/每月/每天目标), 一律剔除不删。 */
      async ptApply(saveAfter) {
        const doSave = saveAfter === undefined ? !!this.ptSaveAfter : !!saveAfter;
        const checked = (this.ptRows || []).filter((r) => r.checked);
        const protectedOnes = checked.filter((r) => M.hasRepeatMechanism(r.old));
        const rows = checked.filter((r) => !M.hasRepeatMechanism(r.old));
        this.ptOpen = false;
        this.ptRows = [];
        this.ptConflicts = [];
        if (protectedOnes.length) {
          this.toast('已跳过 ' + protectedOnes.length + ' 条「' + M.repeatKindLabel(M.repeatKind(protectedOnes[0].old)) + '」重复事项(不会删除)', 'err');
        }
        let deletedItems = [];
        if (rows.length) {
          const list = [];
          for (const r of rows) {
            deletedItems.push({ ...r.old, deleted: false }); // 保留完整快照, 撤销时原样恢复
            const d = { ...r.old, deleted: true };
            M.stamp(d, this.engine.skew);
            list.push(d);
          }
          try {
            await this.engine.commitMany(list);
            this._undoPayload = { kind: 'dedupe', snapshots: deletedItems };
          } catch (e) { this.onCommitErr(e); return; }
        }
        if (doSave) {
          await this.saveTodo();            // 删除完成后再写入新内容
        } else if (rows.length) {
          this.toast('已删除 ' + rows.length + ' 条旧事项(可点“撤销”恢复)');
        }
      },
      /** 面板底部: 勾选的旧条删掉, 并写入当前内容 */
      ptApplyAndSave() { this.ptSaveAfter = true; return this.ptApply(true); },
      /** 面板底部: 只处理旧数据, 不写入当前内容 */
      ptApplyOldOnly() { this.ptSaveAfter = false; return this.ptApply(false); },
      /** 「重复机制」提醒: 看一眼那条相似的事项(只打开, 不改动) */
      ptConflictOpen(c) {
        if (!c || !c.next) return;
        this.openEdit(c.next);   // 只是打开编辑器查看; 用户自己决定要不要改
      },
      /** 「重复机制」提醒: 明确删除“可能重复的那一条”(仅该实例, 需二次确认) */
      async ptConflictDeleteOne(c) {
        if (!c || !c.next) return;
        const t = c.next;
        const label = c.label || '重复';
        if (!confirm(`「${t.title}」是「${label}」的重复事项实例。\n\n确定要删除这一条吗?\n(只删这一条; 下一次到点仍会按「${label}」继续提醒)`)) return;
        const d = { ...t, deleted: true };
        M.stamp(d, this.engine.skew);
        try {
          await this.engine.commitMany([d]);
          this._undoPayload = { kind: 'dedupe', snapshots: [{ ...t, deleted: false }] };
          this.ptConflicts = (this.ptConflicts || []).filter((x) => x.key !== c.key);
          this.toast('已删除该条(可点“撤销”恢复)');
        } catch (e) { this.onCommitErr(e); }
      },
      repeatBadge(t) {
        const k = M.repeatKind(t);
        return k ? M.repeatKindLabel(k) : '';
      },
      /** 撤销刚才的删除(用删除时的完整快照原样恢复, 时间戳盖新章保证服务器接受) */
      async undoDelete() {
        const p = this._undoPayload;
        this._undoPayload = null;
        const snaps = (p && p.snapshots) || [];
        if (!snaps.length) { this.toast('没有可撤销的删除'); return; }
        const list = [];
        for (const s of snaps) {
          const rec = { ...s, deleted: false };
          M.stamp(rec, this.engine.skew);
          list.push(rec);
        }
        try {
          await this.engine.commitMany(list);
          this.toast('已撤销, 恢复 ' + list.length + ' 条');
        } catch (e) { this.onCommitErr(e); }
      },
      onCommitErr(e) {
        if (e?.status === 401) this.onAuth();
        else this.toast('保存失败(离线?稍后自动重试)', 'err');
      },
      // ---------- 编辑器 ----------
      _resetReview() {
        this.ptOpen = false; this.ptRows = []; this.ptNew = null; this.ptSaveAfter = false; this.ptConflicts = [];
      },
      openNew() {
        const t = M.fresh();
        // 快捷默认: 今天剩余时间内无特殊;留空由用户选时间
        this.histClose();
        this.editing = t; this.editorMode = 'new'; this.editorOpen = true; this.materialInput = '';
        this.editingRuleRepeat = 'none';
        this.dupeDraft = []; this.dupeDraftTime = false;
        this._resetReview();
        this._syncEditingClass();
      },
      openEdit(t) {
        this.histClose();
        this.editing = JSON.parse(JSON.stringify(t));
        // 规则实例: 把所属重复规则回填到表单(每周几/每月几号/类型), 保存时统一维护规则窗口
        const r = M.parseRule(t);
        if (r) {
          this.editing.repeat = r.r;
          this.editing.repeatWeekdays = [...(r.wd || [])];
          this.editing.repeatMonthDays = [...(r.md || [])];
        }
        this.editorMode = 'edit'; this.editorOpen = true; this.materialInput = '';
        // 记住原重复方式: 在“定期/截止目标”之间来回切换时, 原有的“每天”不会被清掉
        this.editingRuleRepeat = r ? r.r : 'none';
        this.dupeDraft = []; this.dupeDraftTime = false;
        this._resetReview();
        this._syncEditingClass();
      },
      closeEditor() { this.editorOpen = false; this.editing = null; this.histClose(); this._resetReview(); this._syncEditingClass(); },
      dueInput() {
        if (!this.editing?.dueAt) return '';
        const d = new Date(this.editing.dueAt);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        return d.toISOString().slice(0, 16);
      },
      onDueInput(v) { this.editing.dueAt = v ? new Date(v).getTime() : null; if (v) this.editing.goal = false; },
      quickDue(offsetMs, label) {
        this.editing.dueAt = Date.now() + offsetMs;
        this.toast(`时间已设为: ${label}`);
      },
      /** 快捷时间目标时刻(今天的若已过 → 自动顺延明天, 与按钮文字一致) */
      quickTarget(c) {
        if (c.o) return Date.now() + c.o;
        const t = new Date();
        t.setHours(c.h, 0, 0, 0);
        if (c.d) t.setDate(t.getDate() + c.d);
        else if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
        return t.getTime();
      },
      /** 快捷按钮文字: “今天 18:00”过了点就自动显示“明天 18:00”, 不再误导 */
      chipLabel(c) {
        if (c.o || c.h == null) return c.l;
        const ts = this.quickTarget(c);
        const sameDay = new Date(ts).toDateString() === new Date().toDateString();
        return `${sameDay ? '今天' : '明天'} ${String(c.h).padStart(2, '0')}:00`;
      },
      setRepeat(v) {
        if (v !== 'none' && !this.editing?.dueAt) {
          if (this.editing?.goal) {
            // 目标+每天: 还没挑日期 → 默认今天截止
            this.editing.dueAt = this._goalDefaultMs(0);
          } else {
            this.toast('请先设定一个时间, 再选择重复方式', 'err');
            return;
          }
        }
        this.editing.repeat = v;
        if (v === 'daily' && this.editing.goal) {
          // 目标是“每天要完成的任务”: 截止时刻钉在当天 23:59, 这样每天一条、当天没勾就变红
          this.editing.dueAt = this._endOfDay(this.editing.dueAt);
          // 一次性目标默认提前 1 天(1440 分), 对“每天”没意义 → 收窄到提前 1 小时
          if (this.editing.remindBeforeMin >= 1440) this.editing.remindBeforeMin = 60;
          this.toast('🎯 每天目标: 每天 ' + M.fmtDue(this.editing.dueAt) + ' 前完成, 勾掉后自动排下一天');
          return;
        }
        if (v === 'weekly' || v === 'monthly') {
          // 默认把当天(周几/几号)作为新锚点提示, 也可在下方参数里改
          const hm = new Date(this.editing.dueAt);
          const hint = v === 'weekly'
            ? '周' + '一二三四五六日'[((hm.getDay() + 6) % 7)]
            : hm.getDate() + ' 号';
          this.toast('已选' + (v === 'weekly' ? '每周' : '每月') + ',可点下方参数改' + (v === 'weekly' ? '星期几' : '几号') + '(当前: ' + hint + ')');
        }
      },
      /** dueAt 属于星期几(ISO: 1=周一…7=周日) */
      dueIsoWd(ms) {
        if (!ms) return 0;
        const d = new Date(ms);
        return ((d.getDay() + 6) % 7) + 1;
      },
      /** 每周多选: 命中选中列表(旧数据无列表时按 dueAt 星期高亮) */
      wdOn(v) {
        if (!this.editing || !this.editing.dueAt) return false;
        const arr = this.editing.repeatWeekdays || [];
        return arr.length ? arr.includes(v) : this.dueIsoWd(this.editing.dueAt) === v;
      },
      monthOn(d) {
        if (!this.editing || !this.editing.dueAt) return false;
        const arr = this.editing.repeatMonthDays || [];
        return arr.length ? arr.includes(d) : new Date(this.editing.dueAt).getDate() === d;
      },
      /** 根据多选集合把 dueAt 重算到“最近的符合日”(保留时分) */
      recomputeRepeatDue() {
        const e = this.editing;
        if (!e || !e.dueAt || (e.repeat !== 'weekly' && e.repeat !== 'monthly')) return;
        const base = Math.max(Date.now(), e.dueAt) - 60000;
        const anchor = new Date(e.dueAt);
        const hm = anchor.getHours() * 60 + anchor.getMinutes();
        if (e.repeat === 'weekly') {
          const set = e.repeatWeekdays && e.repeatWeekdays.length ? e.repeatWeekdays : [this.dueIsoWd(e.dueAt)];
          const isoWd = (d) => ((d.getDay() + 6) % 7) + 1;
          const cur = new Date(anchor);
          for (let i = 0; i < 8; i++) {
            if (cur.getTime() > base && set.includes(isoWd(cur))) { e.dueAt = cur.getTime(); return; }
            cur.setDate(cur.getDate() + 1);
          }
        } else {
          const set = e.repeatMonthDays && e.repeatMonthDays.length ? e.repeatMonthDays : [anchor.getDate()];
          let y = anchor.getFullYear(), m = anchor.getMonth();
          for (let mi = 0; mi < 24; mi++) {
            const last = new Date(y, m + 1, 0).getDate();
            for (const dom of set) {
              if (dom > last) continue;
              const cand = new Date(y, m, dom);
              cand.setMinutes(hm);
              if (cand.getTime() > base) { e.dueAt = cand.getTime(); return; }
            }
            m += 1;
            if (m > 11) { m = 0; y += 1; }
          }
        }
      },
      /** 每周: 多选切换周几 */
      toggleRepeatWeekday(v) {
        if (!this.editing) return;
        if (!this.editing.dueAt) {
          const t = new Date(Date.now() + 3600e3); t.setMinutes(0, 0, 0); this.editing.dueAt = t.getTime();
        }
        let arr = (this.editing.repeatWeekdays || []).slice();
        if (!arr.length) arr = [this.dueIsoWd(this.editing.dueAt)];
        if (arr.includes(v)) arr = arr.filter((x) => x !== v); else arr.push(v);
        if (!arr.length) arr = [this.dueIsoWd(this.editing.dueAt)]; // 至少保留一天
        this.editing.repeatWeekdays = [...new Set(arr)].sort((a, b) => a - b);
        this.recomputeRepeatDue();
        this.toast('每周: ' + this.editing.repeatWeekdays.map((w) => '周' + '一二三四五六日'[w - 1]).join('、'));
      },
      /** 每月: 多选切换日号 */
      toggleRepeatMonthDay(d) {
        if (!this.editing) return;
        const dv = Math.max(1, Math.min(31, Math.round(Number(d) || 1)));
        if (!this.editing.dueAt) {
          const t = new Date(Date.now() + 3600e3); t.setMinutes(0, 0, 0); this.editing.dueAt = t.getTime();
        }
        let arr = (this.editing.repeatMonthDays || []).slice();
        if (!arr.length) arr = [new Date(this.editing.dueAt).getDate()];
        if (arr.includes(dv)) arr = arr.filter((x) => x !== dv); else arr.push(dv);
        if (!arr.length) arr = [new Date(this.editing.dueAt).getDate()];
        this.editing.repeatMonthDays = [...new Set(arr)].sort((a, b) => a - b);
        this.recomputeRepeatDue();
        this.toast('每月: ' + this.editing.repeatMonthDays.join('、') + ' 号');
      },
      clearRepeatDays(kind) {
        if (!this.editing) return;
        if (kind === 'weekly') this.editing.repeatWeekdays = [];
        else this.editing.repeatMonthDays = [];
        this.toast('已清空,将沿用当前时间对应的' + (kind === 'weekly' ? '星期' : '日号'));
      },
      clearDue() {
        this.editing.dueAt = null;
        this.editing.repeat = 'none';
        this.editing.goal = false;
      },
      // ---------- 重要目标(只设截止时间, 不规定何时进行) ----------
      _endOfDay(ms) { const d = new Date(ms); d.setHours(23, 59, 0, 0); return d.getTime(); },
      _goalDefaultMs(days) { const d = new Date(); d.setDate(d.getDate() + (days || 3)); d.setHours(23, 59, 0, 0); return d.getTime(); },
      setTimeMode(mode) {
        if (mode === 'goal') {
          const wasDailyGoal = (String(this.editing.repeat) === 'daily');
          // 编辑已有“每天任务”时, 切换模式回来不该丢掉“每天”(用字符串化比较, 避免类型/代理差异)
          const restoreDaily = !wasDailyGoal && String(this.editingRuleRepeat) === 'daily';
          const keepRemind = this.editing.remindBeforeMin >= 1440 ? 1440 : (wasDailyGoal || restoreDaily ? 60 : 0);
          this.editing.goal = true;
          this.editing.repeat = (wasDailyGoal || restoreDaily) ? 'daily' : 'none';
          this.editing.dueAt = this.editing.dueAt ? this._endOfDay(this.editing.dueAt) : this._goalDefaultMs(3);
          // 目标默认提前 1 天提醒(每天目标提前 1 小时); 之后用户可在下拉里自行更改
          this.editing.remindBeforeMin = keepRemind || (wasDailyGoal || restoreDaily ? 60 : 1440);
          this.toast((wasDailyGoal || restoreDaily)
            ? '🎯 每天目标: 每天 23:59 前完成(默认提前 1 小时提醒)'
            : '🎯 截止目标: 只需设定截止日期(已默认提前 1 天提醒); 想“每天都做”就在下面选「每天」');
        } else if (mode === 'due') {
          this.editing.goal = false;
        }
      },
      goalQuick(days) {
        const daily = this.editing.goal && this.editing.repeat === 'daily';
        this.editing.goal = true;
        this.editing.repeat = daily ? 'daily' : 'none'; // 每天目标只改日期, 不改“每天”
        this.editing.dueAt = this._goalDefaultMs(days);
        this.editing.remindBeforeMin = daily ? 60 : 1440;
      },
      goalDateInput() {
        if (!this.editing?.dueAt) return '';
        const d = new Date(this.editing.dueAt);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        return d.toISOString().slice(0, 10);
      },
      onGoalDate(v) {
        if (!v) return;
        const d = new Date(`${v}T23:59`);
        if (!Number.isFinite(d.getTime())) return;
        const daily = this.editing.goal && this.editing.repeat === 'daily';
        this.editing.goal = true;
        this.editing.repeat = daily ? 'daily' : 'none'; // 每天目标改日期时保留“每天”
        this.editing.dueAt = d.getTime();
      },
      /** 目标剩余文案(每天目标显示具体时刻, 一次性目标显示天数) */
      goalLeftText(t) {
        if (!t || !t.dueAt) return '';
        const now = new Date(this.nowTick);
        const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const due = new Date(t.dueAt);
        const d1 = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
        const days = Math.round((d1 - d0) / 86400000);
        const hm = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
        if (days > 1) return `剩 ${days} 天`;
        if (days === 1) return '明天截止';
        if (days === 0) return due.getTime() - now.getTime() < 6 * 3600e3 ? `${hm} 截止` : '今天截止';
        return `已超期 ${-days} 天`;
      },
      addMaterial() {
        const parts = this.materialInput.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
        if (!parts.length) return;
        const cur = new Set(this.editing.materials || []);
        for (const p of parts) cur.add(p);
        this.editing.materials = [...cur];
        this.materialInput = '';
      },
      removeMaterial(m) {
        this.editing.materials = (this.editing.materials || []).filter((x) => x !== m);
      },
      toggleImp(v) {
        this.impFilter = this.impFilter.includes(v) ? this.impFilter.filter((x) => x !== v) : [...this.impFilter, v];
      },
      // ---------- 历史输入联想 ----------
      histInput(field) {
        switch (field) {
          case 'title': return this.editing?.title || '';
          case 'location': return this.editing?.location || '';
          case 'materials': return this.materialInput || '';
          case 'notes': return this.editing?.notes || '';
          default: return '';
        }
      },
      histOpen(field) {
        if (!this.editorOpen || !this.editing) return;
        if (this.histBlurTimer) { clearTimeout(this.histBlurTimer); this.histBlurTimer = null; }
        const all = this.histRanked[field] || [];
        const q = this.histInput(field).trim().toLowerCase();
        let arr = q ? all.filter((e) => e.text.toLowerCase().includes(q)) : all.slice();
        if (q) {
          arr.sort((a, b) => {
            const pa = a.text.toLowerCase().startsWith(q) ? 1 : 0;
            const pb = b.text.toLowerCase().startsWith(q) ? 1 : 0;
            return pb - pa;
          });
        }
        this.hist.items = arr.slice(0, 8);
        this.hist.show = field;
      },
      histPick(field, text) {
        if (!this.editing) return;
        if (this.histBlurTimer) { clearTimeout(this.histBlurTimer); this.histBlurTimer = null; }
        if (field === 'materials') {
          const cur = new Set(this.editing.materials || []);
          cur.add(text);
          this.editing.materials = [...cur];
          this.materialInput = '';
        } else if (field === 'notes') {
          this.editing.notes = text;
        } else if (field === 'location') {
          this.editing.location = text;
        } else {
          this.editing.title = text;
        }
        this.histClose();
      },
      histBlur() {
        // 延迟关闭, 允许点击下拉项(mousedown.prevent 已避免抢焦点, 此处兜底)
        if (this.histBlurTimer) clearTimeout(this.histBlurTimer);
        this.histBlurTimer = setTimeout(() => { this.hist.show = null; }, 180);
      },
      histClose() {
        if (this.histBlurTimer) { clearTimeout(this.histBlurTimer); this.histBlurTimer = null; }
        this.hist.show = null;
        this.hist.items = [];
      },
      quickChip(c) {
        const target = this.quickTarget(c);
        // 今天 XX:00 已过被顺延到明天时给出明确提示
        if (c.h != null && !c.o && !c.d) {
          const today = new Date();
          today.setHours(c.h, 0, 0, 0);
          if (today.getTime() <= Date.now()) {
            this.toast(`今天 ${c.h}:00 已过, 已自动排到明天 ${c.h}:00`, 'info');
          }
        }
        this.editing.dueAt = target;
        this.editing.goal = false;
        this.toast(`时间已设为: ${M.fmtDue(this.editing.dueAt)}`);
      },
      async testNotify() {
        // 桌面 Electron: 走 preload 注入的桌面通知; 一体包(手机 APK): 走本地服务器发系统通知
        if (host) {
          const r = await host.api.testNotification();
          this.toast(r?.ok ? '已发送测试通知' : '测试通知失败', r?.ok ? 'info' : 'err');
          return;
        }
        try {
          const r = await fetch('/api/native/test-notify').then((x) => x.json());
          if (r && r.ok) this.toast('已发送测试通知, 请看通知栏', 'info');
          else this.toast((r && r.error) || '测试通知失败', 'err');
        } catch (e) {
          this.toast('测试通知失败: 请在一体包 App 内使用', 'err');
        }
      },
      async refreshNative() {
        // 一体包: 查询原生权限状态(后台运行/通知/精确闹钟), 供设置区显示
        if (host || !this.onePkg) return;
        try {
          const r = await fetch('/api/native/status').then((x) => x.json());
          if (r && r.ok) {
            this.batteryText = r.batteryIgnoring
              ? '后台运行: 已允许(提醒可靠) ✅'
              : '后台运行: 未允许 ⚠️ 省电清理可能杀掉提醒';
          } else this.batteryText = '后台运行: 查询失败';
        } catch (e) { this.batteryText = '后台运行: 查询失败'; }
      },
      async openBattery() {
        // 一体包: 拉起系统「忽略电池优化」授权(系统弹窗或设置页)
        if (host) { this.toast('桌面版无需此设置', 'info'); return; }
        try {
          const r = await fetch('/api/native/open-battery', { method: 'POST' }).then((x) => x.json());
          if (r && r.ok) {
            this.toast('已拉起系统授权, 请选择「允许」; 若跳到列表请找到本应用开启', 'info');
            setTimeout(() => this.refreshNative(), 2500);
          } else this.toast((r && r.error) || '开启失败', 'err');
        } catch (e) {
          this.toast('仅手机一体包内可用(请升级到最新版)', 'err');
        }
      },
      async setAutostart() {
        if (!host) return;
        const r = await host.api.setAutostart(this.autostartOn);
        if (!r?.ok) { this.autostartOn = !this.autostartOn; this.toast('设置失败', 'err'); }
        else this.toast(this.autostartOn ? '已开启开机自启' : '已关闭开机自启');
      },
      openFolder() {
        if (host) host.api.openFolder();
      },
      // ---------- AI 截图建任务(服务端 /api/ai 代理) ----------
      aiModeDesc() {
        return ({
          auto: '自动判断: 课表→写入, 其它→待办',
          timetable: '📅 专注课表: 识别整周课表并按时间写入待办',
          periodtable: '⏱ 识别节次对照表 → 可修改并保存为换算依据',
          todo: '📋 日常事项: 通知/聊天/票证等 → 一条待办',
        })[this.aiMode] || '';
      },
      /** 流畅模式: 关阴影/动效, 低配机更跟手 */
      applyLite() {
        const on = !!this.perfLite;
        const el = document.documentElement;
        if (el) el.classList.toggle('lite', on);
        try { window.localStorage.setItem('tr:lite', on ? '1' : '0'); } catch { /* 忽略 */ }
      },
      setLite(v) { this.perfLite = !!v; this.applyLite(); },
      aiPtRows() { return this.aiPtText ? this.aiPtText.split('\n').filter(Boolean).length : 0; },
      /** 耗时埋点(诊断信息可见, 定位卡顿) */
      perfPush(m) {
        try {
          window.__perf = window.__perf || [];
          window.__perf.push(m);
          if (window.__perf.length > 20) window.__perf.splice(0, window.__perf.length - 20);
        } catch { /* 忽略 */ }
      },
      aiHeaders() {
        return {
          'Content-Type': 'application/json',
          ...(this.engine && this.engine.token ? { 'x-token': this.engine.token } : {}),
        };
      },
      async loadAiCfg(force = false) {
        if (this.aiCfg && !force) return this.aiCfg;
        const def = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash-vision-exp', hasKey: false, periodTable: '', periodTableAt: 0 };
        try {
          const r = await fetch('/api/ai', { headers: this.aiHeaders() });
          const j = await r.json();
          const cfg = j.ok ? j.config : def;
          // 服务器上的节次表比页面缓存新 → 以服务器为准(避免显示旧内容)
          const loc = this._ptLocal();
          const srvAt = Number(cfg.periodTableAt) || 0;
          if (srvAt >= loc.at) this._ptLocalSet(cfg.periodTable || '', srvAt);
          else { cfg.periodTable = loc.text || cfg.periodTable; cfg.periodTableAt = loc.at; }
          this.aiCfg = cfg;
          this.ptAt = Number(cfg.periodTableAt) || 0;
        } catch { if (!this.aiCfg) this.aiCfg = def; }
        return this.aiCfg;
      },
      /** 设置页「保存配置」: 只提交接口地址/模型/Key —— 绝不携带节次表(防止旧缓存覆盖) */
      async saveAiCfg() {
        if (!this.aiCfg) return;
        this.aiBusy = true;
        try {
          const payload = { baseUrl: this.aiCfg.baseUrl, model: this.aiCfg.model };
          // Key 留空 = 保持不变; 只有真的输入了新 Key 才提交(避免空串误清已保存配置)
          if (this.aiKey && this.aiKey.trim()) payload.apiKey = this.aiKey;
          const r = await fetch('/api/ai', {
            method: 'POST',
            headers: this.aiHeaders(),
            body: JSON.stringify(payload),
          });
          const txt = await r.text();
          let j = null;
          try { j = JSON.parse(txt); } catch { j = null; }
          if (j && j.ok) {
            const pt = { periodTable: this.aiCfg.periodTable, periodTableAt: this.aiCfg.periodTableAt };
            this.aiCfg = { ...j.config, ...pt }; // 节次表以本机/服务器较新者为准, 不回退
            this.aiKey = ''; this.toast('AI 配置已保存');
          } else this.toast('保存失败: ' + (j && j.error ? j.error : ('HTTP ' + r.status + ' ' + txt.slice(0, 120))), 'err');
        } catch (e) { this.toast('保存失败: ' + ((e && e.message) || '网络异常'), 'err'); }
        finally { this.aiBusy = false; }
      },
      closePt() { this.aiPt = false; this.aiPtText = ''; },
      /** 设置页里的节次表「保存节次表」按钮 */
      async savePtFromSettings() {
        if (!this.aiCfg) return;
        const text = this.aiCfg.periodTable || '';
        this.aiBusy = true;
        try { await this.savePeriodTable(text); } finally { this.aiBusy = false; }
      },
      /** 把识别出的节次对照表行(可修改后)永久保存为 AI 节次换算依据 */
      async savePtLines() {
        const text = (this.aiPtText || '').trim();
        if (!text) { this.toast('节次表内容为空', 'err'); return; }
        this.aiBusy = true;
        try {
          const ok = await this.savePeriodTable(text);
          if (ok) this.aiPt = false;
        } finally { this.aiBusy = false; }
      },
      aiPickClick() {
        if (this.editorOpen) { this.toast('请先完成或关闭当前编辑框', 'err'); return; }
        const el = document.getElementById('aiFilePick');
        if (el) el.click();
      },
      onAiFileChange(e) {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) this.onAiImage(f);
      },
      // ---------- 课程专用模式 第二步: 课程详情补全 ----------
      aiDetailPickClick() {
        if (!this.editing || !this.editing.title) { this.toast('请先填写课程名称', 'err'); return; }
        const el = document.getElementById('aiDetailPick');
        if (el) el.click();
      },
      onAiDetailChange(e) {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) this.aiCourseDetail(f);
      },
      async aiCourseDetail(file) {
        if (!this.aiCfg) await this.loadAiCfg();
        if (this.aiCfg && !this.aiCfg.hasKey) {
          this.toast('请先设置 🤖 AI 的 API Key', 'err');
          this.openSettings(false);
          return;
        }
        this.aiBusy = true;
        try {
          const dataUrl = await fileToSmallDataUrl(file);
          const d = this.editing.dueAt ? new Date(this.editing.dueAt) : null;
          const date = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
          const r = await fetch('/api/ai/detail', {
            method: 'POST',
            headers: this.aiHeaders(),
            body: JSON.stringify({ image: dataUrl, course: { name: this.editing.title, date } }),
          });
          const j = await r.json().catch(() => null);
          if (!j || !j.ok) {
            this.toast('解析失败: ' + ((j && j.error) || ('HTTP ' + r.status)), 'err');
            return;
          }
          const f = j.fields || {};
          const add = [];
          if (f.teacher) add.push('👩‍🏫 老师: ' + f.teacher);
          if (f.textbook) add.push('📖 教材/资料: ' + f.textbook);
          if (f.notes) add.push(f.notes);
          if (add.length) {
            const base = (this.editing.notes || '').trim();
            this.editing.notes = [base, ...add].filter(Boolean).join('\n').slice(0, 2000);
          }
          const mats = new Set(this.editing.materials || []);
          for (const m of f.materials || []) mats.add(m);
          this.editing.materials = [...mats];
          if (f.location) this.editing.location = f.location;
          this.toast('✅ 课程详情已填入, 请核对后保存');
        } catch (e) {
          this.toast('AI 解析失败: ' + (e.message || e), 'err');
        } finally { this.aiBusy = false; }
      },
      onPasteImg(e) {
        if (this.editorOpen || this.aiBusy) return;
        const items = e.clipboardData?.items || [];
        const file = [...items].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
        if (file) { e.preventDefault(); this.toast('识别剪贴板截图…'); this.onAiImage(file); }
      },
      async onAiImage(file) {
        if (this.editorOpen) { this.toast('请先完成或关闭当前编辑框', 'err'); return; }
        if (!this.aiCfg) await this.loadAiCfg();
        if (this.aiCfg && !this.aiCfg.hasKey) {
          this.toast('请先设置 🤖 AI 的 API Key', 'err');
          this.openSettings(false);
          return;
        }
        this.aiBusy = true;
        try {
          const dataUrl = await fileToSmallDataUrl(file);
          const r = await fetch('/api/ai/parse', {
            method: 'POST', headers: this.aiHeaders(),
            body: JSON.stringify({ image: dataUrl, mode: this.aiMode || 'auto' }),
          });
          const j = await r.json().catch(() => null);
          if (!j || !j.ok) {
            const msg = (j && j.error) || ('HTTP ' + r.status);
            this.toast('AI 解析失败: ' + msg, 'err');
            if (/key|api.?key/i.test(msg)) this.openSettings(false);
            return;
          }
          const f = j.fields || {};
          if (f.kind === 'periodTable') {
            // 节次对照表识别 → 弹层预览/修改/保存
            this.aiPtText = (Array.isArray(f.lines) ? f.lines : []).join('\n');
            this.aiPt = true;
            return;
          }
          if (f.kind === 'timetable' && Array.isArray(f.courses) && f.courses.length) {
            await this.importTimetable(f.courses, f.mondayIso);
            return;
          }
          const rec = M.fresh();
          rec.title = f.title || '截图待办';
          rec.notes = f.notes || '';
          rec.location = f.location || '';
          rec.materials = Array.isArray(f.materials) ? f.materials : [];
          if (Number.isFinite(f.durationMin) && f.durationMin > 0) rec.durationMin = f.durationMin;
          if (Number.isFinite(f.dueAt) && f.dueAt > 0) rec.dueAt = f.dueAt;
          if (f.importance != null) rec.importance = f.importance;
          if (f.independent != null) rec.independent = f.independent;
          if (['daily', 'weekly', 'monthly'].includes(f.repeat)) {
            rec.repeat = f.repeat; // AI 识别出的重复规律直接应用到编辑器(可再手动改)
          }
          this.editing = rec;
          this.editorMode = 'new';
          this.editorOpen = true;
          this.materialInput = '';
          this._refreshDedupeHit(); // 识别完立刻查重: 命中同一件事就在编辑器里提示“保存会替换旧的”
          this.ptSaveAfter = false;
          this._openDedupeReview(false); // 自动全量扫描潜在重复(不只名字一样), 由你勾选处理
          this.toast('✅ 已按截图填入, 请核对后保存');
        } catch (e) {
          this.toast('AI 解析失败: ' + (e.message || e), 'err');
        } finally { this.aiBusy = false; }
      },
      /**
       * 课表模式(按周): 每周课表不同 → 每节课按图中“周一日期”换算成具体日期的
       * 一次性待办(不设每周重复), 到点前 10 分钟提醒一次。
       */
      async importTimetable(courses, mondayIso) {
        if (!mondayIso) {
          this.toast('图中未读到日期/周次(如“第2周 2026-09-14/09-20”) — 请用带日期的课表截图', 'err');
          return;
        }
        const fmt = (ms) => {
          const d = new Date(ms);
          return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        };
        const withDue = courses.filter((c) => Number.isFinite(c && c.dueAt));
        if (!withDue.length) { this.toast('课程时间换算失败(缺少日期)', 'err'); return; }
        const preview = withDue.slice(0, 10)
          .map((c) => `${fmt(c.dueAt)} ${c.name}${c.location ? ` 📍${c.location}` : ''}`)
          .join('\n');
        if (!window.confirm(`识别为 ${mondayIso} 当周课表, 共 ${withDue.length} 节\n\n${preview}${withDue.length > 10 ? `\n…还有 ${withDue.length - 10} 节` : ''}\n\n按“具体日期”写入待办(不是每周重复; 每周换课表就每周导一次)?`)) return;
        const act = this.todos.filter((t) => !t.deleted);
        const recs = [];
        let skip = 0;
        for (const c of withDue) {
          const dup = act.some((t) => t.title === c.name && t.dueAt === c.dueAt);
          if (dup) { skip++; continue; }
          const dur = c.durationMin && c.durationMin > 0 ? c.durationMin : null;
          const rec = M.normalize({
            ...M.fresh(),
            title: c.name,
            dueAt: c.dueAt,
            durationMin: dur,
            location: c.location || '',
            remindBeforeMin: 10,
            importance: 1,
            independent: true,
            status: 'todo',
            repeat: 'none',
            fuzzy: false,
          });
          M.stamp(rec, this.engine.skew);
          recs.push(rec);
        }
        if (recs.length) { const _pt0 = Date.now(); await this.engine.commitMany(recs); this.perfPush('importTimetable ' + (Date.now() - _pt0) + 'ms'); } // 批量一次推送, 避免逐条网络往返卡顿
        const added = recs.length;
        this.toast(`课表已按日期写入待办: 新增 ${added} 节${skip ? `, 跳过重复 ${skip} 节` : ''}`);
        this.setView('list');
      },
      // ---------- 时段管理 ----------
      onPeriods(list) {
        this.periods = list;
        this.migrateSlotColors(); // 旧数据(无槽位)一次性补分配, 避免撞色
      },
      /** 时段 id → 时段(已删除的不参与) */
      periodById() {
        const m = {};
        for (const p of this.periods) if (!p.deleted) m[p.id] = p;
        return m;
      },
      slotById(id) { return id ? this.periodById()[id] : null; },
      /** 列表卡片: 挂入时段 → 卡片左侧色条用该时段色(无时段保持原重要度/逾期规则) */
      cardLeftStyle(t) {
        const p = this.slotById(t && t.slotId);
        return p ? { borderLeftColor: M.periodColor(p).deep } : null;
      },
      slotColorObj(id) {
        const p = this.slotById(id);
        return p ? M.periodColor(p) : null;
      },
      /** 给 colorSlot==null 的有效时段自动分配空闲槽并推送(幂等) */
      async migrateSlotColors() {
        const need = this.periods.filter((p) => !p.deleted && !Number.isFinite(p.colorSlot));
        if (!need.length || !this.engine) return;
        const used = this.occupiedSlotSet(null);
        const changed = [];
        for (const p of need) {
          const start = M.SLOT_GROUP_START[p.priority] ?? 3;
          let slot = null;
          for (let i = start; i < start + 3; i++) if (!used.has(i)) { slot = i; break; }
          if (slot == null) continue;
          used.add(slot);
          const rec = M.normalizePeriod({ ...p, colorSlot: slot });
          M.stamp(rec, this.engine.skew);
          this.engine.periodMap.set(rec.id, rec);
          changed.push(rec);
        }
        if (!changed.length) return;
        this.engine.onPeriods(this.engine.localPeriods());
        try { await this.engine.pushDirty(); } catch { /* 离线则下次心跳补推 */ }
      },
      // ---------- 主题(浅色 / 深色 / 电光 / 跟随系统) ----------
      setThemePref(v) {
        this.themePref = ['light', 'dark', 'neo', 'system'].includes(v) ? v : 'system';
        try { localStorage.setItem('tr:theme', this.themePref); } catch { /* ignore */ }
        const r = document.documentElement;
        if (this.themePref === 'system') r.removeAttribute('data-theme');
        else r.setAttribute('data-theme', this.themePref);
      },
      // ---------- 时段颜色槽(9 色板, 删除即释放, 新建自动复用空闲) ----------
      occupiedSlotSet(exceptId) {
        const s = new Set();
        for (const p of this.periods) {
          if (p.deleted || p.id === exceptId) continue;
          if (Number.isFinite(p.colorSlot)) s.add(p.colorSlot);
        }
        return s;
      },
      freeSlotFor(priority, exceptId) {
        const start = M.SLOT_GROUP_START[priority] ?? 3;
        const occ = this.occupiedSlotSet(exceptId);
        for (let i = start; i < start + 3; i++) if (!occ.has(i)) return i;
        return null;
      },
      /** 表单当前生效的槽(未分配→组内第一个空闲) */
      slotFormIdx() {
        const f = this.slotForm;
        if (!f) return 0;
        if (Number.isFinite(f.colorSlot)) return f.colorSlot;
        return this.freeSlotFor(f.priority, f.id) ?? (M.SLOT_GROUP_START[f.priority] ?? 3);
      },
      /** 点击色点手动选色(仅限空闲) */
      pickFormSlot(i) {
        if (!this.slotForm) return;
        const start = M.SLOT_GROUP_START[this.slotForm.priority] ?? 3;
        if (i < start || i >= start + 3) return;
        const occ = this.occupiedSlotSet(this.slotForm.id);
        if (occ.has(i) && this.slotForm.colorSlot !== i) return;
        this.slotForm.colorSlot = i;
      },
      autoFormSlot() { if (this.slotForm) this.slotForm.colorSlot = null; },
      curGroupStart() { return M.SLOT_GROUP_START[this.slotForm?.priority] ?? 3; },
      slotColorDim(i) {
        if (!this.slotForm) return true;
        const occ = this.occupiedSlotSet(this.slotForm.id);
        return occ.has(i) && this.slotForm.colorSlot !== i;
      },
      // ---------- 多节点 / 刷选 / 未命名空隙 ----------
      /** 卡片与表单用: 多段文字, 如 "08:00–09:40 / 14:00–16:00", 跨午夜标 (次日) */
      slotTimeLabel(p) {
        const nodes = p?.nodes && p.nodes.length ? p.nodes : [{ startMin: p?.startMin, endMin: p?.endMin }];
        return nodes
          .filter((n) => n && Number.isFinite(n.startMin) && Number.isFinite(n.endMin))
          .map((n) => {
            if (n.endMin < n.startMin) return `${M.fmtMin(n.startMin)}–次日${M.fmtMin(n.endMin)}`;
            if (n.endMin === 1440) return `${M.fmtMin(n.startMin)}–24:00`;
            return `${M.fmtMin(n.startMin)}–${M.fmtMin(n.endMin)}`;
          })
          .join(' / ');
      },
      sortFormNodes() {
        const f = this.slotForm;
        if (!f) return;
        f.nodes = (f.nodes || [])
          .map((n) => ({ startMin: Math.round(n.startMin), endMin: Math.round(n.endMin) }))
          .filter((n) => Number.isFinite(n.startMin) && Number.isFinite(n.endMin) && n.startMin !== n.endMin)
          .sort((a, b) => a.startMin - b.startMin);
        f.startMin = f.nodes.length ? f.nodes[0].startMin : null;
        f.endMin = f.nodes.length ? f.nodes[0].endMin : null;
      },
      addSlotNode() {
        const f = this.slotForm;
        if (!f) return;
        if (!f.nodes || !f.nodes.length) f.nodes = [{ startMin: 9 * 60, endMin: 10 * 60 }];
        else {
          const last = f.nodes[f.nodes.length - 1];
          const s = last && last.endMin < 1425 ? last.endMin + 60 : 9 * 60;
          f.nodes.push({ startMin: Math.min(1380, s), endMin: Math.min(1440, s + 60) });
        }
        this.sortFormNodes();
      },
      removeSlotNode(i) {
        const f = this.slotForm;
        if (!f) return;
        f.nodes.splice(i, 1);
        this.sortFormNodes();
      },
      clearSlotNodes() {
        if (this.slotForm) { this.slotForm.nodes = []; this.sortFormNodes(); }
      },
      /** 表单当前试色(用于刷选条上已选段着色) */
      formBrushCol() {
        const f = this.slotForm;
        if (!f) return M.slotColor(3);
        const idx = Number.isFinite(f.colorSlot) ? f.colorSlot : (M.SLOT_GROUP_START[f.priority] ?? 3);
        return M.slotColor(idx);
      },
      brushSegStyle(nd) {
        const col = this.formBrushCol();
        const left = (Math.min(nd.startMin, nd.endMin) / 1440 * 100);
        const w = (Math.abs(nd.endMin - nd.startMin) / 1440 * 100);
        return {
          left: left + '%',
          width: w + '%',
          background: M.hexA(col.base, 0.5),
          borderColor: col.deep,
        };
      },
      /** 轨迹色块样式: 位置/宽度/颜色(单行省略样式; 轴为连续多日 → 绝对分钟占比) */
      blkStyle(b) {
        const span = (this.flow && this.flow.spanMin) || 1440;
        return {
          left: (b.s / span * 100) + '%',
          width: ((b.e - b.s) / span * 100) + '%',
          background: b.bg,
          borderColor: b.ln,
        };
      },
      /** 绝对轴分钟 → 时:分(跨日时小时累计, 只显示时刻部分) */
      absMin(m) { return M.fmtMin((m == null ? 0 : m) % 1440); },
      /** 绝对轴结束分钟标签: 恰为某日 24:00(下一天 0 点)时显示 24:00 */
      absMinEnd(m) {
        const v = m == null ? 0 : m;
        return v > 0 && v % 1440 === 0 ? '24:00' : M.fmtMin(v % 1440);
      },
      brushMinFromEvent(ev) {
        const bar = this.$refs.brushbar;
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        return Math.round(x * 1440 / 5) * 5;
      },
      brushDown(ev) {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const s = this.brushMinFromEvent(ev);
        if (s == null) return;
        const d = { startMin: s, endMin: Math.min(1440, s + 15) };
        this.brushDraft = d;
        const move = (e) => {
          const m = this.brushMinFromEvent(e);
          if (m == null) return;
          if (m >= d.startMin) d.endMin = Math.min(1440, m + 15);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          const dd = this.brushDraft;
          this.brushDraft = null;
          if (dd && dd.endMin - dd.startMin >= 15) {
            if (!this.slotForm.nodes) this.slotForm.nodes = [];
            this.slotForm.nodes.push({ startMin: dd.startMin, endMin: dd.endMin });
            this.sortFormNodes();
          }
        };
        window.addEventListener('pointermove', move, { passive: true });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
      /** 一键选取: 所选星期里所有“未被任何时段命名”的连续空隙(≥15分钟)并入节点 */
      pickUnnamedGaps() {
        const f = this.slotForm;
        if (!f) return;
        const selfId = f.id;
        const others = this.periods.filter((p) => !p.deleted && p.id !== selfId);
        const allWd = [1, 2, 3, 4, 5, 6, 7];
        const wds = f.freq === 'weekly' && (f.weekdays || []).length ? f.weekdays.slice() : allWd;
        const covered = new Map();
        for (const wd of wds) covered.set(wd, new Array(1440).fill(false));
        const activeOnWd = (p, wd) => p.freq === 'daily' || p.freq === 'yearly' || p.freq === 'monthly' ||
          (p.freq === 'weekly' && (p.weekdays || []).includes(wd));
        for (const p of others) {
          const segs = M.periodDaySegments(p);
          if (!segs.length) continue;
          for (const wd of wds) {
            if (!activeOnWd(p, wd)) continue;
            const arr = covered.get(wd);
            for (const s of segs) {
              const a = Math.max(0, Math.min(1440, s.startMin));
              const b = Math.max(a, Math.min(1440, s.endMin));
              for (let m = a; m < b; m++) arr[m] = true;
            }
          }
        }
        const free = new Array(1440).fill(true);
        for (const wd of wds) {
          const arr = covered.get(wd);
          for (let m = 0; m < 1440; m++) if (arr[m]) free[m] = false;
        }
        const runs = [];
        let rs = -1;
        for (let m = 0; m <= 1440; m++) {
          const isFree = m < 1440 && free[m];
          if (isFree && rs < 0) rs = m;
          if (!isFree && rs >= 0) { if (m - rs >= 15) runs.push({ startMin: rs, endMin: m }); rs = -1; }
        }
        if (!runs.length) { this.toast('所选星期里没有 ≥15 分钟的未命名空隙', 'info'); return; }
        const merged = (f.nodes || []).map((n) => ({ startMin: n.startMin, endMin: n.endMin }));
        for (const r of runs) merged.push({ ...r });
        merged.sort((a, b) => a.startMin - b.startMin);
        const out = [];
        for (const n of merged) {
          if (n.endMin < n.startMin) { out.push(n); continue; }
          const last = out[out.length - 1];
          if (last && last.endMin >= last.startMin && last.endMin >= n.startMin) last.endMin = Math.max(last.endMin, n.endMin);
          else out.push({ ...n });
        }
        f.nodes = out;
        this.sortFormNodes();
        this.toast(`已并入 ${runs.length} 段未命名空隙(按所选 ${wds.length} 个星期取交集)`);
      },
      openSlotNew() {
        this.slotEditing = false;
        this.slotForm = M.freshPeriod();
        this.slotForm.multi = false; // 默认单段形态(可切多段)
        this.ensureSlotNode();
        this.syncSlotMDFields();
      },
      openSlotEdit(p) {
        this.slotEditing = true;
        this.slotForm = { ...M.normalizePeriod(p) };
        this.slotForm.multi = (this.slotForm.nodes || []).length > 1;
        this.ensureSlotNode();
        this.syncSlotMDFields();
      },
      /** 保证表单里至少有一个时间段节点(单段表单直接编辑 nodes[0]) */
      ensureSlotNode() {
        const f = this.slotForm;
        if (!f) return;
        if (!f.nodes || !f.nodes.length) {
          f.nodes = [{ startMin: Number.isFinite(f.startMin) ? f.startMin : 9 * 60, endMin: Number.isFinite(f.endMin) ? f.endMin : 10 * 60 }];
          this.sortFormNodes();
        }
      },
      /** 单段/多段形态切换: 单段只保留第一段时间窗 */
      setSlotMulti(v) {
        const f = this.slotForm;
        if (!f) return;
        f.multi = !!v;
        this.ensureSlotNode();
        if (!f.multi && f.nodes.length > 1) {
          f.nodes = f.nodes.slice(0, 1);
          this.sortFormNodes();
        }
      },
      /** 把 startMD/endMD 拆成 表单里的 月/日 选择 */
      syncSlotMDFields() {
        const f = this.slotForm;
        if (!f) return;
        const split = (md) => (md == null ? null : { m: Math.floor(md / 100), d: md % 100 });
        const s = split(f.startMD); const e = split(f.endMD);
        f.startM = s ? s.m : 1; f.startD = s ? s.d : 1;
        f.endM = e ? e.m : 12; f.endD = e ? e.d : 31;
      },
      mdOf(m, d) { return m * 100 + d; },
      toggleWeekday(w) {
        const cur = this.slotForm.weekdays || [];
        this.slotForm.weekdays = cur.includes(w) ? cur.filter((x) => x !== w) : [...cur, w].sort((a, b) => a - b);
      },
      daysInMonth(m) { return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m - 1) % 12]; },
      /** slotForm 月/日 → startMD/endMD, 并简单修正 2月31日 之类的越界 */
      applySlotMD() {
        const f = this.slotForm;
        const clampD = (m, d) => Math.min(d, this.daysInMonth(m));
        f.startMD = this.mdOf(f.startM, clampD(f.startM, f.startD));
        f.endMD = this.mdOf(f.endM, clampD(f.endM, f.endD));
      },
      cancelSlot() { this.slotForm = null; this.slotEditing = false; },
      async saveSlot() {
        if (!this.slotForm) return;
        const f = this.slotForm;
        if (!f.name.trim()) { this.toast('请填写时段名称', 'err'); return; }
        this.sortFormNodes();
        if (!(f.nodes || []).length) { this.toast('请至少添加一个时间段(或按住时间条刷选)', 'err'); return; }
        if (f.freq === 'weekly' && !(f.weekdays || []).length) { this.toast('请选择每周的星期几', 'err'); return; }
        if (f.freq === 'monthly') {
          if (!f.monthDay || f.monthDay < 1 || f.monthDay > 31) { this.toast('请选择每月的几号', 'err'); return; }
        }
        if (f.freq === 'yearly') {
          this.applySlotMD();
          if (!f.startMD || !f.endMD) { this.toast('请选择年度起止日期', 'err'); return; }
        }
        // 颜色槽: 未分配或与占用冲突 → 自动取同优先组空闲槽; 组满则保留原值
        const occ = this.occupiedSlotSet(f.id);
        if (!Number.isFinite(f.colorSlot) || occ.has(f.colorSlot)) {
          const free = this.freeSlotFor(f.priority, f.id);
          if (free != null) f.colorSlot = free;
        }
        const wasEdit = this.slotEditing;
        const rec = M.normalizePeriod({
          ...f,
          name: f.name.trim(),
          idleName: (f.idleName || '').trim(),
          nodes: f.nodes,
          freq: f.freq || 'daily',
          weekdays: (f.weekdays || []).slice().sort((a, b) => a - b),
        });
        M.stamp(rec, this.engine.skew);
        this.slotForm = null;
        this.slotEditing = false;
        try {
          await this.engine.commitPeriod(rec);
          this.toast(wasEdit ? '时段已保存' : '时段已创建');
        } catch (e) { if (e?.status === 401) this.onAuth(); else this.toast('保存失败(离线),已记本地', 'err'); }
      },
      async removeSlot(p) {
        if (!confirm(`删除时段「${p.name}」? 挂入其中的待办会回到「未安排」。`)) return;
        const rec = M.normalizePeriod({ ...p, deleted: true });
        M.stamp(rec, this.engine.skew);
        try { await this.engine.commitPeriod(rec); this.toast('时段已删除'); }
        catch (e) { if (e?.status === 401) this.onAuth(); else this.toast('删除失败,稍后重试', 'err'); }
      },
      setView(v) {
        this.viewMode = v;
        this.filterOpen = false;
        this.histClose();
        if (v === 'trace') setTimeout(() => this.scrollTraceToNow(), 40);
      },
      /** 轨迹进入后智能定位(连续多日轴): 今天在轴内→定位到“现在”; 否则从最早事项/轴起点开始 */
      scrollTraceToNow() {
        const el = document.querySelector('.tflowwrap');
        if (!el || !this.flow) return;
        const f = this.flow;
        const px = f.pxPerMin;
        const span = f.spanMin || 1440;
        const viewMin = Math.max(240, Math.floor(el.clientWidth / px));
        const maxX = Math.max(0, span * px - el.clientWidth);
        let a;
        if (f.nowMinAbs != null && f.nowMinAbs >= 0) {
          a = f.nowMinAbs - viewMin * 0.35;
        } else if (f.todos.length) {
          const s = Math.min(...f.todos.map((i) => i.s));
          const e = Math.max(...f.todos.map((i) => i.e));
          a = (e - s) <= viewMin ? Math.round((s + e) / 2 - viewMin / 2) : Math.round(s - 45);
        } else {
          a = 0;
        }
        el.scrollLeft = Math.max(0, Math.min(maxX, a * px));
      },
      // ---------- 轨迹 X 轴跨度(缩放) ----------
      traceZoomSet(v) {
        const n = Math.max(2, Math.min(520, Math.round(Number(v) || 92))); // 2px/小时起: 整轴(多日)也能铺进一屏
        // 缩放锚点 = 当前视口中心对应的时间, 缩放后仍对准该处, 避免“越缩越偏左”
        const el = document.querySelector('.tflowwrap');
        const f = this.flow;
        let keepCenterMin = null;
        if (el && f && f.pxPerMin > 0) {
          keepCenterMin = (el.scrollLeft + el.clientWidth / 2) / f.pxPerMin;
        }
        this.traceHourW = n;
        try { window.localStorage.setItem('tr:traceZoom', String(n)); } catch { /* 忽略 */ }
        if (keepCenterMin != null && el) {
          this.$nextTick(() => {
            const nf = this.flow;
            if (!nf || !nf.pxPerMin) return;
            const spanMin = nf.spanMin || 1440;
            const maxX = Math.max(0, spanMin * nf.pxPerMin - el.clientWidth);
            el.scrollLeft = Math.max(0, Math.min(maxX, keepCenterMin * nf.pxPerMin - el.clientWidth / 2));
          });
        }
      },
      traceZoomBy(d) { this.traceZoomSet((this.traceHourW || 92) + d); },
      traceZoomReset() { this.traceZoomSet(92); },
      /** 一键跨度: 让“h 小时”铺满当前一屏 */
      traceFitHours(h) {
        const el = document.querySelector('.tflowwrap');
        const w = el ? el.clientWidth : Math.max(320, window.innerWidth - 24);
        this.traceZoomSet(w / h);
      },
      /** 一键跨度: 让整个连续轴(traceDays 天)铺满一屏 */
      traceFitAxis() {
        const el = document.querySelector('.tflowwrap');
        const w = el ? el.clientWidth : Math.max(320, window.innerWidth - 24);
        const n = Math.max(1, this.traceDays || 1);
        this.traceZoomSet(w / (n * 24));
      },
      /** 轨迹日期切换: 向前/向后翻(可预览任意时间段; 拖动落位也跟着走) */
      traceShift(days) {
        const next = (this.traceOff || 0) + days;
        if (next < -730 || next > 3650) return;
        this.traceOff = next;
        setTimeout(() => this.scrollTraceToNow(), 80);
      },
      traceGoToday() {
        this.traceOff = 0;
        setTimeout(() => this.scrollTraceToNow(), 80);
      },
      /** 设置轨迹轴横跨天数(1~7, 打通相邻天时段) */
      traceDaysSet(n) {
        const v = Math.max(1, Math.min(7, Math.round(Number(n) || 1)));
        this.traceDays = v;
        try { window.localStorage.setItem('tr:traceDays', String(v)); } catch { /* 忽略 */ }
        setTimeout(() => this.scrollTraceToNow(), 60);
      },
      traceSpanLabel() {
        const w = window.innerWidth >= 640 ? Math.min(820, window.innerWidth) : Math.max(280, window.innerWidth - 24);
        const hours = w / (this.traceHourW || 92);
        if (hours > 30) return Math.round(hours) + ' 小时/屏(接近全天)';
        if (hours < 3) return hours.toFixed(1) + ' 小时/屏';
        return Math.round(hours) + ' 小时/屏';
      },
      addDuration(min) { this.editing.durationMin = min; },
      clearDuration() { this.editing.durationMin = null; },
      // ---------- 重复规则实例化窗口(v1.0.53): 同规则最多 3 条未完成实例, 完成自动补下一条 ----------
      _ruleIdOf(t) {
        const r = M.parseRule(t);
        return r ? r.id : null;
      },
      _sibIds(t) {
        const rid = this._ruleIdOf(t);
        return rid ? this.todos.filter((x) => !x.deleted && this._ruleIdOf(x) === rid && x.id !== t.id).map((x) => x.id) : [];
      },
      /**
       * 把“表单时间”拉正到规则最近一次:
       * 起点取「今天(或明天)的规则时刻」—— 而不是用户选的日期本身,
       * 否则选了跨过本周匹配日的时刻(如明天/后天的 18:00)会整周期跳过去,
       * 出现“勾了周五却排到下周五”的问题。
       */
      _snapRepeatDue(rec) {
        if (!rec.repeat || rec.repeat === 'none') return;
        const base = new Date(rec.dueAt || Date.now());
        const hh = base.getHours(), mm = base.getMinutes();
        const start = new Date();
        start.setHours(hh, mm, 0, 0);
        if (start.getTime() <= Date.now()) start.setDate(start.getDate() + 1); // 今天该时刻已过 → 从明天起找
        const first = M.nextOccurrenceMs({
          dueAt: start.getTime(), repeat: rec.repeat,
          repeatWeekdays: rec.repeatWeekdays || [], repeatMonthDays: rec.repeatMonthDays || [],
        }, Date.now() - 1);
        if (first != null) rec.dueAt = first;
      },
      /** 补齐规则窗口到 3 条未完成(anchor 自身若未完成也占一个名额; 新实例严格晚于现有) */
      async _ensureRuleWindow(anchor) {
        const rid = this._ruleIdOf(anchor);
        if (!rid) return;
        const mine = this.todos.filter((x) => !x.deleted && this._ruleIdOf(x) === rid && x.id !== anchor.id);
        const active = mine.filter((x) => x.status !== 'done');
        const anchorActive = anchor.status !== 'done';
        const need = 3 - active.length - (anchorActive ? 1 : 0);
        if (need <= 0) return;
        let last = active.length ? Math.max(...active.map((x) => x.dueAt || 0)) : (anchor.dueAt || Date.now());
        const news = [];
        let guard = 0;
        while (news.length < need && guard++ < 60) {
          // 以“上一条实例的时间”为查找锚: 返回严格晚于它的下一次(避免生成同一天)
          const nxt = M.ruleNextMs({ dueAt: last, rule: anchor.rule }, last);
          if (nxt == null) break;
          const inst = JSON.parse(JSON.stringify(anchor));
          inst.id = M.uid();
          inst.dueAt = nxt;
          inst.status = 'todo';
          inst.updatedAt = Date.now() + this.engine.skew;
          news.push(inst);
          last = nxt;
        }
        if (news.length) await this.engine.commitMany(news);
      },
      /** 完成实例后的整理: 补条 + 已完成历史只留最近 3 条 */
      async _afterInstanceDone(t) {
        const rid = this._ruleIdOf(t);
        if (!rid) return;
        await this._ensureRuleWindow(t);
        const dones = this.todos
          .filter((x) => !x.deleted && this._ruleIdOf(x) === rid && x.status === 'done')
          .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
        const extra = dones.slice(0, Math.max(0, dones.length - 3));
        if (extra.length) {
          const del = extra.map((x) => {
            const d = { ...x, deleted: true };
            M.stamp(d, this.engine.skew);
            return d;
          });
          await this.engine.commitMany(del);
        }
      },
      /** 保存一条(可能带重复规则): 新建/编辑统一处理规则窗口 */
      async saveWithRule(rec, orig) {
        const formRepeat = rec.repeat && rec.repeat !== 'none';
        const origRid = this._ruleIdOf(orig);
        const changedRule = (() => {
          if (!origRid) return false;
          const r0 = M.parseRule(orig);
          const r1 = { r: formRepeat ? rec.repeat : 'none', wd: rec.repeatWeekdays || [], md: rec.repeatMonthDays || [] };
          const hm0 = r0.hm;
          const d0 = new Date(orig.dueAt || Date.now());
          const hmNow = (rec.dueAt ? new Date(rec.dueAt) : new Date()).getHours() * 60 + (rec.dueAt ? new Date(rec.dueAt) : new Date()).getMinutes();
          return r0.r !== r1.r || (formRepeat && (r0.r === 'weekly' && String(r0.wd) !== String(r1.wd))) ||
            (formRepeat && (r0.r === 'monthly' && String(r0.md) !== String(r1.md))) || (formRepeat && hm0 !== hmNow && r1.r !== 'daily');
        })();
        const list = [];
        if (!formRepeat && origRid) {
          // 取消重复: 本条脱离规则, 同规则其它未完成实例一并停止
          rec.rule = '';
          const sibs = this.todos.filter((x) => !x.deleted && this._ruleIdOf(x) === origRid && x.id !== rec.id && x.status !== 'done');
          for (const s of sibs) {
            const d = { ...s, deleted: true };
            M.stamp(d, this.engine.skew);
            list.push(d);
          }
          list.push(rec);
          await this.engine.commitMany(list);
          return;
        }
        if (formRepeat) {
          this._snapRepeatDue(rec);
          if (origRid && !changedRule) {
            // 同规则微调(标题/备注/本次时间等): 仅存本条, 并确保窗口
            rec.repeat = 'none';
            list.push(rec);
            await this.engine.commitMany(list);
            await this._ensureRuleWindow(rec);
            return;
          }
          // 新建规则 / 规则参数变更 → 本条为新锚, 停掉旧规则其它未完成实例
          const newRule = M.makeRule(rec.repeat, rec.repeatWeekdays, rec.repeatMonthDays, rec.dueAt);
          if (origRid) {
            const sibs = this.todos.filter((x) => !x.deleted && this._ruleIdOf(x) === origRid && x.id !== rec.id && x.status !== 'done');
            for (const s of sibs) {
              const d = { ...s, deleted: true };
              M.stamp(d, this.engine.skew);
              list.push(d);
            }
          }
          rec.rule = newRule;
          rec.repeat = 'none';
          list.push(rec);
          await this.engine.commitMany(list);
          await this._ensureRuleWindow(rec);
          return;
        }
        // 普通任务(无重复)
        list.push(rec);
        await this.engine.commitMany(list);
      },
      /** 启动迁移: 旧式“单条滚动”重复记录 → 规则窗口(自身为首条, 补齐到 3) */
      async migrateLegacyRules() {
        if (this._migratedRules) return;
        this._migratedRules = true;
        const olds = this.todos.filter((t) => !t.deleted && t.status !== 'done' && t.repeat && t.repeat !== 'none' && !t.rule && t.dueAt);
        if (!olds.length) return;
        const list = [];
        for (const t of olds) {
          const inst = JSON.parse(JSON.stringify(t));
          // 与 _snapRepeatDue 同口径: 从“今天/明天的规则时刻”起找最近匹配日
          const base = new Date(inst.dueAt || Date.now());
          const hh = base.getHours(), mm = base.getMinutes();
          const start = new Date();
          start.setHours(hh, mm, 0, 0);
          if (start.getTime() <= Date.now()) start.setDate(start.getDate() + 1);
          const first = M.nextOccurrenceMs({
            dueAt: start.getTime(), repeat: inst.repeat,
            repeatWeekdays: inst.repeatWeekdays, repeatMonthDays: inst.repeatMonthDays,
          }, Date.now() - 1);
          if (first != null) inst.dueAt = first;
          inst.rule = M.makeRule(inst.repeat, inst.repeatWeekdays, inst.repeatMonthDays, inst.dueAt);
          inst.repeat = 'none';
          M.stamp(inst, this.engine.skew);
          list.push(inst);
        }
        await this.engine.commitMany(list);
        for (const a of list) await this._ensureRuleWindow(a);
      },
      async saveTodo() {
        if (!this.editing.title.trim()) { this.toast('请填写事项标题', 'err'); return; }
        const _p0 = Date.now();
        const rec = JSON.parse(JSON.stringify(this.editing));
        rec.title = rec.title.trim();
        M.stamp(rec, this.engine.skew);
        this.saving = true;
        try {
          const orig = this.todos.find((x) => x.id === rec.id);
          // 查重(仅新建; 编辑已有条目时是自己, 不会误删): 同一件事时间变了 → 删旧留新
          let dupes = [];
          let dedupeRes = null;
          if (this.dedupePref && !orig) {
            dupes = this.findSameTopic(rec);
            if (dupes.length) dedupeRes = await this.applyDedupe(dupes, rec);
          }
          await this.saveWithRule(rec, orig || null);
          this.saving = false; // 成功也要复位(漏掉会: 按钮永久“保存中…”且禁用)
          this.perfPush('saveTodo ' + (Date.now() - _p0) + 'ms');
          this.closeEditor();
          if (dupes.length && dedupeRes && dedupeRes.removed) {
            const who = dupes.length === 1 ? `「${dupes[0].title}」` : `${dupes.length} 条旧待办`;
            const changed = dupes.some((d) => M.timeChanged(d, rec));
            // 注意: 这里是用“新的整条内容”覆盖旧的(不是字段级合并), 文案必须如实说明
            this.toast(changed
              ? `✅ 已替换${who}的时间(旧的已删除)`
              : `✅ 已更新${who}为最新内容(旧的已删除)`);
          } else {
            this.toast(this.editorMode === 'new' ? '已添加' : '已保存');
          }
        } catch (e) {
          this.saving = false;
          this.perfPush('saveTodo FAIL ' + (Date.now() - _p0) + 'ms');
          if (e?.status === 401) this.onAuth(); else this.toast('保存失败: ' + (e.message || '网络异常'), 'err');
        }
      },
      // ---------- 设置 / 连接 ----------
      openSettings(focusAuth = false) {
        this.settingsOpen = true; this.filterOpen = false;
        if (focusAuth && !this.tokenInput && this.engine) this.tokenInput = this.engine.token;
        if (focusAuth) this.authTab = true;
        this.refreshApk();
        this.refreshNative();
        this.refreshRemote();     // 手机入口状态(只读, 不起隧道)
        // 打开设置时强制拉取最新 AI 配置 + 节次表(避免展示/保存旧缓存)
        this.loadAiCfg(true).then(() => this.ptSync()).catch(() => {});
      },
      closeSettings() { this.settingsOpen = false; },
      // ---------- 远程访问(手机入口): 起/停/诊断/修复/换链接 ----------
      remoteRunning() { return !!(this.remoteStatus && this.remoteStatus.running); },
      remoteStateText() {
        const s = this.remoteStatus;
        if (!s) return '未检测';
        if (s.linkReady) return '✅ 已就绪 · 手机可连';
        if (s.running) return '⏳ 正在等公网域名生效…';
        return '未开启';
      },
      /** 拉取远程状态; full=true 时同时跑一次逐环节诊断。
       *  桌面端走 IPC(能起/停);手机与浏览器端没有 IPC, 就走只读接口 /api/remote 看状态。 */
      async refreshRemote(full = false) {
        if (host && host.api.remoteInfo) {
          try {
            const st = await host.api.remoteInfo();
            if (st && st.ok !== false) this.remoteStatus = st;
            if (st && st.lastError) this.remoteErr = st.lastError;
          } catch (e) { this.remoteErr = String(e && e.message || e); }
        } else {
          // 只读视图: 手机/浏览器只需要知道"入口现在是什么、通不通"
          try {
            const r = await fetch('api/remote', { headers: this.engine ? this.engine._headers(false) : {} });
            if (r.ok) {
              const st = await r.json();
              if (st && st.ok) this.remoteStatus = st;
            }
          } catch { /* 手机端拿不到也不影响使用 */ }
        }
        if (full) await this.runRemoteCheck();
      },
      async runRemoteCheck() {
        if (!host || !host.api.remoteCheck) return;
        this.remoteBusy = true; this.remoteBusyText = '正在逐环节诊断…';
        try {
          const r = await host.api.remoteCheck();
          this.remoteSteps = (r && r.steps) || [];
          if (r && r.status) this.remoteStatus = { ok: true, ...r.status };
          this.remoteErr = r && r.ok ? '' : '有环节未通过 —— 见下方清单';
          if (r && r.ok) this.toast('远程连接诊断通过 ✅');
        } catch (e) { this.remoteErr = String(e && e.message || e); }
        finally { this.remoteBusy = false; this.remoteBusyText = ''; }
      },
      async startRemote() {
        if (!host || !host.api.remoteStart) return;
        const already = this.remoteRunning();
        this.remoteBusy = true; this.remoteStarting = !already;
        this.remoteBusyText = already ? '正在重启远程访问…' : '正在开启远程访问…';
        this.remoteErr = '';
        try {
          const r = await host.api.remoteStart();
          if (r) { const { ok, error, ...rest } = r; this.remoteStatus = { ok: true, ...rest }; if (error) this.remoteErr = error; }
          if (r && r.ok) this.toast('手机入口已就绪 ✅');
          else { this.toast('远程访问未就绪:' + ((r && r.error) || '未知原因'), 'err'); await this.runRemoteCheck(); }
        } catch (e) { this.remoteErr = String(e && e.message || e); }
        finally { this.remoteBusy = false; this.remoteStarting = false; this.remoteBusyText = ''; }
      },
      async stopRemote() {
        if (!host || !host.api.remoteStop) return;
        this.remoteBusy = true; this.remoteBusyText = '正在关闭(先停隧道再停入口)…';
        try {
          const r = await host.api.remoteStop();
          if (r) { const { ok, error, ...rest } = r; this.remoteStatus = { ok: true, ...rest }; }
          this.toast('已关闭手机入口');
        } catch (e) { this.remoteErr = String(e && e.message || e); }
        finally { this.remoteBusy = false; this.remoteBusyText = ''; }
      },
      async repairRemote() {
        if (!host || !host.api.remoteRepair) return;
        this.remoteBusy = true; this.remoteBusyText = '正在修复(清理孤儿 → 重启入口 → 复诊)…';
        this.remoteErr = '';
        try {
          const r = await host.api.remoteRepair();
          if (r) { const { ok, error, actions, steps, ...rest } = r; this.remoteStatus = { ok: true, ...rest }; this.remoteSteps = steps || []; if (error) this.remoteErr = error; }
          const acts = (r && r.actions) || [];
          this.toast(r && r.ok ? '已修复, 手机可以连了 ✅' : '修复后仍有问题, 见诊断清单', r && r.ok ? 'info' : 'err');
          if (acts.length) this.remoteBusyText = '';
        } catch (e) { this.remoteErr = String(e && e.message || e); }
        finally { this.remoteBusy = false; this.remoteBusyText = ''; await this.runRemoteCheck(); }
      },
      copyRemoteLink() {
        const u = this.remoteStatus && this.remoteStatus.linkUrl;
        if (!u) { this.toast('还没有链接', 'err'); return; }
        this.copy(u, '手机链接已复制');
      },
      openRemoteLink() {
        const u = this.remoteStatus && this.remoteStatus.linkUrl;
        if (!u) { this.toast('还没有链接', 'err'); return; }
        if (host && host.api.openExternal) host.api.openExternal(u);
        else window.open(u, '_blank');
      },
      async resetRemoteLink() {
        if (!host || !host.api.remoteReset) return;
        if (!confirm('换一条新链接?\n\n旧的链接立刻失效 —— 手机上如果已经打开过, 需要重新点一次新链接。')) return;
        this.remoteBusy = true; this.remoteBusyText = '正在换新链接…';
        try {
          const r = await host.api.remoteReset();
          if (r) { const { ok, error, ...rest } = r; this.remoteStatus = { ok: true, ...rest }; }
          this.toast(r && r.ok ? '已换新链接(旧的作废)' : '换链接失败', r && r.ok ? 'info' : 'err');
        } catch (e) { this.remoteErr = String(e && e.message || e); }
        finally { this.remoteBusy = false; this.remoteBusyText = ''; }
      },
      async saveToken() {
        if (!this.engine) return;
        await this.engine.setToken(this.tokenInput);
        try {
          await this.engine.sync();
          this.engine.connectWs();
          this.setConn('synced');
          this.authNote = '';
          this.toast('连接成功,已同步数据');
        } catch (e) {
          this.setConn('auth');
          this.toast('连接码不正确或服务器不可达', 'err');
        }
      },
      async resetToken() {
        if (!host) return;
        if (!confirm('重置连接码?其他已连接设备需要更新连接码。')) return;
        const info = await host.api.resetToken();
        if (info?.ok && this.engine) {
          await this.engine.setToken(info.token);
          this.toast('连接码已重置');
        }
      },
      async refreshApk() {
        try {
          const info = host ? await host.api.apkInfo() : null;
          this.apkFiles = info?.files || [];
        } catch { this.apkFiles = []; }
      },
      exportBackup() {
        const a = document.createElement('a');
        a.href = `/api/export?token=${encodeURIComponent(this.engine?.token || '')}`;
        a.download = 'todos-backup.json';
        a.click();
      },
      toggleFilter() { this.filterOpen = !this.filterOpen; },
      clearFilters() {
        this.impFilter = []; this.indepFilter = 'all'; this.search = '';
      },
      activeFilterCount() {
        return this.impFilter.length + (this.indepFilter !== 'all' ? 1 : 0) + (this.search.trim() ? 1 : 0);
      },
      groupTitle(k) { return this.groupLabel(k); },
    },
    async mounted() {
      const self = this;
      this._tickMin = -1;
      this.applyLite(); // 启动即应用流畅模式
      this.engine = new SyncEngine({
        onData: (l) => self.onData(l),
        onPeriods: (l) => self.onPeriods(l),
        onState: (s) => self.setConn(s),
        onAuth: () => self.onAuth(),
        // 保存已本地即时生效; 后台推送失败时只提示一次(心跳会自动重试)
        onPushFail: (e) => {
          if (e && e.status === 401) { self.onAuth(); return; }
          self.setConn('offline');
          if (!self._offlineToastShown) {
            self._offlineToastShown = true;
            self.toast('已保存在本机,联网后自动同步', 'err');
          }
        },
      });
      // URL 参数连接码 ?token=xxx
      const q = new URLSearchParams(location.search);
      if (q.get('token')) {
        await this.engine.setToken(q.get('token'));
        history.replaceState(null, '', location.pathname);
      }
      this.tokenInput = this.engine.token || '';
      this.onData(this.engine.localAll());
      this.onPeriods(this.engine.localPeriods());
      this.engine.start();
      try {
        await this.engine.sync();
        this.setConn('synced');
      } catch (e) {
        if (e.status === 401) { this.onAuth(); } else this.setConn('offline');
      }
      await this.ptSync().catch(() => {}); // 同步后立刻对齐节次表
      this.refreshApk();
      // 恢复主题偏好(theme-init 已先行防闪烁; 此处同步状态)
      let tp = 'system';
      try { tp = localStorage.getItem('tr:theme') || 'system'; } catch { /* ignore */ }
      this.themePref = ['light', 'dark', 'neo', 'system'].includes(tp) ? tp : 'system';
      if (this.themePref !== 'system') document.documentElement.setAttribute('data-theme', this.themePref);
      this.loadAiCfg();
      // 启动即对齐节次对照表(本机缓存 ↔ 服务器 ai.json), 保证永久保存、不被旧内容覆盖
      this.ptSync().catch(() => {});
      // 旧式“单条滚动”重复记录 → 规则实例窗口(幂等; 完成后不再重复执行)
      setTimeout(() => { self.migrateLegacyRules().catch(() => {}); }, 300);
      document.addEventListener('paste', (e) => this.onPasteImg(e));
      this._bindIdle(); // 闲置自动静止光效(手机降温: 停帧即省电)
      setInterval(() => this.tick(), 60000); // 每 60 秒刷新倒计时/状态边界(进行中→逾期)
      // 页面不可见时暂停全部光效动画(省电、减少后台占用)
      document.addEventListener('visibilitychange', () => {
        try { document.documentElement.classList.toggle('bg-idle', document.hidden); } catch (e) { /* ignore */ }
      });
      if (host) {
        const info = await host.api.info().catch(() => null);
        this.desktopInfo = info;
        this.autostartOn = !!info?.autostart;
        // 远程访问: 首次拉状态; 之后只在设置页打开时轮询(免得白耗)
        this.refreshRemote();
        this._remoteTimer = setInterval(() => {
          if (this.settingsOpen) this.refreshRemote();
        }, 20000);
        // 托盘「连接诊断与修复…」→ 打开设置并跑一次诊断
        try {
          host.onOpenRemoteHelp?.(() => {
            this.openSettings();
            this.refreshRemote(true);
          });
        } catch { /* ignore */ }
      }
    },
  });
  app.config.compilerOptions.delimiters = ['{{', '}}'];
  // Vue 渲染/生命周期异常也记入诊断 errs(白屏/卡死的证据来源)
  app.config.errorHandler = (err, _instance, info) => {
    try {
      const s = 'V:' + (info || '') + ' ' + String((err && err.stack) || err).slice(0, 300);
      window.__errs = window.__errs || [];
      if (window.__errs[window.__errs.length - 1] !== s) window.__errs.push(s);
      if (window.__errs.length > 12) window.__errs.splice(0, window.__errs.length - 12);
    } catch { /* 忽略 */ }
  };
  const vm = app.mount('#app'); // mount 返回根组件实例(暴露 data/computed/methods)
  window.__todoApp = vm;
}

boot();
