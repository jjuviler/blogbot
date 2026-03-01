import { postJSON } from '../utils/net.js';

export async function runPlagiarism(text, { signal } = {}) {
  const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  try {
    console.log('[Plagiarism] Starting request to /plagiarism', {
      textLength: (text || '').length
    });
    // Ensure no stale highlights before a new scan
    try { window.__clearEditorMarks?.(); } catch {}
    const res = await postJSON('/plagiarism', { text }, { signal });
    const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const elapsedMs = Math.round(endedAt - startedAt);
    console.log('[Plagiarism] Response received from /plagiarism', {
      elapsedMs,
      status: res?.status,
      decision: res?.decision,
      matchesCount: Array.isArray(res?.matches) ? res.matches.length : 0,
      sourcesCount: Array.isArray(res?.sources) ? res.sources.length : 0,
      policySuppressed: !!res?.policySuppressed,
      checkedAt: res?.checkedAt,
      mode: res?.mode,
      pollAttempts: res?.pollAttempts,
      serverDurationMs: res?.durationMs
    });
    return {
      status: res.status || 'ok',
      score: res.score ?? 0,
      sources: res.sources || [],
      matches: res.matches || [],
      decision: res.decision || 'allow',
      policySuppressed: !!res.policySuppressed,
      mode: res.mode,
      pollAttempts: res.pollAttempts,
      durationMs: res.durationMs,
      checkedAt: res.checkedAt
    };
  } catch (err) {
    const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const elapsedMs = Math.round(endedAt - startedAt);
    console.error('[Plagiarism] Request failed', {
      elapsedMs,
      error: String(err?.message || err)
    });
    throw err;
  }
}


