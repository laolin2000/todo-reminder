#!/usr/bin/env node
// ============================================================
// 待办提醒 · 修复工具
// ------------------------------------------------------------------
// 双击「桌面 → 待办提醒修复工具」即可运行; 也可在命令行带参数直接执行:
//   node tools/fix/tool.mjs check              连接 + AI 解析状态检测(只读)
//   node tools/fix/tool.mjs status             完整体检报告(只读)
//   node tools/fix/tool.mjs archive [--yes] [--days N] [--repeat]
//                                              已完成超 N 天 → 转入日志
//   node tools/fix/tool.mjs remote [check|up|down|link|repair]
//                                              手机远程连接: 诊断 / 修复 / 开关
// 不带参数 = 打开菜单(交互式)。
//
// 已移除的功能(它们都是一次性动作, 做完就不需要常驻占体量):
//   · 改时刻(08:50→08:30) —— 已改完, 全库 08:50 零残留
//   · 开机自启 / 看门狗   —— 用户明确不要自启, 注册表里也没有任何自启项
//   · 重建桌面快捷方式     —— 快捷方式已在桌面且指向正确
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import {
  log, title, fmtMs, nowStr, loadConfig, readJsonOr, httpJson,
  findLivePort, loadTodos, summarize, isRepeatItem, health,
} from './lib.mjs';
import { cmdStatus, cmdArchive } from './commands.mjs';
import { cmdRemoteCheck, cmdRemoteRepair, cmdRemoteUp, cmdRemoteDown, cmdRemoteLink } from './remote.mjs';

/** 开机自启的固定状态: 用户已明确不要自启。原来那套"读写注册表 + 生成看门狗脚本"
 *  已删除, 这里只保留一句说明, 不再占用程序体量。 */
function autostartNote() {
  return [
    '⏸ 开机自启: 已按你的要求保持关闭(不写注册表、不常驻守护)',
    '   代价: 电脑重启后需手动双击桌面「待办提醒」, 否则手机端与 AI 识别不可用',
  ];
}

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(BASE_DIR);

// 不再为每次运行写日志文件 —— 那是没必要的占用(每跑一次就多一个文件)。
// 输出只打到控制台, 需要留档时自己重定向:  node tool.mjs check > out.txt
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const words = argv.filter((a) => !a.startsWith('--'));
const cmd = (words[0] || '').toLowerCase();
const arg1 = (words[1] || '').toLowerCase();
const APPLY = flags.has('--yes') || flags.has('-y');
const DAYS = (() => { const a = words.find((w) => /^\d+$/.test(w)); return a ? Number(a) : null; })();

// ------------------------------------------------------------
// ① check —— 一键检测「连接状态 + AI 解析状态」
// ------------------------------------------------------------
async function cmdCheck() {
  const t0 = Date.now();
  const results = [];
  title('待办提醒 · 连接与 AI 解析检测');

  // —— 连接 ——
  const live = await findLivePort(cfg);
  if (!live) {
    log('  ❌ 桌面端未运行 —— 手机端 / 网页端 / AI 截图识别 此刻全部不可用');
    log('     解决: 双击桌面上的「待办提醒」, 然后重新检测');
  } else {
    log(`  ✅ 桌面端在线 · 端口 ${live.port}`);
    log(`     应用 ${live.data.app} ${live.data.version} · 记录 ${live.data.total} 条(有效 ${live.data.active})`);
  }
  results.push({ name: '桌面端服务', ok: !!live, detail: live ? `端口 ${live.port}` : '未运行' });

  // 手机侧可达性(Tailscale / 局域网 IP)
  let lan = '';
  try {
    const ips = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress) -join ','`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    const list = ips.split(',').filter(Boolean);
    const tail = list.find((x) => x.startsWith('100.'));
    lan = tail || list[0] || '';
    if (lan && live) {
      const tok = await (async () => { try { const c = await readJsonOr(cfg.dataCfgFile, {}); return c.token || ''; } catch { return ''; } })();
      const r = await httpJson(`http://${lan}:${cfg.port}/api/health?token=${tok}`, { timeout: 5000 });
      const ok = r.ok && r.json && r.json.ok;
      log(`  ${ok ? '✅' : '❌'} 手机端可达性 · http://${lan}:${cfg.port} ${ok ? '正常' : '不通'}`);
      results.push({ name: '手机端可达', ok, detail: `http://${lan}:${cfg.port}` });
    }
  } catch { /* ignore */ }

  // 数据文件
  const arr = await loadTodos(cfg);
  const s = summarize(arr);
  log(`  ✅ 数据文件正常 · 有效 ${s.alive} 条(未完成 ${s.open} / 已完成 ${s.done}) · 重复机制 ${s.repeat} 条`);
  results.push({ name: '数据文件', ok: true, detail: `${s.alive} 条有效` });

  // 鉴权
  if (live) {
    const r = await httpJson(`http://127.0.0.1:${live.port}/api/todos`, { timeout: 5000 });
    const ok = r.ok && r.json && Array.isArray(r.json.todos);
    log(`  ${ok ? '✅' : '❌'} 同步接口 /api/todos ${ok ? '可用' : '异常(' + r.status + ')'}`);
    results.push({ name: '同步接口', ok, detail: ok ? 'ok' : String(r.status) });
  }

  // —— AI 解析 ——
  const ai = await readJsonOr(cfg.aiFile, null);
  const aiOk = !!(ai && ai.model && ai.apiKey);
  log('');
  if (aiOk) {
    log(`  ✅ AI 配置完整 · 模型 ${ai.model}`);
    log(`     接口 ${ai.baseUrl} · 密钥 ${String(ai.apiKey).length} 字符`);
    const pt = String(ai.periodTable || '').split('\n').filter(Boolean);
    log(`     节次表 ${pt.length} 条${pt.length ? ' · 第1节 ' + String(pt[0]).replace(/\?1\?\s*/, '') : ''}${ai.courseFix ? ' · 纠错规则 ' + ai.courseFix : ''}`);
  } else {
    log('  ❌ AI 配置不完整(缺模型或密钥)—— 请在「设置 → AI 识别」里填写');
  }
  results.push({ name: 'AI 配置', ok: aiOk, detail: ai ? ai.model || '' : '读不到 ai.json' });

  if (live && aiOk) {
    const r = await httpJson(`http://127.0.0.1:${live.port}/api/ai`, { timeout: 6000 });
    const c = r.json && r.json.config;
    const ok = !!(c && c.hasKey);
    log(`  ${ok ? '✅' : '❌'} AI 接口 /api/ai ${ok ? '可用' : '异常'}`);
    results.push({ name: 'AI 接口', ok, detail: ok ? c.model : String(r.status) });
  } else if (!live) {
    log('  –  AI 接口未测(需要桌面端在运行)');
    results.push({ name: 'AI 接口', ok: false, detail: '桌面端未运行' });
  }

  // —— 手机远程入口(应用内置隧道) ——
  log('');
  try {
    const { remoteSummary } = await import('./remote.mjs');
    const rs = await remoteSummary(cfg, cfg.port);
    for (const line of rs.lines) log('  ' + line);
    results.push({
      name: '手机远程入口',
      ok: !!rs.ok,
      detail: rs.ok ? '已就绪, 手机在任何网络都能连' : (rs.status && rs.status.running ? '正在等域名生效' : '未开启(在应用「设置 → 远程访问」里开)'),
    });
  } catch (e) {
    log('  –  未接入远程模块: ' + e.message);
    results.push({ name: '手机远程入口', ok: false, detail: '模块加载失败' });
  }

  // —— 自启(固定状态, 无开关) ——
  log('');
  for (const line of autostartNote()) log('  ' + line);

  // —— 结论 ——
  const bad = results.filter((r) => !r.ok);
  title('结论');
  if (!bad.length) {
    log('  ✅ 全部正常 —— 连接与 AI 解析都可用。');
  } else {
    log(`  ⚠ ${bad.length} 项异常:`);
    for (const b of bad) log(`     · ${b.name}: ${b.detail}`);
    if (!live) log('     → 最可能的原因: 电脑上的「待办提醒」没在运行。双击桌面快捷方式即可。');
  }
  log('');
  log(`  检测耗时 ${Date.now() - t0} ms`);
  return { pass: bad.length === 0, results };
}

// ------------------------------------------------------------
// 交互菜单
// ------------------------------------------------------------
async function menu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();

  for (;;) {
    log('');
    log('══════════════════════════════════════════════════');
    log('   待办提醒 · 修复工具');
    log('══════════════════════════════════════════════════');
    log(`   数据目录: ${cfg.dataDir}`);
    log(`   项目目录: ${cfg.appDir}`);
    log('');
    log('   1) 检测连接状态与 AI 解析状态  (只读, 最常用)');
    log('   2) 完整体检报告                (只读)');
    log('   3) 手机远程连接: 诊断 / 修复 / 开关');
    log('   4) 已完成超 3 天 → 转入日志     (会改数据)');
    log('   0) 退出');
    log('');
    const c = await ask('   请输入序号后回车: ');

    try {
      if (c === '1') { await cmdCheck(); }
      else if (c === '2') { await cmdStatus(cfg); }
      else if (c === '3') { await remoteMenu(ask); }
      else if (c === '4') {
        const pre = await cmdArchive(cfg, { apply: false, days: cfg.oldDoneDays });
        if (pre.preview) {
          const a = await ask(`\n   确认归档以上 ${pre.preview} 条吗? 输入 y 执行(会自动停/启桌面端): `);
          if (a.toLowerCase() === 'y') await cmdArchive(cfg, { apply: true, days: cfg.oldDoneDays });
          else log('   已取消, 未改动数据。');
        }
      } else if (c === '0' || c === '') {
        break;
      } else {
        log('   无效序号, 请重新输入。');
      }
    } catch (e) {
      log('');
      log('   ❌ 执行出错: ' + (e && e.message ? e.message : e));
    }
  }
  rl.close();
  log('');
  log('   已退出。');
}

/** 手机远程连接子菜单 */
async function remoteMenu(ask) {
  const r = await cmdRemoteCheck(cfg);
  log('');
  log('   a) 一键修复(自动清孤儿 + 重启入口)');
  log('   b) 开启 / 重启远程访问');
  log('   c) 关闭远程访问');
  log('   d) 显示手机链接');
  log('   e) 换一条新链接(旧的作废)');
  log('   f) 只看诊断, 不做别的');
  const a = (await ask('   选择 a~f: ')).toLowerCase();
  if (a === 'a') {
    const pre = await cmdRemoteRepair(cfg, { apply: false });
    if (!pre.ok) {
      const y = await ask('   现在执行修复? 输入 y 继续: ');
      if (y.toLowerCase() === 'y') await cmdRemoteRepair(cfg, { apply: true });
      else log('   已取消。');
    } else {
      log('   一切正常, 无需修复。');
    }
  } else if (a === 'b') {
    await cmdRemoteUp(cfg, {});
  } else if (a === 'c') {
    const y = await ask('   确认关闭手机入口(电脑端不受影响)? 输入 y: ');
    if (y.toLowerCase() === 'y') await cmdRemoteDown(cfg);
    else log('   已取消。');
  } else if (a === 'd') {
    await cmdRemoteLink(cfg, {});
  } else if (a === 'e') {
    const y = await ask('   换新链接后旧链接立刻失效, 手机需重新打开一次。确认? 输入 y: ');
    if (y.toLowerCase() === 'y') await cmdRemoteLink(cfg, { reset: true });
    else log('   已取消。');
  } else {
    log('   (仅诊断, 未做改动)');
  }
  return r;
}

// ------------------------------------------------------------
// 入口
// ------------------------------------------------------------
export async function main() {
  if (!cmd) { await menu(); return; }

  if (cmd === 'check' || cmd === '检测') {
    const r = await cmdCheck();
    process.exitCode = r.pass ? 0 : 2;
    return;
  }
  if (cmd === 'status' || cmd === '体检') { await cmdStatus(cfg); return; }
  if (cmd === 'archive' || cmd === '归档') {
    await cmdArchive(cfg, { apply: APPLY, days: DAYS, includeRepeat: flags.has('--repeat') });
    return;
  }
  if (cmd === 'remote' || cmd === '远程' || cmd === '连接修复') {
    if (arg1 === 'up' || arg1 === 'start' || arg1 === '开启') await cmdRemoteUp(cfg, {});
    else if (arg1 === 'down' || arg1 === 'stop' || arg1 === '关闭') await cmdRemoteDown(cfg);
    else if (arg1 === 'link' || arg1 === '链接') await cmdRemoteLink(cfg, { reset: flags.has('--reset') });
    else if (arg1 === 'repair' || arg1 === '修复') await cmdRemoteRepair(cfg, { apply: APPLY });
    else await cmdRemoteCheck(cfg, {});
    return;
  }

  log('未知命令: ' + cmd);
  log('可用: check | status | archive [--yes] [--days N] [--repeat] | remote [check|up|down|link|repair]');
  process.exitCode = 1;
}

await main();
