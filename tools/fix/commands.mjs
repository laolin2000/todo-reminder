// ============================================================
// 待办提醒 · 修复工具 —— 动作实现
//   cmd_status  : 体检(只读)
//   cmd_archive : 已完成超 N 天 → 转入日志(不动重复机制)
// ============================================================
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import {
  log, bullet, title, fmtMs, nowStr, dayStr, hhmm, stampName,
  readJson, readJsonOr, writeJson, pruneTombstones,
  loadTodos, writeTodos, backupFile, summarize, isRepeatItem, ruleKey,
  health, findLivePort, portListenerPid, procInfo, isOurApp, waitPortFree, waitHealthy,
  startApp, stopApp, httpJson, sleep, electronExe,
} from './lib.mjs';

const DAY = 86400000;

// ------------------------------------------------------------
// ① 体检
// ------------------------------------------------------------
export async function cmdStatus(cfg) {
  const t0 = Date.now();
  title('① 连接状态');
  const live = await findLivePort(cfg);
  const pid = portListenerPid(cfg.port);
  if (live) {
    log(`  ✅ 桌面端在线 · 端口 ${live.port} · pid ${pid ?? '?'}`);
    bullet(`应用 ${live.data.app} 版本 ${live.data.version} · 记录 ${live.data.total} 条(有效 ${live.data.active})`);
    const info = procInfo(pid);
    if (info) bullet(`进程 ${info.name}`);
  } else {
    log(`  ❌ 桌面端不在线(端口 ${cfg.ports.join('/')} 均无响应)`);
    bullet('手机端 / 网页端 / AI 截图识别 / DSH 桥接 此时全部不可用');
    const dead = portListenerPid(cfg.port);
    if (dead) bullet(`注意: 端口 ${cfg.port} 被 pid ${dead} 占用, 但不是本应用的服务器`);
  }
  // 数据文件
  const arr = await loadTodos(cfg);
  const s = summarize(arr);
  title('② 数据');
  bullet(`文件 ${cfg.todosFile}`);
  const st = await fs.stat(cfg.todosFile).catch(() => null);
  if (st) bullet(`大小 ${(st.size / 1024).toFixed(1)} KB · 最后写入 ${nowStr(st.mtime)}`);
  bullet(`总记录 ${s.total} 条 = 有效 ${s.alive}(未完成 ${s.open} / 已完成 ${s.done}) + 墓碑 ${s.tombstones}`);
  bullet(`含重复机制 ${s.repeat} 条`);

  // AI 配置
  title('③ AI 解析配置');
  const ai = await readJsonOr(cfg.aiFile, null);
  if (!ai) {
    log('  ❌ 读不到 ai.json');
  } else {
    bullet(`模型 ${ai.model || '(未设置)'}`);
    bullet(`接口 ${ai.baseUrl || '(未设置)'}`);
    bullet(`密钥 ${ai.apiKey ? '已配置(' + String(ai.apiKey).length + ' 字符)' : '❌ 未配置'}`);
    const pt = String(ai.periodTable || '').split('\n').filter(Boolean);
    bullet(`节次表 ${pt.length} 条` + (pt.length ? ` · 第1节 ${String(pt[0]).replace(/\?1\?\s*/, '')}` : ''));
    if (ai.periodTableAt) bullet(`节次表版本 ${nowStr(ai.periodTableAt)}`);
    if (ai.courseFix) bullet(`纠错规则 ${ai.courseFix}`);
    if (live) {
      // 端到端: 服务端读到的配置是否与文件一致
      const r = await httpJson(`http://127.0.0.1:${live.port}/api/ai`, { timeout: 5000 });
      const c = r.json && r.json.config;
      if (c) {
        const same = c.model === ai.model && !!c.hasKey === !!ai.apiKey;
        log(same ? '  ✅ 服务端 AI 接口可用(与磁盘配置一致)' : '  ⚠ 服务端 AI 配置与磁盘不一致, 建议在设置页重新保存');
        bullet(`服务端: ${c.model} · hasKey=${c.hasKey}`);
      }
    } else {
      bullet('桌面端离线, 未做接口联通性测试');
    }
  }

  // 自启: 用户已明确不要自启, 这里只保留一句固定说明(开关那套已从工具中移除)
  title('④ 开机自启');
  log('  ⏸ 已按你的要求保持关闭(不写注册表、不常驻守护)');
  log('     代价: 电脑重启后需手动双击桌面「待办提醒」, 否则手机端与 AI 识别不可用');

  // 手机远程连接(应用内置隧道)
  title('⑤ 手机远程连接');
  try {
    const { remoteSummary } = await import('./remote.mjs');
    const rs = await remoteSummary(cfg, cfg.port);
    for (const line of rs.lines) log('  ' + line);
  } catch (e) {
    log('  –  未接入远程模块: ' + e.message);
  }

  title('⑥ 日志');
  const lf = logFiles(cfg);
  if (existsSync(lf.json)) {
    const j = await readJsonOr(lf.json, []);
    bullet(`完成日志 ${j.length} 条 · ${lf.json}`);
  } else {
    bullet('尚无完成日志(还没执行过归档)');
  }
  const st2 = await fs.stat(lf.md).catch(() => null);
  if (st2) bullet(`${path.basename(lf.md)} · ${(st2.size / 1024).toFixed(1)} KB · ${nowStr(st2.mtime)}`);
  // 说明: 本工具不再为每次运行写日志文件(那只是没必要的占用), 所以这里不再统计运行记录。

  log('');
  log(`体检耗时 ${Date.now() - t0} ms`);
  return { online: !!live, stats: s, ai: ai ? { model: ai.model, hasKey: !!ai.apiKey } : null };
}

// ------------------------------------------------------------
// ③ 归档: 已完成超 N 天 → 日志
// ------------------------------------------------------------
export function logFiles(cfg) {
  const dir = cfg.logDir;
  return {
    dir,
    json: path.join(dir, '完成日志.json'),
    md: path.join(dir, '任务完成日志.md'),
  };
}

/** 归档候选: 未删除 + status=done + 超过 N 天没动过。
 *  重复机制条目单独区分(默认不动, 避免破坏“未来 3 条”滚动窗口) */
export function pickArchive(arr, days, { includeRepeat = false } = {}) {
  const cutoff = Date.now() - days * DAY;
  const done = arr.filter((t) => !t.deleted && t.status === 'done');
  const stale = done.filter((t) => Number.isFinite(t.updatedAt) && t.updatedAt < cutoff);
  const picked = [];
  const skippedRepeat = [];
  const skippedFresh = done.filter((t) => Number.isFinite(t.updatedAt) && t.updatedAt >= cutoff);
  for (const t of stale) {
    if (isRepeatItem(t) && !includeRepeat) { skippedRepeat.push(t); continue; }
    picked.push(t);
  }
  return { cutoff, picked, skippedRepeat, skippedFresh };
}

/** 读全部日志记录(JSON) */
async function loadLogJson(cfg) {
  const j = await readJsonOr(logFiles(cfg).json, []);
  return Array.isArray(j) ? j : [];
}

/** 把归档条目写进日志(JSON 全量 + Markdown 追加) */
async function appendLog(cfg, picked) {
  const lf = logFiles(cfg);
  await fs.mkdir(lf.dir, { recursive: true });
  const archivedAt = Date.now();

  // —— JSON(机器可读, 含全部字段, 可追溯/可回灌) ——
  const old = await loadLogJson(cfg);
  const have = new Set(old.map((x) => x.id));
  const add = picked.filter((t) => !have.has(t.id))
    .map((t) => ({ ...t, archivedAt, finishAt: t.updatedAt }));
  const all = old.concat(add);
  await writeJson(lf.json, all);

  // —— Markdown(人看的) ——
  if (!existsSync(lf.md)) {
    await fs.writeFile(lf.md, [
      '# 任务完成日志',
      '',
      '> 由「待办提醒修复工具」自动维护。主界面只显示最近的事项, 更早的完成记录收在这里, 不再占用主界面。',
      '',
    ].join('\n'), 'utf8');
  }
  const lines = [];
  const byDay = new Map();
  for (const r of add) {
    const d = dayStr(r.updatedAt || archivedAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  for (const d of [...byDay.keys()].sort()) {
    lines.push('');
    lines.push(`## ${d}`);
    lines.push('');
    byDay.get(d).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const r of byDay.get(d)) {
      const bits = [];
      if (r.location) bits.push(`地点 ${r.location}`);
      if (Array.isArray(r.materials) && r.materials.length) bits.push(`材料 ${r.materials.join('、')}`);
      if (r.notes) bits.push(`备注 ${String(r.notes).replace(/\s+/g, ' ').trim()}`);
      const tag = isRepeatItem(r) ? ' (重复事项)' : '';
      lines.push(`- [x] ${hhmm(r.updatedAt)} **${r.title}**${tag}${bits.length ? ' — ' + bits.join(' · ') : ''}`);
    }
  }
  lines.push('');
  await fs.appendFile(lf.md, lines.join('\n'), 'utf8');
  return { jsonCount: all.length, added: add.length, json: lf.json, md: lf.md };
}

/**
 * 归档主流程:
 *  1) 确保桌面端已停(避免内存里的旧数据覆盖我们的改写)
 *  2) 备份 → 改写 → 校验
 *  3) 写日志
 *  4) 重新拉起桌面端并验证
 */
export async function cmdArchive(cfg, { apply = false, includeRepeat = false, days = null, restart = true } = {}) {
  const N = Number.isFinite(days) ? days : cfg.oldDoneDays;
  const arr = await loadTodos(cfg);
  const s0 = summarize(arr);
  const pick = pickArchive(arr, N, { includeRepeat });

  title(`归档候选(已完成超过 ${N} 天)`);
  log(`  当前: 有效 ${s0.alive} 条(未完成 ${s0.open} / 已完成 ${s0.done})`);
  log(`  待归档: ${pick.picked.length} 条`);
  log(`  保留: ${pick.skippedFresh.length} 条(最近 ${N} 天内完成的)`);
  if (pick.skippedRepeat.length) {
    log(`  跳过: ${pick.skippedRepeat.length} 条(属重复机制, 保护性保留 —— 删掉会破坏“未来 3 条”滚动窗口)`);
    const g = new Map();
    for (const t of pick.skippedRepeat) g.set(t.title, (g.get(t.title) || 0) + 1);
    bullet([...g.entries()].map(([k, v]) => `${k}×${v}`).join(' · '));
  }
  if (!pick.picked.length) { log('  没有可归档的条目。'); return { archived: 0 }; }

  // 按日期汇总
  const byDay = new Map();
  for (const t of pick.picked) byDay.set(dayStr(t.updatedAt), (byDay.get(dayStr(t.updatedAt)) || 0) + 1);
  log('');
  log('  按完成日期:');
  for (const d of [...byDay.keys()].sort()) bullet(`${d}  ${byDay.get(d)} 条`);
  const sample = pick.picked.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  log('');
  log(`  最近 10 条将被归档:`);
  for (const t of sample.slice(0, 10)) bullet(`${fmtMs(t.updatedAt)}  ${t.title}${t.location ? ' @' + t.location : ''}`);

  if (!apply) { log(''); log('  (预演模式, 未改动任何数据。加 --yes 才会真正执行)'); return { preview: pick.picked.length }; }

  // ---------- 执行 ----------
  log('');
  title('执行');

  // ⚠ 沙盒模式: 只改沙盒数据文件, 绝不停止/重启正在运行的真实桌面端
  const sandbox = !!(process.env.TODO_FIX_NO_RESTART || process.env.TODO_FIX_DATA_DIR);
  if (sandbox) log('  (沙盒模式: 不碰运行中的服务器, 只改沙盒数据文件)');

  // 1) 停桌面端
  const live = sandbox ? null : await findLivePort(cfg);
  let stoppedPid = null;
  if (live) {
    const pid = portListenerPid(live.port);
    if (!isOurApp(pid, cfg)) throw new Error(`端口 ${live.port} 的进程(pid ${pid})不是本应用, 拒绝停止。请手动处理。`);
    log(`  停止桌面端(pid ${pid})…`);
    stopApp(pid);
    stoppedPid = pid;
    const freed = await waitPortFree(live.port);
    log(freed ? `  ✅ 已停止, 端口已释放` : `  ⚠ 端口仍被占用, 继续但结果需核对`);
  } else {
    log('  桌面端本来就没在跑, 直接改文件');
  }
  // 若配置端口与实跑端口不同, 也要清理(沙盒模式跳过)
  if (!stoppedPid && !sandbox) {
    const pid = portListenerPid(cfg.port);
    if (pid && isOurApp(pid, cfg)) { stopApp(pid); await waitPortFree(cfg.port); log(`  已停止残留进程 pid ${pid}`); }
  }

  let restartNeeded = !sandbox;
  try {
    // 2) 备份
    const bak = await backupFile(cfg, cfg.todosFile, 'before-archive');
    log(`  ✅ 已备份 → ${bak}`);

    // 3) 停止后再读一次(确保拿到的是内存最后一次落盘的内容, 防止竞态)
    const fresh = await loadTodos(cfg);
    const freshDoneIds = new Set(pick.picked.map((t) => t.id));
    const archiveRecs = fresh.filter((t) => freshDoneIds.has(t.id));
    log(`  读取最新数据: 总 ${fresh.length} 条 → 归档 ${archiveRecs.length} 条`);

    // 4) 写日志(先写日志再动数据, 确保不丢)
    const lg = await appendLog(cfg, archiveRecs);
    log(`  ✅ 已写入日志: ${lg.md}`);
    bullet(`完成日志.json 累计 ${lg.jsonCount} 条`);

    // 5) 改写数据文件 —— 用**墓碑**而不是物理删除。
    //    原因(踩过): 同步是 LWW("最后写入者胜"), 而"记录 vs 什么都没有"这种情况下记录必胜。
    //    所以物理删掉的条目会被手机/其它设备上的旧副本原样推回来(实测 62 条全被复活)。
    //    墓碑带一个**当前时间戳**, 在 LWW 里一定赢过任何旧副本 → 跨设备才真的删得掉。
    const stampNow = Date.now();
    const next = fresh.map((t) => (freshDoneIds.has(t.id)
      ? { ...t, deleted: true, updatedAt: stampNow }
      : t));
    const tombstoned = next.filter((t) => freshDoneIds.has(t.id)).length;
    const pruned = pruneTombstones(next, cfg.tombstoneKeepDays);
    await writeTodos(cfg, pruned.todos);
    log(`  ✅ 已归档 ${tombstoned} 条(写成墓碑, 这样别的设备的旧副本不会再把它推回来)`);
    if (pruned.removed) bullet(`顺带清理了 ${pruned.removed} 条很旧的墓碑(保留最近 ${cfg.tombstoneKeepDays} 天)`);

    // 6) 校验
    const check = await loadTodos(cfg);
    const s1 = summarize(check);
    const stillAlive = check.filter((t) => freshDoneIds.has(t.id) && !t.deleted).length;
    log(`  ✅ 校验: 总记录 ${check.length} · 有效 ${s1.alive}(未完成 ${s1.open} / 已完成 ${s1.done})`);
    if (stillAlive) throw new Error('校验失败: 仍有 ' + stillAlive + ' 条处于"有效"状态');
    restartNeeded = restart;
  } finally {
    // 7) 重新拉起
    if (restartNeeded) {
      if (process.env.TODO_FIX_NO_RESTART) {
        log('  (沙盒模式: 跳过自动重启)');
      } else {
        try {
          const newPid = startApp(cfg, true);
          log(`  重新启动桌面端(pid ${newPid}, 隐藏窗口)…`);
          const h = await waitHealthy(cfg, cfg.port);
          if (h) log(`  ✅ 桌面端已恢复: ${h.app} ${h.version} · 记录 ${h.total} 条(有效 ${h.active})`);
          else log('  ⚠ 桌面端启动后健康检查超时, 请手动双击桌面快捷方式确认');
        } catch (e) {
          log('  ⚠ 自动重启失败: ' + e.message + ' —— 请手动双击「待办提醒」');
        }
      }
    }
  }

  // 汇总
  const after = summarize(await loadTodos(cfg));
  title('结果');
  log(`  有效记录 ${s0.alive} → ${after.alive} 条(减少 ${s0.alive - after.alive})`);
  log(`  未完成 ${s0.open} → ${after.open} 条(提醒不受影响)`);
  log(`  数据文件 ${((await fs.stat(cfg.todosFile)).size / 1024).toFixed(1)} KB`);
  return { archived: pick.picked.length, keep: after };
}
