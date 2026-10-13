// 端到端验证“软件自己的 AI 识图”: 读图 → POST 电脑端 /api/ai/parse → 打印结果
// 用法: node scripts/test-ai-parse.mjs <图片路径> [输出文件]
import fs from 'node:fs';

const img = process.argv[2];
const out = process.argv[3];
if (!img || !fs.existsSync(img)) { console.error('缺少图片'); process.exit(1); }
const b64 = fs.readFileSync(img).toString('base64');
const body = JSON.stringify({ image: 'data:image/png;base64,' + b64, hint: '' });

const start = Date.now();
const r = await fetch('http://127.0.0.1:8790/api/ai/parse', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-token': '7m1bRHHkY6KU' },
  body,
});
const text = await r.text();
const info = `HTTP ${r.status} · ${Date.now() - start}ms\n\n` + text;
console.log(info);
if (out) fs.writeFileSync(out, info, 'utf8');
process.exit(r.ok ? 0 : 2);
