// hook.js — 诊断用: 捕获启动期错误 + 性能计数
window.__errs = [];
window.__perf = []; // ['path ms' ...] 最近 20 条耗时
window.addEventListener('error', (e) => {
  window.__errs.push((e.message || 'err') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
});
window.addEventListener('unhandledrejection', (e) => {
  window.__errs.push('P:' + String((e.reason && e.reason.message) || e.reason));
});
