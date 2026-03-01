// server.js
// Node 18+ recommended (built-in fetch)

import express from "express";
import { logScan } from "./sheets-logger.js";
import compression from "compression";
import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- .env loader (no dependency) ----
try {
  const envPath = path.join(__dirname, ".env");
  if (fsSync.existsSync(envPath)) {
    const raw = fsSync.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#")) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch {}

const app = express();

console.log('[Server Debug] Server starting up...');
const PORT = process.env.PORT || 3000;

// ---- Config ----
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3:8b";
const LEGAL_TOPICS_PATH = path.join(__dirname, "legal-topics.txt");

const FETCH_TIMEOUT_MS = 12000;
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || "60000", 10); // 60s
const MAX_GUIDELINES = 60000; // ~60k chars
const MAX_DRAFT = 40000;      // ~40k chars

// ---- Middleware / static ----
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

// Log all requests
app.use((req, res, next) => {
  console.log(`[Request Debug] ${req.method} ${req.path}`);
  next();
});

// ---- Health ----
app.post("/log-scan", async (req, res) => {
  try {
    await logScan(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[/log-scan] Logging error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// ============================================================================
// 1) Broken Links checker
// ============================================================================
app.post("/check-links", async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: "Provide { urls: string[] }" });
  }

  const LIMIT = 6; // concurrency
  const results = [];
  let i = 0;

  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const url = urls[idx];
      results[idx] = await checkUrl(url);
    }
  }

  await Promise.all(Array.from({ length: Math.min(LIMIT, urls.length) }, worker));
  res.json({ results });
});

async function checkUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET", // HEAD can be unreliable; GET follows redirects by default
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "aeo-checker/0.1 (+local)" }
    });

    clearTimeout(timeout);
    const finalUrl = res.url || url;
    return {
      url,
      finalUrl,
      status: res.status,
      ok: res.ok,
      redirectCount: url === finalUrl ? 0 : 1, // simple signal
      error: null
    };
  } catch (err) {
    clearTimeout(timeout);
    return {
      url,
      finalUrl: null,
      status: null,
      ok: false,
      redirectCount: 0,
      error: classifyError(err)
    };
  }
}

function classifyError(err) {
  if (err?.name === "AbortError") return "timeout";
  const msg = String(err?.message || err);
  if (/ENOTFOUND|DNS|getaddrinfo/i.test(msg)) return "dns";
  if (/TLS|certificate/i.test(msg)) return "tls";
  return "network";
}

// ============================================================================
// 2) Legal Review via local LLM (Ollama)
// ============================================================================
let LEGAL_GUIDELINES_CACHE = null;

async function loadLegalGuidelines() {
  try {
    const txt = await fs.readFile(LEGAL_TOPICS_PATH, "utf8");
    LEGAL_GUIDELINES_CACHE = (txt || "").slice(0, MAX_GUIDELINES).trim();
    return LEGAL_GUIDELINES_CACHE;
  } catch (e) {
    LEGAL_GUIDELINES_CACHE = null;
    throw new Error(`Unable to read legal-topics.txt at ${LEGAL_TOPICS_PATH}. ${e.message}`);
  }
}

app.post("/legal-review", async (req, res) => {
  try {
    const draftIn = (req.body?.text ?? "").toString();
    if (!draftIn) return res.status(400).json({ error: "Provide { text }" });

    const draft = draftIn.slice(0, MAX_DRAFT);
    const guidelines = LEGAL_GUIDELINES_CACHE ?? await loadLegalGuidelines();
    if (!guidelines) return res.status(500).json({ error: "Legal guidelines unavailable" });

    const prompt = buildLegalPrompt(guidelines, draft);
    let llmJson;
    try {
      llmJson = await callOpenAIJSON({
        base: OPENAI_BASE,
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        prompt,
        timeoutMs: OLLAMA_TIMEOUT_MS
      });
    } catch (e) {
      // Try backup model on primary model failure
      llmJson = await callOpenAIJSON({
        base: OPENAI_BASE,
        apiKey: OPENAI_API_KEY,
        model: OPENAI_BACKUP_MODEL,
        prompt,
        timeoutMs: OLLAMA_TIMEOUT_MS
      });
    }

    return res.json(llmJson);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

function buildLegalPrompt(guidelines, draft) {
  return [
    `SYSTEM:`,
    `You are HubSpot’s legal triage assistant. Your job is to decide if a draft MUST be reviewed by Legal before publication, based on the internal guidelines provided. Be conservative: when in doubt, choose REVIEW.`,
    ``,
    `OUTPUT FORMAT (STRICT JSON, no extra text):`,
    `{`,
    `  "decision": "review" | "clear",`,
    `  "topics_triggered": string[],`,
    `  "reasons": string,`,
    `  "confidence": number,`,
    `  "excerpts": [ {"text": string, "topic": string} ]`,
    `}`,
    ``,
    `CRITERIA:`,
    `- REVIEW if the draft appears to touch or risk touching any listed topic (e.g., M&A, strategic alliances, first product/service debut or sunset, pricing changes, business model changes, partner program/policy changes, exclusivity statements, customer data statements, laws/policy/legal topics like GDPR/CCPA/Section 230/antitrust, forward-looking statements/roadmap, interpretations/promises beyond Customer Terms/AUP/Privacy Policy, absolute security/reliability claims, competitor comparisons/claims, other non-public or confidential information).`,
    `- CLEAR only if none of the above are implicated.`,
    `- If the guidelines indicate involvement of groups like IR/Finance/PR, still choose REVIEW and include those labels under topics_triggered.`,
    ``,
    `GUIDELINES (verbatim, internal-only):`,
    guidelines,
    ``,
    `DRAFT TO EVALUATE (public-facing copy):`,
    draft,
    ``,
    `INSTRUCTIONS:`,
    `- Read both sections once.`,
    `- Decide: "review" vs "clear".`,
    `- If REVIEW, include which topics and 1–3 short excerpts that triggered the decision.`,
    `- Keep reasons concise and practical for a writer.`,
    `- Respond with STRICT JSON only—no prose outside the JSON.`
  ].join("\n");
}

async function callOllamaJSON({ url, model, prompt, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 256
        }
      })
    });

    clearTimeout(t);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Ollama error ${resp.status}: ${txt || resp.statusText}`);
    }

    const json = await resp.json(); // { response: "...", ... }
    const raw = (json && json.response) ? json.response.trim() : "";

    try {
      return JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}$/);
      if (m) return JSON.parse(m[0]);
      throw new Error(`Model did not return valid JSON: ${raw.slice(0, 300)}...`);
    }
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// OpenAI: strict JSON caller (responses should be raw JSON string we can parse)
async function callOpenAIJSON({ base, apiKey, model, prompt, timeoutMs = 15000 }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for STYLE_PROVIDER=openai");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You reply ONLY with strict JSON. No backticks, no extra text." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });
    clearTimeout(t);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`OpenAI error ${resp.status}: ${txt || resp.statusText}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return JSON.parse(content);
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// OpenAI: plain text capture (best-effort), used only for debugging raw
async function callOpenAIText({ base, apiKey, model, prompt, timeoutMs = 15000 }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for STYLE_PROVIDER=openai");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Reply with the JSON object only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      })
    });
    clearTimeout(t);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`OpenAI error ${resp.status}: ${txt || resp.statusText}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || "";
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ---- Start ----
app.listen(PORT, () => {
  console.log(`AEO checker server running at http://localhost:${PORT}`);
  console.log(`Provider: OpenAI — Primary Model: ${OPENAI_MODEL} — Backup Model: ${OPENAI_BACKUP_MODEL} — Base: ${OPENAI_BASE}`);
});

// ============================================================================
// 3) Plagiarism checker (Originality.ai)
// ============================================================================
const ORIGINALITY_API_BASE = process.env.ORIGINALITY_API_BASE || "https://api.originality.ai/api/v3";
const ORIGINALITY_API_KEY  = process.env.ORIGINALITY_API_KEY || "";
const ORIGINALITY_USER_AGENT = "aeo-checker/1.0";
const ORIGINALITY_TIMEOUT_MS = 115_000;

// Cap outgoing plagiarism payload to avoid massive JSON downloads
const PLAG_MAX_MATCHES_OUT = parseInt(process.env.PLAG_MAX_MATCHES_OUT || "300", 10);
const PLAG_MAX_SOURCES_OUT = parseInt(process.env.PLAG_MAX_SOURCES_OUT || "50", 10);

// Paging configuration (lossless paging)
const PLAG_PAGE_SIZE = parseInt(process.env.PLAG_PAGE_SIZE || "300", 10);
const PLAG_SOURCE_PAGE_SIZE = parseInt(process.env.PLAG_SOURCE_PAGE_SIZE || "50", 10);
const SCAN_TTL_MS = parseInt(process.env.SCAN_TTL_MS || String(10 * 60 * 1000), 10); // 10 min
const scans = new Map(); // scanId -> { payload, expiresAt }

// Length guard toggle (default OFF) — never drop by length unless enabled
const ENABLE_MIN_LENGTH_GUARD = process.env.ENABLE_MIN_LENGTH_GUARD === "1";
const MIN_SNIPPET_CHARS = parseInt(process.env.MIN_SNIPPET_CHARS || "60", 10);

// --- Snippet guards (same logic as your TS route) --------------------------
const PLAG_MIN_SNIPPET_CHARS = 60;
const PLAG_MAX_STOPWORD_RATIO = 0.70;

const PLAG_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","as","because","while","when","than","so","that",
  "of","in","on","at","to","from","for","with","about","into","through","during","before","after","between","under","over",
  "is","am","are","was","were","be","been","being","do","does","did","have","has","had","can","could","will","would","should","may","might","must",
  "this","that","these","those","it","its","they","them","their","he","she","his","her","we","us","our","you","your","i","me","my",
  "all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","too","very","once","again","here","there","now"
]);

function plagStopwordRatio(s) {
  const tokens = (String(s).toLowerCase().match(/[a-z']+/g) || []).filter(t => t.length > 1);
  if (tokens.length === 0) return 1;
  let stop = 0;
  for (const t of tokens) if (PLAG_STOPWORDS.has(t)) stop++;
  return stop / tokens.length;
}

function plagAcceptSnippet(raw) {
  const s = String(raw).replace(/\s+/g, " ").trim();
  const shouldDropForLength = ENABLE_MIN_LENGTH_GUARD && (s.length < MIN_SNIPPET_CHARS);
  if (shouldDropForLength) return false; // default: do NOT drop by length
  if (plagStopwordRatio(s) > PLAG_MAX_STOPWORD_RATIO) return false;
  return true;
}

// --- Source policy: allow/deny + boilerplate paths --------------------------
const PLAG_ALLOWLIST_ROOTS = new Set([]);
const PLAG_DENYLIST_ROOTS = new Set([
  "dictionary.com","merriam-webster.com","oxforddictionaries.com","thesaurus.com",
  "cambridge.org","brainyquote.com","goodreads.com","wiktionary.org",
  "issuu.com","scribd.com","slideshare.net","studocu.com"
]);

const PLAG_BOILERPLATE_PATH_RE =
  /(\/privacy|\/terms|\/legal|\/cookies|\/about|\/sitemap|\/robots\.txt)(\/|$)|(?:-privacy|-terms)(?:\/|$)/i;

const PLAG_MULTIPART_TLDS = new Set([
  "co.uk","org.uk","ac.uk","gov.uk",
  "com.au","net.au","org.au",
  "co.jp",
  "com.br","com.mx","com.cn","com.tr","com.sg","com.hk","com.tw"
]);

function plagDomainRoot(host) {
  const parts = String(host).toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  if (PLAG_MULTIPART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

function plagGetBlockReason(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const root = plagDomainRoot(host);
    const path = u.pathname.toLowerCase();

    if (PLAG_ALLOWLIST_ROOTS.has(root)) return null;
    if (host === "hubspot.com" || host.endsWith(".hubspot.com")) return "companyOwned";
    if (PLAG_BOILERPLATE_PATH_RE.test(path)) return "boilerplatePath";
    if (PLAG_DENYLIST_ROOTS.has(root) || PLAG_DENYLIST_ROOTS.has(host)) return "denylisted";

    return null;
  } catch {
    return "malformedUrl";
  }
}

function plagSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function plagSafeJson(res) { try { return await res.json(); } catch { return null; } }

function plagFindAllRanges(haystack, needle, cap = 8) {
  const ranges = [];
  const H = String(haystack);
  const N = String(needle);
  if (!H || !N) return ranges;
  let idx = 0;
  while (ranges.length < cap) {
    idx = H.indexOf(N, idx);
    if (idx === -1) break;
    const end = idx + N.length;
    ranges.push([idx, end]);
    idx = end || (idx + 1);
  }
  return ranges;
}

// ---------------- In-memory scan cache (TTL) ----------------
function now() { return Date.now(); }

function saveScan(scanId, payload) {
  scans.set(scanId, { payload, expiresAt: now() + SCAN_TTL_MS });
}
function getScan(scanId) {
  const rec = scans.get(scanId);
  if (!rec) return null;
  if (now() > rec.expiresAt) { scans.delete(scanId); return null; }
  return rec.payload;
}
function sweepScans() {
  const t = now();
  let removed = 0;
  for (const [k, v] of scans.entries()) if (t > v.expiresAt) { scans.delete(k); removed++; }
  if (removed) console.log("[Plagiarism] sweepScans removed", { removed, remaining: scans.size });
}
setInterval(sweepScans, 60 * 1000).unref?.();

// ---------------- Overlap merge + sorting utilities ----------------
// Sort strongest first: prefer higher score, then longer span
function sortMatches(ms) {
  return [...(ms || [])].sort((a, b) => {
    const sa = Number(a?.score ?? a?.weight ?? 0);
    const sb = Number(b?.score ?? b?.weight ?? 0);
    if (sb !== sa) return sb - sa;
    const la = Math.max(0, Number(a?.end ?? 0) - Number(a?.start ?? 0));
    const lb = Math.max(0, Number(b?.end ?? 0) - Number(b?.start ?? 0));
    return lb - la;
  });
}

// Merge overlapping/near-duplicate intervals; keep the stronger match and union sources
function mergeOverlaps(matches, overlapChars = 20) {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  const byStart = [...matches].sort((a, b) => (Number(a.start) - Number(b.start)));
  const out = [];
  for (const m of byStart) {
    if (!Number.isFinite(m.start) || !Number.isFinite(m.end)) { out.push(m); continue; }
    const last = out[out.length - 1];
    if (last && m.start <= (last.end + overlapChars)) {
      // choose stronger representative
      const sLast = Number(last?.score ?? last?.weight ?? 0);
      const sM = Number(m?.score ?? m?.weight ?? 0);
      const keep = sM > sLast ? { ...m } : { ...last };
      keep.start = Math.min(last.start, m.start);
      keep.end   = Math.max(last.end, m.end);
      const srcA = Array.isArray(last?.sources) ? last.sources : [];
      const srcB = Array.isArray(m?.sources) ? m.sources : [];
      const srcSet = new Map();
      for (const s of [...srcA, ...srcB]) {
        const key = typeof s === "string" ? s : (s?.url || s?.id || JSON.stringify(s));
        if (!srcSet.has(key)) srcSet.set(key, s);
      }
      keep.sources = [...srcSet.values()];
      out[out.length - 1] = keep;
    } else {
      out.push(m);
    }
  }
  return out;
}

// Reduce plagiarism response size while preserving totals for UI display
function capPlagPayload(normalized) {
  const totalMatches = Array.isArray(normalized?.matches) ? normalized.matches.length : 0;
  const totalSources = Array.isArray(normalized?.sources) ? normalized.sources.length : 0;

  const matches = Array.isArray(normalized?.matches) ? normalized.matches : [];
  const sortedMatches = [...matches].sort((a, b) => (Number(b?.weight ?? 0) - Number(a?.weight ?? 0)));
  const cappedMatches = sortedMatches.slice(0, PLAG_MAX_MATCHES_OUT);

  const sources = Array.isArray(normalized?.sources) ? normalized.sources : [];
  const cappedSources = sources.slice(0, PLAG_MAX_SOURCES_OUT);

  return {
    ...normalized,
    matches: cappedMatches,
    sources: cappedSources,
    meta: {
      totalMatches,
      totalSources,
      usedMatches: cappedMatches.length,
      usedSources: cappedSources.length
    }
  };
}

async function originalityCreateScan({ text, signal }) {
  const payload = {
    title: "AEO checker ad-hoc scan",
    check_ai: false,
    check_plagiarism: true,
    check_facts: false,
    check_readability: false,
    check_grammar: false,
    check_contentOptimizer: false,
    storeScan: false,
    aiModelVersion: "lite",
    content: text,
  };
  
  console.log('[Originality.ai] Request payload (redacted content length):', { contentLength: (text || '').length });
  
  const resp = await fetch(`${ORIGINALITY_API_BASE}/scan`, {
    method: "POST",
    headers: {
      "X-OAI-API-KEY": ORIGINALITY_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal
  });
  
  console.log('[Originality.ai] Create scan response:', { status: resp.status, statusText: resp.statusText });
  return resp;
}

async function originalityGetScan(scanId, { signal }) {
  const resp = await fetch(`${ORIGINALITY_API_BASE}/scan/${encodeURIComponent(scanId)}`, {
    method: "GET",
    headers: {
      "X-OAI-API-KEY": ORIGINALITY_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": ORIGINALITY_USER_AGENT,
    },
    signal
  });
  return resp;
}

/** Normalize -> { score, sources[{url,title,percent}], matches[{url,title,sentence,weight,ranges}], policySuppressed } */
function plagNormalize(api, fullText) {
  const plag = api?.results?.plagiarism;
  if (!plag) return null;

  const score = typeof plag.score === "number" ? plag.score : Number(plag.score ?? 0);

  const aggMap = new Map(); // link -> { url, title?, count }
  const matches = [];
  const drops = { companyOwned: 0, boilerplatePath: 0, denylisted: 0, malformedUrl: 0 };
  let rawCount = 0; // as returned by Originality (pre-guards)

  const outer = Array.isArray(plag?.results) ? plag.results : [];
  for (const entry of outer) {
    const inner = Array.isArray(entry?.results) ? entry.results : [];
    for (const match of inner) {
      // Count raw items before any guards
      const scoresArr = Array.isArray(match?.scores) ? match.scores : [];
      if (scoresArr.length > 0) {
        for (const s of scoresArr) {
          const sentence = typeof s?.sentence === "string" ? s.sentence : "";
          if (sentence) rawCount++;
        }
      } else {
        const phraseRaw = typeof entry?.phrase === "string" ? entry.phrase : "";
        if (phraseRaw) rawCount++;
      }

      const link = match?.link;
      if (!link) { drops.malformedUrl++; continue; }

      const reason = plagGetBlockReason(link);
      if (reason) { drops[reason]++; continue; }

      const title = match?.title;

      let acceptedCount = 0;
      if (scoresArr.length > 0) {
        for (const s of scoresArr) {
          const sentence = typeof s?.sentence === "string" ? s.sentence : "";
          if (!sentence) continue;
          if (!plagAcceptSnippet(sentence)) continue;

          acceptedCount++;
          const weight = typeof s?.score === "number" ? s.score : undefined;
          const ranges = plagFindAllRanges(fullText, sentence, 4);
          matches.push({ url: link, title, sentence, weight, ranges });
        }
      } else {
        const phrase = typeof entry?.phrase === "string" ? entry.phrase : "";
        if (phrase && plagAcceptSnippet(phrase)) {
          acceptedCount = 1;
          const ranges = plagFindAllRanges(fullText, phrase, 4);
          matches.push({ url: link, title, sentence: phrase, ranges });
        }
      }

      if (acceptedCount > 0) {
        const prev = aggMap.get(link);
        if (prev) {
          prev.count += acceptedCount;
          if (!prev.title && title) prev.title = title;
        } else {
          aggMap.set(link, { url: link, title, count: acceptedCount });
        }
      }
    }
  }

  console.log(
    `[plagiarism] kept ${matches.length} snippet(s) after guards (min=${PLAG_MIN_SNIPPET_CHARS}, maxStop=${PLAG_MAX_STOPWORD_RATIO})`
  );
  try { console.log("[Plagiarism][Metrics] rawCount:", rawCount); } catch {}
  try { console.log("[Plagiarism][Metrics] guardedCount:", matches.length); } catch {}

  const agg = Array.from(aggMap.values());
  const total = agg.reduce((sum, a) => sum + a.count, 0);
  const sources = total > 0
    ? agg.map(a => ({ url: a.url, title: a.title, percent: (a.count / total) * 100 }))
         .sort((a, b) => b.percent - a.percent)
    : [];

  const policySuppressed = (drops.companyOwned + drops.boilerplatePath + drops.denylisted) > 0;

  console.log(
    `[plagiarism] dropped — company:${drops.companyOwned}, boilerplate:${drops.boilerplatePath}, denylist:${drops.denylisted}, malformed:${drops.malformedUrl}`
  );

  return { score, sources, matches, policySuppressed, stageCounts: { rawCount, guardedCount: matches.length } };
}

// POST /plagiarism { text: string }
app.post("/plagiarism", async (req, res) => {
  try {
    if (!ORIGINALITY_API_KEY) {
      return res.status(502).json({ 
        status: "error", 
        error: "Plagiarism check unavailable: ORIGINALITY_API_KEY not configured. Please set the ORIGINALITY_API_KEY environment variable." 
      });
    }
    const text = (req.body?.text || "").toString();
    if (!text.trim()) {
      return res.status(400).json({ status: "error", error: "Missing text" });
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ORIGINALITY_TIMEOUT_MS);

    try {
      const reqStarted = Date.now();
      const createRes = await originalityCreateScan({ text, signal: ctrl.signal });

      if (createRes.status === 429) {
        clearTimeout(t);
        return res.status(429).json({ status: "error", error: "Rate limited by Originality.ai (429)." });
      }

      const initial = await plagSafeJson(createRes);
      console.log('[Plagiarism] Create response parsed JSON keys:', initial ? Object.keys(initial) : null);
      if (!createRes.ok || !initial) {
        clearTimeout(t);
        
        // Check for account-level restrictions
        const responseText = initial?.message || initial?.error || '';
        if (createRes.status === 422 && (
          responseText.includes('unable to start scan') || 
          responseText.includes('invalid or missing scan properties') ||
          responseText.includes('This API Key is not activated')
        )) {
          console.warn('[Plagiarism] Account restriction detected, disabling plagiarism check:', {
            status: createRes.status,
            message: responseText,
            timestamp: new Date().toISOString(),
            endpoint: `${ORIGINALITY_API_BASE}/scan`,
            keyPrefix: ORIGINALITY_API_KEY.substring(0, 8) + '...',
            contentLength: text.length
          });
          
          return res.json({
            status: "ok",
            decision: "disabled",
            score: 0,
            sources: [],
            matches: [],
            policySuppressed: false,
            disabled_reason: "Account not enabled for API scans",
            checkedAt: Date.now()
          });
        }
        
        console.error('[Plagiarism] API Error:', {
          status: createRes.status,
          statusText: createRes.statusText,
          response: initial,
          url: `${ORIGINALITY_API_BASE}/scan`,
          timestamp: new Date().toISOString(),
          keyPrefix: ORIGINALITY_API_KEY.substring(0, 8) + '...',
          contentLength: text.length
        });
        const msg = initial?.message || initial?.error || `${createRes.status} ${createRes.statusText}`;
        return res.status(createRes.status || 502).json({ 
          status: "error", 
          error: msg,
          details: initial
        });
      }

      const normalizedNow = plagNormalize(initial, text);
      if (normalizedNow) {
        clearTimeout(t);
        const durationMs = Date.now() - reqStarted;
        console.log('[Plagiarism] Immediate result from create:', {
          durationMs,
          matches: normalizedNow.matches?.length || 0,
          sources: normalizedNow.sources?.length || 0,
          score: normalizedNow.score
        });
        console.log("[Plagiarism] normalized raw counts:", {
          matches: normalizedNow?.matches?.length ?? 0,
          sources: normalizedNow?.sources?.length ?? 0,
        });

        // Lossless paging: merge overlaps, cache full, return first page
        const withOffsets = Array.isArray(normalizedNow.matches) ? normalizedNow.matches.map(m => {
          const r0 = Array.isArray(m?.ranges) && m.ranges.length ? m.ranges[0] : null;
          const s = Array.isArray(r0) && r0.length === 2 ? r0[0] : undefined;
          const e = Array.isArray(r0) && r0.length === 2 ? r0[1] : undefined;
          const score = Number(m?.weight ?? 0);
          return { ...m, start: Number.isFinite(s) ? s : undefined, end: Number.isFinite(e) ? e : undefined, score };
        }) : [];
        const mergedMatches = mergeOverlaps(withOffsets || []);
        const sortedMatches = sortMatches(mergedMatches);
        console.log("[Plagiarism] merge/sort:", {
          before: normalizedNow?.matches?.length ?? 0,
          after: sortedMatches.length,
          reducedBy: (normalizedNow?.matches?.length ?? 0) - sortedMatches.length,
        });
        // Stage metrics
        const stageCounts = {
          rawCount: Number(normalizedNow?.stageCounts?.rawCount || 0),
          guardedCount: Number(normalizedNow?.stageCounts?.guardedCount || (Array.isArray(withOffsets) ? withOffsets.length : 0)),
          mergedCount: Array.isArray(mergedMatches) ? mergedMatches.length : 0,
          sortedCount: Array.isArray(sortedMatches) ? sortedMatches.length : 0,
          page1Count: 0,
        };
        try { console.log("[Plagiarism][Metrics] mergedCount:", stageCounts.mergedCount); } catch {}
        try { console.log("[Plagiarism][Metrics] sortedCount:", stageCounts.sortedCount); } catch {}

        const cacheScanId = crypto.randomUUID();
        const fullPayload = {
          ...normalizedNow,
          matches: sortedMatches,
          sources: Array.isArray(normalizedNow.sources) ? normalizedNow.sources : [],
          createdAt: now()
        };
        saveScan(cacheScanId, fullPayload);

        const pageMatches = sortedMatches.slice(0, PLAG_PAGE_SIZE);
        const pageSources = fullPayload.sources.slice(0, PLAG_SOURCE_PAGE_SIZE);
        stageCounts.page1Count = Array.isArray(pageMatches) ? pageMatches.length : 0;
        try { console.log("[Plagiarism][Metrics] page1Count:", stageCounts.page1Count); } catch {}
        const decision = sortedMatches.length > 0 ? "block" : "allow";
        const nextCursorMatches = (PLAG_PAGE_SIZE < sortedMatches.length)
          ? { offset: PLAG_PAGE_SIZE, limit: PLAG_PAGE_SIZE }
          : null;
        const nextCursorSources = (PLAG_SOURCE_PAGE_SIZE < fullPayload.sources.length)
          ? { offset: PLAG_SOURCE_PAGE_SIZE, limit: PLAG_SOURCE_PAGE_SIZE }
          : null;
        if (sortedMatches.length > PLAG_PAGE_SIZE && !nextCursorMatches) {
          console.warn("[Plagiarism][Metrics] WARNING: pagination expected but nextCursor missing");
        }
        console.log("[Plagiarism] cached scan", {
          scanId: cacheScanId,
          totalMatches: sortedMatches.length,
          totalSources: fullPayload.sources.length,
          pageSizeMatches: PLAG_PAGE_SIZE,
          pageSizeSources: PLAG_SOURCE_PAGE_SIZE,
          nextCursorMatches: !!nextCursorMatches,
          nextCursorSources: !!nextCursorSources,
          stageCounts,
          durationMs: Date.now() - reqStarted,
        });

        const responseBody = {
          status: "ok",
          scanId: cacheScanId,
          decision,
          score: normalizedNow.score ?? 0,
          policySuppressed: !!normalizedNow.policySuppressed,
          meta: {
            totalMatches: sortedMatches.length,
            totalSources: fullPayload.sources.length,
            pageSize: PLAG_PAGE_SIZE,
            sourcePageSize: PLAG_SOURCE_PAGE_SIZE,
            stageCounts,
          },
          matches: pageMatches,
          sources: pageSources,
          nextCursor: { matches: nextCursorMatches, sources: nextCursorSources },
          checkedAt: Date.now(),
          mode: 'immediate',
          pollAttempts: 0,
          durationMs
        };
        return res.json(responseBody);
      }

      const scanId =
        initial?.results?.properties?.id ??
        initial?.id ??
        null;

      if (!scanId) {
        clearTimeout(t);
        return res.status(502).json({ status: "error", error: "Unexpected response: no scan id" });
      }

      const start = Date.now();
      let polls = 0;
      while (Date.now() - start < 60_000) {
        await plagSleep(1000);

        const getRes = await originalityGetScan(scanId, { signal: ctrl.signal });

        if (getRes.status === 429) {
          await plagSleep(1500);
          continue;
        }

        const got = await plagSafeJson(getRes);
        polls++;
        console.log('[Plagiarism] Poll result:', { status: getRes.status, ok: getRes.ok, keys: got ? Object.keys(got) : null, polls });
        if (!getRes.ok || !got) {
          clearTimeout(t);
          const msg = got?.message || got?.error || `${getRes.status} ${getRes.statusText}`;
          return res.status(502).json({ status: "error", error: `Result fetch failed: ${msg}` });
        }

        const normalizedLater = plagNormalize(got, text);
        if (normalizedLater) {
          clearTimeout(t);
          const totalMs = Date.now() - reqStarted;
          console.log('[Plagiarism] Polled result returned:', {
            totalMs,
            polls,
            matches: normalizedLater.matches?.length || 0,
            sources: normalizedLater.sources?.length || 0,
            score: normalizedLater.score
          });
          console.log("[Plagiarism] normalized raw counts:", {
            matches: normalizedLater?.matches?.length ?? 0,
            sources: normalizedLater?.sources?.length ?? 0,
          });

          // Lossless paging: merge overlaps, cache full, return first page
          const withOffsets = Array.isArray(normalizedLater.matches) ? normalizedLater.matches.map(m => {
            const r0 = Array.isArray(m?.ranges) && m.ranges.length ? m.ranges[0] : null;
            const s = Array.isArray(r0) && r0.length === 2 ? r0[0] : undefined;
            const e = Array.isArray(r0) && r0.length === 2 ? r0[1] : undefined;
            const score = Number(m?.weight ?? 0);
            return { ...m, start: Number.isFinite(s) ? s : undefined, end: Number.isFinite(e) ? e : undefined, score };
          }) : [];
          const mergedMatches = mergeOverlaps(withOffsets || []);
          const sortedMatches = sortMatches(mergedMatches);
          console.log("[Plagiarism] merge/sort:", {
            before: normalizedLater?.matches?.length ?? 0,
            after: sortedMatches.length,
            reducedBy: (normalizedLater?.matches?.length ?? 0) - sortedMatches.length,
          });
          // Stage metrics
          const stageCounts = {
            rawCount: Number(normalizedLater?.stageCounts?.rawCount || 0),
            guardedCount: Number(normalizedLater?.stageCounts?.guardedCount || (Array.isArray(withOffsets) ? withOffsets.length : 0)),
            mergedCount: Array.isArray(mergedMatches) ? mergedMatches.length : 0,
            sortedCount: Array.isArray(sortedMatches) ? sortedMatches.length : 0,
            page1Count: 0,
          };
          try { console.log("[Plagiarism][Metrics] mergedCount:", stageCounts.mergedCount); } catch {}
          try { console.log("[Plagiarism][Metrics] sortedCount:", stageCounts.sortedCount); } catch {}

          const cacheScanId = crypto.randomUUID();
          const fullPayload = {
            ...normalizedLater,
            matches: sortedMatches,
            sources: Array.isArray(normalizedLater.sources) ? normalizedLater.sources : [],
            createdAt: now()
          };
          saveScan(cacheScanId, fullPayload);

          const pageMatches = sortedMatches.slice(0, PLAG_PAGE_SIZE);
          const pageSources = fullPayload.sources.slice(0, PLAG_SOURCE_PAGE_SIZE);
          stageCounts.page1Count = Array.isArray(pageMatches) ? pageMatches.length : 0;
          try { console.log("[Plagiarism][Metrics] page1Count:", stageCounts.page1Count); } catch {}
          const decision = sortedMatches.length > 0 ? "block" : "allow";
          const nextCursorMatches = (PLAG_PAGE_SIZE < sortedMatches.length)
            ? { offset: PLAG_PAGE_SIZE, limit: PLAG_PAGE_SIZE }
            : null;
          const nextCursorSources = (PLAG_SOURCE_PAGE_SIZE < fullPayload.sources.length)
            ? { offset: PLAG_SOURCE_PAGE_SIZE, limit: PLAG_SOURCE_PAGE_SIZE }
            : null;
          if (sortedMatches.length > PLAG_PAGE_SIZE && !nextCursorMatches) {
            console.warn("[Plagiarism][Metrics] WARNING: pagination expected but nextCursor missing");
          }
          console.log("[Plagiarism] cached scan", {
            scanId: cacheScanId,
            totalMatches: sortedMatches.length,
            totalSources: fullPayload.sources.length,
            pageSizeMatches: PLAG_PAGE_SIZE,
            pageSizeSources: PLAG_SOURCE_PAGE_SIZE,
            nextCursorMatches: !!nextCursorMatches,
            nextCursorSources: !!nextCursorSources,
            stageCounts,
            durationMs: Date.now() - reqStarted,
          });

          const responseBody = {
            status: "ok",
            scanId: cacheScanId,
            decision,
            score: normalizedLater.score ?? 0,
            policySuppressed: !!normalizedLater.policySuppressed,
            meta: {
              totalMatches: sortedMatches.length,
              totalSources: fullPayload.sources.length,
              pageSize: PLAG_PAGE_SIZE,
              sourcePageSize: PLAG_SOURCE_PAGE_SIZE,
              stageCounts,
            },
            matches: pageMatches,
            sources: pageSources,
            nextCursor: { matches: nextCursorMatches, sources: nextCursorSources },
            checkedAt: Date.now(),
            mode: 'polled',
            pollAttempts: polls,
            durationMs: totalMs
          };
          return res.json(responseBody);
        }
      }

      clearTimeout(t);
      const totalMs = Date.now() - reqStarted;
      console.warn('[Plagiarism] Timeout waiting for results', { totalMs, polls });
      return res.status(504).json({ status: "error", error: "Timed out waiting for plagiarism results.", durationMs: totalMs, pollAttempts: polls });
    } catch (e) {
      clearTimeout(t);
      const aborted = e?.name === "AbortError";
      return res.status(aborted ? 504 : 500).json({
        status: "error",
        error: aborted ? "Timed out while waiting for Originality.ai" : String(e?.message || e)
      });
    }
  } catch (err) {
    return res.status(500).json({ status: "error", error: String(err?.message || err) });
  }
});

// ---------------- Paging endpoints (lossless) ----------------
// GET /plagiarism/matches?scanId=&offset=0&limit=300&minScore=0
app.get("/plagiarism/matches", (req, res) => {
  const t0 = Date.now();
  const scanId = String(req.query.scanId || "");
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
  const limit  = parseInt(String(req.query.limit  ?? String(PLAG_PAGE_SIZE)), 10) || PLAG_PAGE_SIZE;
  const minScore = req.query.minScore != null ? Number(req.query.minScore) : null;

  const full = getScan(scanId);
  if (!full) {
    console.warn("[Plagiarism] matches 404 (expired or missing)", { scanId });
    return res.status(404).json({ error: "scan not found or expired" });
  }

  let matches = Array.isArray(full.matches) ? full.matches : [];
  if (Number.isFinite(minScore)) matches = matches.filter(m => Number(m?.score ?? m?.weight ?? 0) >= minScore);

  const total = matches.length;
  const slice = matches.slice(offset, offset + limit);
  const nextCursor = (offset + limit) < total ? { offset: offset + limit, limit } : null;

  console.log("[Plagiarism] matches page", {
    scanId,
    offset,
    limit,
    minScore: (minScore ?? null),
    total: total,
    returned: slice.length,
    next: !!nextCursor,
    durationMs: Date.now() - t0,
  });

  return res.json({
    status: "ok",
    scanId,
    meta: { totalMatches: total, offset, limit },
    matches: slice,
    nextCursor
  });
});

// GET /plagiarism/sources?scanId=&offset=0&limit=50
app.get("/plagiarism/sources", (req, res) => {
  const t1 = Date.now();
  const scanId = String(req.query.scanId || "");
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
  const limit  = parseInt(String(req.query.limit  ?? String(PLAG_SOURCE_PAGE_SIZE)), 10) || PLAG_SOURCE_PAGE_SIZE;

  const full = getScan(scanId);
  if (!full) {
    console.warn("[Plagiarism] sources 404 (expired or missing)", { scanId });
    return res.status(404).json({ error: "scan not found or expired" });
  }

  const sources = Array.isArray(full.sources) ? full.sources : [];
  const total = sources.length;
  const slice = sources.slice(offset, offset + limit);
  const nextCursor = (offset + limit) < total ? { offset: offset + limit, limit } : null;

  console.log("[Plagiarism] sources page", {
    scanId,
    offset,
    limit,
    total,
    returned: slice.length,
    next: !!nextCursor,
    durationMs: Date.now() - t1,
  });

  return res.json({
    status: "ok",
    scanId,
    meta: { totalSources: total, offset, limit },
    sources: slice,
    nextCursor
  });
});

// ============================================================================
// 4) Style check: LLM judge + overlap gate (debuggable)
//    POST /api/stylecheck  { text?: string, sentences?: string[], debug?: boolean, bypassOverlap?: boolean }
// ============================================================================
const OLLAMA_BASE = process.env.OLLAMA_BASE || process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_JUDGE_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b-instruct-q5_K_M";
const STYLE_TIMEOUT_MS = parseInt(process.env.STYLECHECK_TIMEOUT_MS || "45000", 10); // per-call
const STYLE_MIN_WORDS = parseInt(process.env.MIN_WORDS || "10", 10);
const STYLE_OVERLAP_DELTA = Number(process.env.OVERLAP_DELTA || "0.20");
const STYLE_PROVIDER = 'openai'; // Always use OpenAI, no Ollama backup
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_BACKUP_MODEL = process.env.OPENAI_BACKUP_MODEL || 'gpt-4o-mini';
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com';
const STYLE_MAX_JUDGED = parseInt(
  process.env.STYLE_MAX_JUDGED || (STYLE_PROVIDER === 'openai' ? '24' : '100')
, 10);

app.post("/api/stylecheck", async (req, res) => {
  console.log(`[API Debug] /api/stylecheck called with designOnly: ${!!req.body?.designOnly}`);
  console.log(`[API Debug] Request body keys:`, Object.keys(req.body || {}));
  try {
    const debug = !!(req.body?.debug || req.query?.debug);
    const bypassOverlap = !!(req.body?.bypassOverlap || req.query?.bypassOverlap);
    const originalText = typeof req.body?.text === "string" ? req.body.text : null;
    const designOnly = !!(req.body?.designOnly || req.query?.designOnly);

    // ---- 0) Ingest: text OR sentences[] OR html --------------------------
    let sentences = [];
    if (Array.isArray(req.body?.sentences)) {
      sentences = req.body.sentences.map(s => String(s || "").trim());
    } else if (typeof req.body?.html === "string" && req.body.html.trim()) {
      sentences = splitSentencesFromHTML(req.body.html);
    } else if (typeof req.body?.text === "string" && req.body.text.trim()) {
      sentences = splitSentences(req.body.text);
    } else {
      return res.status(400).json({ error: "Provide { sentences: string[] } or { text: string } or { html: string }" });
    }

    // hard cap: first 100 sentences
    sentences = sentences.slice(0, 100);
    
    console.log('[Style Check Debug] Input text length:', req.body.text?.length || 0);
    console.log('[Style Check Debug] Input HTML length:', req.body.html?.length || 0);
    console.log('[Style Check Debug] Split into sentences:', sentences.length);
    console.log('[Style Check Debug] First 5 sentences:', sentences.slice(0, 5).map(s => s.substring(0, 100) + '...'));

    // If design-only, skip prefilters + LLM; just compute design elements and return fast
    if (designOnly) {
      try {
        // Use HTML content if available for better H2 detection, otherwise use text
        const contentForAnalysis = req.body?.html || originalText || sentences.join("\n");
        console.log(`[Design Elements Debug] Using content for analysis: ${contentForAnalysis.length} chars`);
        const design = analyzeDesignElements(contentForAnalysis, true); // designOnly = true
        return res.json({
        flags: [],
        meta: {
          total: sentences.length,
          unique: sentences.length,
          considered: 0,
          flagged: 0,
          skipped: [],
          distribution: { judged_total: 0, judge_true: 0, judge_false: 0, overlap_kept: 0, overlap_dropped: 0 },
          debug: !!debug,
          bypassOverlap: !!bypassOverlap,
          model: STYLE_PROVIDER === 'openai' ? OPENAI_MODEL : OLLAMA_JUDGE_MODEL,
          baseUrl: STYLE_PROVIDER === 'openai' ? OPENAI_BASE : OLLAMA_BASE,
          provider: STYLE_PROVIDER,
          thresholds: { minWords: STYLE_MIN_WORDS, overlapDelta: STYLE_OVERLAP_DELTA, maxJudged: 0 }
        },
        judged: undefined,
        sample: debug ? sentences.slice(0, 8) : undefined,
        design_elements: design
      });
      } catch (error) {
        console.error('[Design Elements Error]', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // ---- 1) Pre-filters (cheap) --------------------------------------------
    const seen = new Set(); // dedupe on normalized key
    const skips = [];
    const candidates = [];

    console.log('[Style Check Debug] Starting pre-filtering for', sentences.length, 'sentences');
    
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].trim();
      const reason = shouldSkip(s, seen);
      if (reason) {
        skips.push({ i, reason, text: s }); // include text for visibility
        console.log(`[Style Check Debug] Skipped sentence ${i}: "${s.substring(0, 50)}..." - Reason: ${reason}`);
      } else {
        candidates.push({ i, text: s });
        console.log(`[Style Check Debug] Candidate sentence ${i}: "${s.substring(0, 50)}..."`);
      }
    }
    
    console.log('[Style Check Debug] Pre-filtering results:', {
      total: sentences.length,
      skipped: skips.length,
      candidates: candidates.length
    });

    // ---- 2) LLM judge (concurrent, small pool) -----------------------------
    // To avoid long waits/cost with hosted APIs, cap how many we judge per request.
    const toJudge = Array.isArray(candidates) && candidates.length > STYLE_MAX_JUDGED
      ? candidates.slice(0, STYLE_MAX_JUDGED)
      : candidates;
    
    console.log('[Style Check Debug] Sending', toJudge.length, 'sentences to LLM judge');
    console.log('[Style Check Debug] Sentences to judge:', toJudge.map(item => `"${item.text.substring(0, 50)}..."`));
    
    const judged = await mapWithConcurrency(
      toJudge,
      4, // concurrency
      (item) => judgeSentenceLLM(item.text, { url: OLLAMA_BASE, model: OLLAMA_JUDGE_MODEL, timeoutMs: STYLE_TIMEOUT_MS, debug })
        .then(out => ({ ...item, judge: out }))
        .catch(e => ({ ...item, judge: { should_flag: false, reasons: [`llm_error:${String(e?.message || e)}`], minimal_rewrite: "" } }))
    );
    
    console.log('[Style Check Debug] LLM judging results:', judged.map(r => ({
      text: r.text.substring(0, 50) + '...',
      should_flag: r.judge?.should_flag,
      reasons: r.judge?.reasons
    })));

    // Compute deltas up front so the client can see them.
    for (const r of judged) {
      const j = r.judge || {};
      const delta = j && typeof j.minimal_rewrite === "string"
        ? jaccardDelta5(r.text, j.minimal_rewrite || "")
        : 0;
      r.delta = delta;
    }

    // ---- 3) Overlap gate (5-gram Jaccard) ----------------------------------
    const flags = [];
    console.log('[Style Check Debug] Starting overlap gate with threshold:', STYLE_OVERLAP_DELTA);
    
    for (const r of judged) {
      const j = r.judge || {};
      if (!j.should_flag) {
        console.log(`[Style Check Debug] Sentence not flagged by LLM: "${r.text.substring(0, 50)}..."`);
        continue;
      }

      console.log(`[Style Check Debug] Sentence flagged by LLM: "${r.text.substring(0, 50)}..." - Delta: ${r.delta}`);
      
      if (bypassOverlap || r.delta > STYLE_OVERLAP_DELTA) {
        flags.push({
          i: r.i,
          text: r.text,
          reasons: Array.isArray(j.reasons) ? j.reasons.slice(0, 4) : [],
          preview: j.minimal_rewrite || "",
          delta: r.delta
        });
        console.log(`[Style Check Debug] KEPT flag (delta ${r.delta} > ${STYLE_OVERLAP_DELTA}): "${r.text.substring(0, 50)}..."`);
      } else {
        skips.push({ i: r.i, reason: "overlap_low", text: r.text, delta: r.delta });
        console.log(`[Style Check Debug] DROPPED flag (delta ${r.delta} <= ${STYLE_OVERLAP_DELTA}): "${r.text.substring(0, 50)}..."`);
      }
    }
    
    console.log('[Style Check Debug] Final flags:', flags.length);

    // ---- 4) Respond ---------------------------------------------------------
    const dist = {
      judged_total: judged.length,
      judge_true: judged.filter(r => r.judge?.should_flag).length,
      judge_false: judged.filter(r => !r.judge?.should_flag).length,
      overlap_kept: flags.length,
      overlap_dropped: judged.filter(r => r.judge?.should_flag && r.delta <= STYLE_OVERLAP_DELTA).length
    };

    const design = analyzeDesignElements(originalText || sentences.join("\n"));

    res.json({
      flags: flags.sort((a,b) => a.i - b.i),
      meta: {
        total: sentences.length,
        unique: sentences.length - skips.filter(s => s.reason === "deduped").length,
        considered: toJudge.length,
        flagged: flags.length,
        skipped: skips.sort((a,b) => a.i - b.i),
        distribution: dist,
        debug: !!debug,
        bypassOverlap: !!bypassOverlap,
        model: STYLE_PROVIDER === 'openai' ? OPENAI_MODEL : OLLAMA_JUDGE_MODEL,
        baseUrl: STYLE_PROVIDER === 'openai' ? OPENAI_BASE : OLLAMA_BASE,
        provider: STYLE_PROVIDER,
        thresholds: { minWords: STYLE_MIN_WORDS, overlapDelta: STYLE_OVERLAP_DELTA, maxJudged: STYLE_MAX_JUDGED }
      },
      // When debug is on, include raw judged items for console inspection.
      judged: debug ? judged.sort((a,b) => a.i - b.i) : undefined,
      sample: debug ? sentences.slice(0, 8) : undefined,
      design_elements: design
    });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ------------------------------ Helpers -------------------------------------

function splitSentencesFromHTML(html = "") {
  console.log('[splitSentencesFromHTML] called, html length:', (html || '').length);
  // HTML-based sentence splitter that uses structural elements
  if (!html) return [];
  
  const sentences = [];
  
  // Parse HTML and extract text from structural elements
  const structuralElements = html.match(/<(p|h[1-6]|li|div|br)[^>]*>.*?<\/(p|h[1-6]|li|div)>|<(p|h[1-6]|li|div|br)[^>]*\/>/gi) || [];
  
  for (const element of structuralElements) {
    // Remove all HTML tags (including <br>) to get plain text
    const cleanText = element
      // Convert <br> variants to newlines first
      .replace(/<br\b[^>]*\/?>(?![^<]*>)/gi, '\n')
      .replace(/<br\b[^>]*\/?>(?=[^]*?)/gi, '\n')
      // Strip remaining tags
      .replace(/<[^>]*>/gi, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (!cleanText) continue;
    
    
    // Apply sentence-level parsing per line (treat \n as hard boundary)
    const chunks = cleanText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (const chunk of chunks) {
      const sentenceMatches = chunk.match(/[A-Z][^.!?\n]*[.!?]+/g);
      if (sentenceMatches) {
        for (const m of sentenceMatches) {
          const trimmed = m.trim();
          if (trimmed && trimmed.length > 20) sentences.push(trimmed);
        }
      } else if (chunk.length > 20) {
        sentences.push(chunk);
      }
    }
  }
  
  return sentences;
}

function splitSentences(text = "") {
  console.log('[splitSentences] called, text length:', (text || '').length);
  if (!text) return [];

  const normalized = String(text);
  const sentences = [];
  for (let line of normalized) {
    // collapse NBSPs to spaces, trim
    line = line.replace(/\u00A0/g, ' ').trim();
    if (!line) continue;

    // Prefer sentence-ish lines
    if (/^[A-Z].*[.!?]$/.test(line) && line.length > 20) {
      sentences.push(line);
    } else if (line.length > 20) {
      sentences.push(line);
    }
  }
  console.log('[Split Sentences]', sentences.length);
  return sentences;
}


function shouldSkip(s, seenSet) {
  const key = s.toLowerCase().replace(/\s+/g, " ");
  if (seenSet.has(key)) return "deduped";
  seenSet.add(key);

  if (wordCount(s) < STYLE_MIN_WORDS) return "min_length";

  if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(s)) return "bullet_like";
  const pipeCount = (s.match(/\|/g) || []).length;
  if (pipeCount >= 2) return "table_like";

  if (/\?\s*$/.test(s) && wordCount(s) <= 12) return "short_question";

  if (/```/.test(s) || /`[^`]+`/.test(s)) return "code_like";
  if (/^\s*>/.test(s)) return "blockquote";
  if (/[“"](.){20,}[”"]/.test(s)) return "long_quote";

  const toks = tokenize(s);
  if (toks.length) {
    const noisy = toks.filter(t => isUrlToken(t) || isNumberLike(t)).length;
    if (noisy / toks.length >= 0.4) return "url_number_dense";
  }

  return null; // keep
}

function wordCount(t=""){ return (t.trim().match(/\b[\w’'-]+\b/g) || []).length; }

function tokenize(s="") {
  return (s.match(/[A-Za-z0-9][A-Za-z0-9._:\/-]*/g) || []);
}
function isUrlToken(tok="") { return /^(https?:\/\/|www\.)/i.test(tok); }
function isNumberLike(tok="") { return /^(\d+([.,]\d+)?)(%|[kmgt]b|[smhdwy]|x)?$/i.test(tok); }

// LLM judge call: returns { should_flag:boolean, reasons:string[], minimal_rewrite:string }
async function judgeSentenceLLM(sentence, { url, model, timeoutMs, debug = false }) {
  const prompt = [
    "You are a concise style judge. For the given sentence, decide if it likely needs simplification for clarity.",
    "Return STRICT JSON only with these fields:",
    '{ "should_flag": boolean, "reasons": string[], "minimal_rewrite": string }',
    "",
    "Guidance:",
    "- Flag if sentence has stacked clauses, vague referents, heavy nominalizations, or passive + hedging that obscures who does what.",
    "- minimal_rewrite must be a light-touch rewrite in ONE sentence (for measurement only).",
    "- Keep reasons short (1-4 items).",
    "",
    "Sentence:",
    sentence
  ].join("\n");

  // Try strict JSON first with selected provider; on failure, try backup model.
  let raw;
  if (STYLE_PROVIDER === 'openai') {
    try {
      raw = await callOpenAIJSON({ base: OPENAI_BASE, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL, prompt, timeoutMs });
    } catch (e) {
      // Try backup model on primary model failure
      try {
        raw = await callOpenAIJSON({ base: OPENAI_BASE, apiKey: OPENAI_API_KEY, model: OPENAI_BACKUP_MODEL, prompt, timeoutMs });
      } catch (backupError) {
        // best-effort raw capture via plain text completion with backup model
        try {
          raw = await callOpenAIText({ base: OPENAI_BASE, apiKey: OPENAI_API_KEY, model: OPENAI_BACKUP_MODEL, prompt, timeoutMs });
        } catch {
          raw = null;
        }
      }
    }
  } else {
    try {
      raw = await callOllamaJSON({ url, model, prompt, timeoutMs });
    } catch (e) {
      // Fallback: capture Ollama raw
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${url}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.2, num_predict: 256 } })
        });
        clearTimeout(t);
        const j = await resp.json().catch(async () => ({ response: await resp.text().catch(() => "") }));
        raw = (j && j.response) ? String(j.response).trim() : "";
      } catch {
        clearTimeout(t);
        raw = null;
      }
    }
  }

  if (raw && typeof raw === "object" && "should_flag" in raw) {
    return {
      should_flag: !!raw.should_flag,
      reasons: Array.isArray(raw.reasons) ? raw.reasons.slice(0, 4) : [],
      minimal_rewrite: typeof raw.minimal_rewrite === "string" ? raw.minimal_rewrite.trim() : ""
    };
  }

  if (typeof raw === "string") {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i) || raw.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        const j = JSON.parse(m[1] || m[0]);
        return {
          should_flag: !!j.should_flag,
          reasons: Array.isArray(j.reasons) ? j.reasons.slice(0, 4) : [],
          minimal_rewrite: typeof j.minimal_rewrite === "string" ? j.minimal_rewrite.trim() : ""
        };
      } catch {}
    }
  }

  const out = { should_flag: false, reasons: ["parse_error"], minimal_rewrite: "" };
  if (debug && raw) {
    out._raw = typeof raw === 'string' ? raw.slice(0, 4000) : JSON.stringify(raw).slice(0, 4000);
    out.error = "strict_json_parse_failed";
  }
  return out;
}

// 5-gram Jaccard delta (1 - similarity). Normalize & ignore URLs.
function jaccardDelta5(a="", b="") {
  const norm = (s) => normalizeForOverlap(s);
  const A = ngrams5(norm(a));
  const B = ngrams5(norm(b));
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const sim = union ? inter / union : 0;
  return 1 - sim;
}

function normalizeForOverlap(s="") {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/https?:\/\/\S+|www\.\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function ngrams5(s="") {
  const tokens = s.split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 4 < tokens.length; i++) {
    set.add(tokens.slice(i, i+5).join(" "));
  }
  return set;
}

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------- Design Elements Checker (deterministic) -------------------
function analyzeDesignElements(textIn = "", designOnly = false) {
  const text = String(textIn || "");
  const len = text.length;

  const flags = [];
  const notes = [];
  const issuesHeadings = [];
  const issuesFAQ = [];
  const issuesTLDR = [];
  const issuesComp = [];

  // Word count and short-doc guard
  const words = (text.match(/\b[\w’'-]+\b/g) || []).length;
  const isShortDoc = words < 600;

  function pushFlag(level, rule, message, location) {
    const key = `${level}|${rule}|${message}|${location ? location.join(',') : ''}`;
    if (!pushFlag._seen) pushFlag._seen = new Set();
    if (pushFlag._seen.has(key)) return;
    pushFlag._seen.add(key);
    flags.push({ level, rule, message, location: location || null });
  }

  function findRanges(patterns) {
    const out = [];
    for (const re of patterns) {
      let m;
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      while ((m = r.exec(text)) !== null) {
        out.push([m.index, m.index + m[0].length]);
        if (m.index === r.lastIndex) r.lastIndex++;
      }
    }
    return out;
  }

  // A) FAQ / Q&A -------------------------------------------------------------
  const faqLabels = [
    /\bfaq\b/i,
    /\bfrequently\s+asked\s+questions\b/i,
    /\bq\s*&\s*a\b/i
  ];
  const faqLabelRanges = findRanges(faqLabels).slice(0, 5);
  // Log full FAQ label text(s) if identified
  if (faqLabelRanges.length > 0) {
    try {
      const labelsFound = faqLabelRanges.map(([s, e]) => text.slice(s, e));
      console.log('[Design Elements Debug] FAQ labels found:', labelsFound);
    } catch {}
  }
  const qColon = findRanges([/^\s*q\s*:\s+/gim, /^\s*question\s*:\s+/gim]);
  const aColon = findRanges([/^\s*a\s*:\s+/gim, /^\s*answer\s*:\s+/gim]);
  const questionLines = (text.match(/^\s*(what|how|why|when|where|which|can|does|is|are)\b[^\n]*\?/gim) || []);
  const faqPresent = faqLabelRanges.length > 0 || (qColon.length >= 2 && aColon.length >= 1) || questionLines.length >= 3;
  if (!faqPresent) {
    pushFlag('suggestion', 'faq', 'Consider adding an FAQ/Q&A section to capture long-tail questions.', null);
  } else {
    if (questionLines.length < 3 && (qColon.length + questionLines.length) < 3) {
      issuesFAQ.push('FAQ exists but is short (fewer than 3 questions). Consider adding more questions.');
      pushFlag('warning', 'faq', 'FAQ exists but is short (fewer than 3 questions). Consider adding more questions.', faqLabelRanges[0] || null);
    }
  }

  // B) Headings: density + semantics ----------------------------------------
  const lines = text.split(/\n/);
  let h2Count = 0;
  let h3Count = 0;
  const semanticH2 = [];
  const semanticH3 = [];
  let inCode = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode || /^>/.test(line)) continue;
    const m2 = line.match(/^#{2}\s+(.+)/);
    const m3 = line.match(/^#{3}\s+(.+)/);
    const m2Html = line.match(/<h2[^>]*>(.+?)<\/h2>/i);
    const m3Html = line.match(/<h3[^>]*>(.+?)<\/h3>/i);
    const content = (m2 && m2[1]) || (m3 && m3[1]) || (m2Html && m2Html[1]) || (m3Html && m3Html[1]) || '';
    if (m2 || m2Html) h2Count++;
    if (m3 || m3Html) h3Count++;
    if (content) {
      const sem = isSemanticHeading(content);
      if ((m2 || m2Html) && sem) semanticH2.push(content);
      if ((m3 || m3Html) && sem) semanticH3.push(content);
    }
  }
  const h2ForRatio = h2Count > 0 ? h2Count : (h3Count > 0 ? 1 : 1);
  const ratioH3PerH2 = h3Count / Math.max(h2ForRatio, 1);
  
  if (!isShortDoc && words > 800 && h2Count < 2) {
    issuesHeadings.push('Consider adding more H2s to structure the article.');
    pushFlag('suggestion', 'headings', 'Consider adding more H2s to structure the article.', null);
  }
  if (!isShortDoc && words > 1200 && ratioH3PerH2 < (1/3)) {
    issuesHeadings.push('Consider using more H3s to break up long H2 sections.');
    pushFlag('suggestion', 'headings', 'Consider using more H3s to break up long H2 sections.', null);
  }
  const h2SemanticPct = h2Count ? Math.round((semanticH2.length / h2Count) * 100) : 0;
  const h3SemanticPct = h3Count ? Math.round((semanticH3.length / h3Count) * 100) : 0;
  if (!isShortDoc && words > 1000 && h2SemanticPct < 40 && h3SemanticPct < 40) {
    issuesHeadings.push("Headings aren't phrased as questions/tasks—consider more semantic H2/H3 (e.g., 'What is…', 'How to…').");
    pushFlag('warning', 'headings', "Headings aren't phrased as questions/tasks—consider more semantic H2/H3 (e.g., 'What is…', 'How to…').", null);
  }

  // C) TL;DR / Key Takeaways -------------------------------------------------
  const tldrLabels = [
    /\btl;?dr\b/i,
    /\btldr\b/i,
    /\bkey\s+takeaways\b/i,
    /\bkey\s+takeaway\b/i,
    /\bat\s+a\s+glance\b/i,
    /\bsummary\b/i,
    /\bsummaries\b/i,
    /\bin\s+short\b/i,
    /\bquick\s+summary\b/i,
    /\bexecutive\s+summary\b/i,
    /\boverview\b/i,
    /\bthe\s+bottom\s+line\b/i,
    /\bwrap\s*up\b/i,
    /\bconclusion\b/i,
    /\bconclusions\b/i,
    /\bwhat\s+you\s+need\s+to\s+know\b/i,
    /\bmain\s+points\b/i,
    /\bkey\s+points\b/i,
    /\bhighlights\b/i,
    /\bessentials\b/i,
    /\bquick\s+start\b/i,
    /\bgetting\s+started\b/i
  ];
  const tldrRanges = findRanges(tldrLabels);
  const tldrPresent = tldrRanges.length > 0;
  const tldrLocs = tldrRanges.slice(0, 3);
  if (tldrPresent) {
    try {
      const labels = tldrLocs.map(([s, e]) => ({ start: s, end: e, text: text.slice(s, e) }));
      console.log('[Design Elements Debug] TLDR labels found:', labels);
    } catch {}
  }
  if (!tldrPresent) {
    pushFlag('suggestion', 'tldr', 'Consider adding a TL;DR or Key Takeaways block to front-load value.', null);
  } else {
    const [start] = tldrLocs[0] || [0,0];
    // Expand the measurement window: up to next H1/H2/HR or 1200 chars, whichever comes first
    const after = text.slice(start);
    const nextBoundaryRel = after.search(/<(?:h1|h2|hr)\b/i);
    const hardCap = 1200;
    const end = nextBoundaryRel !== -1 ? Math.min(len, start + nextBoundaryRel) : Math.min(len, start + hardCap);
    const windowHtml = text.slice(start, end);
    const windowText = windowHtml.replace(/<[^>]*>/g, ' ');
    const wordsInWindow = (windowText.match(/\b[\w’'-]+\b/g) || []).length;
    try {
      console.log('[Design Elements Debug] TLDR window words:', {
        wordsInWindow,
        start,
        end,
        windowChars: end - start,
        usedBoundary: nextBoundaryRel !== -1 ? 'next-heading-or-hr' : `hardcap-${hardCap}`
      });
    } catch {}
    if (wordsInWindow > 120) {
      issuesTLDR.push('TL;DR is lengthy—tighten to 3–5 bullets or ~60–120 words.');
      pushFlag('suggestion', 'tldr', 'TL;DR is lengthy—tighten to 3–5 bullets or ~60–120 words.', tldrLocs[0] || null);
    }
  }


  // D) Comparison tables (soft)
  const compSignals = /\b(vs\.?|comparison|compare|alternatives)\b/i.test(text);
  const tableLikeLines = (text.match(/^\s*\|[^\n]+\|\s*$/gim) || []).length;
  const hasMarkdownTable = tableLikeLines >= 2;
  let compPresent = false;
  let compCount = 0;
  if (hasMarkdownTable) {
    compPresent = true;
    compCount = Math.max(1, Math.floor(tableLikeLines / 2));
  } else if (compSignals && words > 300) {
    pushFlag('suggestion', 'comparison', 'Consider adding a small comparison table for quick scanning.', null);
  }



  // G) Chunking: long unstructured sections --------------------------------
  console.log(`[Design Elements Debug] Calling analyzeChunking with ${words} words`);
  const chunking = analyzeChunking(text, words);
  console.log(`[Design Elements Debug] Chunking analysis complete, found ${chunking.flags?.length || 0} flags`);

  return {
    faq: { present: !!faqPresent, locations: faqLabelRanges, issues: issuesFAQ },
    headings: {
      density: { h2: h2Count, h3: h3Count, ratio_h3_per_h2: Number(ratioH3PerH2.toFixed(3)) },
      semantic: {
        h2_semantic_pct: h2SemanticPct,
        h3_semantic_pct: h3SemanticPct,
        examples_non_semantic: []
      },
      issues: issuesHeadings
    },
    tldr: { present: !!tldrPresent, locations: tldrLocs, issues: issuesTLDR },
    comparison_tables: { present: compPresent, count: compCount, issues: issuesComp },
    chunking,
    flags: [...flags, ...(chunking.flags || [])],
    meta: { considered: true, notes }
  };
}

function isSemanticHeading(s = "") {
  const x = s.toLowerCase();
  return (
    /\bwhat\s+(is|are)\b/.test(x) ||
    /\bhow\s+to\b/.test(x) ||
    /\bwhy\b/.test(x) ||
    /\bwhen\b/.test(x) ||
    /\bwhere\b/.test(x) ||
    /\bwhich\b/.test(x) ||
    /\bpros\s+and\s+cons\b/.test(x) ||
    /\bvs\.?\b/.test(x) ||
    /\bcomparison\b/.test(x) ||
    /\bexamples?\b/.test(x) ||
    /\bsteps\s+to\b/.test(x) ||
    /\bchecklist\b/.test(x) ||
    /\bbest\s+practices\b/.test(x)
  );
}

// ---------------- Chunking Analyzer (deterministic) ------------------------
function analyzeChunking(text = "", totalWords = 0) {
  console.log(`[Chunking Debug] Starting analyzeChunking with ${totalWords} words`);
  console.log(`[Chunking Debug] Text length: ${text.length} chars`);
  
  // Skip chunking warnings for short docs
  if (totalWords < 600) {
    return {
      summary: { total_words: totalWords, median_h2_len: 0, abs_threshold: 0, rel_multiplier: 1.75 },
      sections: [],
      flags: []
    };
  }

  const sections = [];
  const flags = [];
  
  // Parse sections by H2 boundaries
  const lines = text.split(/\n/);
  
  // First, check if document has any H2 headings (both Markdown ## and HTML <h2>)
  const hasMarkdownH2 = lines.some(line => /^#{2}\s+/.test(line.trim()));
  const hasHtmlH2 = /<h2[^>]*>/i.test(text);
  const hasH2Headings = hasMarkdownH2 || hasHtmlH2;
  
  console.log(`[Long Section Debug] H2 detection:`, {
    hasMarkdownH2,
    hasHtmlH2,
    hasH2Headings,
    totalWords,
    textLength: text.length
  });
  
  // If no H2 headings, skip chunking analysis to avoid false positives
  if (!hasH2Headings) {
    console.log(`[Long Section Debug] No H2 headings found, skipping chunking analysis to avoid false positives`);
    return {
      summary: { total_words: totalWords, median_h2_len: 0, abs_threshold: 600, rel_multiplier: 1.75 },
      sections: [],
      flags: []
    };
  }
  
  let currentSection = { heading: 'Document', start: 0, content: '', h3Count: 0, hasBullets: false };
  let inCode = false;
  let inBlockquote = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Track code/blockquote state
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (/^>/.test(line)) { inBlockquote = true; } else if (!/^>/.test(line) && inBlockquote) { inBlockquote = false; }
    
    // Skip content inside code/blockquotes
    if (inCode || inBlockquote) continue;
    
    // Check for H2 (both Markdown ## and HTML <h2>)
    const h2Match = line.match(/^#{2}\s+(.+)/);
    const h2HtmlMatch = line.match(/<h2[^>]*>(.+?)<\/h2>/i);
    
    if (h2Match || h2HtmlMatch) {
      console.log(`[Long Section Debug] Found H2:`, {
        line: line.substring(0, 100),
        h2Match: h2Match ? h2Match[1] : null,
        h2HtmlMatch: h2HtmlMatch ? h2HtmlMatch[1] : null
      });
      
      // Save previous section
      if (currentSection.content.trim()) {
        sections.push(analyzeSection(currentSection, i));
      }
      // Start new section
      const heading = h2Match ? h2Match[1] : h2HtmlMatch[1];
      currentSection = {
        heading: heading,
        start: i,
        content: '',
        h3Count: 0,
        hasBullets: false
      };
      continue;
    }
    
    // Check for H3 (both Markdown ### and HTML <h3>)
    const h3Match = line.match(/^#{3}\s+(.+)/);
    const h3HtmlMatch = line.match(/<h3[^>]*>(.+?)<\/h3>/i);
    
    if (h3Match || h3HtmlMatch) {
      console.log(`[Long Section Debug] Found H3:`, {
        line: line.substring(0, 100),
        h3Match: h3Match ? h3Match[1] : null,
        h3HtmlMatch: h3HtmlMatch ? h3HtmlMatch[1] : null
      });
      currentSection.h3Count++;
      continue;
    }
    
    // Check for bullets (2+ consecutive list lines)
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      currentSection.hasBullets = true;
    }
    
    // Add content to current section
    currentSection.content += line + '\n';
  }
  
  // Add final section
  if (currentSection.content.trim()) {
    sections.push(analyzeSection(currentSection, lines.length));
  }
  
  console.log(`[Long Section Debug] Sections found:`, sections.map(s => ({
    heading: s.section_heading,
    wordCount: s.length_words,
    hasH3: s.h3_count > 0,
    hasBullets: s.has_bullets
  })));
  
  
  // Calculate thresholds
  const sectionLengths = sections.map(s => s.length_words);
  const medianH2Len = sectionLengths.length > 0 ? 
    sectionLengths.sort((a,b) => a-b)[Math.floor(sectionLengths.length/2)] : 0;
  const absThreshold = totalWords >= 2500 ? 600 : 600;
  const relThreshold = Math.round(1.75 * medianH2Len);
  
  console.log(`[Long Section Debug] Thresholds calculated:`, {
    totalWords: totalWords,
    absThreshold: absThreshold,
    relThreshold: relThreshold,
    medianH2Length: medianH2Len,
    sectionCount: sections.length,
    sectionLengths: sectionLengths,
    hasH2Headings: hasH2Headings
  });
  
  // Generate warnings
  sections.forEach(section => {
    let warned = false;
    let reason = null;
    let thresholdWords = 0;
    
    // Check for long paragraphs within the section
    console.log(`[Long Section Debug] Checking section "${section.section_heading}" for long paragraphs...`);
    console.log(`[Long Section Debug] Section content length: ${section.content.length} chars`);
    
    const longParagraphs = findLongParagraphs(section.content, 300);
    console.log(`[Long Paragraph Flag] Found ${longParagraphs.length} long paragraph(s) in section "${section.section_heading}":`, 
      longParagraphs.map(p => ({ wordCount: p.wordCount, preview: p.preview }))
    );
    
    if (longParagraphs.length > 0) {
      longParagraphs.forEach((paragraph, paragraphIndex) => {
        flags.push({
          level: 'warning',
          rule: 'chunking',
          section_heading: section.section_heading,
          length_words: paragraph.wordCount,
          has_h3: section.h3_count > 0,
          has_bullets: section.has_bullets,
          threshold_words: 300,
          message: 'Long paragraph detected. Consider breaking into shorter paragraphs.',
          paragraph_preview: paragraph.preview,
          paragraph_content: paragraph.content,
          paragraph_index: paragraphIndex
        });
      });
    }
    
    // Absolute threshold check for entire section
    if (section.length_words > absThreshold && section.h3_count === 0 && !section.has_bullets) {
      warned = true;
      reason = 'abs_threshold';
      thresholdWords = absThreshold;
    }
    // Relative threshold check for entire section
    else if (section.length_words > relThreshold && section.h3_count === 0 && !section.has_bullets) {
      warned = true;
      reason = 'relative_outlier';
      thresholdWords = relThreshold;
    }
    
    if (warned) {
      console.log(`[Long Section Flag] Section "${section.section_heading}" flagged:`, {
        reason: reason,
        wordCount: section.length_words,
        threshold: thresholdWords,
        hasH3: section.h3_count > 0,
        hasBullets: section.has_bullets,
        absThreshold: absThreshold,
        relThreshold: relThreshold,
        medianH2Length: medianH2Len
      });
      
      flags.push({
        level: 'warning',
        rule: 'chunking',
        section_heading: section.section_heading,
        length_words: section.length_words,
        has_h3: section.h3_count > 0,
        has_bullets: section.has_bullets,
        threshold_words: thresholdWords,
        message: 'Section is long and unstructured. Split into query-aligned H3s (e.g., \'What is…\', \'How to…\', \'Best practices…\').',
        heading_text: section.section_heading
      });
    }
    
    section.warned = warned;
    section.reason = reason;
    section.threshold_words = thresholdWords;
  });
  
  return {
    summary: {
      total_words: totalWords,
      median_h2_len: medianH2Len,
      abs_threshold: absThreshold,
      rel_multiplier: 1.75
    },
    sections,
    flags
  };
}

function findLongParagraphs(content, threshold) {
  console.log(`[Long Paragraph Debug] Starting findLongParagraphs with threshold ${threshold}`);
  console.log(`[Long Paragraph Debug] Content length: ${content.length} chars`);
  
  const longParagraphs = [];
  
  // Extract text content from HTML <p> tags
  const pTagRegex = /<p[^>]*>(.*?)<\/p>/gi;
  let match;
  
  while ((match = pTagRegex.exec(content)) !== null) {
    const paragraphText = match[1];
    // Remove HTML tags from the paragraph text
    const cleanText = paragraphText.replace(/<[^>]*>/g, '');
    const wordCount = (cleanText.match(/\b[\w'-]+\b/g) || []).length;
    
    console.log(`[Long Paragraph Debug] Found paragraph: ${wordCount} words (threshold: ${threshold})`);
    
    if (wordCount > threshold) {
      // Get first 50 words as preview
      const words = cleanText.trim().split(/\s+/);
      const preview = words.slice(0, 50).join(' ') + (words.length > 50 ? '...' : '');
      
      console.log(`[Long Paragraph Flag] Found long paragraph: ${wordCount} words`);
      
      longParagraphs.push({
        wordCount: wordCount,
        preview: preview,
        content: cleanText.trim()
      });
    }
  }
  
  return longParagraphs;
}

function analyzeSection(section, endLine) {
  const content = section.content.trim();
  const wordCount = (content.match(/\b[\w'-]+\b/g) || []).length;
  
  return {
    section_heading: section.heading,
    start: section.start,
    end: endLine,
    content: content, // Add the content property!
    length_words: wordCount,
    h3_count: section.h3Count,
    has_bullets: section.hasBullets,
    warned: false,
    reason: null,
    threshold_words: 0
  };
}
