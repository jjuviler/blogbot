// utils/approx.js
// Dependency-free approximate substring matcher for ~sentence length strings.
// Strategy: exact -> relaxed (punct-stripped) -> Dice(bigrams) sliding window.
//
// Public:
//   findBestApproximateSpan(needle: string, haystack: string, opts?) =>
//     { start, end, text, score, source } | null
//
// Notes:
// - `start`/`end` are best-effort offsets into the ORIGINAL haystack.
// - For relaxed/dice phases, offsets are approximations (good enough for logging / later mark.js).
// - Keep thresholds modest; you’ll tune with real data.

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const SMART_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]|\u0092/g; // ’ and friends
const SMART_DOUBLE = /[\u201C\u201D\u201E\u201F\u2033]/g;        // “ ”
const DASHES = /[\u2012-\u2015\u2212]/g;                        // en/em/minus variants
const MULTI_SPACE = /\s+/g;

// Base normalizer that also returns an index map from normalized->original
function normalizeWithMap(input) {
  const src = String(input || '');
  const out = [];
  const map = []; // map[normIndex] = originalIndex

  // We perform replacements char-by-char to keep a map.
  for (let i = 0; i < src.length; i++) {
    let ch = src[i];

    // Remove zero width chars (skip mapping)
    if (ZERO_WIDTH.test(ch)) continue;

    // Normalize smart punctuation/dashes
    if (SMART_QUOTES.test(ch)) ch = "'";
    else if (SMART_DOUBLE.test(ch)) ch = '"';
    else if (DASHES.test(ch)) ch = '-';

    out.push(ch);
    map.push(i);
  }

  let joined = out.join('').toLowerCase();

  // Collapse whitespace to single spaces and maintain a coarse map
  const collapsed = [];
  const collapsedMap = [];
  {
    let lastWasSpace = false;
    for (let i = 0; i < joined.length; i++) {
      const ch = joined[i];
      const isSpace = /\s/.test(ch);
      if (isSpace) {
        if (lastWasSpace) continue;
        lastWasSpace = true;
        collapsed.push(' ');
        collapsedMap.push(map[i]);
      } else {
        lastWasSpace = false;
        collapsed.push(ch);
        collapsedMap.push(map[i]);
      }
    }
  }

  const norm = collapsed.join('').trim();
  // Trim mapping alignment: remove leading/trailing spaces changed by trim()
  let startTrim = 0;
  while (startTrim < collapsed.length && collapsed[startTrim] === ' ') startTrim++;
  let endTrim = collapsed.length;
  while (endTrim > startTrim && collapsed[endTrim - 1] === ' ') endTrim--;

  return {
    norm,
    map: collapsedMap.slice(startTrim, endTrim)
  };
}

// Relaxed normalizer: strip most punctuation as well
function normalizeRelaxedWithMap(input) {
  const base = normalizeWithMap(input);
  const out = [];
  const m = [];
  for (let i = 0; i < base.norm.length; i++) {
    const ch = base.norm[i];
    // Keep letters, numbers, spaces only
    if (/[\p{L}\p{N} ]/u.test(ch)) {
      out.push(ch);
      m.push(base.map[i]);
    }
  }
  // Collapse spaces again after punct strip
  const s = out.join('').replace(MULTI_SPACE, ' ').trim();
  // Rebuild simple map aligned to s by walking
  const remap = [];
  {
    let j = 0;
    for (let i = 0; i < out.length && j < s.length; i++) {
      if (out[i] === s[j]) {
        remap.push(m[i]);
        j++;
      }
    }
  }
  return { norm: s, map: remap };
}

// Exact/relaxed index mapping back to original
function mapBack(map, start, end) {
  if (!map.length) return { start: 0, end: 0 };
  const s = Math.max(0, Math.min(start, map.length - 1));
  const e = Math.max(0, Math.min(end - 1, map.length - 1));
  return { start: map[s], end: map[e] + 1 };
}

// Bigram helpers for Dice coefficient
function bigrams(s) {
  const arr = [];
  for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2));
  return arr;
}
function multiset(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}
function diceScore(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const A = multiset(bigrams(a));
  const B = multiset(bigrams(b));
  let inter = 0;
  for (const [k, va] of A.entries()) {
    const vb = B.get(k) || 0;
    inter += Math.min(va, vb);
  }
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return total ? (2 * inter) / total : 0;
}

// Gather candidate anchor positions by searching a prefix
function anchorPositions(hayNorm, needleNorm, minPref = 6, maxPref = 12, maxHits = 50) {
  const hits = new Set();
  for (let pref = Math.min(maxPref, needleNorm.length); pref >= minPref; pref--) {
    const prefix = needleNorm.slice(0, pref);
    let from = 0, count = 0;
    while (count < maxHits) {
      const idx = hayNorm.indexOf(prefix, from);
      if (idx === -1) break;
      hits.add(idx);
      count++;
      from = idx + 1;
    }
    if (hits.size) break; // prefer longer prefix anchors
  }
  return [...hits].sort((a, b) => a - b);
}

// Sliding window Dice around anchors (or whole doc if no anchors)
function bestDiceWindow(hayNorm, needleNorm, windowPad = 0.3, scanStep = 2, anchors = []) {
  const nLen = needleNorm.length;
  if (!nLen || !hayNorm.length) return null;
  const minLen = Math.max(15, Math.floor(nLen * (1 - windowPad)));
  const maxLen = Math.ceil(nLen * (1 + windowPad));

  let best = { score: 0, start: 0, end: 0, text: '' };

  const scanRegions = [];
  if (anchors.length) {
    for (const a of anchors) {
      const s = Math.max(0, a - Math.floor(nLen * 0.5));
      const e = Math.min(hayNorm.length, a + Math.floor(nLen * 1.5));
      scanRegions.push([s, e]);
    }
  } else {
    scanRegions.push([0, hayNorm.length]);
  }

  for (const [rs, re] of scanRegions) {
    for (let winLen = minLen; winLen <= maxLen; winLen += Math.max(3, Math.floor(nLen * 0.1))) {
      for (let i = rs; i + winLen <= re; i += scanStep) {
        const sub = hayNorm.slice(i, i + winLen);
        const sc = diceScore(needleNorm, sub);
        if (sc > best.score) best = { score: sc, start: i, end: i + winLen, text: sub };
      }
    }
  }
  return best.score > 0 ? best : null;
}

export function findBestApproximateSpan(needle, haystack, opts = {}) {
  const {
    diceThreshold = 0.55,     // accept Dice matches above this
    preferRelaxedMin = 20,    // if needle is >= this, try relaxed before Dice
  } = opts;

  const original = String(haystack || '');
  const needleStr = String(needle || '').trim();
  if (!needleStr || !original) return null;

  // Phase 1: normalized exact
  const H = normalizeWithMap(original);
  const N = normalizeWithMap(needleStr);
  let idx = H.norm.indexOf(N.norm);
  if (idx !== -1) {
    const { start, end } = mapBack(H.map, idx, idx + N.norm.length);
    return {
      start, end,
      text: original.slice(start, end),
      score: 1,
      source: 'exact'
    };
  }

  // Phase 2: relaxed (punct stripped) exact (only if needle is reasonably long)
  if (needleStr.length >= preferRelaxedMin) {
    const Hr = normalizeRelaxedWithMap(original);
    const Nr = normalizeRelaxedWithMap(needleStr);
    idx = Hr.norm.indexOf(Nr.norm);
    if (idx !== -1) {
      const { start, end } = mapBack(Hr.map, idx, idx + Nr.norm.length);
      return {
        start, end,
        text: original.slice(start, end),
        score: 0.9,
        source: 'relaxed'
      };
    }
  }

  // Phase 3: Dice(bigrams) sliding window (anchor by prefix if possible)
  const anchors = anchorPositions(H.norm, N.norm);
  const best = bestDiceWindow(H.norm, N.norm, 0.3, 2, anchors);
  if (best && best.score >= diceThreshold) {
    const { start, end } = mapBack(H.map, best.start, best.end);
    return {
      start, end,
      text: original.slice(start, end),
      score: best.score,
      source: 'dice'
    };
  }

  return null;
}


