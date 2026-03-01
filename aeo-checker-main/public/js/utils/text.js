export function extractTextFromHTML(html = "") {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

export function splitSentences(text = "") {
  if (!text) return [];
  // Normalize <br> -> \n early in case HTML-ish text leaked in
  const pre = String(text)
    .replace(/<br\s*\/>?/gi, '\n')
    .replace(/\r/g, '');

  // Split by newline and sentence-ish boundaries fallback
  const lines = pre.split(/\n+/);

  const sentences = [];
  for (let raw of lines) {
    if (!raw) continue;

    // Trim and collapse internal whitespace
    let s = raw.trim().replace(/\s+/g, ' ');

    // Strip leading test/label parentheses and similar "meta" prefixes
    // e.g. "(Plagiarism Canary 2 – ...)" "(Vague ...)" "(Expect: ...)"
    s = s.replace(/^(\([^)]*\)\s*)+/g, '');   // drop any leading (...) groups

    // Skip headings/short fragments
    if (s.length < 20) continue;
    if (/^[^\w\s]*$/.test(s)) continue;               // just symbols
    if (/^[A-Z\s]+$/.test(s)) continue;               // SHOUTY HEADINGS
    if (/^(TL;DR|FAQ|Q&A|Steps|Plan|Draft|Review|Publish)\b/i.test(s)) continue;

    // If a line ends with obvious sentence punctuation, keep as-is;
    // otherwise keep long-enough lines as fallback "sentences".
    if (/^[A-Z].*[.!?]["”’]?$/i.test(s) || s.length > 40) {
      sentences.push(s);
    }
  }

  return sentences;
}

export function collectURLs(html = "") {
  const urls = new Set();
  const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = aRe.exec(html)) !== null) {
    const href = (m[1] || '').trim();
    if (!href) continue;
    const low = href.toLowerCase();
    if (low.startsWith('javascript:') || low.startsWith('data:')) continue;
    urls.add(href);
  }
  return Array.from(urls);
}


