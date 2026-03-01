import { postJSON } from '../utils/net.js';

export async function runLinksCheck(urls, { signal } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { results: [], meta: { broken: 0, skipped: true } };
  }
  const res = await postJSON('/check-links', { urls }, { signal });
  const results = Array.isArray(res?.results) ? res.results : [];
  const broken = results.filter(r => !r.ok).length;
  return { results, meta: { broken } };
}


