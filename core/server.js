// ============================================================
// server.js — 待办同步服务器(HTTP API + WebSocket + 静态 Web UI)
// 认证: 本机(loopback)免令牌;远程请求需 X-Token 与 config 中令牌一致。
// ============================================================
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { TodoStore, PeriodStore } from './storage.js';
import * as Remote from './remote.mjs';

export const APP_NAME = '待办提醒';
export const APP_VERSION = '0.5.2';
export const DEFAULT_PORT = 8790;

export function isLoopback(remote) {
  if (!remote) return false;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** 生成或读取 dataDir/config.json 里的令牌 */
export async function loadConfig(dataDir, overrides = {}) {
  const file = path.join(dataDir, 'config.json');
  let cfg = { token: '', port: DEFAULT_PORT };
  try {
    cfg = { ...cfg, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (e) { /* ENOENT 首次运行 */ }
  if (!cfg.token) cfg.token = crypto.randomBytes(9).toString('base64url');
  if (Number.isInteger(overrides.port)) cfg.port = overrides.port;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ token: cfg.token, port: cfg.port }, null, 2), 'utf8');
  return cfg;
}

// ---------- AI 解析助手(截图→待办 / 截图→课表; OpenAI 兼容 /chat/completions) ----------
const AI_SYSTEM = [
  '你是“待办提醒”应用的截图解析助手。用户会发来一张截图,可能是: ①普通信息(聊天/通知/票证/公告/便签…)要提取一条待办; ②学校/单位的“课程表/课表”(通常是表格,含星期几、节次/钟点、课程名、教室)。',
  '先判断是哪一种。只输出一个 JSON 对象(不要 markdown、不要解释)。',
  '情况A 是课表时输出:',
  '{ "kind": "timetable", "mondayIso": "图中该周“周一”的日期, 格式 YYYY-MM-DD(例如图顶写着 第2周 2026-09-14/2026-09-20 → 填 2026-09-14; 没有日期信息则填 null)", "courses": [',
  '  { "name": "课程名(≤40字)", "day": 1到7(周一=1…周日=7), "startMin": 当天0点起分钟数(如8:00=480), "endMin": 结束分钟数(如9:40=580), "location": "地点, 没有则空串" }',
  '] }',
  '课表色块/格子里通常第一行是课程名、下一行是地点(如: 教101 / 文科楼B302 / 实验楼 / 机房 / 体育馆 / 操场)。请只把“课程名”填进 name,把地点(教室/楼栋/场所)单独填进 location;格子里的老师姓名、备注等杂讯不要混入 name 或 location。',
  '课程的“重要程度”由应用统一默认设为中,不要输出 importance。',
  '时间换算规则: 截图写了钟点(如 08:00-09:40)就直接换算分钟; 只写节次(如“第1-2节”)且无钟点参照时, 按国内常见默认: 第1节08:00、第2节10:00、第3节14:00、第4节15:40、第5节19:00, 每节课45分钟, 连续节次相加(如1-2节=08:00-09:45); 无法推断的课程跳过。每个课程都要有 day 与 startMin。',
  '情况B 不是课表时输出:',
  '{ "kind": "todo", "title": "简短标题(≤40字, 必填)", "notes": "补充说明或空串", "location": "地点或空串",',
  ' "materials": ["所需材料"], "durationMin": 数字或 null(分钟, 看不出就 null),',
  ' "importance": 0或1或2(null 表示不确定), "independent": true或false或null,',
  ' "repeat": "none|daily|weekly|monthly" 或 null(截图明确写了“每天/每周X/每月X号”才填, 否则 null),',
  ' "dueIso": "YYYY-MM-DDTHH:mm"(按用户所在本地时间, 必须能算出具体时刻; 截图里没有时间信息则为 null; 若写了“每周三 19:00”则 dueIso=下一次周三19:00 且 repeat=weekly; “每月15号”→下一次15号 且 repeat=monthly) }',
  '重要: 地点(场馆/教室/小区/医院等)一律进 location, 绝不写进 notes; “每周/每月/每天”这类重复规律进 repeat+dueIso, 也不许写进 notes; notes 只放无法结构化的补充文字(如携带物品之外的提醒、注意事项), 没有就留空串。',
].join('\n');

const AI_DETAIL_SYSTEM = [
  '你是“待办提醒”应用的“课程详情”解析助手。用户会发一张课程详情截图(可能是教学平台某门课的页面/老师发的通知/教材封面等)。',
  '提取与课程相关的: 任课老师、教材/资料、上课/作业要求、考试安排等, 输出一个JSON对象(不要markdown):',
  '{ "teacher": "任课老师名(无则空串)", "textbook": "教材或资料名(无则空串)", "location": "地点/教室(如截图有且需要修正则填, 否则空串)",',
  '  "materials": ["需要携带的物品/资料"], "notes": "其它说明(作业/要求/考试等, ≤300字, 无则空串)" }',
  '只提取截图里真实出现的信息, 不确定的字段填空串。',
].join('\n');

/** 专注课表识别(模式 timetable): 只输出课表 JSON */
const AI_TIMETABLE_SYSTEM = [
  '你是“待办提醒”应用的【课表识别】助手。用户发来的这张截图是学校/单位的课程表(通常含星期几、节次/钟点、课程名、教室)。',
  '只输出一个 JSON 对象(不要 markdown、不要解释):',
  '{ "kind": "timetable", "mondayIso": "图中该周“周一”的日期, YYYY-MM-DD(没有日期信息则填 null)", "courses": [',
  '  { "name": "课程名(≤40字)", "day": 1到7(周一=1…周日=7), "startMin": 当天0点起分钟数(如8:00=480), "endMin": 结束分钟数(如9:40=580), "location": "地点/教室, 没有则空串" }',
  '] }',
  '色块/格子里第一行通常是课程名、下一行是地点(教101/实验楼/机房/操场等)。只把课程名填进 name, 地点单独填进 location; 老师姓名与备注等杂讯不要混入。',
  '只按图中直接写明的钟点换算 startMin/endMin; 若只写“第X节/第X-Y节”, 则严格按提示里给出的本校节次时间对照表换算(没有对照表时按常见默认: 第1节08:00 起每节45分钟连续相加)。',
  '若截图不是课表或无法提取任何课程, 输出 { "kind": "timetable", "mondayIso": null, "courses": [] }。',
].join('\n');

/** 日常事项识别(模式 todo): 只输出普通待办 JSON */
const AI_TODO_SYSTEM = [
  '你是“待办提醒”应用的【日常事项识别】助手。用户会发一张普通信息截图(聊天/通知/票证/公告/便签/快递单…), 要提取“一条待办”。',
  '只输出一个 JSON 对象(不要 markdown、不要解释):',
  '{ "kind": "todo", "title": "简短标题(≤40字, 必填)", "notes": "补充说明或空串", "location": "地点或空串",',
  ' "materials": ["所需材料"], "durationMin": 数字或 null(分钟, 看不出就 null),',
  ' "importance": 0或1或2或null, "independent": true或false或null,',
  ' "repeat": "none|daily|weekly|monthly" 或 null(截图明确写“每天/每周X/每月X号”才填, 否则 null),',
  ' "dueIso": "YYYY-MM-DDTHH:mm"(按用户本地时间; “每周三 19:00”→下一次周三19:00且 repeat=weekly; “每月15号”→下一次15号且 repeat=monthly; 没有时间信息则 null) }',
  '重要: 地点(场馆/教室/医院/小区等)一律放 location, 绝不放进 notes; “每周/每月/每天”重复规律放 repeat+dueIso, 也绝不放进 notes; notes 只放无法结构化的补充说明, 没有就空串。',
  '即使截图像课表也忽略: 本模式只提取待办。',
].join('\n');

/** 节次对照表识别(模式 periodtable): 读“第X节 时间”清单 */
const AI_PERIODTABLE_SYSTEM = [
  '你是“待办提醒”应用的【节次对照表识别】助手。这张截图是一张“节次时间对照表”(每一行形如: 第1节 08:00-08:45, 或 第1-2节 08:00-09:20 等)。',
  '只输出一个 JSON 对象(不要 markdown):',
  '{ "kind": "periodTable", "rows": [ { "label": "第1节", "start": "08:00", "end": "08:45" }, ... ] }',
  '规则: 每一行一个条目; label 写“第X节”或“第X-Y节”; start/end 写 24 小时制 HH:mm; 连堂(如 08:00-09:35 属第1-2节)按图中一整行处理, 不要拆开。',
  '若截图不是节次对照表, 输出 { "kind": "periodTable", "rows": [] }。',
].join('\n');

/** OpenAI 兼容 chat 请求; 优先 global fetch, 退化 node:https */
async function aiChatJson({ baseUrl, model, apiKey, imageDataUrl, userText, system = AI_SYSTEM, timeoutMs = 60000 }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model,
    temperature: 0.2,
    max_tokens: 4000,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  let resp;
  if (typeof fetch === 'function') {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      resp = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
    } finally { clearTimeout(to); }
  } else {
    resp = await new Promise((resolve, reject) => {
      const lib = url.startsWith('https:') ? import('node:https') : import('node:http');
      lib.then((h) => {
        const req = h.request(url, { method: 'POST', headers, timeout: timeoutMs }, (r) => resolve(r));
        req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
        req.on('error', reject);
        req.write(body);
        req.end();
      }).catch(reject);
    });
  }
  const text = await resp.text();
  if (!resp.ok || resp.status >= 300) {
    throw new Error(`AI 接口返回 ${resp.status}: ${text.slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('AI 返回不是有效 JSON'); }
  const msg0 = data?.choices?.[0]?.message || {};
  // 部分模型会把正文放 reasoning_content(content 空)→ 兜底读取
  let content = msg0.content;
  if (!content && msg0.reasoning_content) content = msg0.reasoning_content;
  if (!content) throw new Error('AI 未返回内容');
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(content) || [null, content];
  const start = m[1].indexOf('{');
  const end = m[1].lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 未输出可解析 JSON');
  return JSON.parse(m[1].slice(start, end + 1));
}

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ name, address: a.address, tailscale: a.address.startsWith('100.') });
      }
    }
  }
  return out;
}

/**
 * 启动服务器(阻塞后可 close)。
 * @param {object} o { dataDir, webDir, dlDir, port, quiet }
 */
export async function startServer(o) {
  const { dataDir, webDir, dlDir } = o;
  await fs.mkdir(dlDir, { recursive: true });
  const cfg = await loadConfig(dataDir, { port: o.port });
  const store = new TodoStore(path.join(dataDir, 'todos.json'));
  await store.load();
  const periodStore = new PeriodStore(path.join(dataDir, 'periods.json'));
  await periodStore.load();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // ---------- 认证 ----------
  function authed(req, res, next) {
    if (isLoopback(req.socket.remoteAddress)) return next();
    const tok = req.headers['x-token'] || (req.method === 'GET' ? req.query?.token : undefined);
    if (tok === cfg.token) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  function wsAuthed(info) {
    if (isLoopback(info.socket.remoteAddress)) return true;
    const u = new URL(info.req.url, 'http://x');
    const tok = u.searchParams.get('token') || info.req.headers['x-token'];
    return tok === cfg.token;
  }

  // ---------- REST API ----------
  app.get('/api/health', (req, res) => {
    const all = store.all();
    res.json({ ok: true, app: APP_NAME, version: APP_VERSION, time: Date.now(),
      total: all.length, active: all.filter((t) => !t.deleted).length });
  });

  app.get('/api/todos', authed, (req, res) => {
    res.json({ todos: store.all(), serverTime: Date.now() });
  });

  // 客户端推送自己的改动 → 服务器 LWW 合并 → 返回权威全量
  // 顺带把「手机远程入口地址」带回去: 手机端(一体包)据此自动学习新地址 ——
  // 公网隧道每次重启都会换域名, 手机不可能预先知道, 只能由电脑端告诉它。
  app.post('/api/sync', authed, (req, res) => {
    const body = req.body || {};
    const { touched } = store.upsert(body.todos);
    const now = Date.now();
    broadcast({ type: 'todos-changed', todos: touched, at: now });
    res.json({
      todos: store.all(), serverTime: now, applied: touched.map((t) => t.id),
      remote: remoteHint(),
    });
  });

  // ---------- 时段库 ----------
  app.get('/api/periods', authed, (req, res) => {
    res.json({ periods: periodStore.all(), serverTime: Date.now() });
  });

  app.post('/api/periods/sync', authed, (req, res) => {
    const body = req.body || {};
    const { touched } = periodStore.upsert(body.periods);
    const now = Date.now();
    broadcast({ type: 'periods-changed', periods: touched, at: now });
    res.json({ periods: periodStore.all(), serverTime: now, applied: touched.map((p) => p.id) });
  });

  app.get('/api/export', authed, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="todos-backup.json"');
    res.json({
      app: APP_NAME, exportedAt: Date.now(), version: APP_VERSION,
      todos: store.all(), periods: periodStore.all(),
    });
  });

  // dl 目录内 APK 列表(设置页显示)
  app.get('/api/apk', authed, async (req, res) => {
    let files = [];
    try {
      files = (await fs.readdir(dlDir)).filter((f) => f.toLowerCase().endsWith('.apk'));
      const withSize = await Promise.all(files.map(async (f) => {
        try { const st = await fs.stat(path.join(dlDir, f)); return { name: f, size: st.size, url: '/dl/' + encodeURIComponent(f) }; }
        catch { return null; }
      }));
      res.json({ ok: true, files: withSize.filter(Boolean) });
    } catch (e) {
      res.json({ ok: true, files: [] });
    }
  });

  // 最新 APK 版本(一键更新用): 匹配 todo-reminder-vX.Y.Z.apk, 取版本最高
  app.get('/api/update', authed, async (req, res) => {
    try {
      const files = (await fs.readdir(dlDir)).filter((f) => /^todo-reminder-v\d+\.\d+\.\d+\.apk$/i.test(f));
      const best = files
        .map((f) => {
          const m = /v(\d+)\.(\d+)\.(\d+)/i.exec(f);
          return m ? { name: f, ver: [+m[1], +m[2], +m[3]], version: `${m[1]}.${m[2]}.${m[3]}` } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.ver[0] - a.ver[0] || b.ver[1] - a.ver[1] || b.ver[2] - a.ver[2])[0];
      res.json({
        ok: true,
        latest: best ? { version: best.version, name: best.name, url: '/dl/' + encodeURIComponent(best.name) } : null,
      });
    } catch {
      res.json({ ok: true, latest: null });
    }
  });

  // 最新「手机一体包」版本(手机 App 内一键更新用): 匹配 todo-reminder-phone-vX.Y.Z.apk
  // 优先读取发布时生成的 version.json(权威元数据: versionCode / sha256 / size),
  // 客户端据此用数字版本号判定 + 哈希校验, 不再依赖“解析下载包”这一不可靠闸门。
  app.get('/api/phone/update', authed, async (req, res) => {
    try {
      let meta = null;
      try {
        const raw = await fs.readFile(path.join(dlDir, 'version.json'), 'utf8');
        const j = JSON.parse(raw);
        if (j && typeof j.name === 'string' && typeof j.version === 'string') meta = j;
      } catch { /* 无 version.json → 回退文件名扫描 */ }
      if (meta) {
        // 校验清单与磁盘文件一致(文件缺失/大小不符 → 回退扫描)
        let ok = false;
        try {
          const st = await fs.stat(path.join(dlDir, meta.name));
          ok = !Number.isFinite(meta.size) || st.size === meta.size;
        } catch { ok = false; }
        if (ok) {
          return res.json({
            ok: true,
            latest: {
              version: meta.version,
              versionCode: Number.isFinite(meta.versionCode) ? meta.versionCode : null,
              name: meta.name,
              url: '/dl/' + encodeURIComponent(meta.name),
              sha256: typeof meta.sha256 === 'string' ? meta.sha256 : null,
              size: Number.isFinite(meta.size) ? meta.size : null,
            },
          });
        }
      }
      const files = (await fs.readdir(dlDir)).filter((f) => /^todo-reminder-phone-v\d+\.\d+\.\d+\.apk$/i.test(f));
      const best = files
        .map((f) => {
          const m = /v(\d+)\.(\d+)\.(\d+)/i.exec(f);
          return m ? { name: f, ver: [+m[1], +m[2], +m[3]], version: `${m[1]}.${m[2]}.${m[3]}` } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.ver[0] - a.ver[0] || b.ver[1] - a.ver[1] || b.ver[2] - a.ver[2])[0];
      res.json({
        ok: true,
        latest: best ? { version: best.version, name: best.name, url: '/dl/' + encodeURIComponent(best.name) } : null,
      });
    } catch {
      res.json({ ok: true, latest: null });
    }
  });

  // ---------- AI 截图建任务(设置 + 解析代理; 密钥只存本机) ----------
  const aiFile = path.join(dataDir, 'ai.json');
  let aiCfg = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash-vision-exp', apiKey: '', periodTable: '', courseFix: '' };
  try { aiCfg = { ...aiCfg, ...JSON.parse(await fs.readFile(aiFile, 'utf8')) }; } catch { /* 首次运行 */ }
  // 节次对照表版本号: 多端(手机/电脑)同步用, 只有“更新的一次输入”才允许覆盖
  if (!Number.isFinite(aiCfg.periodTableAt) || aiCfg.periodTableAt <= 0) {
    aiCfg.periodTableAt = (aiCfg.periodTable || '').trim() ? 1 : 0; // 老数据没有时间戳: 非空视为已存在
  }
  const saveAi = async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(aiFile, JSON.stringify({
      baseUrl: aiCfg.baseUrl, model: aiCfg.model, apiKey: aiCfg.apiKey,
      periodTable: aiCfg.periodTable || '', periodTableAt: aiCfg.periodTableAt || 0,
      courseFix: aiCfg.courseFix || '',
    }, null, 2), 'utf8');
  };
  const aiPublic = () => ({
    baseUrl: aiCfg.baseUrl, model: aiCfg.model, hasKey: !!aiCfg.apiKey,
    periodTable: aiCfg.periodTable || '', periodTableAt: aiCfg.periodTableAt || 0,
    courseFix: aiCfg.courseFix || '',
  });
  const normPt = (v) => String(v == null ? '' : v).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30).join('\n');

  /** 手机远程入口的提示信息(给一体包用: 让它知道该往哪连)。
   *  publicUrl 只在隧道真的就绪时给出, 避免把失效域名发给手机。 */
  const remoteHint = () => {
    try {
      const st = Remote.status();
      const pub = st.linkReady && st.base && !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(st.base) ? st.base : '';
      return {
        ok: true, running: !!st.running, publicUrl: pub, base: st.base || '',
        linkReady: !!st.linkReady, linkUrl: pub && st.linkUrl ? st.linkUrl : '',
      };
    } catch {
      return { ok: false, running: false, publicUrl: '', base: '', linkReady: false, linkUrl: '' };
    }
  };

  /**
   * 手机远程入口的只读状态 —— 让手机/浏览器里的设置页也能显示"当前入口是什么"。
   * 只读: 不暴露任何凭据(token 只给前 6 位做校验用), 真正起停入口只能在桌面端做。
   */
  app.get('/api/remote', authed, async (req, res) => {
    try {
      const st = Remote.status();
      res.json({
        ok: true,
        running: st.running,
        base: st.base || '',
        linkReady: !!st.linkReady,
        linkLocal: !!st.linkLocal,
        port: st.port,
        tunnelPid: st.tunnelPid || null,
        startedAt: st.startedAt || null,
      });
    } catch (e) {
      res.json({ ok: true, running: false, base: '', linkReady: false, error: e.message });
    }
  });

  app.get('/api/ai', authed, (req, res) => res.json({ ok: true, config: aiPublic() }));
  /**
   * 设置页保存: 只接受“明确提交”的字段。
   * periodTable 只有在同时带上 periodTableAt(版本号)时才写入 —— 避免页面里的
   * 旧缓存(或加载失败时的空值)把用户刚录入的节次表覆盖回旧内容。
   */
  const applyAiCfg = (b) => {
    if (typeof b.baseUrl === 'string' && /^https?:\/\//i.test(b.baseUrl)) aiCfg.baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
    if (typeof b.model === 'string' && b.model.trim()) aiCfg.model = b.model.trim();
    if (typeof b.apiKey === 'string') aiCfg.apiKey = b.apiKey.trim();
    if (typeof b.periodTable === 'string' && Number.isFinite(Number(b.periodTableAt))) {
      aiCfg.periodTable = normPt(b.periodTable);
      aiCfg.periodTableAt = Number(b.periodTableAt);
    }
    if (typeof b.courseFix === 'string') {
      aiCfg.courseFix = b.courseFix.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60).join('\n');
    }
  };

  app.put('/api/ai', authed, async (req, res) => {
    applyAiCfg(req.body || {});
    await saveAi();
    res.json({ ok: true, config: aiPublic() });
  });

  // 手机一体包内 WebView 对 PUT 不稳 → 统一也接受 POST(与 PUT 完全一致)
  app.post('/api/ai', authed, async (req, res) => {
    applyAiCfg(req.body || {});
    await saveAi();
    res.json({ ok: true, config: aiPublic() });
  });

  // ---------- 节次对照表: 独立存取 + 版本号(LWW), 永久保存在应用数据里 ----------
  app.get('/api/ai/periodtable', authed, (req, res) => {
    res.json({ ok: true, periodTable: aiCfg.periodTable || '', periodTableAt: aiCfg.periodTableAt || 0, serverTime: Date.now() });
  });

  /** 客户端带上本机版本号: 更新的赢; 相同则服务器版为准(幂等)。
   *  空内容默认拒绝写入(只能靠 clear:true 显式清空) —— 防止异常/空载荷把已录入的节次表清掉。 */
  app.post('/api/ai/periodtable', authed, async (req, res) => {
    const b = req.body || {};
    const at = Number(b.periodTableAt);
    const text = normPt(b.periodTable);
    let adopted = false;
    if (b.clear === true) {
      aiCfg.periodTable = '';
      aiCfg.periodTableAt = Number.isFinite(at) && at > 0 ? at : Date.now();
      await saveAi();
      adopted = true;
    } else if (!text) {
      return res.json({ ok: true, adopted: false, reason: 'empty-ignored',
        periodTable: aiCfg.periodTable || '', periodTableAt: aiCfg.periodTableAt || 0, serverTime: Date.now() });
    } else if (Number.isFinite(at) && at > 0 && at > (aiCfg.periodTableAt || 0)) {
      aiCfg.periodTable = text;
      aiCfg.periodTableAt = at;
      await saveAi();
      adopted = true;
    }
    res.json({ ok: true, adopted, periodTable: aiCfg.periodTable || '', periodTableAt: aiCfg.periodTableAt || 0, serverTime: Date.now() });
  });

  app.post('/api/ai/parse', authed, async (req, res) => {
    try {
      const b = req.body || {};
      if (!aiCfg.apiKey) {
        return res.status(400).json({ ok: false, error: '尚未填写 AI API Key: 设置 → 🤖 AI 建任务' });
      }
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(String(b.image || ''))) {
        return res.status(400).json({ ok: false, error: '缺少图片(需 dataURL 格式)' });
      }
      const nowText = new Date().toString();
      const periodRule = (aiCfg.periodTable || '').trim();
      const periodHint = periodRule
        ? `\n[本校节次时间对照表, 请优先按它把“第X节/第X-Y节”换算成钟点; 若图中直接写明钟点则以图中为准]\n${periodRule.slice(0, 800)}`
        : '\n[若课表只写“第X节/第X-Y节”且图中没有钟点: 默认按第1节 08:00 起、每节 45 分钟换算; 若与实际不符, 请到设置把学校节次时间表填入]';
      const mode = String(b.mode || 'auto'); // auto / timetable / todo / periodtable
      let system = AI_SYSTEM;
      let userText = `现在本地时间: ${nowText}。请分析这张截图: 是课程表就按课表输出 kind=timetable, 否则按普通待办输出 kind=todo。`;
      if (mode === 'timetable') {
        system = AI_TIMETABLE_SYSTEM;
        userText = `现在本地时间: ${nowText}。请按【课表识别】规则处理这张截图。${periodHint}`;
      } else if (mode === 'todo') {
        system = AI_TODO_SYSTEM;
        userText = `现在本地时间: ${nowText}。请按【日常事项识别】规则处理这张截图。`;
      } else if (mode === 'periodtable') {
        system = AI_PERIODTABLE_SYSTEM;
        userText = `现在本地时间: ${nowText}。请按【节次对照表识别】规则处理这张截图。`;
      }
      userText += String(b.hint || '');
      let raw;
      try {
        raw = await aiChatJson({
          baseUrl: aiCfg.baseUrl, model: aiCfg.model, apiKey: aiCfg.apiKey, imageDataUrl: b.image, userText, system,
        });
      } catch (e1) {
        const msg1 = String(e1?.message || e1);
        if (!/JSON|array element|unexpected|token|length/i.test(msg1)) throw e1; // 网络/接口错误不重试
        // 模型输出了不完整/非法 JSON → 重试一次, 强调“完整未截断”
        raw = await aiChatJson({
          baseUrl: aiCfg.baseUrl, model: aiCfg.model, apiKey: aiCfg.apiKey, imageDataUrl: b.image,
          userText: userText + '\n[上次输出不是完整的JSON, 请重新输出: 只输出一个完整的、未截断的JSON对象, 不要任何多余文字]',
          system,
        });
      }
      const s = (v) => (typeof v === 'string' ? v.trim() : '');
      const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

      // ---------- 节次对照表识别(periodtable): 识别结果 → 可编辑行, 供回写 aiCfg.periodTable ----------
      if (mode === 'periodtable') {
        const rowArr = Array.isArray(raw.rows) ? raw.rows : (Array.isArray(raw.items) ? raw.items : []);
        const lines = [];
        const rows = [];
        const seen = new Set();
        for (const r of rowArr) {
          const label = s(r.label || r.name || r.period);
          const tm = String(r.time || r.range || `${s(r.start)}-${s(r.end)}`);
          const mT = tm.match(/(\d{1,2}):(\d{2})\s*[-–—~至至]\s*(\d{1,2}):(\d{2})/) || tm.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
          if (!label || !mT) continue;
          const st = `${String(Number(mT[1])).padStart(2, '0')}:${mT[2]}`;
          const en = `${String(Number(mT[3])).padStart(2, '0')}:${mT[4]}`;
          const line = `${label} ${st}-${en}`;
          const key = st + '-' + en;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ label, start: st, end: en });
          lines.push(line);
        }
        if (!lines.length) return res.json({ ok: false, error: '未识别到节次行 — 请截一张清晰的“节次时间对照表”' });
        return res.json({ ok: true, fields: { kind: 'periodTable', lines, rows } });
      }

      // ---------- 课表模式(专注课表 / auto 走此分支; 日常模式跳过) ----------
      if (mode !== 'todo') {
      // ---------- 课表模式: 多门课程 → 归一化为 courses(每周重复时段) ----------
      const rawCourses = Array.isArray(raw.courses) ? raw.courses : (Array.isArray(raw.items) ? raw.items : []);
      const dayCn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
      const courses = [];
      for (const c of rawCourses) {
        const name = s(c.name || c.title || c.course).slice(0, 40);
        if (!name) continue;
        if (/日语/.test(name)) continue; // 用户要求: 现在及以后导入一律忽略日语课程
        let day = num(c.day);
        if ((day == null || day < 1 || day > 7) && typeof c.day === 'string' && /^[1-7]$/.test(c.day.trim())) {
          day = Number(c.day.trim());
        }
        if (day == null || day < 1 || day > 7) {
          day = 0;
          const dn = s(c.dayName || c.dayCn || '');
          for (const [k, v] of Object.entries(dayCn)) if (dn.includes(k)) { day = v; break; }
        }
        if (!day) continue; // 无法确定星期几 → 跳过
        const startMin = num(c.startMin);
        if (startMin == null || startMin < 0 || startMin > 1439) continue;
        let endMin = num(c.endMin);
        if (endMin == null || endMin <= startMin) endMin = Math.min(1439, startMin + 90);
        courses.push({
          name,
          day,
          startMin,
          endMin,
          env: s(c.location || c.room || c.env).slice(0, 60),
        });
      }
      if (raw.kind === 'timetable' || rawCourses.length > 0) {
        if (!courses.length) {
          return res.json({ ok: false, error: '识别为课表但没有提取到课程 — 试试更清晰的整周课表截图' });
        }
        for (const c of courses) c.location = c.env || ''; // 客户端统一读 location
        // 手动时间修正: 每行 “周X|课程名|HH:MM-HH:MM”, 命中则覆盖该节时间(节次表识别不可靠时的兜底)
        const fixDay = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7 };
        for (const ln of String(aiCfg.courseFix || '').split('\n')) {
          const t = ln.trim();
          const m2 = t.match(/^周([一二三四五六日])\s*[|｜,，、]\s*(.+?)\s*[|｜,，、]\s*(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})$/);
          if (!m2) continue;
          const day = fixDay[m2[1]];
          if (!day) continue;
          const sMin = Number(m2[3]) * 60 + Number(m2[4]);
          const eMin = Number(m2[5]) * 60 + Number(m2[6]);
          if (eMin <= sMin || eMin > 1440) continue;
          for (const c of courses) {
            if (c.day === day && c.name === m2[2].trim()) {
              c.startMin = sMin;
              c.endMin = eMin;
            }
          }
        }
        // 周日期: 周一日期(YYYY-MM-DD); 从图顶“第X周 2026-09-14/2026-09-20”读取
        let mondayIso = null;
        const isoCands = ['mondayIso', 'mondayDate', 'weekStart', 'dateRange', 'dateText', 'range']
          .map((k) => (typeof raw[k] === 'string' ? raw[k] : ''))
          .join(' ');
        const m = isoCands.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (m) {
          const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
          if (!Number.isNaN(dt.getTime())) {
            mondayIso = `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
          }
        }
        const fmtMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
        const dateOf = (iso, delta) => {
          const [y, mo, d] = iso.split('-').map(Number);
          const dt = new Date(Date.UTC(y, mo - 1, d + delta));
          return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
        };
        if (mondayIso) {
          for (const c of courses) {
            const date = dateOf(mondayIso, (c.day || 1) - 1);
            c.date = date;
            c.dueAt = new Date(`${date}T${fmtMin(c.startMin)}`).getTime(); // 本机时区具体时刻
            c.durationMin = c.endMin - c.startMin;
          }
        }
        return res.json({ ok: true, fields: { kind: 'timetable', mondayIso, courses } });
      }
        // 专注课表模式: 一个都提不出来就明确失败, 不再当作普通待办
        if (mode === 'timetable') {
          return res.json({ ok: false, error: '识别为课表但没有提取到课程 — 试试更清晰的整周课表截图' });
        }
      }

      // ---------- 普通待办模式 ----------
      const fields = {
        kind: 'todo',
        title: s(raw.title).slice(0, 120) || '截图待办',
        notes: s(raw.notes).slice(0, 2000),
        location: s(raw.location).slice(0, 120),
        materials: Array.isArray(raw.materials) ? raw.materials.map((x) => s(x)).filter(Boolean).slice(0, 20) : [],
        durationMin: Number.isFinite(raw.durationMin) && raw.durationMin > 0 ? Math.min(10080, Math.round(raw.durationMin)) : null,
        importance: [0, 1, 2].includes(raw.importance) ? raw.importance : null,
        independent: typeof raw.independent === 'boolean' ? raw.independent : null,
        repeat: ['daily', 'weekly', 'monthly'].includes(raw.repeat) ? raw.repeat : 'none',
        dueAt: null,
      };
      const iso = s(raw.dueIso);
      const ts = iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).getTime() : null;
      if (ts != null) fields.dueAt = ts;
      res.json({ ok: true, fields });
    } catch (e) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  });

  // ---------- 课程详情补全(课程模式第二步: 对已写入的课程, 用课程详情截图补老师/教材/资料) ----------
  app.post('/api/ai/detail', authed, async (req, res) => {
    try {
      const b = req.body || {};
      if (!aiCfg.apiKey) {
        return res.status(400).json({ ok: false, error: '尚未填写 AI API Key: 设置 → 🤖 AI 建任务' });
      }
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(String(b.image || ''))) {
        return res.status(400).json({ ok: false, error: '缺少图片(需 dataURL 格式)' });
      }
      const course = (typeof b.course === 'object' && b.course ? b.course : {});
      const userText = `现在本地时间: ${new Date().toString()}。这张截图是课程「${String(course.name || '')}」${course.date ? `(${course.date})` : ''}的详情/资料, 请按规则提取。`;
      let raw;
      try {
        raw = await aiChatJson({
          baseUrl: aiCfg.baseUrl, model: aiCfg.model, apiKey: aiCfg.apiKey, imageDataUrl: b.image, userText,
          system: AI_DETAIL_SYSTEM,
        });
      } catch (e1) {
        const m1 = String(e1?.message || e1);
        if (!/JSON|array element|unexpected|token|length/i.test(m1)) throw e1;
        raw = await aiChatJson({
          baseUrl: aiCfg.baseUrl, model: aiCfg.model, apiKey: aiCfg.apiKey, imageDataUrl: b.image,
          userText: userText + '\n[上次输出不是完整JSON, 请只输出一个完整未截断的JSON对象]',
          system: AI_DETAIL_SYSTEM,
        });
      }
      const s = (v) => (typeof v === 'string' ? v.trim() : '');
      const fields = {
        teacher: s(raw.teacher).slice(0, 60),
        textbook: s(raw.textbook).slice(0, 200),
        location: s(raw.location).slice(0, 120),
        materials: Array.isArray(raw.materials) ? raw.materials.map((x) => s(x)).filter(Boolean).slice(0, 12) : [],
        notes: s(raw.notes).slice(0, 600),
      };
      res.json({ ok: true, fields });
    } catch (e) {
      res.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
    }
  });

  app.post('/api/token/reset', authed, async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      return res.status(403).json({ ok: false, error: 'loopback-only' });
    }
    cfg.token = crypto.randomBytes(9).toString('base64url');
    await fs.writeFile(path.join(dataDir, 'config.json'),
      JSON.stringify({ token: cfg.token, port: cfg.port }, null, 2), 'utf8');
    res.json({ ok: true, token: cfg.token });
  });

  // 仅本机触发的优雅关停(测试/服务管理用;落盘后再退出)
  if (o.allowShutdown) {
    app.post('/api/__shutdown', (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ ok: false });
      res.json({ ok: true });
      setTimeout(() => { o.onShutdown?.().catch(() => process.exit(0)); }, 50);
    });
  }

  // ---------- 静态 ----------
  // 投递过来的 .html/.txt/.md 显式带 charset=utf-8: 否则浏览器按本地默认(GBK)猜, 中文会乱码
  app.use('/dl', express.static(dlDir, {
    index: false,
    setHeaders(res, filePath) {
      if (/\.(?:html?)$/i.test(filePath)) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      else if (/\.(?:txt|md|csv|json)$/i.test(filePath)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    },
  }));
  // 投递列表: APK 之外也列出电脑端投递过来的文稿/表格/压缩包(scripts/deliver.ps1),
  // 否则 PDF/DOCX 只能靠完整 URL 访问, 在手机上没法发现
  app.get('/dl', async (req, res) => {
    const DL_EXT = /\.(apk|txt|md|html?|pdf|docx|xlsx|pptx|csv|zip|png|jpe?g|webp|mp3|mp4)$/i;
    let entries = [];
    try {
      const names = (await fs.readdir(dlDir)).filter((f) => DL_EXT.test(f));
      entries = (await Promise.all(names.map(async (f) => {
        try { const st = await fs.stat(path.join(dlDir, f)); return { f, size: st.size, at: st.mtimeMs }; }
        catch { return null; }
      }))).filter(Boolean).sort((a, b) => b.at - a.at);
    } catch { /* ignore */ }
    const isApk = (f) => /\.apk$/i.test(f);
    const sizeKb = (n) => (n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
    const row = (e) => `<li style="margin:6px 0"><a href="/dl/${encodeURIComponent(e.f)}">${e.f}</a>`
      + ` <span style="color:#9ca3af;font-size:12px">${sizeKb(e.size)}</span></li>`;
    const apks = entries.filter((e) => isApk(e.f));
    const docs = entries.filter((e) => !isApk(e.f));
    res.type('html').send(`<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>待办提醒 · 下载</title>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#1f2937">
<h2>📦 下载中心</h2>
<h3 style="margin-bottom:4px">📄 电脑投递的文件</h3>
${docs.length ? '<ul style="padding-left:20px">' + docs.map(row).join('') + '</ul>'
    : '<p style="color:#6b7280">暂无。在电脑上运行 <code>TodoReminder\\scripts\\deliver.ps1 &lt;文件&gt;</code> 投递。</p>'}
<h3 style="margin-bottom:4px">📱 安卓 APK</h3>
${apks.length ? '<ul style="padding-left:20px">' + apks.map(row).join('') + '</ul>'
    : '<p style="color:#6b7280">APK 尚未生成。在电脑端项目目录运行 <code>scripts\\build-apk.ps1</code> 后,APK 会出现在这里。</p>'}
<p style="margin-top:28px"><a href="/">← 返回待办应用</a></p></body></html>`);
  });
  // 静态资源: HTML/JS/CSS 一律不缓存(带 ?v= 的资源本身也是新的),
  // 避免“升级后页面还在跑旧 app.js”这种极难排查的问题(手机 WebView 缓存尤其顽固)
  app.use(express.static(webDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (/\.(?:html|js|css|webmanifest)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  }));
  app.use((req, res) => res.status(404).type('text').send('404 Not Found'));

  // ---------- WebSocket ----------
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (!url.startsWith('/ws')) { socket.destroy(); return; }
    if (!wsAuthed({ socket, req })) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', at: Date.now() }));
      ws.on('close', () => clients.delete(ws));
    });
  });
  setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000).unref();

  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of clients) { if (ws.readyState === 1) try { ws.send(s); } catch { /* ignore */ } }
  }

  // 本机文件变化(如有)也广播 — 服务端是唯一写入口,监听 storage 事件
  store.on('change', (todos) => broadcast({ type: 'todos-changed', todos, at: Date.now() }));
  periodStore.on('change', (periods) => broadcast({ type: 'periods-changed', periods, at: Date.now() }));

  // 选端口: 指定 > 尝试占用则 +1(最多 20 次)
  let port = Number.isInteger(cfg.port) && cfg.port > 0 ? cfg.port : DEFAULT_PORT;
  let server = null;
  for (let i = 0; i < 20; i++) {
    try {
      server = await new Promise((resolve, reject) => {
        const s = httpServer.listen(port, '0.0.0.0');
        s.once('listening', () => resolve(s));
        s.once('error', reject);
      });
      break;
    } catch (e) {
      if (e.code === 'EADDRINUSE') { port += 1; continue; }
      throw e;
    }
  }
  if (!server) throw new Error('无法找到可用端口(8790+)');

  const api = {
    cfg, store, periodStore, port, token: cfg.token,
    close: async () => {
      clearInterval(); // noop 保护
      for (const ws of clients) { try { ws.close(); } catch { /* ignore */ } }
      await new Promise((r) => httpServer.close(r));
      await store.flushNow();
      await periodStore.flushNow();
    },
    broadcast,
  };
  if (!o.quiet) {
    const tsv = lanAddresses().filter((a) => a.tailscale);
    console.log(`\n📡 ${APP_NAME} 同步服务器已启动  http://127.0.0.1:${port}`);
    console.log(`   连接码(远程设备用): ${cfg.token}`);
    for (const a of lanAddresses()) {
      console.log(`   本机地址: http://${a.address}:${port}  (${a.name}${a.tailscale ? ' · Tailscale' : ''})`);
    }
    if (!tsv.length) console.log('   未检测到 Tailscale 地址 — 如需外网访问请先运行 tailscale up(见 README)');
    console.log('');
  }
  return api;
}
