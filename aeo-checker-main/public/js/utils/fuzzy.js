// utils/fuzzy.js
// Public API:
//   findBestFuzzyMatch(needle: string, haystackLines: string[], opts?) -> { match, score, index } | null

export function defaultPreprocess(s) {
  if (!s) return '';
  return String(s)
    .replace(/<br\s*\/>?/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    // strip leading parenthetical label blocks
    .replace(/^(\([^)]*\)\s*)+/g, '')
    // normalize unicode punctuation
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .trim()
    .toLowerCase();
}

export function findBestFuzzyMatch(needle, haystackLines, opts = {}) {
  const fs = window.fuzzysort;
  if (!fs) {
    console.warn('[fuzzy] fuzzysort not loaded');
    return null;
  }
  const {
    threshold = 0.30,     // relax for sentence-length matches
    limit = 1,
    preprocess = defaultPreprocess
  } = opts;

  const q = preprocess(needle || '');
  if (!q) return null;

  // Keep raw + preprocessed + original index
  const targets = haystackLines.map((t, i) => ({
    i,
    raw: String(t || ''),
    val: preprocess(String(t || ''))
  })).filter(x => x.val.length > 0);

  if (!targets.length) return null;

  // Search by the preprocessed key; results[i].obj points back to our object
  const results = fs.go(q, targets, { key: 'val', limit, threshold });
  if (!results || !results.length) return null;

  const r = results[0];
  const score = Number(r.score ?? 0);
  if (score < threshold) return null;

  return {
    match: r.obj.raw,  // original unmodified line
    score,
    index: r.obj.i
  };
}

