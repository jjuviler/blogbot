import { qs, el } from '../utils/dom.js';

const panel = () => qs('#results-panel');
const content = () => qs('#results-content');
const STORAGE_KEY = 'aeo-results-cards';

function saveCard(card) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push(card);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {}
}

function clearSaved() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function addResultCard(card, { persist = true } = {}) {
  const p = panel();
  const c = content();
  if (!p || !c) return;
  p.style.display = 'block';

  const cardEl = el('div', { class: `result-card ${card.severity || 'neutral'}` });
  let html = `<div class="result-card-header">${card.header || ''}`;
  if (card.link) {
    html += ` <a href="${card.link.url}" target="_blank" class="result-card-link">${card.link.text}</a>`;
  }
  html += `</div><button class="result-card-dismiss" title="Dismiss this issue">×</button>`;
  if (card.snippet) html += `<div class="result-card-snippet"><strong>Original:</strong> ${card.snippet}</div>`;
  if (card.matchText) html += `<div class="result-card-snippet"><strong>Match:</strong> ${card.matchText}</div>`;
  if (card.body) html += `<div class="result-card-body">"${card.body}"</div>`;
  if (card.rewrite) html += `<div class="result-card-body"><strong>Suggested:</strong> ${card.rewrite}</div>`;
  if (Array.isArray(card.reasons) && card.reasons.length) {
    html += '<ul class="result-card-reasons">' + card.reasons.map(r => `<li>${r}</li>`).join('') + '</ul>';
  }
  if (card.detail) html += `<div class="result-card-detail">${card.detail}</div>`;
  if (card.reason) html += `<div class="result-card-detail"><strong>Reason:</strong> ${card.reason}</div>`;
  if (card.id) html += `<div class="result-card-id" style="font-size: 0.8em; color: #666; margin-top: 6px;">${card.id}</div>`;
  cardEl.innerHTML = html;

  // Hover-driven highlight via global helpers
  if (typeof window.__applyHighlight === 'function') {
    cardEl.addEventListener('mouseenter', () => {
      const phrase = card.phrase;
      const href = card.href || card.finalHref;
      try { console.log('[Hover Debug] enter card', { id: card.id, hasHref: !!href, phrase }); } catch {}
      if (href) {
        // For broken links: highlight only the specific anchor element by restricting mark.js to that element
        try {
          if (typeof window.__applyAnchorHighlight === 'function') {
            window.__applyAnchorHighlight(href);
            return;
          }
        } catch {}
      }
      if (phrase) {
        window.__applyHighlight(phrase);
      }
    });
    cardEl.addEventListener('mouseleave', () => {
      try { console.log('[Hover Debug] leave card', { id: card.id }); } catch {}
      // On hover-off, blanket-clear any <mark> wrappers in the editor
      try { window.__clearEditorMarks?.(); } catch {}
    });
  }

  const btn = cardEl.querySelector('.result-card-dismiss');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    cardEl.style.display = 'none';
    // If no visible cards remain, remove the results panel from DOM
    const cNow = content();
    const pNow = panel();
    if (cNow) {
      const visible = Array.from(cNow.children).filter(el => {
        if (!(el instanceof Element)) return false;
        const cs = window.getComputedStyle(el);
        return cs.display !== 'none';
      });
      if (visible.length === 0 && pNow && pNow.parentNode) {
        pNow.parentNode.removeChild(pNow);
      }
    }
  });

  c.appendChild(cardEl);
  if (persist) saveCard(card);
}

export function dismissCard(id) {
  const c = content();
  if (!c) return;
  const els = c.querySelectorAll('.result-card-id');
  for (const e of els) {
    if (e.textContent && e.textContent.includes(String(id))) {
      const card = e.closest('.result-card');
      if (card) card.style.display = 'none';
    }
  }
}

export function clearResults() {
  const p = panel();
  const c = content();
  if (c) c.innerHTML = '';
  if (p && p.parentNode) p.parentNode.removeChild(p);
  clearSaved();
}

export function addErrorToast(message) {
  addResultCard({
    severity: 'severe',
    header: 'Check failed',
    detail: message
  });
}

export function restoreResults() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    ensureResultsPanel();
    for (const card of arr) addResultCard(card, { persist: false });
  } catch {}
}

export function ensureResultsPanel() {
  if (panel() && content()) return;
  const aside = document.querySelector('.side-panel');
  if (!aside) return;
  const p = document.createElement('div');
  p.id = 'results-panel';
  p.className = 'results-panel';
  p.style.display = 'none';
  const c = document.createElement('div');
  c.id = 'results-content';
  c.className = 'results-content';
  p.appendChild(c);
  aside.appendChild(p);
}

