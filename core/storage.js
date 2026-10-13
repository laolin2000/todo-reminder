// ============================================================
// storage.js — JSON 持久化 + Last-Write-Wins 合并存储
// 所有记录含墓碑(deleted)以支持多端删除同步。
// ============================================================
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const IMPORTANCE = ['low', 'medium', 'high']; // 低/中/高
export const STATUS = ['todo', 'doing', 'done'];

export function newTodoId() {
  return randomUUID();
}

/** 构造一条默认待办记录(纯函数,不含 id 外逻辑) */
export function blankTodo() {
  const now = Date.now();
  return {
    id: newTodoId(),
    title: '',
    notes: '',
    location: '',
    dueAt: null,          // epoch ms
    importance: 1,        // 重要度 5 档: 0轻微 1一般 2重要 3紧急 4特急
    effort: 1,            // 任务量 4 档: 0轻松 1适中 2较重 3繁重
    materials: [],        // string[]
    durationMin: null,    // 分钟
    independent: true,    // true=独立  false=依赖他人/前置
    status: 'todo',       // todo / doing / done
    remindBeforeMin: 15,  // 提前提醒分钟
    repeat: 'none',       // none / daily / weekly / monthly
    repeatWeekdays: [],   // weekly: 1..7(周一=1), 可多选
    repeatMonthDays: [],  // monthly: 1..31, 可多选
    fuzzy: false,         // 模糊: 到点/逾期不弹通知
    goal: false,          // 重要目标: 只规定截止时间, 不规定何时进行
    rule: '',             // 重复规则实例化: 所属规则 JSON(空=普通/旧式重复)
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
}

export function normalizeTodo(t) {  const b = blankTodo();
  const o = t || {};
  return {
    id: typeof o.id === 'string' && o.id ? o.id : newTodoId(),
    title: typeof o.title === 'string' ? o.title : b.title,
    notes: typeof o.notes === 'string' ? o.notes : b.notes,
    location: typeof o.location === 'string' ? o.location : b.location,
    dueAt: Number.isFinite(o.dueAt) && o.dueAt != null ? o.dueAt : null,
    importance: [0, 1, 2, 3, 4].includes(o.importance) ? o.importance : b.importance,
    effort: [0, 1, 2, 3].includes(o.effort) ? o.effort : 1, // 任务量 4 档, 旧数据默认 适中
    materials: Array.isArray(o.materials)
      ? o.materials.map((m) => String(m)).filter(Boolean)
      : typeof o.materials === 'string' && o.materials.trim()
        ? o.materials.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
        : [],
    durationMin: Number.isFinite(o.durationMin) && o.durationMin != null && o.durationMin >= 0 ? Math.round(o.durationMin) : null,
    slotId: typeof o.slotId === 'string' ? o.slotId : '',
    independent: typeof o.independent === 'boolean' ? o.independent : b.independent,
    status: STATUS.includes(o.status) ? o.status : b.status,
    remindBeforeMin: Number.isFinite(o.remindBeforeMin) && o.remindBeforeMin >= 0 ? Math.round(o.remindBeforeMin) : b.remindBeforeMin,
    repeat: ['none', 'daily', 'weekly', 'monthly'].includes(o.repeat) ? o.repeat : 'none',
    repeatWeekdays: Array.isArray(o.repeatWeekdays)
      ? [...new Set(o.repeatWeekdays.map((w) => Math.round(w)).filter((w) => w >= 1 && w <= 7))].sort((a, b) => a - b)
      : [],
    repeatMonthDays: Array.isArray(o.repeatMonthDays)
      ? [...new Set(o.repeatMonthDays.map((d) => Math.round(d)).filter((d) => d >= 1 && d <= 31))].sort((a, b) => a - b)
      : [],
    fuzzy: o.fuzzy === true,
    goal: o.goal === true, // 重要目标(只设截止时间)
    rule: typeof o.rule === 'string' ? o.rule : '', // 重复规则实例化元数据(空串 = 普通/旧式)
    createdAt: Number.isFinite(o.createdAt) ? o.createdAt : b.createdAt,
    updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now(),
    deleted: o.deleted === true,
  };
}

/**
 * 下一次重复发生时刻(本地时区, 保时间点/星期/几号语义)。
 * daily+1天; weekly+7天(与锚点同星期几); monthly=下月同几号(短月取月末最后一天)。
 * 返回第一个严格晚于 afterMs 的发生时刻; 非重复/无时间返回 null。
 * 语义与网页 model.js、安卓 Todo.kt 保持一致。
 */
export function nextOccurrenceMs(t, afterMs) {
  const due = t?.dueAt;
  const rep = t?.repeat;
  if (!due || !rep || rep === 'none' || !Number.isFinite(afterMs)) return null;
  const anchor = new Date(due);
  const isoWd = (d) => ((d.getDay() + 6) % 7) + 1;
  if (rep === 'daily') {
    const cur = new Date(anchor);
    while (cur.getTime() <= afterMs) cur.setDate(cur.getDate() + 1);
    return cur.getTime();
  }
  if (rep === 'weekly') {
    const set = (t.repeatWeekdays && t.repeatWeekdays.length) ? t.repeatWeekdays : [isoWd(anchor)];
    const cur = new Date(anchor);
    for (let i = 0; i < 380; i++) {
      if (cur.getTime() > afterMs && set.includes(isoWd(cur))) return cur.getTime();
      cur.setDate(cur.getDate() + 1);
    }
    return null;
  }
  const set = (t.repeatMonthDays && t.repeatMonthDays.length) ? t.repeatMonthDays : [anchor.getDate()];
  const hm = anchor.getHours() * 60 + anchor.getMinutes();
  let y = anchor.getFullYear();
  let m = anchor.getMonth();
  for (let mi = 0; mi < 400; mi++) {
    const last = new Date(y, m + 1, 0).getDate();
    for (const dom of set) {
      if (dom > last) continue;
      const cand = new Date(y, m, dom);
      cand.setMinutes(hm);
      if (cand.getTime() > afterMs) return cand.getTime();
    }
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return null;
}

export class TodoStore extends EventEmitter {
  /** @param {string} file todos.json 绝对路径 */
  constructor(file) {
    super();
    this.file = file;
    this.map = new Map(); // id -> record(含墓碑)
    this._writeTimer = null;
    this._writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const t of arr) {
          const n = normalizeTodo(t);
          this.map.set(n.id, n);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[storage] 读取数据失败(将重建):', e.message);
      this.map = new Map();
    }
    return this;
  }

  /** 同步快照(含墓碑),调用方勿直接修改返回对象 */
  all() {
    return [...this.map.values()];
  }

  active() {
    return this.all().filter((t) => !t.deleted);
  }

  get(id) {
    return this.map.get(id) ?? null;
  }

  /**
   * LWW 合并一批记录;返回最终被触碰记录的服务器版本(含墓碑)。
   * 规则: incoming.updatedAt >= stored.updatedAt 时整条替换(记录级 LWW)。
   * @param {any[]} todos
   * @returns {{touched: any[], now: number}}
   */
  upsert(todos) {
    const now = Date.now();
    const touched = [];
    if (!Array.isArray(todos)) return { touched, now };
    for (const raw of todos) {
      const inc = normalizeTodo(raw);
      const cur = this.map.get(inc.id);
      if (cur && inc.updatedAt < cur.updatedAt) {
        touched.push(cur); // 本地更新,返回本地权威版本
        continue;
      }
      const rec = { ...inc };
      // 不强制改写时间戳: 客户端已按服务器时钟偏差校正,多端 LWW 以各自 updatedAt 公平比较;
      // 仅当客户端未携带有效时间戳时(normalize 已兜底)才由服务器盖章。
      this.map.set(rec.id, rec);
      touched.push(rec);
    }
    if (touched.length) {
      this.persist();
      setImmediate(() => this.emit('change', touched.map((t) => ({ ...t }))));
    }
    return { touched, now };
  }

  /** 清理已删除且超过 minAgeMs 的墓碑(可选维护) */
  purgeDeleted(minAgeMs = 30 * 24 * 3600e3) {
    const cutoff = Date.now() - minAgeMs;
    let changed = false;
    for (const [id, t] of this.map) {
      if (t.deleted && t.updatedAt < cutoff) {
        this.map.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  /** 立即落盘(防抖 + 原子写) */
  persist() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this._flush(), 60);
  }

  async flushNow() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    await this._flush();
  }

  async _flush() {
    this._writing = this._writing.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const payload = JSON.stringify(this.all(), null, 1);
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.file);
    }).catch((e) => console.error('[storage] 写入失败:', e.message));
    await this._writing;
  }
}

// ============================================================
// 时段(Period): 长期自定义时段库
// 字段: 名称/时间段(startMin~endMin 当天分钟)/环境内容/优先度/提前提醒
// 重复频度: daily(每天) / weekly(每周, 周几多选) / monthly(每月几号) / yearly(每年 某月日~某月日, 可跨年)
// 与 TodoStore 相同的 LWW + 墓碑合并语义。
// ============================================================
const WEEK_POOL = [1, 2, 3, 4, 5, 6, 7]; // 周一..周日

export function normalizePeriod(p) {
  const o = p || {};
  const now = Date.now();
  const clampMin = (v) => Number.isFinite(v) ? Math.min(1440, Math.max(0, Math.round(v))) : null;
  const md = (v) => (Number.isFinite(v) && v >= 101 && v <= 1231 ? Math.round(v) : null);
  const weekdays = Array.isArray(o.weekdays)
    ? [...new Set(o.weekdays.map((w) => Math.round(w)).filter((w) => WEEK_POOL.includes(w)))].sort((a, b) => a - b)
    : [];
  // 节点(nodes): 时间段列表, 每段 {startMin, endMin}, endMin<startMin 表示跨午夜(自动拆两段显示);
  // 兼容旧数据: 无 nodes 时由 startMin/endMin 构造单节点。
  const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
  let nodes = rawNodes
    .map((n) => ({ startMin: clampMin(n?.startMin), endMin: clampMin(n?.endMin) }))
    .filter((n) => n.startMin != null && n.endMin != null && n.startMin !== n.endMin)
    .sort((a, b) => a.startMin - b.startMin);
  const legacyStart = clampMin(o.startMin);
  const legacyEnd = clampMin(o.endMin);
  if (!nodes.length && legacyStart != null && legacyEnd != null && legacyStart !== legacyEnd) {
    nodes = [{ startMin: legacyStart, endMin: legacyEnd }];
  }
  const primary = nodes[0] || { startMin: null, endMin: null };
  return {
    id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
    name: typeof o.name === 'string' ? o.name : '',
    idleName: typeof o.idleName === 'string' ? o.idleName : '', // 不激活时的名字(可空=沿用 name)
    startMin: primary.startMin,
    endMin: primary.endMin,
    nodes,
    env: typeof o.env === 'string' ? o.env : '',
    priority: [0, 1, 2].includes(o.priority) ? o.priority : 1,
    remindBeforeMin: Number.isFinite(o.remindBeforeMin) && o.remindBeforeMin >= 0 ? Math.round(o.remindBeforeMin) : 10,
    freq: ['daily', 'weekly', 'monthly', 'yearly'].includes(o.freq) ? o.freq : 'daily',
    weekdays,
    monthDay: Number.isFinite(o.monthDay) && o.monthDay >= 1 && o.monthDay <= 31 ? Math.round(o.monthDay) : null, // 每月第几日(1..31; 当月无此日则跳过)
    startMD: md(o.startMD),
    endMD: md(o.endMD),
    colorSlot: Number.isFinite(o.colorSlot) && o.colorSlot >= 0 && o.colorSlot <= 8 ? Math.round(o.colorSlot) : null,
    createdAt: Number.isFinite(o.createdAt) ? o.createdAt : now,
    updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : now,
    deleted: o.deleted === true,
  };
}

/** 该时段在一“天”(0..1440 分钟轴)内的显示段; 跨午夜节点自动拆成 [start,1440)+[0,end] */
export function periodDaySegments(p) {
  const segs = [];
  for (const n of p?.nodes || []) {
    if (n.startMin == null || n.endMin == null) continue;
    if (n.endMin < n.startMin) { // 跨午夜
      if (n.startMin < 1440) segs.push({ startMin: n.startMin, endMin: 1440 });
      if (n.endMin > 0) segs.push({ startMin: 0, endMin: n.endMin });
    } else if (n.endMin > n.startMin) {
      segs.push({ startMin: n.startMin, endMin: n.endMin });
    }
  }
  return segs;
}

/** 某分钟(0..1439)是否在该时段激活范围内(跨午夜自动判定) */
export function periodActiveAt(p, minute) {
  for (const n of p?.nodes || []) {
    if (n.startMin == null || n.endMin == null) continue;
    if (n.endMin < n.startMin) {
      if (minute >= n.startMin || minute < n.endMin) return true;
    } else if (minute >= n.startMin && minute < n.endMin) {
      return true;
    }
  }
  return false;
}

/**
 * 该时段的“重复”是否命中某一天(用于提醒触发与轨迹泳道显示)。
 * jsDate 需为本地时区日期对象。
 */
export function periodActiveOnDay(p, jsDate) {
  if (!p) return false;
  if (p.freq === 'weekly') {
    const jsDay = jsDate.getDay(); // 0=周日
    const w = jsDay === 0 ? 7 : jsDay;
    return (p.weekdays || []).includes(w);
  }
  if (p.freq === 'monthly') {
    // 每月第 monthDay 日(1..31); 当月没有该日(如 31 号遇小月)→ 该月跳过
    return p.monthDay == null || jsDate.getDate() === p.monthDay;
  }
  if (p.freq === 'yearly') {
    if (p.startMD == null || p.endMD == null) return true;
    const md = (jsDate.getMonth() + 1) * 100 + jsDate.getDate();
    return p.startMD <= p.endMD
      ? md >= p.startMD && md <= p.endMD
      : md >= p.startMD || md <= p.endMD; // 跨年如 12-20 ~ 01-05
  }
  return true; // daily
}

export class PeriodStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.map = new Map();
    this._writeTimer = null;
    this._writing = Promise.resolve();
  }

  async load() {
    try {
      const arr = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(arr)) for (const p of arr) { const n = normalizePeriod(p); this.map.set(n.id, n); }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[periods] 读取数据失败(将重建):', e.message);
      this.map = new Map();
    }
    return this;
  }

  all() { return [...this.map.values()]; }

  active() { return this.all().filter((p) => !p.deleted); }

  get(id) { return this.map.get(id) ?? null; }

  upsert(list) {
    const touched = [];
    if (!Array.isArray(list)) return { touched };
    for (const raw of list) {
      const inc = normalizePeriod(raw);
      const cur = this.map.get(inc.id);
      if (cur && inc.updatedAt < cur.updatedAt) { touched.push(cur); continue; }
      this.map.set(inc.id, inc);
      touched.push(inc);
    }
    if (touched.length) {
      this.persist();
      setImmediate(() => this.emit('change', touched.map((t) => ({ ...t }))));
    }
    return { touched };
  }

  persist() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this._flush(), 60);
  }

  async flushNow() {
    if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
    await this._flush();
  }

  async _flush() {
    this._writing = this._writing.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.all(), null, 1), 'utf8');
      await fs.rename(tmp, this.file);
    }).catch((e) => console.error('[periods] 写入失败:', e.message));
    await this._writing;
  }
}
