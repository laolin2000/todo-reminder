// theme-init.js — 渲染前应用主题, 避免闪烁(必须在 vendor 之前同步加载)
(function () {
  try {
    var p = localStorage.getItem('tr:theme') || 'system';
    if (p === 'light' || p === 'dark' || p === 'neo') document.documentElement.setAttribute('data-theme', p);
  } catch (e) { /* ignore */ }
})();
