// ============================================================
// api.js — 同步引擎(Web/手机浏览器客户端)
// 策略: 本地缓存 → 启动时推送本地较新改动(POST /api/sync) → 服务器返回权威全量
//      → 之后由 WebSocket 增量实时更新。401 时抛 auth 事件,由 UI 引导输入连接码。
// ============================================================
import { normalize, normalizePeriod } from './model.js';

const LS_TODOS = 'tr:v1:todos';
const LS_PERIODS = 'tr:v1:periods';
const LS_META = 'tr:v1:meta';

export class SyncEngine {
  constructor({ onData, onPeriods, onState, onAuth, onPushFail }) {
    this.onData = onData || (() => {});
    this.onPeriods = onPeriods || (() => {});
    this.onState = onState || (() => {});
    this.onAuth = onAuth || (() => {});
    this.onPushFail = onPushFail || (() => {}); // 后台推送失败回调(UI 提示“已存本机”)
    this.map = new Map();
    this.periodMap = new Map();
    this.token = localStorage.getItem('tr:v1:token') || '';
    this.lastSynced = Number(localStorage.getItem(LS_META) ? (JSON.parse(localStorage.getItem(LS_META)).lastSynced || 0) : 0) || 0;
    this.skew = 0; // serverTime - clientTime 估计
    this.ws = null;
    this.wsRetry = 0;
    this.pendingTimer = null;
    this._loadCache();
  }

  get base() { return location.origin; }
  get wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const t = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    return `${proto}${location.host}/ws${t}`;
  }

  _headers(json) {
    const h = { 'x-token': this.token };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  _loadCache() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_TODOS) || '[]');
      for (const t of arr) { const n = normalize(t); this.map.set(n.id, n); }
    } catch { this.map = new Map(); }
    try {
      const arr = JSON.parse(localStorage.getItem(LS_PERIODS) || '[]');
      for (const t of arr) { const n = normalizePeriod(t); this.periodMap.set(n.id, n); }
    } catch { this.periodMap = new Map(); }
  }

  _saveCache() {
    try {
      localStorage.setItem(LS_TODOS, JSON.stringify([...this.map.values()]));
      localStorage.setItem(LS_PERIODS, JSON.stringify([...this.periodMap.values()]));
      localStorage.setItem(LS_META, JSON.stringify({ lastSynced: this.lastSynced }));
    } catch { /* 存储满等场景忽略 */ }
  }

  todos() { return [...this.map.values()]; }
  periods() { return [...this.periodMap.values()]; }
  localAll() { return this.todos().filter((t) => !t.deleted); }
  localPeriods() { return this.periods().filter((p) => !p.deleted); }

  /** 客户端本地记录(含墓碑) */
  async _fetch(path, opts) {
    const _t0 = Date.now();
    // 请求级超时保护: 服务器/网络无响应时 25s 内必须失败返回, 不许无限“保存中…”
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    let r;
    try {
      r = await fetch(path, { ...opts, signal: ctl.signal });
    } catch (e) {
      const isAbort = e && (e.name === 'AbortError' || /abor/i.test(String(e && e.message)));
      const msg = isAbort ? '请求超时(25s, 服务器无响应)' : (e && e.message ? e.message : '网络异常');
      this.recordErr(path.split('?')[0] + ' ' + msg);
      const err = new Error(msg);
      err.status = 0;
      throw err;
    } finally {
      clearTimeout(timer);
      this.perf((path.split('?')[0] || '') + ' ' + (Date.now() - _t0) + 'ms');
    }
    if (r.status === 401) {
      const ev = new Error('unauthorized'); ev.status = 401;
      throw ev;
    }
    if (!r.ok) {
      let txt = '';
      try { txt = await r.text(); } catch { /* ignore */ }
      const err = new Error(`HTTP ${r.status}: ${String(txt).slice(0, 140)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  /** 把一次耗时记入 window.__perf(诊断信息可读, 定位卡顿) */
  perf(m) {
    try {
      window.__perf = window.__perf || [];
      window.__perf.push(m);
      if (window.__perf.length > 20) window.__perf.splice(0, window.__perf.length - 20);
    } catch { /* 忽略 */ }
  }

  async setToken(tok) {
    this.token = (tok || '').trim();
    localStorage.setItem('tr:v1:token', this.token);
  }

  /** 完整同步: 推送本地较新改动 → 以服务器全量为准。返回服务器时间。 */
  async sync() {
    this.onState('syncing');
    // 一次性计算脏集合, 避免 adopt 更新 lastSynced 导致新建记录漏推
    const toPush = this.todos().filter((t) => t.updatedAt > this.lastSynced);
    const toPushP = this.periods().filter((p) => p.updatedAt > this.lastSynced);
    const body = JSON.stringify({ todos: toPush });
    const data = await this._fetch(this.base + '/api/sync', {
      method: 'POST', headers: this._headers(true), body,
    });
    this._adopt(data);
    // 时段库同步
    const pdata = await this._fetch(this.base + '/api/periods/sync', {
      method: 'POST', headers: this._headers(true),
      body: JSON.stringify({ periods: toPushP }),
    });
    if (pdata && Array.isArray(pdata.periods)) {
      const next = new Map();
      for (const p of pdata.periods) { const n = normalizePeriod(p); next.set(n.id, n); }
      this.periodMap = next;
      this.onPeriods(this.localPeriods());
      this._saveCache();
    }
    return data.serverTime;
  }

  async health() {
    return this._fetch(this.base + '/api/health');
  }

  _adopt(data) {
    if (!data || !Array.isArray(data.todos)) return;
    const next = new Map();
    for (const t of data.todos) { const n = normalize(t); next.set(n.id, n); }
    this.map = next;
    this.skew = (data.serverTime || Date.now()) - Date.now();
    this.lastSynced = Date.now() + this.skew; // 服务器时钟基准
    this._saveCache();
    this.onData(this.localAll());
  }

  /** 保存后的增量合并: 只替换有变化的记录并返回是否变化;
   *  避免“每次保存都整表重建+整页刷新”造成的明显卡顿 */
  _applyMerge(data) {
    if (!data || !Array.isArray(data.todos)) return false;
    const sig = (t) => `${t.id}|${t.updatedAt}|${t.deleted}|${t.title}|${t.notes}|${t.location}|${t.dueAt || 0}|${t.status}|${t.importance}|${t.effort}|${t.goal}|${(t.materials || []).join(',')}|${t.durationMin || 0}|${t.independent}|${t.remindBeforeMin}|${t.repeat}|${t.fuzzy}|${t.slotId || ''}|${t.createdAt || 0}`;
    let changed = false;
    for (const raw of data.todos) {
      const n = normalize(raw);
      const cur = this.map.get(n.id);
      if (!cur || sig(cur) !== sig(n)) { this.map.set(n.id, n); changed = true; }
    }
    this.skew = (data.serverTime || Date.now()) - Date.now();
    this.lastSynced = Date.now() + this.skew;
    this._saveCache();
    if (changed) this.onData(this.localAll());
    return changed;
  }

  /** WS 增量: 用服务器版本替换本地版本 */
  applyDelta(records) {
    let changed = false;
    for (const raw of records) {
      const inc = normalize(raw);
      const cur = this.map.get(inc.id);
      if (cur && inc.updatedAt < cur.updatedAt) continue; // 本地更新,忽略过期广播
      this.map.set(inc.id, inc);
      changed = true;
    }
    if (changed) {
      this._saveCache();
      this.onData(this.localAll());
    }
  }

  applyPeriodDelta(records) {
    let changed = false;
    for (const raw of records) {
      const inc = normalizePeriod(raw);
      const cur = this.periodMap.get(inc.id);
      if (cur && inc.updatedAt < cur.updatedAt) continue;
      this.periodMap.set(inc.id, inc);
      changed = true;
    }
    if (changed) {
      this._saveCache();
      this.onPeriods(this.localPeriods());
    }
  }

  /** 本地立即改动: 本地先生效并立刻返回(不等待网络), 后台推送;
   *  失败不打断界面 — 先落盘本地, 后续心跳自动重试(以手机为主存储) */
  async commit(rec) {
    const prev = this.map.get(rec.id);
    this.map.set(rec.id, normalize(rec));
    this.onData(this.localAll());
    this.pushDirty().catch((e) => this._pushFail(e, prev ? new Map([[prev.id, prev]]) : null));
  }

  /** 批量本地改动(如课表多节): 一次本地更新 + 一次后台推送 */
  async commitMany(recs) {
    const prevs = new Map();
    for (const raw of recs) {
      const rec = normalize(raw);
      if (!prevs.has(rec.id)) prevs.set(rec.id, this.map.get(rec.id));
      this.map.set(rec.id, rec);
    }
    this.onData(this.localAll());
    this.pushDirty().catch((e) => this._pushFail(e, prevs));
  }

  /** 后台推送失败: 落盘本地防丢失, 回滚(服务器权威模式)或仅提示(手机本地主模式) */
  _pushFail(e, prevs) {
    if (e && e.status === 401) { this.onAuth(); return; }
    try { this._saveCache(); } catch { /* 忽略 */ }
    this.onPushFail(e, prevs);
  }

  async pushDirty() {
    // 一次性计算脏集合, 避免后续合并更新 lastSynced 导致新建记录漏推
    const dirty = this.todos().filter((t) => t.updatedAt > this.lastSynced);
    const dirtyP = this.periods().filter((p) => p.updatedAt > this.lastSynced);
    const jobs = [];
    if (dirty.length) {
      jobs.push(this._fetch(this.base + '/api/sync', {
        method: 'POST', headers: this._headers(true),
        body: JSON.stringify({ todos: dirty }),
      }).then((data) => this._applyMerge(data)));
    }
    if (dirtyP.length) {
      jobs.push(this._fetch(this.base + '/api/periods/sync', {
        method: 'POST', headers: this._headers(true),
        body: JSON.stringify({ periods: dirtyP }),
      }).then((pdata) => {
        if (pdata && Array.isArray(pdata.periods)) {
          const sigP = (p) => `${p.id}|${p.updatedAt}|${p.deleted}|${p.name}|${p.idleName}|${JSON.stringify(p.nodes || [])}|${p.freq}|${p.weekdays || []}|${p.colorSlot}`;
          let changed = false;
          for (const raw of pdata.periods) {
            const n = normalizePeriod(raw);
            const cur = this.periodMap.get(n.id);
            if (!cur || sigP(cur) !== sigP(n)) { this.periodMap.set(n.id, n); changed = true; }
          }
          this._saveCache();
          if (changed) this.onPeriods(this.localPeriods());
        }
      }));
    }
    await Promise.all(jobs); // 待办/时段并行推送, 减少等待
  }

  /** 本地时段改动: 记录 + 推送 */
  async commitPeriod(rec) {
    const prev = this.periodMap.get(rec.id);
    this.periodMap.set(rec.id, normalizePeriod(rec));
    this.onPeriods(this.localPeriods());
    try {
      await this.pushDirty();
    } catch (e) {
      if (e.status === 401) this.onAuth();
      else if (prev) { this.periodMap.set(prev.id, prev); this.onPeriods(this.localPeriods()); }
      throw e;
    }
  }

  /** 变更可能来自其他端(轮询兜底,保底 60s;WebSocket 断线自动重连) */
  start() {
    this.connectWs();
    setInterval(() => { this.heartbeat(); }, 60000);
  }

  async heartbeat() {
    // 一体包(本地服务): 不依赖系统网络状态; 远程服务器模式才检查 navigator.onLine
    if (!window.__NO_WS__ && navigator.onLine === false) { this.onState('offline'); return; }
    try {
      await this.pushDirty();
      this.onState('synced');
    } catch (e) {
      this.recordErr('hb ' + (e && e.message ? e.message : e));
      if (e && e.status === 401) { this.onState('auth'); this.onAuth(); }
      else this.onState('offline');
    }
  }

  /** 把最近一次同步失败原因记入 window.__errs(诊断弹窗可读) */
  recordErr(m) {
    try {
      window.__errs = window.__errs || [];
      const s = String(m).slice(0, 220);
      if (window.__errs[window.__errs.length - 1] !== s) window.__errs.push(s);
      if (window.__errs.length > 12) window.__errs.splice(0, window.__errs.length - 12);
    } catch { /* ignore */ }
  }

  connectWs() {
    if (window.__NO_WS__) return; // 内嵌一体包: 本地单窗口, 轮询心跳已足够, 不连 WebSocket
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch { return; }
    this.ws = ws;
    const onOpen = () => { this.wsRetry = 0; this.onState('synced'); };
    const onMsg = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'todos-changed' && Array.isArray(m.todos)) {
          this.applyDelta(m.todos);
        } else if (m.type === 'periods-changed' && Array.isArray(m.periods)) {
          this.applyPeriodDelta(m.periods);
        }
      } catch { /* ignore */ }
    };
    const onClose = () => {
      this.ws = null;
      this.onState('offline');
      const delay = Math.min(15000, 800 * 2 ** this.wsRetry++);
      setTimeout(() => { if (!this.ws) this.connectWs(); }, delay);
    };
    const onErr = () => { try { ws.close(); } catch { /* ignore */ } };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onErr);
  }
}
