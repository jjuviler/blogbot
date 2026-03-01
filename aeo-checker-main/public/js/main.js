import { initEditor, getContent, setPlaceholder } from './editor/editor.js';
import { showProgress, updateProgress, clearProgress, summarizeScan } from './ui/progress.js';
import { addResultCard, clearResults, addErrorToast, restoreResults, ensureResultsPanel } from './ui/results.js';
import { readSettings, wireSettingsPanel } from './ui/settings.js';
import { collectURLs, splitSentences } from './utils/text.js';
import { runLinksCheck } from './checks/links.js';
import { runPlagiarism } from './checks/plagiarism.js';
import { runLegalReview } from './checks/legal.js';
import { runStyleCheck } from './checks/stylecheck.js';
import { runMentionsCheck } from './checks/mentions.js';
import he from "https://esm.sh/he@1.2.0";
import { findBestApproximateSpan } from './utils/approx.js';

// Toggle to enable verbose plagiarism debug logs in the console
const LOG_PLAGIARISM_DEBUG = false;

// Hotkey-driven highlight state (for vague sentence first phrase)
let __highlightPhrase = null;
let __marker = null;
let __isHighlighted = false;
let __hotkeyBound = false;

function ensureMarker() {
  if (window.tinymce && tinymce.activeEditor) {
    const body = tinymce.activeEditor.getBody();
    if (!__marker || (__marker && __marker.ctx !== body)) {
      // Create new Mark instance for current editor body
      __marker = new window.Mark(body);
      __marker.ctx = body;
    }
  }
}

// ==== Highlight Debug Helpers ====
window.DEBUG_HL = window.DEBUG_HL ?? false; // flip to true in console when needed

function hlLog(...args) {
  if (window.DEBUG_HL) console.log("[HL]", ...args);
}
function hlWarn(...args) {
  if (window.DEBUG_HL) console.warn("[HL]", ...args);
}

function ensureHlPanel() {
  let el = document.getElementById("hl-debug-panel");
  if (el) return el;
  el = document.createElement("div");
  el.id = "hl-debug-panel";
  Object.assign(el.style, {
    position: "fixed", right: "8px", bottom: "8px", maxWidth: "40vw",
    font: "12px/1.4 system-ui, sans-serif", color: "#111",
    background: "rgba(255,255,255,0.95)", border: "1px solid #ddd",
    borderRadius: "8px", padding: "8px 10px", zIndex: 999999
  });
  el.innerHTML = "<b>HL Debug</b><div id='hl-debug-body' style='white-space:pre-wrap;word-break:break-word'></div>";
  document.body.appendChild(el);
  return el;
}

function setHlPanel(obj) {
  if (!window.DEBUG_HL) return;
  const panel = ensureHlPanel();
  const body = panel.querySelector("#hl-debug-body");
  const safe = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  body.textContent = Object.entries(obj).map(([k, v]) => `${k}: ${safe(v)}`).join("\n");
}

function getEditorRoot() {
  // Try TinyMCE iframe <body>, else fallback to document.body
  const iframeBody = document.querySelector(".tox-edit-area iframe")?.contentDocument?.body;
  if (iframeBody) return { root: iframeBody, where: "iframe.body" };
  return { root: document.body, where: "document.body (fallback)" };
}

// Debug helper: log presence/location of first highlight and scroll capability
function __debugLogFirstHighlight(root, className, passName) {
  try {
    const first = root ? root.querySelector('.' + className) : null;
    const canScroll = !!(first && typeof first.scrollIntoView === 'function');
    const rect = first ? first.getBoundingClientRect() : null;
    hlLog('First highlight check', {
      pass: passName,
      found: !!first,
      canScroll,
      rect: rect ? { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) } : null
    });
  } catch (e) {
    hlWarn('First highlight log error', e);
  }
}

function __scrollFirstHighlight(root, className, passName) {
  try {
    const first = root ? root.querySelector('.' + className) : null;
    if (!first) {
      hlLog('No first highlight to scroll', { pass: passName });
      return;
    }
    if (typeof first.scrollIntoView === 'function') {
      first.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      hlLog('Scrolled to first highlight', { pass: passName });
    } else {
      hlWarn('scrollIntoView not available on first highlight', { pass: passName });
    }
  } catch (e) {
    hlWarn('Error scrolling to first highlight', e);
  }
}

// --- Lightweight helpers for robust cross-block matching ---
function escapeForRegex(s) {
  // Escape regex special chars EXCEPT spaces (we handle them later)
  return String(s || '').replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// --- Editor root resolution (TinyMCE-first, with safe fallback) ---
function resolveEditorRoot() {
  try {
    if (window.tinymce?.activeEditor) {
      const ed = window.tinymce.activeEditor;
      const body = ed.getBody?.();
      if (body && body.ownerDocument) return { root: body, where: 'tinymce.activeEditor.getBody()' };
    }
  } catch {}

  const iframeBody = document.querySelector('.tox-edit-area iframe')?.contentDocument?.body;
  if (iframeBody) return { root: iframeBody, where: '.tox-edit-area iframe.contentDocument.body' };

  const contentRoot = document.querySelector('#editor-root');
  if (contentRoot) return { root: contentRoot, where: '#editor-root' };

  return { root: null, where: 'unresolved' };
}

function waitForEditorReady(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    (function tick() {
      const { root } = resolveEditorRoot();
      if (root && root.innerText?.length > 0) return resolve(root);
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now - t0 > timeoutMs) return resolve(null);
      requestAnimationFrame(tick);
    })();
  });
}

// --- Editor root resolution (TinyMCE-first) ---
function __resolveEditorRoot() {
  try {
    if (window.tinymce?.activeEditor) {
      const ed = window.tinymce.activeEditor;
      const body = ed.getBody?.();
      if (body && body.ownerDocument) return body;
    }
  } catch {}
  const iframeBody = document.querySelector(".tox-edit-area iframe")?.contentDocument?.body;
  if (iframeBody) return iframeBody;
  const contentRoot = document.querySelector("#editor-root");
  return contentRoot || null;
}

// --- Blanket remove ALL <mark> tags inside the editor body ---
function __clearEditorMarksImpl() {
  const root = __resolveEditorRoot();
  if (!root) return;
  const marks = root.querySelectorAll("mark");
  if (!marks.length) return;
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
}

// Expose globally for other modules (idempotent)
window.__clearEditorMarks = window.__clearEditorMarks || __clearEditorMarksImpl;

// Initial sweep after load (and a couple retries for late TinyMCE init)
document.addEventListener("DOMContentLoaded", () => {
  try { window.__clearEditorMarks?.(); } catch {}
  setTimeout(() => { try { window.__clearEditorMarks?.(); } catch {} }, 250);
  setTimeout(() => { try { window.__clearEditorMarks?.(); } catch {} }, 1000);
});

function toFlexibleWhitespaceRegex(phrase) {
  // Build a regex that tolerates newlines, NBSPs, and multiple spaces between words.
  // Also be a bit lenient around sentence punctuation.
  const escaped = escapeForRegex(phrase).trim();
  const tokens = escaped.split(/\s+/);
  const punctOpt = "[\\.,;:!?»“”\"'’)]?";
  const body = tokens.map((t, i) => {
    const core = t;
    if (i < tokens.length - 1) {
      return `${core}${punctOpt}[\\s\\u00A0]+`;
    }
    return core;
  }).join("");
  return new RegExp(body, "i");
}

function splitOnceSmart(phrase) {
  // Try to split near the middle on strong punctuation, else on nearest space.
  const p = String(phrase || '');
  const mid = Math.floor(p.length / 2);
  const strong = /[.!?;:]/g;
  let best = -1, bestDist = Infinity;

  let m;
  while ((m = strong.exec(p))) {
    const idx = m.index;
    const dist = Math.abs(idx - mid);
    if (dist < bestDist) { bestDist = dist; best = idx; }
  }

  if (best === -1) {
    const leftSpace  = p.lastIndexOf(" ", mid);
    const rightSpace = p.indexOf(" ", mid);
    const pick = (idx) => (idx >= 0 ? Math.abs(idx - mid) : Infinity);
    best = pick(leftSpace) <= pick(rightSpace) ? leftSpace : rightSpace;
  }

  if (best <= 0 || best >= p.length - 1) return null;

  const left  = p.slice(0, best).trim().replace(/^[^\w]+|[^\w]+$/g, "");
  const right = p.slice(best + 1).trim().replace(/^[^\w]+|[^\w]+$/g, "");
  if (!left || !right) return null;
  return [left, right];
}

// Cluster and dedupe cards by start offset (within window chars keep highest score)
function dedupeCardsByStart(cards, windowSize = 10) {
  try {
    const withOffsets = cards.filter(c => Number.isFinite(c?.start));
    if (withOffsets.length === 0) return { kept: cards, clusters: [] };

    // Sort by start asc for clustering
    const sorted = [...withOffsets].sort((a, b) => (a.start - b.start) || ((b.score ?? 0) - (a.score ?? 0)));

    const clusters = [];
    let current = [];
    let clusterMinStart = null;

    for (const card of sorted) {
      if (current.length === 0) {
        current.push(card);
        clusterMinStart = card.start;
        continue;
      }
      if (Math.abs(card.start - clusterMinStart) <= windowSize) {
        current.push(card);
      } else {
        clusters.push(current);
        current = [card];
        clusterMinStart = card.start;
      }
    }
    if (current.length) clusters.push(current);

    // Select winner per cluster (highest score, tie-breaker: earliest start)
    const winners = new Set();
    clusters.forEach(group => {
      let best = group[0];
      for (let k = 1; k < group.length; k++) {
        const cand = group[k];
        const bestScore = Number(best.score ?? -Infinity);
        const candScore = Number(cand.score ?? -Infinity);
        if (candScore > bestScore || (candScore === bestScore && cand.start < best.start)) {
          best = cand;
        }
      }
      winners.add(best);
    });

    // Keep all cards without offsets; for offset cards keep winners only
    const kept = cards.filter(c => !Number.isFinite(c?.start) || winners.has(c));

    return { kept, clusters };
  } catch (e) {
    console.warn('dedupeCardsByStart failed:', e);
    return { kept: cards, clusters: [] };
  }
}

// Expose lightweight highlight controls for card hover
// TODO: wire to your elements
// - editorRoot: the element containing the article content (e.g., TinyMCE iframe body)
// - hoverClass: the CSS class your highlight uses for hover state
// Selectors to EXCLUDE from marking (defensive, in case cards end up inside root)
const HL_EXCLUDES = [
  '#plag-cards',
  '.plag-card',
  '.sidebar',
  '.toolbar',
  '.floating-ui'
];

window.__applyHighlight = async function applyHighlight(matchText, opts = {}) {
  try {
    const hoverClass = opts.hoverClass || 'highlighted-phrase';

    // Resolve a safe editor root; if not ready, wait briefly (no document.body fallback)
    let { root, where } = opts.editorRoot ? { root: opts.editorRoot, where: 'provided' } : resolveEditorRoot();
    if (!root) {
      root = await waitForEditorReady();
      where = root ? 'waitForEditorReady()' : 'unresolved';
    }

    if (!root) {
      hlWarn('No editor root; abort highlight');
      return;
    }
    const MarkCtor = window.Mark || (window.tinymce && window.tinymce.activeEditor && window.Mark);

    const snippet = String(matchText || '');
    const info = {
      whereRoot: where,
      snippetLen: snippet.length,
      snippetPreview: snippet.slice(0, 120) + (snippet.length > 120 ? '…' : ''),
      totalHitsExact: 0,
      totalHitsFlex: 0,
      totalHitsSplit: 0,
      flexRegex: null,
      rootLen: (root?.innerText || '').length
    };
    hlLog('applyHighlight called');
    setHlPanel(info);

    if (!snippet || !root || !MarkCtor) {
      hlWarn('No snippet or root or Mark', { hasSnippet: !!snippet, hasRoot: !!root, hasMark: !!MarkCtor });
      return;
    }

    const mark = new MarkCtor(root);

    // 0) Clear previous temporary highlights of this class only
    try { mark.unmark({ className: hoverClass }); } catch (e) { hlWarn('unmark error', e); }

    const baseOpts = {
      className: hoverClass,
      separateWordSearch: false,
      acrossElements: true,
      ignoreJoiners: true,
      diacritics: true,
      exclude: HL_EXCLUDES,
      ignorePunctuation: ':;.,-–—()[]{}!¿?¡"\'`·*~_'.split(''),
    };

    // Pass 1: Exact text
    try {
      mark.mark(snippet, {
        ...baseOpts,
        done: (count) => {
          info.totalHitsExact = count;
          hlLog('Exact pass hits:', count);
          setHlPanel(info);
          if (count > 0) __debugLogFirstHighlight(root, hoverClass, 'exact');
        }
      });
    } catch (e) { hlWarn('Exact pass error', e); }
    if (info.totalHitsExact > 0) { __debugLogFirstHighlight(root, hoverClass, 'exact'); __scrollFirstHighlight(root, hoverClass, 'exact'); __isHighlighted = true; return; }

    // Pass 2: Flexible whitespace regex
    try {
      const flex = toFlexibleWhitespaceRegex(snippet);
      info.flexRegex = String(flex);
      setHlPanel(info);
      mark.markRegExp(flex, {
        ...baseOpts,
        done: (count) => {
          info.totalHitsFlex = count;
          hlLog('Flex regex pass hits:', count, 'regex=', info.flexRegex);
          setHlPanel(info);
          if (count > 0) __debugLogFirstHighlight(root, hoverClass, 'flex');
        }
      });
    } catch (e) { hlWarn('Flex regex build/error', e); }
    if (info.totalHitsFlex > 0) { __debugLogFirstHighlight(root, hoverClass, 'flex'); __scrollFirstHighlight(root, hoverClass, 'flex'); __isHighlighted = true; return; }

    // Pass 3: Split once → two partial highlights
    try {
      const parts = splitOnceSmart(snippet);
      if (parts && parts.length === 2) {
        const MIN_PART = 6;
        const [left, right] = parts;
        hlLog('Split parts:', { left, right });
        if (left.length >= MIN_PART) {
          mark.mark(left, { ...baseOpts, done: (c) => { info.totalHitsSplit += c; setHlPanel(info); if (c > 0) __debugLogFirstHighlight(root, hoverClass, 'split-left'); } });
        }
        if (right.length >= MIN_PART) {
          mark.mark(right, { ...baseOpts, done: (c) => { info.totalHitsSplit += c; setHlPanel(info); if (c > 0) __debugLogFirstHighlight(root, hoverClass, 'split-right'); } });
        }
        hlLog('Split pass hits total:', info.totalHitsSplit);
        setHlPanel(info);
        if (info.totalHitsSplit > 0) { __debugLogFirstHighlight(root, hoverClass, 'split'); __scrollFirstHighlight(root, hoverClass, 'split'); __isHighlighted = true; return; }
      } else {
        hlLog('SplitOnceSmart produced no viable parts');
      }
    } catch (e) { hlWarn('Split pass error', e); }
  } catch {}
};
window.__clearHighlight = function () {
  try {
    if (__marker) __marker.unmark();
  } catch {}
  __isHighlighted = false;
};

// Apply highlight scoped to a specific anchor (by href or data-mce-href)
window.__applyAnchorHighlight = function (href) {
  try {
    if (!href || !window.tinymce || !tinymce.activeEditor) return;
    const body = tinymce.activeEditor.getBody();
    const sel = `a[href="${CSS.escape(href)}"], a[data-mce-href="${CSS.escape(href)}"]`;
    const anchor = body.querySelector(sel);
    if (!anchor) return;
    // Reuse global marker but scope to anchor by creating a temporary Mark on body, then only marking inside anchor text
    // For reliable clear, set global marker to body and mark anchor.textContent within anchor context
    ensureMarker();
    if (!__marker) return;
    __marker.unmark({ done: () => {
      // Use a temporary marker scoped to the anchor so we only wrap inside that element
      const scoped = new window.Mark(anchor);
      scoped.mark(anchor.textContent || '', {
        separateWordSearch: false,
        className: 'highlighted-phrase',
        done: () => {
          try { anchor.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch {}
        }
      });
      __isHighlighted = true;
    }});
  } catch {}
};

function collectAnchorMapFromHTML(html) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const links = doc.querySelectorAll('a[href]');
    links.forEach(a => {
      const href = (a.getAttribute('href') || '').trim();
      const text = (a.textContent || '').trim();
      if (href) out.push({ href, text });
    });
  } catch {}
  return out;
}

function buildCardsFromResult(name, data, ctx = {}) {
  switch (name) {
    case 'Check plagiarism': {
      if (!data?.matches || data.matches.length === 0) return [];
      return data.matches.map((m, idx) => ({
        id: `plagiarism-${idx}`,
        severity: 'severe',
        header: 'Plagiarism instance found.',
        link: m?.url ? { url: m.url, text: m.title || 'source' } : undefined,
        snippet: m.sentence || ''
      }));
    }
    case 'Check broken links': {
      const broken = (data?.results || []).filter(r => !r.ok);
      try { console.log('[Links Debug] Broken links found:', broken); } catch {}
      const anchors = Array.isArray(ctx.anchors) ? ctx.anchors : [];
      function findAnchorText(url) {
        if (!url) return '';
        const exact = anchors.find(a => a.href === url && a.text);
        if (exact && exact.text) return exact.text;
        const contains = anchors.find(a => url.includes(a.href) && a.text);
        return contains && contains.text ? contains.text : '';
      }
      const cards = broken.map((b, idx) => {
        const anchorText = findAnchorText(b.url) || findAnchorText(b.finalUrl);
        try { console.log('[Links Debug] Card mapping:', { url: b.url, finalUrl: b.finalUrl, anchorText }); } catch {}
        return {
          id: `broken-link-${idx}`,
          severity: 'severe',
          header: 'Broken link found',
          link: { url: b.url, text: 'open' },
          detail: b.error || String(b.status || ''),
          phrase: anchorText || undefined,
          href: b.url,
          finalHref: b.finalUrl || undefined
        };
      });
      try { console.log('[Links Debug] Broken link cards created:', cards); } catch {}
      return cards;
    }
    case 'Scan for vague sentences': {
      const flags = data?.flags || [];
      return flags.map((f, idx) => ({
        id: `vague-${idx}`,
        severity: 'warning',
        header: 'Rewrite suggested.',
        rewrite: f.preview || '',
        reasons: Array.isArray(f.reasons) ? f.reasons.slice(0, 3) : [],
        phrase: typeof f.text === 'string' ? f.text : undefined
      }));
    }
    case 'Check design elements': {
      const flags = data?.design_elements?.flags || [];
      return flags.map((f, idx) => ({
        id: `design-${idx}`,
        severity: (f.rule === 'headings' && /aren't\s+phrased\s+as\s+questions|semantic\s+H2\/?H3/i.test(f.message || ''))
          ? 'neutral'
          : (/long|warning/i.test(f.level || '') ? 'warning' : 'neutral'),
        header: f.message || 'Design element issue',
        detail: f.paragraph_preview || f.heading_text || '',
        // Carry metadata for later enrichment into a highlight phrase
        rule: f.rule,
        locationStart: Array.isArray(f.location) ? f.location[0] : undefined,
        locationEnd: Array.isArray(f.location) ? f.location[1] : undefined,
        paragraphContent: f.paragraph_content,
        headingText: f.heading_text
      }));
    }
    case 'Check for HubSpot Mentions': {
      const gaps = data?.gaps || [];
      return gaps.map((g, idx) => ({
        id: `mentions-${idx}`,
        severity: 'warning',
        header: 'Brand mention gap detected.',
        detail: `Gap of ${g.words} words without a mention. Beginning of the gap is highlighted.`,
        // Carry word indices for later enrichment into a highlight phrase
        startWord: g.startWord,
        endWord: g.endWord
      }));
    }
    case 'Check legal review': {
      if (data?.decision !== 'review') return [];
      const topics = Array.isArray(data.topics_triggered) ? data.topics_triggered : [];
      if (!topics.length) return [{ id: 'legal-0', severity: 'severe', header: 'Requires legal review', detail: data.reasons || 'See topics triggered.' }];
      return topics.map((t, idx) => ({
        id: `legal-${idx}`,
        severity: 'warning',
        header: `Legal review: ${t}`,
        detail: data.reasons || ''
      }));
    }
  }
  return [];
}

async function orchestrateScan() {
  const settings = readSettings();
  let html = getContent({ as: 'html' });
  const text = getContent({ as: 'text' });

  // Clear any previous result cards immediately before scanning
  clearResults();
  ensureResultsPanel();

  // Build anchor map from current editor HTML for link highlighting
  const anchorMap = collectAnchorMapFromHTML(html);

  const steps = [];
  if (settings.links) steps.push({ name: 'Check broken links', run: (signal) => runLinksCheck(collectURLs(html), { signal }) });
  if (settings.plagiarism) steps.push({ name: 'Check plagiarism', run: (signal) => runPlagiarism(text, { signal }) });
  if (settings.legal) steps.push({ name: 'Check legal review', run: (signal) => runLegalReview(text, { signal }) });
  if (settings.vague) steps.push({ name: 'Scan for vague sentences', run: async (signal) => {
    const decodedHtml = typeof html === 'string' ? he.decode(html) : html;
    return runStyleCheck({ html: decodedHtml, text, debug: false }, { signal });
  } });
  if (settings.mentions) steps.push({ name: 'Check for HubSpot Mentions', run: async () => runMentionsCheck(text) });
  if (settings.design) steps.push({ name: 'Check design elements', run: (signal) => {
    const decodedHtml = typeof html === 'string' ? he.decode(html) : html;
    return runStyleCheck({ html: decodedHtml, text, designOnly: true }, { signal });
  }});

  showProgress(steps.map(s => ({ name: s.name })));

  const controller = new AbortController();
  // Buffer all cards and errors; render only after full scan completes
  const bufferedCards = [];
  const bufferedErrorCards = [];
  const scanMeta = {};
  for (let i = 0; i < steps.length; i++) {
    updateProgress(i, 'running');
    try {
      const stepStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      console.log('[Scan] Starting step', steps[i].name, { index: i + 1, total: steps.length });
      const data = await steps[i].run(controller.signal);
      const stepEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      console.log('[Scan] Finished step', steps[i].name, { elapsedMs: Math.round(stepEnd - stepStart) });
      if (steps[i].name === 'Check plagiarism') { scanMeta.plagScore = data?.score; }
      if (steps[i].name === 'Check broken links') { scanMeta.linksTotal = data?.results?.length; }
      if (steps[i].name === 'Check legal review') { scanMeta.legalDecision = data?.decision; scanMeta.legalTopics = data?.topics_triggered; }
      if (steps[i].name === 'Check plagiarism') {
        const enrichStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const textContent = getContent({ as: 'text' }) || '';
        const matches = Array.isArray(data?.matches) ? data.matches : [];
        console.log('[Plagiarism] Matches received:', matches.length);
        
        for (const m of matches) {
          const orig = (m && (m.sentence || m.text)) ? String(m.sentence || m.text).trim() : '';
          if (!orig) continue;

          const hit = findBestApproximateSpan(orig, textContent, {
            diceThreshold: 0.55,
            preferRelaxedMin: 20
          });

          if (hit) {
            if (LOG_PLAGIARISM_DEBUG) {
              try {
                console.log('%c[Plagiarism Approx]',
                  'color:#0b8e00',
                  '\nOriginal:', orig,
                  `\nMatched : ${hit.text}`,
                  `\nScore   : ${hit.score.toFixed(3)}`,
                  `\nSource  : ${hit.source}`,
                  `\nOffsets : [${hit.start}, ${hit.end}]`
                );
              } catch {}
            }
            // Stash the match back on the match object for card rendering later
            try { m.__approxMatch = { text: hit.text, start: hit.start, end: hit.end, score: hit.score }; } catch {}
          } else {
            if (LOG_PLAGIARISM_DEBUG) {
              try { console.log('%c[No approximate match found]', 'color:#b58900', orig); } catch {}
            }
          }
        }
        const enrichEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        console.log('[Plagiarism] Approx enrichment loop completed', { elapsedMs: Math.round(enrichEnd - enrichStart) });
      }
      if (steps[i].name === 'Scan for vague sentences') {
        const flags = Array.isArray(data?.flags) ? data.flags : [];
        const textContent = getContent({ as: 'text' }) || '';
        let total = 0;
        let found = 0;
        const missing = [];
        for (const f of flags) {
          if (typeof f?.text === 'string' && f.text.length) {
            total++;
            const needle = f.text;
            const hit = textContent.indexOf(needle) !== -1;
            if (hit) {
              found++;
            } else {
              missing.push(needle);
            }
          }
        }
        const notFound = total - found;
        // silent tallies

        // Store ONLY the first flagged phrase for on-demand highlighting via hotkey
        __highlightPhrase = flags.length > 0 && typeof flags[0]?.text === 'string' ? flags[0].text : null;
        __isHighlighted = false;
        if (!__hotkeyBound) {
          __hotkeyBound = true;
          document.addEventListener('keydown', (e) => {
            if ((e.key === 'h' || e.key === 'H') && __highlightPhrase && !__isHighlighted) {
              try {
                ensureMarker();
                if (__marker) {
                  __marker.unmark({ done: () => {
                    __marker.mark(__highlightPhrase, {
                      separateWordSearch: false,
                      className: 'highlighted-phrase'
                    });
                    __isHighlighted = true;
                  }});
                }
              } catch (err) {
                console.warn('Highlight hotkey failed:', err);
              }
            }
          });
          document.addEventListener('keyup', (e) => {
            if ((e.key === 'h' || e.key === 'H') && __isHighlighted && __marker) {
              try {
                __marker.unmark();
              } catch {}
              __isHighlighted = false;
            }
          });
        }
      }
      // Log editor HTML after this step's scan completes, before cards are created
      if (steps[i].name === 'Check plagiarism') {
        try {
          const editorHtmlSnapshot = getContent({ as: 'html' }) || '';
          console.log('[Plagiarism] Editor HTML snapshot (before cards)', editorHtmlSnapshot);
        } catch {}
      }

      const cards = buildCardsFromResult(steps[i].name, data, { anchors: anchorMap });
      if (steps[i].name === 'Check design elements') {
        try {
          const faqLocs = data?.design_elements?.faq?.locations;
          if (Array.isArray(faqLocs) && faqLocs.length) {
            const decodedHtml = typeof html === 'string' ? he.decode(html) : (html || '');
            const labels = faqLocs
              .map(r => (Array.isArray(r) && r.length === 2) ? ({ start: r[0], end: r[1], text: decodedHtml.slice(r[0], r[1]) }) : null)
              .filter(Boolean);
            if (labels.length) {
              console.log('[Design Elements] FAQ labels found:', labels);
            }
          }
          // Log all H2 headings found in current HTML
          try {
            const decodedHtml = typeof html === 'string' ? he.decode(html) : (html || '');
            const doc = new DOMParser().parseFromString(decodedHtml, 'text/html');
            const h2s = Array.from(doc.querySelectorAll('h2')).map(n => (n.textContent || '').trim()).filter(Boolean);
            console.log('[Design Elements] H2 headings found:', h2s);
          } catch {}
          // Log TL;DR labels and window word counts client-side if available in response
          try {
            const tldrLocs = data?.design_elements?.tldr?.locations;
            if (Array.isArray(tldrLocs) && tldrLocs.length) {
              const decodedHtml = typeof html === 'string' ? he.decode(html) : (html || '');
              const labels = tldrLocs
                .map(r => (Array.isArray(r) && r.length === 2) ? ({ start: r[0], end: r[1], text: decodedHtml.slice(r[0], r[1]) }) : null)
                .filter(Boolean);
              if (labels.length) console.log('[Design Elements] TLDR labels found:', labels);
              const [first] = tldrLocs;
              if (Array.isArray(first) && first.length === 2) {
                const start = first[0];
                const end = Math.min(decodedHtml.length, start + 600);
                const windowText = decodedHtml.slice(start, end).replace(/<[^>]*>/g, ' ');
                const wordsInWindow = (windowText.match(/\b[\w’'-]+\b/g) || []).length;
                console.log('[Design Elements] TLDR window words:', { wordsInWindow, start, end, windowChars: end - start });
              }
            }
          } catch {}
          // Enrich design cards with highlightable phrases
          try {
            const decodedHtml = typeof html === 'string' ? he.decode(html) : (html || '');
            for (const card of cards) {
              // For FAQ card, prefer the earliest detected label from server-provided locations
              if (card.rule === 'faq' && Array.isArray(data?.design_elements?.faq?.locations) && data.design_elements.faq.locations.length) {
                try {
                  const locs = [...data.design_elements.faq.locations].filter(r => Array.isArray(r) && r.length === 2).sort((a,b) => a[0] - b[0]);
                  const [s, e] = locs[0] || [];
                  if (Number.isFinite(s) && Number.isFinite(e)) {
                    const labelRaw = decodedHtml.slice(s, e).replace(/\u00a0/g, ' ');
                    const label = labelRaw.replace(/\s+/g, ' ').trim();
                    if (label) card.phrase = label;
                  }
                } catch {}
              }
              if (card.paragraphContent && !card.phrase) {
                // Use first ~20 words for stability
                const compact = String(card.paragraphContent).replace(/\s+/g, ' ').trim();
                const words = compact.split(/\s+/);
                card.phrase = words.slice(0, 20).join(' ');
                continue;
              }
              if (card.headingText && !card.phrase) {
                card.phrase = String(card.headingText).trim();
                continue;
              }
              if (Number.isFinite(card.locationStart) && Number.isFinite(card.locationEnd) && !card.phrase) {
                const raw = decodedHtml.slice(card.locationStart, card.locationEnd).replace(/\u00a0/g, ' ');
                const compact = raw.replace(/\s+/g, ' ').trim();
                const words = compact.split(/\s+/);
                card.phrase = words.slice(0, 12).join(' ');
              }
            }
          } catch {}
        } catch {}
      }
      if (steps[i].name === 'Check for HubSpot Mentions') {
        try {
          const plain = getContent({ as: 'text' }) || '';
          // Precompute word spans once to map word indices to char offsets
          const spans = [];
          try {
            const re = /\b[\w’'-]+\b/g;
            let m;
            while ((m = re.exec(plain)) !== null) {
              spans.push({ start: m.index, end: m.index + m[0].length });
            }
          } catch {}
          for (const card of cards) {
            if (!Number.isFinite(card?.startWord) || !Number.isFinite(card?.endWord)) continue;
            const start = card.startWord === 0 ? 0 : (spans[card.startWord] ? spans[card.startWord].end : 0);
            const end = card.endWord < spans.length ? spans[card.endWord].start : plain.length;
            // Normalize whitespace and shorten to a small, reliably matchable snippet
            const raw = plain.slice(start, end).replace(/\u00a0/g, ' ');
            const compact = raw.replace(/\s+/g, ' ').trim();
            const words = compact.split(/\s+/);
            const snippet = words.slice(0, 20).join(' ');
            if (snippet && !card.phrase) card.phrase = snippet;
          }
        } catch {}
      }
      if (steps[i].name === 'Check for HubSpot Mentions') {
        try {
          const gaps = Array.isArray(data?.gaps) ? data.gaps : [];
          if (gaps.length) {
            const plain = getContent({ as: 'text' }) || '';
            // Build word spans to translate word indices to character offsets
            const spans = [];
            try {
              const re = /\b[\w’'-]+\b/g;
              let m;
              while ((m = re.exec(plain)) !== null) {
                spans.push({ start: m.index, end: m.index + m[0].length });
              }
            } catch {}
            gaps.forEach((g, idx) => {
              const start = g.startWord === 0 ? 0 : (spans[g.startWord] ? spans[g.startWord].end : 0);
              const end = g.endWord < spans.length ? spans[g.endWord].start : plain.length;
              const segment = plain.slice(start, end);
              try {
                console.log('[HubSpot Mentions] Gap', idx, {
                  words: g.words,
                  startWord: g.startWord,
                  endWord: g.endWord,
                  start,
                  end,
                  text: segment
                });
              } catch {}
            });
            // Attach highlight phrases to existing mention cards (by id order)
            try {
              const c = document.querySelector('#results-content');
              if (c) {
                const existing = Array.from(c.children).filter(el => el.classList && el.classList.contains('result-card'));
                // Build the same segments array in order of gaps and add phrase via addResultCard after mapping
                // Since cards for mentions are added later in this loop, we will enrich via kept cards below before add
              }
            } catch {}
          }
        } catch {}
      }
      // Enrich plagiarism cards with approximate span offsets so clustering can work
      if (steps[i].name === 'Check plagiarism') {
        try {
          const textContentForOffsets = getContent({ as: 'text' }) || '';
          let enriched = 0;
          for (const card of cards) {
            const phrase = (typeof card?.snippet === 'string' && card.snippet) || (typeof card?.body === 'string' && card.body) || '';
            if (!phrase) continue;
            // Prefer match from step loop if available (more accurate per-item)
            const linked = (Array.isArray(data?.matches) ? data.matches : []).find(m => (m?.sentence || m?.text) === phrase);
            const stored = linked?.__approxMatch;
            const hit = stored || findBestApproximateSpan(phrase, textContentForOffsets, { diceThreshold: 0.55, preferRelaxedMin: 20 });
            if (hit) {
              card.start = hit.start;
              card.end = hit.end;
              card.matchText = hit.text;
              if (!Number.isFinite(card.score)) card.score = hit.score;
              enriched++;
            }
          }
          
        } catch {}
      }
      // Note: a second duplicate enrichment block previously re-ran approximate spans here.
      // Removed to avoid doubled work and UI freezes on large documents.
      const dedupeStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const { kept } = dedupeCardsByStart(cards, 10);
      const dedupeEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      console.log('[Scan] Cards built', {
        step: steps[i].name,
        raw: Array.isArray(cards) ? cards.length : 0,
        afterDedupe: Array.isArray(kept) ? kept.length : 0,
        dedupeMs: Math.round(dedupeEnd - dedupeStart)
      });
      // For plagiarism, compute simple found/not-found summary of matchText in current doc
      if (steps[i].name === 'Check plagiarism') {
        try {
          const plain = getContent({ as: 'text' }) || '';
          let totalPlag = 0;
          let foundPlag = 0;
          for (const c of kept) {
            totalPlag++;
            const m = (typeof c.matchText === 'string' && c.matchText.trim()) ? c.matchText : (typeof c.snippet === 'string' && c.snippet.trim() ? c.snippet : '');
            if (m && plain.indexOf(m) !== -1) foundPlag++;
          }
          const notFound = totalPlag - foundPlag;
          
          // Set hover-highlight phrase for all plagiarism cards (matchText preferred)
          for (const c of kept) {
            if (!c?.phrase) {
              const p = (typeof c.matchText === 'string' && c.matchText.trim()) ? c.matchText : (typeof c.snippet === 'string' && c.snippet.trim() ? c.snippet : '');
              if (p) c.phrase = p;
            }
          }
        } catch {}
      }
      // Defer rendering until the end of the scan
      bufferedCards.push(...kept);
      updateProgress(i, 'success');
    } catch (e) {
      updateProgress(i, 'error', e);
      // Defer error card rendering as well
      bufferedErrorCards.push({
        severity: 'severe',
        header: 'Check failed',
        detail: `${steps[i].name} failed: ${e.message || e}`
      });
      console.error('[Scan] Step failed', steps[i].name, e);
    }
  }

  // Render all buffered cards at once after the entire scan is complete
  // Sort cards by document offset when available; unknown offsets last
  try {
    const plain = getContent({ as: 'text' }) || '';
    const scored = bufferedCards.map((c, idx) => {
      // Prefer explicit numeric start
      if (Number.isFinite(c?.start)) return { c, start: Number(c.start), idx };
      // Best-effort: try to locate by phrase/snippet/matchText
      const probe = (typeof c.matchText === 'string' && c.matchText.trim())
        || (typeof c.phrase === 'string' && c.phrase.trim())
        || (typeof c.snippet === 'string' && c.snippet.trim())
        || (typeof c.body === 'string' && c.body.trim())
        || '';
      if (probe) {
        const hit = findBestApproximateSpan(probe, plain, { diceThreshold: 0.55, preferRelaxedMin: 20 });
        if (hit && Number.isFinite(hit.start)) return { c: { ...c, start: hit.start, end: hit.end, matchText: c.matchText || hit.text }, start: hit.start, idx };
        const ix = plain.indexOf(probe);
        if (ix !== -1) return { c, start: ix, idx };
      }
      return { c, start: Infinity, idx };
    });
    scored.sort((a, b) => (a.start === b.start ? a.idx - b.idx : a.start - b.start));
    for (const { c } of scored) addResultCard(c);
  } catch {
    for (const c of bufferedCards) addResultCard(c);
  }
  for (const c of bufferedErrorCards) addResultCard(c);

  // Fire-and-forget scan log — invisible to the user
  try {
    const countPrefix = (prefix) => bufferedCards.filter(c => c.id && c.id.startsWith(prefix)).length;
    const plagMatches = countPrefix('plagiarism-');
    const plagEnabled = steps.some(s => s.name === 'Check plagiarism');
    const logEntry = {
      timestamp:         new Date().toISOString(),
      checksRun:         steps.map(s => s.name).join(', '),
      plagiarismEnabled: plagEnabled,
      plagiarismScore:   scanMeta.plagScore ?? null,
      plagiarismMatches: plagEnabled ? plagMatches : null,
      plagiarismPassed:  plagEnabled ? (plagMatches === 0) : null,
      linksEnabled:      steps.some(s => s.name === 'Check broken links'),
      linksTotal:        scanMeta.linksTotal ?? null,
      linksBroken:       countPrefix('broken-link-'),
      legalEnabled:      steps.some(s => s.name === 'Check legal review'),
      legalDecision:     scanMeta.legalDecision ?? null,
      legalTopics:       Array.isArray(scanMeta.legalTopics) ? scanMeta.legalTopics.join(', ') : (scanMeta.legalTopics ?? null),
      vagueEnabled:      steps.some(s => s.name === 'Scan for vague sentences'),
      vagueFlags:        countPrefix('vague-'),
      mentionsEnabled:   steps.some(s => s.name === 'Check for HubSpot Mentions'),
      mentionsGaps:      countPrefix('mentions-'),
      designEnabled:     steps.some(s => s.name === 'Check design elements'),
      designFlags:       countPrefix('design-'),
    };
    fetch('/log-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logEntry)
    }).catch(() => {});
  } catch {}

  summarizeScan('Scan complete.');
}

document.addEventListener('DOMContentLoaded', async () => {
  await initEditor({ el: '#docArea' });
  // Remove placeholder prompt per request
  setPlaceholder('');
  wireSettingsPanel();
  restoreResults();

  // Sidebar resize wiring
  try {
    const layout = document.querySelector('.layout');
    const resizer = document.getElementById('sidebar-resizer');
    const sidebar = document.querySelector('.side-panel');
    const root = document.documentElement;
    if (layout && resizer && sidebar) {
      // Initialize width from localStorage if present
      const saved = localStorage.getItem('sidebarWidthPx');
      if (saved) {
        const px = Math.max(0, parseInt(saved, 10) || 0);
        root.style.setProperty('--sidebar-width', px + 'px');
      }

      const getClamp = () => {
        const minVar = getComputedStyle(root).getPropertyValue('--sidebar-min').trim();
        const maxVar = getComputedStyle(root).getPropertyValue('--sidebar-max').trim();
        const parseSize = (v) => {
          if (!v) return NaN;
          if (v.endsWith('px')) return parseFloat(v);
          if (v.endsWith('rem')) return parseFloat(v) * parseFloat(getComputedStyle(document.body).fontSize || '16');
          if (v.endsWith('%')) return (parseFloat(v) / 100) * layout.clientWidth;
          return parseFloat(v);
        };
        return {
          min: Number.isFinite(parseSize(minVar)) ? parseSize(minVar) : 280,
          max: Number.isFinite(parseSize(maxVar)) ? parseSize(maxVar) : 800
        };
      };

      let startX = 0;
      let startWidth = 0;
      let dragging = false;

      const onMouseMove = (e) => {
        if (!dragging) return;
        const delta = (e.clientX || 0) - startX;
        const next = Math.max(0, startWidth - delta); // sidebar on right, border dragged left/right
        const { min, max } = getClamp();
        const clamped = Math.max(min, Math.min(max, next));
        root.style.setProperty('--sidebar-width', clamped + 'px');
      };

      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('is-resizing');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', endDrag);
        // Persist width
        const computed = getComputedStyle(sidebar).width;
        const px = Math.round(parseFloat(computed));
        if (Number.isFinite(px)) localStorage.setItem('sidebarWidthPx', String(px));
      };

      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = layout.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        startX = e.clientX;
        startWidth = sidebarRect.width;
        dragging = true;
        document.body.classList.add('is-resizing');
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', endDrag);
      });

      // Keyboard accessibility: left/right arrows adjust by 10px
      resizer.addEventListener('keydown', (e) => {
        const step = (e.shiftKey ? 40 : 10);
        const current = parseFloat(getComputedStyle(sidebar).width) || 0;
        const { min, max } = getClamp();
        if (e.key === 'ArrowLeft') {
          const next = Math.max(min, Math.min(max, current + step));
          root.style.setProperty('--sidebar-width', next + 'px');
          localStorage.setItem('sidebarWidthPx', String(Math.round(next)));
          e.preventDefault();
        } else if (e.key === 'ArrowRight') {
          const next = Math.max(min, Math.min(max, current - step));
          root.style.setProperty('--sidebar-width', next + 'px');
          localStorage.setItem('sidebarWidthPx', String(Math.round(next)));
          e.preventDefault();
        }
      });
    }
  } catch (err) {
    console.warn('Sidebar resize wiring failed:', err);
  }

  const scanBtn = document.getElementById('scan-document');
  const clearBtn = document.getElementById('clear-results');
  if (scanBtn) scanBtn.addEventListener('click', () => { orchestrateScan(); });
  if (clearBtn) clearBtn.addEventListener('click', () => { clearResults(); clearProgress(); });
});


