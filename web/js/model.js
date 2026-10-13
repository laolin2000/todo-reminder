// ============================================================
// model.js — 浏览器端待办模型(与 core/storage.js 的 normalize 保持同构)
// 字段: 标题/备注/时间/重要程度/任务量/所需材料/所需时间/独立性/状态/提前提醒
// ============================================================
// 重要程度 5 档(0 轻微 → 4 特急); 旧版 0低/1中/2高 自动映射到 0/1/2, 语义不变
export const IMPORTANCE = [
  { v: 0, label: '轻微', color: '#7b8494', bg: '#eef1f6' },
  { v: 1, label: '一般', color: '#0e7490', bg: '#e6f7fb' },
  { v: 2, label: '重要', color: '#b0700f', bg: '#fdf1dd' },
  { v: 3, label: '紧急', color: '#d9761f', bg: '#fdeee0' },
  { v: 4, label: '特急', color: '#d33f49', bg: '#fde9ea' },
];
// 任务量 4 档(0 轻松 → 3 繁重); 不定时事项也会显示
export const EFFORT = [
  { v: 0, label: '轻松', color: '#0e7490', bg: '#e6f7fb' },
  { v: 1, label: '适中', color: '#8a94a6', bg: '#eef1f6' },
  { v: 2, label: '较重', color: '#b0700f', bg: '#fdf1dd' },
  { v: 3, label: '繁重', color: '#c2415a', bg: '#fde9ea' },
];
export const STATUS_LABEL = { todo: '待办', doing: '进行中', overdue: '已逾期', done: '已完成' };

// ---------- 「同一件事」查重(v1.0.64): 标题归一 + 相似度 ----------
/** 去掉 [xxx] 【xxx】 (xxx) 备注/教室等后缀, 便于「英语单词(第3单元)」与「英语单词」视为同一件事 */
export function titleCore(s) {
  return String(s == null ? '' : s)
    .replace(/[（(\[【][^）)\]】]{0,24}[）)\]】]/g, ' ') // 括号内的补充说明
    .replace(/\s+/g, ' ')
    .trim();
}
/** 归一化比较键: 去空白/标点/大小写差异(全角⇄半角) */
export function titleKey(s) {
  return titleCore(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .toLowerCase()
    .replace(/[\s\-_·、,，.。;；:：!！?？'"“”‘’()()\[\]【】<>《》/\\|~+*#@&^%$¥]/g, '');
}
/** 字符二元组 Jaccard 相似度(0..1); 短串按字符集合兜底 */
export function titleSim(a, b) {
  const x = titleKey(a), y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const set = new Set();
    if (s.length < 2) { set.add(s); return set; }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(x), B = grams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}
/** 两条待办是否为「同一件事」(只看标题与地点, 不看时间) */
export function sameTopic(a, b) {
  const ka = titleKey(a && a.title), kb = titleKey(b && b.title);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // 包含关系: 「英语单词」与「英语单词unit3」算同一件事(短串至少 3 字, 避免误判)
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 3 && long.includes(short)) return true;
  const sim = titleSim(a.title, b.title);
  if (sim >= 0.72) return true;
  // 地点相同(非空)时放宽阈值: 同一地点+相近标题视为同一件事
  const la = String((a && a.location) || '').trim().toLowerCase();
  const lb = String((b && b.location) || '').trim().toLowerCase();
  if (la && lb && la === lb && sim >= 0.5) return true;
  return false;
}
/** 两条待办的时间是否不同(空值 vs 有值 也算不同) */
export function timeChanged(a, b) {
  const x = a && a.dueAt ? Number(a.dueAt) : 0;
  const y = b && b.dueAt ? Number(b.dueAt) : 0;
  if (!x && !y) return false;
  if (!x || !y) return true;
  return Math.abs(x - y) > 60000; // 1 分钟内视为同一时刻
}

// ---------- 潜在重复「扫描」(v1.0.66): 名字不完全一样也要能看出来 ----------
const STOPWORDS = new Set(['今天', '明天', '后天', '上午', '下午', '晚上', '中午', '早上', '然后', '记得', '需要', '要去', '要去', '一下', '这个', '那个', '东西', '事情', '时间', '以及', '还有', '或者', '和', '的', '了', '去', '做', '要', '在', '把', '给', '与', '及', '还是']);

/** 归一化文本(全角→半角、去标点空白、小写) */
function normText(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[\s\-_·、,，.。;；:：!！?？'"“”‘’()()\[\]【】<>《》/\\|~+*#@&^%$¥]/g, '');
}

/** 完整关键词集合(不做“短词被长词包含就丢弃”的压缩) */
export function keywordsFull(s) {
  const t = String(s == null ? '' : s).toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z][a-z0-9]{2,}/g) || []) out.add(w);
  for (const seg of t.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        const w = seg.slice(i, i + n);
        if (!STOPWORDS.has(w)) out.add(w);
      }
    }
    if (seg.length >= 2) out.add(seg);
  }
  return [...out];
}

/** 中文/英文关键词(压缩版: 有「英语单词」就不再单列「英语」「单词」) */
export function keywords(s) {
  const arr = keywordsFull(s);
  return arr.filter((w) => !arr.some((o) => o !== w && o.includes(w)));
}

/** 单条待办的可比较文本(标题为主, 备注/地点/材料作补充) */
function searchBlob(t) {
  return [t && t.title, t && t.notes, t && t.location, ...((t && t.materials) || [])].filter(Boolean).join(' ');
}

/** 字符二元组 Jaccard(用于没有共同关键词时的兜底) */
function bigramJaccard(a, b) {
  const g = (s) => {
    const t = normText(s);
    const set = new Set();
    if (t.length < 2) { if (t) set.add(t); return set; }
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = g(a), B = g(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 判断两条待办是否「可能重复」, 返回可解释的理由。
 * 与 sameTopic 的区别: 这里允许“名字不一样但讲同一件事”, 只用于给用户过目(不自动删)。
 * @param {object} opt {df: Map<词, 出现次数>, total: 样本数} —— 用于抑制“大家都有”的高频词(如共同前缀)
 * @returns {{score:number, shared:string[], reasons:string[]}|null}
 */
export function overlap(a, b, opt = {}) {
  const ta = String((a && a.title) || '').trim();
  const tb = String((b && b.title) || '').trim();
  if (!ta || !tb) return null;
  const df = opt.df, total = Number(opt.total) || 0;
  /** 该词是否“够特别”: 出现在太多个事项里 → 视为前缀/通用词, 不算重复证据 */
  const commonMax = Math.max(2, Math.floor(total * 0.35));
  const commonWords = new Set();
  if (df && total >= 5) {
    for (const [w, n] of df) if (n > commonMax) commonWords.add(w);
  }
  const common = (w) => {
    if (!commonWords.size) return false;
    if (commonWords.has(w)) return true;
    // 2 字碎片(如长词「扫描测试」切出的「扫描测/描测试」)不算独立证据
    return w.length <= 2 && [...commonWords].some((c) => c.length > w.length && c.includes(w));
  };
  const ka = titleKey(ta), kb = titleKey(tb);
  const reasons = [];
  let score = 0;
  // ① 标题完全一致
  if (ka === kb) { score = 1; reasons.push('标题相同'); }
  // ② 包含关系(短标题被长标题完整包含即算: 「组会」⊂「课题组组会（时间调整）」)
  const [s1, l1] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (s1.length >= 2 && l1.includes(s1)) { score = Math.max(score, 0.9); reasons.push('标题互相包含'); }
  // ③ 关键词重叠(核心: 名字不同也能看出来是同一件事)
  //    用完整词集, 避免「组会」与「课题组组会」因短词被压缩而永远没有交集
  const kaArr = keywordsFull(ta), kbArr = keywordsFull(tb);
  const blobA = keywordsFull(searchBlob(a)), blobB = keywordsFull(searchBlob(b));
  const pick = (arr, other) => arr
    .filter((w) => other.includes(w))
    .filter((w) => !common(w))
    .sort((x, y) => y.length - x.length);
  const titleShared = pick(kaArr, kbArr);
  const blobShared = pick(blobA, blobB);
  const strong = titleShared.filter((w) => w.length >= 3);
  const weak = titleShared.filter((w) => w.length === 2);
  if (strong.length) {
    const longest = strong[0].length;
    // 共同的核心词越长/越多 → 越可能是同一件事
    let sc = strong.length >= 2 ? 0.9 : 0.72;
    if (longest >= 4) sc = Math.min(0.94, sc + 0.08);
    score = Math.max(score, sc);
    reasons.push('共同关键词: ' + strong.slice(0, 3).join('、'));
  } else if (weak.length >= 2) {
    // 只有 2 字词重合时给个低分(需要用户过目, 不会自动删)
    score = Math.max(score, 0.55);
    reasons.push('共同短词: ' + weak.slice(0, 3).join('、'));
  } else if (blobShared.length) {
    const strongB = blobShared.filter((w) => w.length >= 3).slice(0, 2);
    if (strongB.length) {
      score = Math.max(score, 0.6);
      reasons.push('备注/材料里出现相同内容: ' + strongB.join('、'));
    }
  }
  // ④ 相似度兜底(字面相近但切词没对上)
  if (score < 0.6) {
    const j = bigramJaccard(ta, tb);
    if (j >= 0.6) { score = Math.max(score, Math.min(0.8, j)); reasons.push('字面相似 ' + Math.round(j * 100) + '%'); }
  }
  // ⑤ 地点相同 → 加权(同一地点的相近事项更容易是同一件事)
  const la = String((a && a.location) || '').trim();
  const lb = String((b && b.location) || '').trim();
  if (la && lb && normText(la) === normText(lb)) {
    score = Math.min(1, score + 0.1);
    reasons.push('地点相同: ' + la);
  }
  if (!reasons.length || score < 0.5) return null;
  const sharedWords = strong.length ? strong : (weak.length ? weak : blobShared);
  return { score: Number(score.toFixed(2)), shared: sharedWords.slice(0, 4), reasons };
}

/** 统计每个关键词在所有事项里出现的次数(用于抑制高频前缀词)。
 *  必须用完整词集: 压缩版会把长词切出的 2 字碎片丢掉, 导致「扫描测/描测试」
 *  这类碎片统计不到词频、反而被当成"专属词"造成误判。 */
export function keywordDf(items) {
  const df = new Map();
  let total = 0;
  for (const t of items || []) {
    if (!t || t.deleted) continue;
    total++;
    for (const w of new Set(keywordsFull(searchBlob(t)))) df.set(w, (df.get(w) || 0) + 1);
  }
  return { df, total };
}

/** 扫描: 找出与 todo 可能重复的现有待办(按可能性排序)。
 *  有「重复机制」的事项(每天/每周/每月/每天目标)**不进候选列表** —— 它们不会被删,
 *  而是走 scanRepeatConflicts 单独以“提醒”形式呈现。
 *  opt = {min, skip} */
export function scanOverlaps(todo, pool, opt = {}) {
  const min = Number.isFinite(opt.min) ? opt.min : 0.5;
  const cand = [];
  for (const t of pool || []) {
    if (!t || t.deleted || (todo && t.id === todo.id)) continue;
    if (opt.skip && opt.skip(t)) continue;
    if (hasRepeatMechanism(t)) continue; // 重复机制: 不动
    cand.push(t);
  }
  const { df, total } = keywordDf(pool || []);
  const out = [];
  for (const t of cand) {
    const hit = overlap(todo, t, { df, total });
    if (hit && hit.score >= min) out.push({ todo: t, ...hit });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

/**
 * 与「重复机制」事项的相似度冲突(v1.0.68): 只提出、不删除。
 * 只有当相似度“极高”时才返回 —— 避免每天提醒都会撞上一堆东西。
 * @returns {Array<{key, kind, label, sample, next, items, score, reasons, shared, hl}>}
 */
export function scanRepeatConflicts(todo, pool, opt = {}) {
  const min = Number.isFinite(opt.min) ? opt.min : Number(opt.strongMin) || 0.82;
  const { df, total } = keywordDf(pool || []);
  const fams = new Map();
  for (const t of pool || []) {
    if (!t || t.deleted || (todo && t.id === todo.id)) continue;
    if (!hasRepeatMechanism(t)) continue;
    if (opt.skip && opt.skip(t)) continue; // 已完成/已逾期的不提醒
    const hit = overlap(todo, t, { df, total });
    if (!hit || hit.score < min) continue;
    const key = ruleKeyOf(t) || ('anon:' + t.id);
    const fam = fams.get(key) || { key, kind: repeatKind(t), items: [], best: null };
    fam.items.push(t);
    if (!fam.best || hit.score > fam.best.score) fam.best = { score: hit.score, reasons: hit.reasons, shared: hit.shared, todo: t };
    fams.set(key, fam);
  }
  const out = [];
  for (const fam of fams.values()) {
    const items = fam.items.slice().sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
    out.push({
      key: fam.key, kind: fam.kind, label: repeatKindLabel(fam.kind),
      sample: fam.best.todo.title, next: items[0],
      count: items.length, items,
      score: fam.best.score, reasons: fam.best.reasons, shared: fam.best.shared,
      hl: highlightParts(fam.best.todo.title || '', fam.best.shared || []),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 关键词高亮: 把命中词切成 普通/命中 片段(供 UI 用 <b> 标记) */
export function highlightParts(text, shared) {
  const src = String(text == null ? '' : text);
  const words = (shared || []).filter((w) => w && w.length >= 2).sort((a, b) => b.length - a.length);
  if (!words.length) return [{ t: src, hit: false }];
  const lower = src.toLowerCase();
  const marks = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0 && marks.length < 12) { marks.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
  }
  if (!marks.length) return [{ t: src, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  const parts = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) parts.push({ t: src.slice(at, s), hit: false });
    parts.push({ t: src.slice(s, e), hit: true });
    at = e;
  }
  if (at < src.length) parts.push({ t: src.slice(at), hit: false });
  return parts;
}

/** 是否属于“还在生效、值得比对”的待办(跳过已完成/已逾期/已结束) */
export function isScanCandidate(t) {
  if (!t || t.deleted) return false;
  if (t.status === 'done') return false;
  const title = String(t.title || '').trim();
  if (!title || title === '(已删除)') return false; // 历史遗留的占位记录
  const now = Date.now();
  if (t.dueAt && Number(t.dueAt) < now) return false; // 已逾期/时间已过
  return true;
}

// ---------- 「重复机制」保护(v1.0.68) ----------
/** 该待办的重复机制类型: 'daily' | 'weekly' | 'monthly' | ''(无) */
export function repeatKind(t) {
  if (!t) return '';
  const r = parseRule(t);
  if (r && r.r && r.r !== 'none') return r.r;
  if (t.repeat && t.repeat !== 'none') return t.repeat; // 旧式(未迁移)的重复记录
  return '';
}
/** 是否属于“有明确重复机制”的事项 —— 扫描时一律不动它, 只在相似度极高时提出来给人看 */
export function hasRepeatMechanism(t) {
  const k = repeatKind(t);
  if (!k) return false;
  if (k === 'daily' && t && t.goal === true) return true; // 「每天目标」
  return ['daily', 'weekly', 'monthly'].includes(k);
}
/** 重复机制的规则编号(同一串实例共用); 旧式无 rule 的用 标题+类型 兜底分组 */
export function ruleKeyOf(t) {
  const k = repeatKind(t);
  if (!k) return '';
  const r = parseRule(t);
  return r && r.id ? r.id : ('legacy:' + k + ':' + titleKey(t && t.title));
}
/** 重复机制的中文说明 */
export function repeatKindLabel(k) {
  if (k === 'daily') return '每天';
  if (k === 'weekly') return '每周';
  if (k === 'monthly') return '每月';
  return '';
}


export const REMIND_CHOICES = [
  { m: 0, label: '准时提醒' }, { m: 5, label: '提前 5 分钟' }, { m: 10, label: '提前 10 分钟' },
  { m: 15, label: '提前 15 分钟' }, { m: 30, label: '提前 30 分钟' }, { m: 60, label: '提前 1 小时' },
  { m: 120, label: '提前 2 小时' }, { m: 1440, label: '提前 1 天' }, { m: 2880, label: '提前 2 天' },
];

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
}

export function normalize(t) {
  const o = t || {};
  return {
    id: typeof o.id === 'string' && o.id ? o.id : uid(),
    title: typeof o.title === 'string' ? o.title : '',
    notes: typeof o.notes === 'string' ? o.notes : '',
    location: typeof o.location === 'string' ? o.location : '',
    dueAt: Number.isFinite(o.dueAt) && o.dueAt != null ? o.dueAt : null,
    importance: [0, 1, 2, 3, 4].includes(o.importance) ? o.importance : 1,
    effort: [0, 1, 2, 3].includes(o.effort) ? o.effort : 1, // 任务量 4 档, 旧数据默认 适中
    materials: Array.isArray(o.materials)
      ? o.materials.map((m) => String(m)).filter(Boolean)
      : typeof o.materials === 'string' && o.materials.trim()
        ? o.materials.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
        : [],
    durationMin: Number.isFinite(o.durationMin) && o.durationMin != null && o.durationMin >= 0 ? Math.round(o.durationMin) : null,
    slotId: typeof o.slotId === 'string' ? o.slotId : '',
    independent: typeof o.independent === 'boolean' ? o.independent : true,
    status: ['todo', 'doing', 'done'].includes(o.status) ? o.status : 'todo',
    remindBeforeMin: Number.isFinite(o.remindBeforeMin) && o.remindBeforeMin >= 0 ? Math.round(o.remindBeforeMin) : 15,
    repeat: ['none', 'daily', 'weekly', 'monthly'].includes(o.repeat) ? o.repeat : 'none',
    repeatWeekdays: Array.isArray(o.repeatWeekdays)
      ? [...new Set(o.repeatWeekdays.map((w) => Math.round(w)).filter((w) => w >= 1 && w <= 7))].sort((a, b) => a - b)
      : [],
    repeatMonthDays: Array.isArray(o.repeatMonthDays)
      ? [...new Set(o.repeatMonthDays.map((d) => Math.round(d)).filter((d) => d >= 1 && d <= 31))].sort((a, b) => a - b)
      : [],
    fuzzy: o.fuzzy === true,
    goal: o.goal === true, // 重要目标: 只规定截止时间(dueAt), 不规定何时进行
    // 重复规则实例化: rule 为该实例所属重复规则的 JSON(含规则id/类型/星期/日号),
    // 实例本身 repeat='none'(由规则窗口统一补条); 空串 = 普通任务或旧式重复记录
    rule: typeof o.rule === 'string' ? o.rule : '',
    createdAt: Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
    updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now(),
    deleted: o.deleted === true,
  };
}

export function fresh() {
  return normalize({
    title: '', dueAt: null, importance: 1, status: 'todo', independent: true,
    materials: [], durationMin: null, remindBeforeMin: 15, repeat: 'none', fuzzy: false,
    notes: '', location: '', slotId: '', goal: false,
  });
}

// ---------- 时段(自定义时段库) ----------
export const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];

// ---------- 重复触发(待办: 每天/每周/每月) ----------
/** 下一次发生时刻: 严格晚于 afterMs 的最近一次;
 *  daily +1天; weekly = 所选 repeatWeekdays 中最近的一天(缺省=锚点星期);
 *  monthly = 所选 repeatMonthDays 中最近的一天(缺省=锚点几号, 短月取月末); 非重复返回 null */
export function nextOccurrenceMs(t, afterMs) {
  const due = t && t.dueAt;
  const rep = t && t.repeat;
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
  // monthly
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

/** 卡片上的重复标记, 如: 每天 / 每周一三五 / 每月1、15日 */
export function repeatLabel(t) {
  if (!t || !t.dueAt || !t.repeat || t.repeat === 'none') return '';
  const d = new Date(t.dueAt);
  if (t.repeat === 'daily') return '每天';
  if (t.repeat === 'weekly') {
    const set = (t.repeatWeekdays && t.repeatWeekdays.length) ? t.repeatWeekdays : [((d.getDay() + 6) % 7) + 1];
    return `每周${set.map((w) => WEEK_CN[w - 1]).join('、')}`;
  }
  const set = (t.repeatMonthDays && t.repeatMonthDays.length) ? t.repeatMonthDays : [d.getDate()];
  const label = set.slice(0, 6).map((x) => `${x}日`).join('、');
  return `每月${label}${set.length > 6 ? `等${set.length}天` : ''}`;
}

// ---------- 重复规则实例化(v1.0.53): 同一规则展开 3 条实例滚动窗口 ----------
/** 解析实例携带的规则 JSON(无则 null) */
export function parseRule(t) {
  if (!t || !t.rule) return null;
  try {
    const r = JSON.parse(t.rule);
    if (r && typeof r.id === 'string') return r;
  } catch (e) { /* 忽略损坏规则 */ }
  return null;
}
/** 是否重复规则实例(含规则头) */
export function isInstance(t) { return !!parseRule(t); }
/** 新建规则描述(含独立规则 id, 便于多规则同内容并存) */
export function makeRule(repeat, repeatWeekdays, repeatMonthDays, instanceDueAt) {
  const d = new Date(instanceDueAt);
  return JSON.stringify({
    id: 'ru-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    r: repeat, wd: Array.isArray(repeatWeekdays) ? repeatWeekdays : [],
    md: Array.isArray(repeatMonthDays) ? repeatMonthDays : [],
    hm: d.getHours() * 60 + d.getMinutes(),
  });
}
/** 实例/旧式记录共用的重复标签(实例读 rule, 旧式读自身字段) */
export function repLabel(t) {
  const r = parseRule(t);
  if (!r) return repeatLabel(t);
  const d = new Date(t.dueAt);
  if (r.r === 'daily') return '每天';
  if (r.r === 'weekly') {
    const wd = (r.wd && r.wd.length) ? r.wd : [((d.getDay() + 6) % 7) + 1];
    return `每周${wd.map((w) => WEEK_CN[w - 1]).join('、')}`;
  }
  const md = (r.md && r.md.length) ? r.md : [d.getDate()];
  return `每月${md.slice(0, 6).map((x) => `${x}日`).join('、')}${md.length > 6 ? `等${md.length}天` : ''}`;
}
/** 规则在 afterMs 之后的最近一次触发(以该实例的日期时刻为锚) */
export function ruleNextMs(inst, afterMs) {
  const r = parseRule(inst);
  if (!r || !inst || !inst.dueAt || !Number.isFinite(afterMs)) return null;
  return nextOccurrenceMs({
    dueAt: inst.dueAt,
    repeat: r.r,
    repeatWeekdays: r.wd || [],
    repeatMonthDays: r.md || [],
  }, afterMs);
}

export function freshPeriod() {
  return normalizePeriod({
    name: '', startMin: 9 * 60, endMin: 11 * 60, env: '', priority: 1, remindBeforeMin: 10,
    freq: 'daily', weekdays: [], startMD: null, endMD: null,
  });
}

export function normalizePeriod(p) {
  const o = p || {};
  const clampMin = (v) => (Number.isFinite(v) ? Math.min(1440, Math.max(0, Math.round(v))) : null);
  const md = (v) => (Number.isFinite(v) && v >= 101 && v <= 1231 ? Math.round(v) : null);
  const weekdays = Array.isArray(o.weekdays)
    ? [...new Set(o.weekdays.map((w) => Math.round(w)).filter((w) => [1, 2, 3, 4, 5, 6, 7].includes(w)))].sort((a, b) => a - b)
    : [];
  // 多节点: 每段 {startMin,endMin}; endMin<startMin 表示跨午夜; 兼容旧数据(单 startMin/endMin)
  const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
  let nodes = rawNodes
    .map((n) => ({ startMin: clampMin(n && n.startMin), endMin: clampMin(n && n.endMin) }))
    .filter((n) => n.startMin != null && n.endMin != null && n.startMin !== n.endMin)
    .sort((a, b) => a.startMin - b.startMin);
  const legacyStart = clampMin(o.startMin);
  const legacyEnd = clampMin(o.endMin);
  if (!nodes.length && legacyStart != null && legacyEnd != null && legacyStart !== legacyEnd) {
    nodes = [{ startMin: legacyStart, endMin: legacyEnd }];
  }
  const primary = nodes[0] || { startMin: null, endMin: null };
  return {
    id: typeof o.id === 'string' && o.id ? o.id : uid(),
    name: typeof o.name === 'string' ? o.name : '',
    idleName: typeof o.idleName === 'string' ? o.idleName : '',
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
    createdAt: Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
    updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now(),
    deleted: o.deleted === true,
  };
}

/** 该时段在 0..1440 分钟轴上当天的显示段(跨午夜拆两段) */
export function periodDaySegments(p) {
  const segs = [];
  for (const n of p?.nodes || []) {
    if (n.startMin == null || n.endMin == null) continue;
    if (n.endMin < n.startMin) {
      if (n.startMin < 1440) segs.push({ startMin: n.startMin, endMin: 1440 });
      if (n.endMin > 0) segs.push({ startMin: 0, endMin: n.endMin });
    } else if (n.endMin > n.startMin) {
      segs.push({ startMin: n.startMin, endMin: n.endMin });
    }
  }
  return segs;
}

/** 某分钟(0..1439)是否在激活范围(跨午夜自动判定) */
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

/** 当前是否激活 → 激活用 name, 否则用 idleName(为空沿用 name) */
export function periodDisplayName(p, now = new Date()) {
  const m = now.getHours() * 60 + now.getMinutes();
  if (periodActiveAt(p, m)) return p && p.name ? p.name : '';
  return (p && p.idleName) || (p && p.name) || '';
}

/** 该时段“重复”是否命中某一天(提醒触发 + 轨迹泳道显示) */
export function periodActiveOnDay(p, jsDate = new Date()) {
  if (!p) return false;
  if (p.freq === 'weekly') {
    const jsDay = jsDate.getDay(); // 0=周日
    return (p.weekdays || []).includes(jsDay === 0 ? 7 : jsDay);
  }
  if (p.freq === 'monthly') {
    return p.monthDay == null || jsDate.getDate() === p.monthDay; // 每月第 monthDay 日; 当月无此日则跳过
  }
  if (p.freq === 'yearly') {
    if (p.startMD == null || p.endMD == null) return true;
    const md = (jsDate.getMonth() + 1) * 100 + jsDate.getDate();
    return p.startMD <= p.endMD
      ? md >= p.startMD && md <= p.endMD
      : md >= p.startMD || md <= p.endMD;
  }
  return true; // daily
}

export function fmtMD(md) {
  if (md == null) return '';
  return `${Math.floor(md / 100)}月${md % 100}日`;
}

/** 时段重复的中文摘要, 如: 每天 / 每周一·三·五 / 每月15日 / 每年6月1日–6月30日 */
export function periodFreqLabel(p) {
  if (!p || p.freq === 'daily') return '每天';
  if (p.freq === 'weekly') {
    const ws = (p.weekdays || []).map((w) => `周${WEEK_CN[w - 1]}`).join('·');
    return ws ? `每周${ws}` : '每周';
  }
  if (p.freq === 'monthly') return p.monthDay ? `每月${p.monthDay}日` : '每月';
  const s = fmtMD(p.startMD), e = fmtMD(p.endMD);
  if (!s) return '每年';
  if (!e || e === s) return `每年${s}`;
  return `每年${s}–${e}`;
}

export function fmtMin(min) {
  if (min == null) return '--:--';
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------- 时段配色板 ----------
// 设计要点(参考配色设计文章):
//  色相数量少而克制、每优先组使用各自色相区、全板统一明度/饱和度 → 协调感;
//  低饱和柔色 → 视觉不抢内容; 深浅主题下浅底深字均清晰。
// 色板 9 槽: 槽 0-2 高优先(玫红/珊瑚/杏, 暖), 3-5 中(薄荷/青/湖蓝), 6-8 低(雾蓝/藕紫/灰紫)。
// 槽位分配持久化在 colorSlot; 删除时段即释放槽位(墓碑不计占用), 新时段自动复用。
export const SLOT_HUES = {
  2: [350, 18, 42],   // 高: 玫红 / 珊瑚 / 杏
  1: [152, 174, 196], // 中: 薄荷 / 青 / 湖蓝
  0: [222, 250, 268], // 低: 雾蓝 / 藕紫 / 灰紫
};
export const SLOT_GROUP_START = { 2: 0, 1: 3, 0: 6 };
export const NONE_SLOT_COLOR = { base: '#c6cdd9', soft: '#f0f2f6', deep: '#87909f', t6: 'rgba(134,143,158,0.06)', t12: 'rgba(134,143,158,0.12)', t22: 'rgba(134,143,158,0.22)' };

const hslHex = (h, s, l) => {
  const S = s / 100, L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
};

/** hex → rgba 字符串(用于把时段色透明叠到任何主题背景上) */
export function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 'rgba(120,130,150,' + a + ')';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 槽位 → { base(方块/主色, 柔), soft(更浅底), deep(左条/标签, 同色深), t6/t12/t22(透明叠色) } */
export function slotColor(i) {
  const g = i < 3 ? 2 : i < 6 ? 1 : 0;
  const h = SLOT_HUES[g][i % 3];
  const base = hslHex(h, 60, 76);
  return {
    base,
    soft: hslHex(h, 62, 90),
    deep: hslHex(h, 64, 47),
    hue: h,
    t6: hexA(base, 0.06),
    t12: hexA(base, 0.12),
    t22: hexA(base, 0.22),
  };
}

/** 某时段应使用的颜色(未分配→所属优先组第一个空槽的色) */
export function periodColor(p, occupiedSlots = []) {
  if (p && Number.isFinite(p.colorSlot)) return slotColor(p.colorSlot);
  const start = SLOT_GROUP_START[p?.priority ?? 1] ?? 3;
  for (let i = start; i < start + 3; i++) {
    if (!occupiedSlots.includes(i)) return slotColor(i);
  }
  return slotColor(start);
}

/** 构造新的本地记录(使用校正后的时间戳) */
export function stamp(rec, skewMs = 0) {
  rec.updatedAt = Date.now() + skewMs;
  return rec;
}

// ---------- 展示辅助 ----------
export const imp = (v) => IMPORTANCE[v] || IMPORTANCE[1];
export const effort = (v) => EFFORT[v] || EFFORT[1];

export function fmtDue(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  const tm = new Date(now.getTime() + 86400e3);
  if (sameDay(d, tm)) return `明天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function countdown(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = ts - now;
  if (diff <= 0) {
    const over = Math.round(-diff / 60000);
    if (over < 60) return `已逾期 ${over} 分钟`;
    return `已逾期 ${(over / 60).toFixed(1)} 小时`;
  }
  const min = Math.round(diff / 60000);
  if (min < 60) return `剩 ${min} 分钟`;
  if (min < 1440) return `剩 ${(min / 60).toFixed(min < 600 ? 0 : 1)} 小时`;
  return `剩 ${(min / 1440).toFixed(1)} 天`;
}

// ---------- 生命周期状态(与 Android util/Fmt.kt 保持一致) ----------
// 规则: 已完成优先;开始时间未到→待办;已到开始、未到“开始+所需时长”→进行中;
// 过了结束时刻(无时长=开始即结束, 与旧版一致)→已逾期。手动“进行中”标记仅在开始前保留。
export function endAt(t) {
  if (!t || t.dueAt == null) return null;
  const dur = Number.isFinite(t.durationMin) && t.durationMin > 0 ? t.durationMin : 0;
  return t.dueAt + dur * 60000;
}

export function lifeStatus(t, now = Date.now()) {
  if (!t || t.status === 'done') return 'done';
  if (t.status === 'doing') return 'doing'; // 手动“进行中”优先(逾期事项可改回进行中)
  if (t.dueAt == null) return 'todo';
  const end = endAt(t) || t.dueAt;
  if (now < t.dueAt) return 'todo';
  if (now < end) return 'doing';
  return 'overdue';
}

function cnDur(ms) {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (min < 60) return `${min} 分钟`;
  if (min < 1440) {
    const h = min / 60;
    return `${h % 1 === 0 ? h : h.toFixed(1)} 小时`;
  }
  return `${(min / 1440).toFixed(1)} 天`;
}

/** 卡片上的时间倒计时文案: 开始前“剩 X” / 进行中“剩 X(到结束)” / 逾期“已逾期 X” */
export function lifeText(t, now = Date.now()) {
  if (!t || t.status === 'done' || t.dueAt == null) return '';
  const end = endAt(t) || t.dueAt;
  if (now < t.dueAt) return `剩 ${cnDur(t.dueAt - now)}`;
  if (now < end) return `剩 ${cnDur(end - now)}`;
  return `已逾期 ${cnDur(now - end)}`;
}

export function fmtDuration(min) {
  if (min == null) return '';
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  return h % 1 === 0 ? `${h} 小时` : `${Math.floor(h)} 小时 ${min % 60} 分钟`;
}

/** 日期分组桶: overdue/today/tomorrow/week/later/none */
export function dateBucket(ts, now = new Date()) {
  if (!ts) return 'none';
  const d = new Date(ts);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 86400e3);
  if (day < 0) return 'overdue';
  if (day === 0) return 'today';
  if (day === 1) return 'tomorrow';
  if (day < 7) return 'week';
  return 'later';
}

export const BUCKET_LABEL = {
  overdue: '⏰ 已逾期', none: '⌛ 不定时', today: '🗓 今天', tomorrow: '🌅 明天',
  week: '📅 7 天内', later: '📆 更晚',
};
