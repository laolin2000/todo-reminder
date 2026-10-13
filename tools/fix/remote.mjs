// ============================================================
// 待办提醒 · 修复工具 —— 连接修复
// 应用内置的远程访问(core/remote.mjs)是唯一实现, 这里只做:
//   · 逐环节诊断(与应用设置页里「连接诊断」同一份判断)
//   · 一键修复(清孤儿 → 重启入口 → 复诊)
//   · 开 / 关 / 看链接
//   · 与修复工具的体检合并输出
// ============================================================
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { log, bullet, title, fmtMs, nowStr } from './lib.mjs';

/** 动态加载 core/remote.mjs(两处共用同一份实现, 不复制逻辑) */
export async function loadRemote(cfg) {
  const p = path.join(cfg.coreDir, 'remote.mjs');
  try {
    const mod = await import(pathToFileURL(p).href);
    mod.setLogger(() => {});   // 工具里不需要冗余日志
    return mod;
  } catch (e) {
    return { __error: `无法加载远程模块 ${p}: ${e.message}` };
  }
}

// ------------------------------------------------------------
// 诊断
// ------------------------------------------------------------
export async function cmdRemoteCheck(cfg, { appPort } = {}) {
  const M = await loadRemote(cfg);
  title('远程连接(手机入口)诊断');
  if (M.__error) { log('  ❌ ' + M.__error); return { ok: false }; }
  const up = appPort || cfg.port;

  const r = await M.check({ upstreamPort: up });
  for (const s of r.steps) {
    log(`  ${s.ok ? '✅' : '❌'} ${s.name}  —  ${s.detail}`);
    if (!s.ok && s.fix) bullet('修法: ' + s.fix);
  }
  const st = r.status || {};
  log('');
  log(`  入口地址: ${st.base || '(无)'}`);
  if (st.linkUrl) log(`  手机链接: ${st.linkUrl}`);
  if (st.linkCreatedAt) bullet(`链接创建于 ${fmtMs(Date.parse(st.linkCreatedAt))}`);
  if (st.tunnelPid) bullet(`隧道进程 pid ${st.tunnelPid} · 已重启 ${st.tunnelRestarts} 次`);
  if (st.lastError) bullet('最近错误: ' + st.lastError);
  log('');
  log(r.ok ? '  ✅ 远程连接全部正常 —— 手机可以在任何网络下打开上面的链接。'
           : '  ⚠ 有环节未通过 —— 可以试「连接修复」(本菜单 a 项)。');
  return r;
}

// ------------------------------------------------------------
// 修复
// ------------------------------------------------------------
export async function cmdRemoteRepair(cfg, { appPort, apply = false } = {}) {
  const M = await loadRemote(cfg);
  title('远程连接修复');
  if (M.__error) { log('  ❌ ' + M.__error); return { ok: false }; }
  const up = appPort || cfg.port;

  const before = await M.check({ upstreamPort: up });
  log(`  修复前: ${before.ok ? '本来就好' : '有 ' + before.steps.filter((s) => !s.ok).length + ' 个环节未通过'}`);
  for (const s of before.steps.filter((x) => !x.ok)) bullet(`✗ ${s.name}: ${s.detail}`);

  if (!apply) {
    log('');
    log('  (预演模式: 未做任何改动。加 --yes 才会真正执行修复)');
    return { preview: true, ok: before.ok };
  }

  log('');
  log('  开始修复(会重启入口服务, 电脑端界面不受影响)……');
  const r = await M.repair({
    upstreamPort: up,
    onProgress: (p) => bullet(p),
  });
  log('');
  if (r.actions && r.actions.length) {
    log('  执行的动作:');
    for (const a of r.actions) bullet(a);
  }
  log('');
  for (const s of (r.after && r.after.steps) || []) {
    log(`  ${s.ok ? '✅' : '❌'} ${s.name}  —  ${s.detail}`);
  }
  const st = (r.after && r.after.status) || {};
  if (st.linkUrl) { log(''); log('  手机链接: ' + st.linkUrl); }
  log('');
  log(r.ok ? '  ✅ 修复完成 —— 手机现在应该能连上了。' : '  ⚠ 仍有环节未通过, 见上面的清单。');
  return r;
}

// ------------------------------------------------------------
// 开关 / 看链接
// ------------------------------------------------------------
export async function cmdRemoteUp(cfg, { appPort, waitMs = 150000 } = {}) {
  const M = await loadRemote(cfg);
  title('开启远程访问');
  if (M.__error) { log('  ❌ ' + M.__error); return { ok: false }; }
  const r = await M.start({
    upstreamPort: appPort || cfg.port,
    waitMs,
    onProgress: (p) => bullet(p),
  });
  if (r.ok) {
    log('');
    log('  ✅ 已就绪');
    log('  手机链接: ' + (r.linkUrl || r.base));
    log('  (手机第一次打开后会自动记住这台设备, 之后只打开域名即可)');
  } else {
    log('');
    log('  ❌ 未就绪: ' + (r.error || '未知原因'));
    log('  提示: 电脑端「待办提醒」本身没在运行的话, 隧道会拿到 502 —— 先启动应用。');
  }
  return r;
}

export async function cmdRemoteDown(cfg) {
  const M = await loadRemote(cfg);
  title('关闭远程访问');
  if (M.__error) { log('  ❌ ' + M.__error); return { ok: false }; }
  const rep = await M.stop();
  log('  停隧道: ' + (rep.intentCleared ? '已关掉保活意图' : '跳过') + ' · 隧道进程 ' + (rep.tunnelStopped ? '已停' : '未在跑'));
  log('  停入口: ' + (rep.guardKilled ? '已停' : '未在跑'));
  if (rep.orphanKilled) log('  清理了 1 个残留隧道进程');
  const still = await M.isPortListening();
  log(still ? '  ⚠ 端口仍在监听, 请再跑一次' : '  ✅ 已关闭, 端口已释放(DSH 那套隧道不受影响)');
  return rep;
}

export async function cmdRemoteLink(cfg, { reset = false } = {}) {
  const M = await loadRemote(cfg);
  title('手机链接');
  if (M.__error) { log('  ❌ ' + M.__error); return { ok: false }; }
  if (reset) {
    const r = await M.resetLink();
    log(r.ok ? '  ✅ 已换新链接(旧的立刻作废)' : '  ❌ ' + (r.error || '失败'));
  }
  const st = M.status();
  const link = M.currentLink();
  if (!link.url) {
    log('  ⚠ 还没有链接 —— 先「开启远程访问」');
    return { ok: false };
  }
  log('  ' + link.url);
  log('');
  if (link.local) {
    log('  ⚠ 目前还没有公网域名, 这条链接只能在这台电脑上打开。');
    log('    手机要用的话, 先开启远程访问并等域名生效。');
  } else {
    log('  手机浏览器打开这条链接即可(第一次会自动记住设备)。');
  }
  log(`  入口 ${st.base} · 隧道 pid ${st.tunnelPid || '-'}`);
  return { ok: true, url: link.url };
}

// ------------------------------------------------------------
// 合并进体检(只读)
// ------------------------------------------------------------
export async function remoteSummary(cfg, appPort) {
  const M = await loadRemote(cfg);
  if (M.__error) return { ok: false, error: M.__error, lines: ['❌ ' + M.__error] };
  const lines = [];
  let st = {};
  try { st = M.status(); } catch { /* ignore */ }
  const portUp = await M.isPortListening();
  const base = st.base || '';
  const publicOk = base && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(base);
  lines.push(portUp ? `✅ 入口服务在跑(${M.REMOTE.bind}:${M.REMOTE.port})` : `–  入口服务未运行(${M.REMOTE.port})`);
  if (publicOk) lines.push(`✅ 公网入口 ${base}`);
  else if (portUp) lines.push('⏳ 还在等公网域名生效');
  if (st.linkUrl && st.linkReady) lines.push('✅ 手机链接已就绪');
  else if (st.linkUrl) lines.push('–  手机链接仅本机可用(尚无公网域名)');
  if (st.tunnelPid) lines.push(`–  隧道 pid ${st.tunnelPid}(已重启 ${st.tunnelRestarts} 次)`);
  if (st.lastError) lines.push('⚠ ' + st.lastError);
  const pre = M.preflight ? M.preflight({ upstreamPort: appPort }) : { problems: [] };
  for (const p of pre.problems || []) lines.push(`❌ 缺依赖: ${p.name} —— ${p.fix}`);
  return { ok: portUp && publicOk && !!st.linkReady, lines, status: st };
}
