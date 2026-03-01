const HUBSPOT_TERMS = [
  /hubspot crm/i,
  /marketing hub/i,
  /sales hub/i,
  /service hub/i,
  /cms hub/i,
  /operations hub/i,
  /hubspot/i
];

function wordCount(t = '') { return (t.trim().match(/\b[\w’'-]+\b/g) || []).length; }
function hasMention(t = '') { return HUBSPOT_TERMS.some(re => re.test(t)); }
function wordStartPositions(t = '') {
  const starts = []; const re = /\b[\w’'-]+\b/g; let m; while ((m = re.exec(t)) !== null) starts.push(m.index); return starts;
}
function mentionCharPositions(t = '') {
  const positions = []; for (const re of HUBSPOT_TERMS) { const r = new RegExp(re, re.flags.includes('g') ? re.flags : re.flags + 'g'); let m; while ((m = r.exec(t)) !== null) positions.push(m.index); }
  return positions.sort((a,b)=>a-b);
}
function charToWordIndices(charPositions, wordStarts) {
  const out = []; let wi = 0; for (const cp of charPositions) { while (wi + 1 < wordStarts.length && wordStarts[wi + 1] <= cp) wi++; out.push(wi); } return out;
}

export function runMentionsCheck(text, targetWords = 800) {
  const full = String(text || '');
  const totalWords = wordCount(full);
  const wStarts = wordStartPositions(full);
  const mentionWordIdx = charToWordIndices(mentionCharPositions(full), wStarts);

  const gaps = [];
  if (mentionWordIdx.length === 0) {
    gaps.push({ startWord: 0, endWord: totalWords });
  } else {
    if (mentionWordIdx[0] > 0) gaps.push({ startWord: 0, endWord: mentionWordIdx[0] });
    for (let i = 1; i < mentionWordIdx.length; i++) gaps.push({ startWord: mentionWordIdx[i-1], endWord: mentionWordIdx[i] });
    gaps.push({ startWord: mentionWordIdx[mentionWordIdx.length - 1], endWord: totalWords });
  }

  const globalFlags = gaps
    .filter(g => (g.endWord - g.startWord) > targetWords)
    .map(g => ({ type: 'global-gap', words: g.endWord - g.startWord, startWord: g.startWord, endWord: g.endWord }));

  return { gaps: globalFlags, hits: mentionWordIdx.length };
}


