import { qs, el } from '../utils/dom.js';

const panel = () => qs('#progress-panel');
const content = () => qs('#progress-content');
const summary = () => qs('#scan-summary');

export function showProgress(checks) {
  const p = panel();
  const c = content();
  if (!p || !c) return;
  p.style.display = 'block';
  c.innerHTML = '';
  checks.forEach((check, index) => {
    const item = el('div', { class: 'progress-item' }, [
      el('div', { class: 'progress-status pending' }),
      el('span', {}, `${index + 1}/${checks.length} ${check.name}...`)
    ]);
    c.appendChild(item);
  });
}

export function updateProgress(stepIndex, status, error = null) {
  const c = content();
  if (!c) return;
  const items = c.querySelectorAll('.progress-item');
  const item = items[stepIndex];
  if (!item) return;
  const statusEl = item.querySelector('.progress-status');
  const textEl = item.querySelector('span');
  statusEl.className = `progress-status ${status}`;
  if (status === 'success') textEl.textContent = textEl.textContent.replace('...', ' ✓');
  if (status === 'error') {
    const msg = (error && (error.message || String(error))) || 'Error';
    textEl.textContent = `${textEl.textContent.replace('...', '')} — ${msg}`;
  }
}

export function clearProgress() {
  const p = panel();
  const c = content();
  const s = summary();
  if (p) p.style.display = 'none';
  if (c) c.innerHTML = '';
  if (s) s.innerHTML = '';
}

export function summarizeScan(metaText) {
  const s = summary();
  if (!s) return;
  s.innerHTML = metaText || '';
}


