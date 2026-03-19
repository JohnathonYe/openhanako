/**
 * 全局轻量 Toast（InputArea、bridge 拖拽上传等共用）
 */
export function showHanaToast(text: string, type: 'success' | 'error' = 'success', duration = 20000): void {
  const el = document.createElement('div');
  el.className = `hana-toast ${type}`;

  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);

  const close = document.createElement('button');
  close.className = 'hana-toast-close';
  close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  close.onclick = dismiss;
  el.appendChild(close);

  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  const timer = setTimeout(dismiss, duration);
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }
}
