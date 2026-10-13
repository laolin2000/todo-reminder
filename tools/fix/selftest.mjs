// ============================================================
// 修复工具 · 沙盒自测
// 把真实数据复制到临时目录, 在沙盒里跑一遍「改时间 + 归档 + 自启」,
// 校验: 只动该动的、重复机制不受影响、日志写得对、原数据零改动。
// 用法: node tools/fix/selftest.mjs
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const TOOL = path.join(HERE, 'tool.mjs');
const REAL_DATA = path.join(process.env.APPDATA || '', '待办提醒', 'data');

const sand = path.join(os.tmpdir(), 'todo-fix-selftest-' + Date.now());
const sandData = path.join(sand, 'data');
const sandLogs = path.join(sand, 'logs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

function run(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TODO_FIX_DATA_DIR: sandData,
      TODO_FIX_LOG_DIR: sandLogs,
      TODO_FIX_RUNKEY: 'HKCU:\\Software\\TodoReminderFixSelfTest\\Run',
      TODO_FIX_NO_RESTART: '1',
      ...extraEnv,
    },
    timeout: 120000,
  });
  return out;
}

function readArr(file) { return JSON.parse(stripBom(execFileSync(process.execPath, ['-e',
  `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))); }
function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

console.log('════ 修复工具 沙盒自测 ════');
console.log('沙盒:', sand);

// ---------- 准备沙盒 ----------
await fs.mkdir(sandData, { recursive: true });
await fs.mkdir(sandLogs, { recursive: true });
const realTodos = await fs.readFile(path.join(REAL_DATA, 'todos.json'), 'utf8');
const realAi = await fs.readFile(path.join(REAL_DATA, 'ai.json'), 'utf8').catch(() => null);
const realCfg = await fs.readFile(path.join(REAL_DATA, 'config.json'), 'utf8').catch(() => null);
await fs.writeFile(path.join(sandData, 'todos.json'), realTodos);
if (realAi) await fs.writeFile(path.join(sandData, 'ai.json'), realAi);
if (realCfg) await fs.writeFile(path.join(sandData, 'config.json'), realCfg);

const before = JSON.parse(stripBom(realTodos));
const bAlive = before.filter((t) => !t.deleted);
const bDone = bAlive.filter((t) => t.status === 'done');
const bOpen = bAlive.filter((t) => t.status !== 'done');
const bRepeat = bAlive.filter((t) => t.rule || (t.repeat && t.repeat !== 'none'));
const cutoff = Date.now() - 3 * 86400000;
const bOldDone = bDone.filter((t) => t.updatedAt < cutoff && !(t.rule || (t.repeat && t.repeat !== 'none')));
console.log(`准备: 有效 ${bAlive.length} · 未完成 ${bOpen.length} · 已完成 ${bDone.length} · 重复 ${bRepeat.length}`);
console.log(`      预期归档 ${bOldDone.length} 条`);

// ---------- 1. 预演(必须零改动) ----------
console.log('\n① 预演模式(不加 --yes)');
const hashBefore = await fs.readFile(path.join(sandData, 'todos.json'), 'utf8');
run(['archive']);
const hashAfter = await fs.readFile(path.join(sandData, 'todos.json'), 'utf8');
ok(hashBefore === hashAfter, '预演不修改数据文件');

// ---------- 2. 归档 ----------
console.log('\n② 归档已完成超 3 天');
const bakDir = path.join(sandData, 'backups');
run(['archive', '--yes']);
const after2 = readArr(path.join(sandData, 'todos.json'));
const aAlive = after2.filter((t) => !t.deleted);
const aOpen = aAlive.filter((t) => t.status !== 'done');
const aDone = aAlive.filter((t) => t.status === 'done');
const aRepeat = aAlive.filter((t) => t.rule || (t.repeat && t.repeat !== 'none'));

ok(aAlive.length === bAlive.length - bOldDone.length, `有效记录 ${bAlive.length} → ${aAlive.length}(预期减 ${bOldDone.length})`);
ok(aOpen.length === bOpen.length, `未完成 ${bOpen.length} → ${aOpen.length}(提醒不受影响)`);
ok(aRepeat.length === bRepeat.length, `重复机制 ${bRepeat.length} → ${aRepeat.length}(一条没动)`);
ok(aDone.length === bDone.length - bOldDone.length, `已完成 ${bDone.length} → ${aDone.length}`);

// 归档必须是**墓碑**(deleted:true + 时间戳更新), 否则同步(LWW)会把旧副本推回来复活它
const archived = after2.filter((t) => bOldDone.some((o) => o.id === t.id));
ok(archived.length === bOldDone.length, `归档条目都还在文件里(共 ${archived.length} 条)`);
ok(archived.every((t) => t.deleted === true), '归档条目全部标为 deleted(墓碑)');
ok(archived.every((t) => t.updatedAt > (bOldDone.find((o) => o.id === t.id)?.updatedAt || 0)),
  '墓碑时间戳都**比原记录更新**(这是 LWW 下不会被旧副本复活的保证)');

// 每条重复规则的未完成窗口仍为 3(或原本就不足)
const ruleOpen = (arr) => {
  const m = new Map();
  for (const t of arr) {
    if (t.deleted || t.status === 'done' || !t.rule) continue;
    let k = t.rule; try { k = JSON.parse(t.rule).id || t.rule; } catch { /* ignore */ }
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
};
const rb = ruleOpen(before), ra = ruleOpen(after2);
let windowOk = true;
for (const [k, v] of ra) if (v > 3) windowOk = false;
ok(windowOk, '每条重复规则的未完成实例 ≤ 3(窗口未被破坏)');
console.log('     规则未完成数: ' + [...ra.entries()].map(([k, v]) => `${k.slice(-6)}=${v}`).join(' '));

// 备份存在(只有"真的有东西要归档"时才会写备份; 没东西可归档 → 不算失败)
const baks = await fs.readdir(bakDir).catch(() => []);
if (bOldDone.length) {
  ok(baks.some((f) => f.includes('before-archive')), '归档前已自动备份');
  const bakFile = baks.filter((f) => f.includes('before-archive')).sort().pop();
  if (bakFile) {
    const bakArr = readArr(path.join(bakDir, bakFile));
    ok(bakArr.length === before.length, `备份完整(原 ${before.length} 条)`);
  }
} else {
  console.log('  – 真实数据里已没有"超过 3 天没动过的已完成条目"(说明归档本来就干净), 跳过备份/日志断言');
}

// ---------- 3. 日志 ----------
console.log('\n③ 完成日志');
if (!bOldDone.length) {
  // 没有可归档条目时: 工具应当什么都不做(不建日志、不改数据)
  const outNothing = run(['archive', '--yes']);
  ok(/没有可归档的条目/.test(outNothing), '无可归档条目时明确报告"没有可归档的条目"');
  ok(!(await fs.readFile(path.join(sandLogs, '完成日志.json'), 'utf8').catch(() => null)),
    '无可归档条目时不创建完成日志(不产生无意义文件)');
  console.log('  (以下日志断言仅在有归档发生时才有意义, 已跳过)');
} else {
  let lg = null;
  try { lg = JSON.parse(stripBom(await fs.readFile(path.join(sandLogs, '完成日志.json'), 'utf8'))); } catch { lg = null; }
  const md = await fs.readFile(path.join(sandLogs, '任务完成日志.md'), 'utf8').catch(() => '');
  ok(Array.isArray(lg) && lg.length === bOldDone.length, `完成日志.json 记录 ${lg ? lg.length : 0} 条(预期 ${bOldDone.length})`);
  ok(lg && lg.every((x) => x.archivedAt && x.status === 'done'), '日志每条都带 archivedAt 且状态为已完成');
  ok(md.includes('# 任务完成日志'), '任务完成日志.md 已生成');
  const mdRows = (md.match(/^- \[x\] /gm) || []).length;
  ok(mdRows === bOldDone.length, `Markdown 行数 ${mdRows}(预期 ${bOldDone.length})`);
  const sampleTitles = (lg || []).slice(0, 3).map((x) => x.title);
  ok(sampleTitles.every((t) => md.includes(t)), '日志内容与数据一致(标题可检索)');
  console.log('     日志样例: ' + sampleTitles.join(' / '));
}

// ---------- 4. 幂等 ----------
console.log('\n④ 再归档一次(应无可归档条目)');
const out5 = run(['archive', '--yes']);
ok(/没有可归档的条目/.test(out5), '第二次归档无重复动作');
const after3 = readArr(path.join(sandData, 'todos.json'));
ok(after3.length === after2.length, '数据量未再变化');

// ---------- 5. 已移除的命令确实不再存在 ----------
console.log('\n⑤ 已移除的命令(改时间 / 自启 / 快捷方式)');
for (const c of ['times', 'autostart', 'shortcut']) {
  let out = '', code = 0;
  try { out = run([c]); } catch (e) { code = e.status ?? 1; out = String(e.stdout || '') + String(e.stderr || ''); }
  ok(code !== 0 && /未知命令/.test(out), `\`${c}\` 已移除(返回未知命令、退出码非 0)`);
}

// ---------- 6. 真实数据零改动 ----------
console.log('\n⑥ 真实数据是否被碰过');
const realNow = await fs.readFile(path.join(REAL_DATA, 'todos.json'), 'utf8');
ok(realNow === realTodos, '真实 todos.json 与测试前逐字节一致(沙盒未污染真实数据)');

// ---------- 结果 ----------
console.log('\n════ 结果 ════');
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log(`  沙盒目录(可删): ${sand}`);
console.log(fail === 0 ? '  ✅ 全部通过' : '  ❌ 有失败项');
process.exitCode = fail === 0 ? 0 : 1;
