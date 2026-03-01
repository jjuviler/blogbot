import { qs, on } from '../utils/dom.js';

const SETTINGS_STORAGE_KEY = 'aeo-checker-settings';

export function readSettings() {
  return {
    plagiarism: qs('#check-plagiarism')?.checked ?? true,
    legal: qs('#check-legal')?.checked ?? true,
    links: qs('#check-links')?.checked ?? true,
    vague: qs('#check-vague')?.checked ?? true,
    mentions: qs('#check-mentions')?.checked ?? true,
    design: qs('#check-design')?.checked ?? true,
  };
}

export function wireSettingsPanel() {
  const toggle = qs('#settings-toggle');
  const content = qs('#settings-content');
  const label = qs('#settings-label');
  const count = qs('#settings-count');
  const checkAll = qs('#check-all');
  const uncheckAll = qs('#uncheck-all');

  function updateCount() {
    const boxes = document.querySelectorAll('.settings-checkbox');
    const enabled = Array.from(boxes).filter(cb => cb.checked).length;
    const total = boxes.length;
    if (count) count.textContent = `(${enabled} of ${total} checks enabled)`;
    persistSettings();
  }

  function persistSettings() {
    try {
      const state = {
        open: content?.style.display !== 'none',
        checks: {
          plagiarism: qs('#check-plagiarism')?.checked ?? true,
          legal: qs('#check-legal')?.checked ?? true,
          links: qs('#check-links')?.checked ?? true,
          vague: qs('#check-vague')?.checked ?? true,
          mentions: qs('#check-mentions')?.checked ?? true,
          design: qs('#check-design')?.checked ?? true
        }
      };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }

  function restoreSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);
      if (state && state.checks) {
        const map = [
          ['#check-plagiarism', 'plagiarism'],
          ['#check-legal', 'legal'],
          ['#check-links', 'links'],
          ['#check-vague', 'vague'],
          ['#check-mentions', 'mentions'],
          ['#check-design', 'design']
        ];
        for (const [sel, key] of map) {
          const el = qs(sel);
          if (el && typeof state.checks[key] === 'boolean') el.checked = state.checks[key];
        }
      }
      if (typeof state?.open === 'boolean' && content && label) {
        content.style.display = state.open ? 'block' : 'none';
        label.textContent = state.open ? 'Hide settings' : 'View settings';
      }
    } catch {}
  }

  if (toggle && content && label) {
    on(toggle, 'click', () => {
      const open = content.style.display !== 'none';
      content.style.display = open ? 'none' : 'block';
      label.textContent = open ? 'View settings' : 'Hide settings';
      updateCount();
    });
  }
  if (checkAll) on(checkAll, 'click', () => { document.querySelectorAll('.settings-checkbox').forEach(cb => cb.checked = true); updateCount(); });
  if (uncheckAll) on(uncheckAll, 'click', () => { document.querySelectorAll('.settings-checkbox').forEach(cb => cb.checked = false); updateCount(); });

  document.querySelectorAll('.settings-checkbox').forEach(cb => on(cb, 'change', updateCount));
  restoreSettings();
  updateCount();
}


