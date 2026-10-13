// 公网路径对比诊断: 新待办隧道 vs 已知活着的 DSH 隧道
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import * as R from './remote.mjs';

R.setLogger(() => {});
const sh = (cmd, args, ms = 25000) => new Promise((res) => {
  execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 },
    (e, out, err) => res({ code: e ? 1 : 0, out: String(out || ''), err: String(err || '') }));
});

async function probe(label, base, pathq = '/__guard/health') {
  const u = base + pathq;
  let hostname = '';
  try { hostname = new URL(base).hostname; } catch { /* ignore */ }
  console.log(`\n── ${label} ──`);
  console.log('  url  =', u);
  console.log('  host =', hostname);

  // 1) 系统 DNS
  const d1 = await sh('powershell.exe', ['-NoProfile', '-Command',
    `(Resolve-DnsName -Name '${hostname}' -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) -join ','`]);
  console.log('  本机DNS :', d1.out.trim() || '(空)');
  // 2) 公共 DNS
  const d2 = await sh('powershell.exe', ['-NoProfile', '-Command',
    `(Resolve-DnsName -Name '${hostname}' -Server 1.1.1.1 -Type A -QuickTimeout -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) -join ','`]);
  console.log('  1.1.1.1 :', d2.out.trim() || '(空)');
  // 3) curl 直连(默认解析)
  const c1 = await sh('curl.exe', ['-s', '-S', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '20', u]);
  console.log('  curl    :', c1.out.trim(), c1.err.trim() ? '| ' + c1.err.trim().slice(0, 120) : '');
  // 4) Node fetch
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 18000);
    const res = await fetch(u, { signal: ctl.signal });
    clearTimeout(t);
    console.log('  fetch   :', 'HTTP ' + res.status, (await res.text()).trim().slice(0, 40));
  } catch (e) {
    console.log('  fetch   :', e.name + ' ' + e.message + (e.cause ? ' | ' + (e.cause.code || e.cause.message) : ''));
  }
  return { hostname, curl: c1.out.trim(), dns: d1.out.trim() };
}

// 对照组: 已在跑的 DSH 隧道
const dshUrl = (await fs.readFile('C:/Users/<you>/.dsh/remote/public-url.txt', 'utf8').catch(() => '')).trim();
await probe('对照组 · DSH 隧道(已在跑)', dshUrl, '/__guard/health');

// 起待办隧道
console.log('\n启动待办隧道…');
const r = await R.start({ upstreamPort: 8790, waitMs: 75000, onProgress: (p) => console.log('  ' + p) });
console.log('start ok=' + r.ok);
const base = R.currentLink().base;
const out = await probe('待办隧道(新建)', base, '/__guard/health');

// 隧道日志尾部(看 cloudflared 自己怎么报)
try {
  const log = await fs.readFile(R.FILE.log(), 'utf8');
  const lines = log.trim().split(/\r?\n/);
  console.log('\n── cloudflared 日志尾部 ──');
  for (const l of lines.slice(-12)) console.log('  ' + l.slice(0, 200));
  const errs = lines.filter((l) => /ERR|error|fail|Unregistered|retry/i.test(l)).slice(-6);
  if (errs.length) { console.log('  —— 含错误字样 ——'); for (const l of errs) console.log('  ! ' + l.slice(0, 200)); }
} catch (e) { console.log('  读不到隧道日志:', e.message); }

console.log('\n收干净…');
console.log(JSON.stringify(await R.stop()));
