'use strict';
/**
 * AURA core — standalone, dependency-free token saver.
 *
 * Answers prompts WITHOUT calling an LLM, cheapest path first:
 *   1. FETCH   — exact cache hit (normalized prompt -> sha256 key)
 *   2. QUERY   — fuzzy cache hit (word-overlap cosine similarity >= 0.82)
 *   3. COMPUTE — solve locally (math / date / unit-convert / base64 / word-count / casing)
 *
 * If none apply, route() returns { hit:false }. ask() will then optionally call an
 * LLM (only if a provider key is present in the environment) and record the answer
 * so the next identical/similar prompt is free.
 *
 * Identical logic to the dashboard's backend/lib/aura.js, but persists cache to
 * ~/.shaddai-aura so it works from ANY terminal, independent of the dashboard repo.
 *
 * Uses ONLY node built-ins (fs, path, os, crypto) + global fetch (Node 18+).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { validateSkill, isRegexSafe } = require('./lib/validate-skill');
const searchIndex = require('./lib/search-index');
const { computeExtra } = require('./lib/compute-ops');
const toolSelect = require('./lib/tool-select');
const contextCompress = require('./lib/context-compress');
const promptDistill = require('./lib/prompt-distill');

// --------------------------------------------------------------------------- config
const DATA_DIR    = process.env.AURA_HOME || path.join(os.homedir(), '.shaddai-aura');
const CACHE_FILE  = path.join(DATA_DIR, 'aura-cache.json');
const STATS_FILE  = path.join(DATA_DIR, 'aura-stats.json');
const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES    = 5000;
const SIM_THRESHOLD  = 0.82;
const COST_PER_1K    = 0.0005;
const CHARS_PER_TOK  = 4;

// --------------------------------------------------------------------------- json fs
function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {} }
function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fb; } }
function writeJson(file, obj) { try { ensureDir(); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return true; } catch (_) { return false; } }

// --------------------------------------------------------------------------- stats
const METHODS = ['fetch', 'query', 'skill', 'compute', 'distill', 'toolInject', 'compress'];
function loadStats() {
  const s = readJson(STATS_FILE, { hits: 0, misses: 0, tokensSaved: 0, byMethod: {}, tokensByMethod: {} });
  // back-fill any missing method buckets (older stats files predate some surfaces)
  if (!s.byMethod || typeof s.byMethod !== 'object') s.byMethod = {};
  if (!s.tokensByMethod || typeof s.tokensByMethod !== 'object') s.tokensByMethod = {};
  for (const m of METHODS) { if (typeof s.byMethod[m] !== 'number') s.byMethod[m] = 0; if (typeof s.tokensByMethod[m] !== 'number') s.tokensByMethod[m] = 0; }
  return s;
}
function bumpStats(mut) { try { const s = loadStats(); mut(s); writeJson(STATS_FILE, s); } catch (_) {} }
// Record a hit's token savings against BOTH the running total and its surface subtotal, so
// stats() can show exactly how much each saver (tools/history/instructions/cache/…) earned.
function addSaved(s, method, tokens) {
  const n = Math.round(Number(tokens) || 0);
  s.tokensSaved += n;
  if (!s.tokensByMethod) s.tokensByMethod = {};
  s.tokensByMethod[method] = (s.tokensByMethod[method] || 0) + n;
}
function estTokens(str) { return Math.max(1, Math.ceil(String(str || '').length / CHARS_PER_TOK)); }

// --------------------------------------------------------------------------- normalize + sim
function normalize(p) { return String(p || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function hashKey(p) { return crypto.createHash('sha256').update(normalize(p)).digest('hex'); }
function toks(s) { return normalize(s).split(' ').filter(Boolean); }
// Reduce entropy/ambiguity before matching. Strip filler so CONTENT words
// dominate similarity — "what's the X?" then matches a cached "X". Falls back to raw tokens
// if stripping would empty the prompt.
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'what', 'whats', 's', 'please', 'me', 'tell', 'give', 'do', 'you', 'can', 'how', 'i', 'my', 'it', 'this', 'that', 'with', 'about', 'show']);
function simToks(s) {
  const all = toks(s);
  const kept = all.filter(t => !STOP.has(t));
  return kept.length ? kept : all;
}
function cosineSim(a, b) {
  const ta = simToks(a), tb = simToks(b);
  if (!ta.length || !tb.length) return 0;
  const fa = {}, fb = {};
  for (const t of ta) fa[t] = (fa[t] || 0) + 1;
  for (const t of tb) fb[t] = (fb[t] || 0) + 1;
  let dot = 0;
  for (const k of Object.keys(fa)) if (fb[k]) dot += fa[k] * fb[k];
  const mag = (f) => Math.sqrt(Object.values(f).reduce((s, v) => s + v * v, 0));
  const m = mag(fa) * mag(fb);
  return m ? dot / m : 0;
}

// --------------------------------------------------------------------------- cache
function loadCache() { const c = readJson(CACHE_FILE, {}); return (c && typeof c === 'object') ? c : {}; }
function pruneCache(cache) {
  const now = Date.now();
  for (const k of Object.keys(cache)) { const e = cache[k]; if (!e || (e.ts + (e.ttl || DEFAULT_TTL_MS)) < now) delete cache[k]; }
  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => cache[a].ts - cache[b].ts);
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete cache[keys[i]];
  }
  return cache;
}

// buildFuzzyIndex(cache) — turn the loaded cache object { key: { prompt, answer } } into
// the array shape search-index wants and build a fresh BM25 index. Rebuilt per route()
// (correct-by-construction: always reflects the current cache, no stale-index bugs). Cheap
// for small caches; the win is at scale, where search() scores only word-sharing candidates
// instead of every entry.
function buildFuzzyIndex(cache) {
  const entries = [];
  for (const k of Object.keys(cache)) {
    const e = cache[k];
    if (e && e.prompt !== undefined) entries.push({ key: k, prompt: e.prompt, answer: e.answer });
  }
  return searchIndex.buildIndex(entries);
}

// =========================================================================== COMPUTE
function safeMath(expr) {
  const m = expr.match(/(\d+\.?\d*|\.\d+|[+\-*/%^()])/g);
  if (!m) return null;
  if (m.join('').replace(/\s/g, '') !== expr.replace(/\s/g, '')) return null;
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
  const out = [], ops = [];
  let prevType = null;
  for (let i = 0; i < m.length; i++) {
    let t = m[i];
    if (/^(\d|\.)/.test(t)) { out.push(parseFloat(t)); prevType = 'num'; }
    else if (t === '(') { ops.push(t); prevType = '('; }
    else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
      if (!ops.length) return null;
      ops.pop(); prevType = ')';
    } else {
      if ((t === '-' || t === '+') && (prevType === null || prevType === 'op' || prevType === '(')) out.push(0);
      while (ops.length && ops[ops.length - 1] !== '(' &&
        (prec[ops[ops.length - 1]] > prec[t] || (prec[ops[ops.length - 1]] === prec[t] && t !== '^'))) out.push(ops.pop());
      ops.push(t); prevType = 'op';
    }
  }
  while (ops.length) { const o = ops.pop(); if (o === '(') return null; out.push(o); }
  const st = [];
  for (const tok of out) {
    if (typeof tok === 'number') { st.push(tok); continue; }
    const b = st.pop(), a = st.pop();
    if (a === undefined || b === undefined) return null;
    let r;
    switch (tok) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/': r = b === 0 ? null : a / b; break;
      case '%': r = b === 0 ? null : a % b; break;
      case '^': r = Math.pow(a, b); break;
      default: return null;
    }
    if (r === null || !isFinite(r)) return null;
    st.push(r);
  }
  if (st.length !== 1 || !isFinite(st[0])) return null;
  return String(Math.round(st[0] * 1e10) / 1e10);
}

const UNIT_FACTORS = {
  mm: 0.001, cm: 0.01, m: 1, km: 1000,
  in: 0.0254, inch: 0.0254, inches: 0.0254,
  ft: 0.3048, foot: 0.3048, feet: 0.3048,
  yd: 0.9144, yard: 0.9144, yards: 0.9144,
  mi: 1609.344, mile: 1609.344, miles: 1609.344,
  mg: 0.001, g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592
};
const LENGTH = new Set(['mm', 'cm', 'm', 'km', 'in', 'inch', 'inches', 'ft', 'foot', 'feet', 'yd', 'yard', 'yards', 'mi', 'mile', 'miles']);
const WEIGHT = new Set(['mg', 'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds']);
function convertUnits(prompt) {
  const m = prompt.toLowerCase().match(/(-?\d+\.?\d*)\s*([a-z]+)\s*(?:to|in|into)\s*([a-z]+)/);
  if (!m) return null;
  const val = parseFloat(m[1]), from = m[2], to = m[3];
  const temp = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };
  if (temp[from] && temp[to]) {
    const tf = temp[from], tt = temp[to];
    let c;
    if (tf === 'c') c = val; else if (tf === 'f') c = (val - 32) * 5 / 9; else c = val - 273.15;
    let r;
    if (tt === 'c') r = c; else if (tt === 'f') r = c * 9 / 5 + 32; else r = c + 273.15;
    return `${Math.round(r * 100) / 100} ${to}`;
  }
  if (!UNIT_FACTORS[from] || !UNIT_FACTORS[to]) return null;
  const sameDim = (LENGTH.has(from) && LENGTH.has(to)) || (WEIGHT.has(from) && WEIGHT.has(to));
  if (!sameDim) return null;
  const r = (val * UNIT_FACTORS[from]) / UNIT_FACTORS[to];
  return `${Math.round(r * 1e6) / 1e6} ${to}`;
}
function base64Op(prompt) {
  let m = prompt.match(/base64\s+encode\s+(.+)/i);
  if (m) return Buffer.from(m[1].trim(), 'utf8').toString('base64');
  m = prompt.match(/base64\s+decode\s+(.+)/i);
  if (m) { try { return Buffer.from(m[1].trim(), 'base64').toString('utf8'); } catch (_) { return null; } }
  return null;
}
function wordCountOp(prompt) {
  let m = prompt.match(/(?:word count(?:\s+of)?|how many words(?:\s+(?:are\s+)?in)?)\s*:?\s*(.+)/i);
  if (!m) return null;
  const txt = m[1].trim().replace(/^["']|["']$/g, '');
  if (!txt) return null;
  return String(txt.split(/\s+/).filter(Boolean).length);
}
function formatOp(prompt) {
  let m = prompt.match(/^\s*(uppercase|lowercase|reverse)\s*:?\s*(.+)/i);
  if (!m) return null;
  const op = m[1].toLowerCase(), txt = m[2].trim().replace(/^["']|["']$/g, '');
  if (op === 'uppercase') return txt.toUpperCase();
  if (op === 'lowercase') return txt.toLowerCase();
  if (op === 'reverse') return txt.split('').reverse().join('');
  return null;
}
function dateOp(prompt) {
  const p = prompt.toLowerCase();
  if (/\b(today'?s? date|what(?:'s| is) (?:the |today'?s? )?date|current date)\b/.test(p)) return new Date().toISOString().slice(0, 10);
  if (/\b(current time|what(?:'s| is) the time|time right now)\b/.test(p)) return new Date().toISOString();
  return null;
}
// --- parametric templates ("compile once → run free"): recognize a recurring
//     SHAPE and solve any instance deterministically, forever, with no LLM. ---
const round2 = (n) => Math.round(n * 100) / 100;
function percentOf(p) {
  // "15% of 240" / "what is 15 percent of 240"
  const m = p.toLowerCase().match(/(-?\d+\.?\d*)\s*(?:%|percent)\s+of\s+(-?\d+\.?\d*)/);
  if (!m) return null;
  return String(round2((parseFloat(m[1]) / 100) * parseFloat(m[2])));
}
function percentOff(p) {
  // "20% off 50" / "20 percent off $50"
  const m = p.toLowerCase().match(/(-?\d+\.?\d*)\s*(?:%|percent)\s+off\s+\$?(-?\d+\.?\d*)/);
  if (!m) return null;
  const base = parseFloat(m[2]); const off = (parseFloat(m[1]) / 100) * base;
  return `${round2(base - off)} (you save ${round2(off)})`;
}
function tipCalc(p) {
  const s = p.toLowerCase();
  let bill, pct;
  // "tip on 80 at 18%"  /  "tip on $80 18%"
  let m = s.match(/tip\s+on\s+\$?(-?\d+\.?\d*)\s+(?:at\s+)?(-?\d+\.?\d*)\s*(?:%|percent)/);
  if (m) { bill = parseFloat(m[1]); pct = parseFloat(m[2]); }
  else {
    // "18% tip on $80"
    m = s.match(/(-?\d+\.?\d*)\s*(?:%|percent)\s+tip\s+on\s+\$?(-?\d+\.?\d*)/);
    if (!m) return null;
    pct = parseFloat(m[1]); bill = parseFloat(m[2]);
  }
  const tip = round2(bill * pct / 100);
  return `tip ${tip}, total ${round2(bill + tip)}`;
}
function percentChange(p) {
  // "percent change from 80 to 100" / "% change 80 to 100"
  const m = p.toLowerCase().match(/(?:percent|%)\s*change\s+(?:from\s+)?(-?\d+\.?\d*)\s+to\s+(-?\d+\.?\d*)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (a === 0) return null;
  return `${round2(((b - a) / Math.abs(a)) * 100)}%`;
}
function daysBetween(p) {
  // "days between 2026-01-01 and 2026-06-15"
  const m = p.toLowerCase().match(/days?\s+between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d1 = new Date(m[1] + 'T00:00:00Z'), d2 = new Date(m[2] + 'T00:00:00Z');
  if (isNaN(d1) || isNaN(d2)) return null;
  return String(Math.abs(Math.round((d2 - d1) / 86400000)));
}

function compute(prompt) {
  const raw = String(prompt || '').trim();
  if (!raw) return null;
  const date = dateOp(raw);        if (date !== null) return date;
  const b64 = base64Op(raw);       if (b64 !== null) return b64;
  const wc = wordCountOp(raw);     if (wc !== null) return wc;
  const fmt = formatOp(raw);       if (fmt !== null) return fmt;
  const poff = percentOff(raw);    if (poff !== null) return poff;   // before percentOf (both have "%")
  const tip = tipCalc(raw);        if (tip !== null) return tip;
  const pof = percentOf(raw);      if (pof !== null) return pof;
  const pch = percentChange(raw);  if (pch !== null) return pch;
  const dbt = daysBetween(raw);    if (dbt !== null) return dbt;
  const conv = convertUnits(raw);  if (conv !== null) return conv;
  const ext = computeExtra(raw);   if (ext !== null) return ext;   // base/hash/url/rot13/case/color
  let mathSrc = raw
    .replace(/^\s*(what(?:'s| is)|calculate|compute|solve|eval(?:uate)?|how much is)\b/i, '')
    .replace(/[?=]/g, '')
    .replace(/\bx\b/gi, '*')
    .trim();
  if (/^[\d\s+\-*/%^().]+$/.test(mathSrc) && /\d/.test(mathSrc)) {
    const r = safeMath(mathSrc);
    if (r !== null) return r;
  }
  return null;
}

// =========================================================================== ROUTE
function route(prompt, opts = {}) {
  try {
    const p = String(prompt || '');
    if (!p.trim()) return { hit: false };
    const cache = pruneCache(loadCache());
    const key = hashKey(p);
    const exact = cache[key];
    if (exact && (exact.ts + (exact.ttl || DEFAULT_TTL_MS)) >= Date.now()) {
      const saved = estTokens(p) + estTokens(exact.answer);
      bumpStats((s) => { s.hits++; s.byMethod.fetch++; addSaved(s, "fetch", saved); });
      return { hit: true, method: 'fetch', answer: exact.answer, savedTokensEst: saved };
    }
    // FUZZY candidate lookup — was an O(N) cosineSim scan over the WHOLE cache (dies at
    // 100k entries). Now: build an inverted BM25 index from the loaded cache and score
    // ONLY the docs that share a content word with the prompt. We still confirm the top
    // candidates with cosineSim + SIM_THRESHOLD so hit semantics (the `similarity` field,
    // weak-match misses) are byte-for-byte preserved — BM25 just narrows the field.
    let best = null, bestSim = 0;
    const idx = buildFuzzyIndex(cache);
    const candidates = searchIndex.search(idx, p, { limit: 10 });
    for (const c of candidates) {
      const e = cache[c.key]; if (!e) continue;
      const sim = cosineSim(p, e.prompt);
      if (sim > bestSim) { bestSim = sim; best = e; }
    }
    // COMPUTE is deterministic and must beat an APPROXIMATE fuzzy match: "what is 15% of
    // 240" must compute 36, not fuzzy-hit a cached "15 * 240" -> 3600. So try compute
    // BEFORE returning a query hit. (Exact cache stays authoritative above; skills sit
    // between compute and fuzzy, still able to override a generic computation.)
    const skill = matchSkill(p);
    if (skill && !skill.adapter) {
      const saved = estTokens(p) + estTokens(skill.text);
      bumpStats((s) => { s.hits++; s.byMethod.skill++; addSaved(s, "skill", saved); });
      return { hit: true, method: 'skill', answer: skill.text, savedTokensEst: saved, skill: skill.name };
    }

    const computed = compute(p);
    if (computed !== null) {
      const saved = estTokens(p) + estTokens(computed);
      bumpStats((s) => { s.hits++; s.byMethod.compute++; addSaved(s, "compute", saved); });
      try { recordAnswer(p, computed, opts); } catch (_) {}
      return { hit: true, method: 'compute', answer: computed, savedTokensEst: saved };
    }
    // FUZZY (query) hit — only after compute/skill declined, so an approximate match never
    // shadows a deterministic answer, but a real prior paraphrase is still free.
    if (best && bestSim >= SIM_THRESHOLD) {
      const saved = estTokens(p) + estTokens(best.answer);
      bumpStats((s) => { s.hits++; s.byMethod.query++; addSaved(s, "query", saved); });
      return { hit: true, method: 'query', answer: best.answer, savedTokensEst: saved, similarity: Math.round(bestSim * 1000) / 1000 };
    }
    bumpStats((s) => { s.misses++; });
    return { hit: false };
  } catch (_) {
    try { bumpStats((s) => { s.misses++; }); } catch (_) {}
    return { hit: false };
  }
}

function recordAnswer(prompt, answer, opts = {}) {
  try {
    const p = String(prompt || '');
    if (!p.trim() || answer === undefined || answer === null) return false;
    const cache = pruneCache(loadCache());
    cache[hashKey(p)] = { prompt: p, answer: String(answer), ts: Date.now(), ttl: Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS };
    pruneCache(cache);
    return writeJson(CACHE_FILE, cache);
  } catch (_) { return false; }
}

function stats() {
  try {
    const s = loadStats();
    const total = s.hits + s.misses;
    const hitRate = total ? s.hits / total : 0;
    return {
      hits: s.hits, misses: s.misses,
      hitRate: Math.round(hitRate * 1000) / 1000,
      tokensSaved: s.tokensSaved,
      costSavedUsd: Math.round(((s.tokensSaved / 1000) * COST_PER_1K) * 1e6) / 1e6,
      byMethod: s.byMethod,
      tokensByMethod: s.tokensByMethod,
      costByMethod: Object.fromEntries(METHODS.map((m) => [m, Math.round((((s.tokensByMethod[m] || 0) / 1000) * COST_PER_1K) * 1e6) / 1e6])),
      cacheFile: CACHE_FILE
    };
  } catch (_) {
    return { hits: 0, misses: 0, hitRate: 0, tokensSaved: 0, costSavedUsd: 0, byMethod: { fetch: 0, query: 0, compute: 0 }, cacheFile: CACHE_FILE };
  }
}

function clearCache() { return writeJson(CACHE_FILE, {}); }

// Record prompt-distillation savings into the shared ledger (3rd pillar). `saved` is the
// estimated tokens trimmed from a prompt/system-prompt via lib/prompt-distill.
function recordDistill(saved) {
  const n = Number(saved);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { bumpStats((s) => { s.byMethod.distill = (s.byMethod.distill || 0) + 1; addSaved(s, "distill", n); }); return true; } catch (_) { return false; }
}

// Selective tool injection (per-call saver): send only the tools relevant to this prompt.
// Thin wrapper over lib/tool-select that also books the savings into the shared ledger.
function selectTools(prompt, tools, opts) {
  const r = toolSelect.selectTools(prompt, tools, opts);
  try {
    const saved = r && r.report && Number(r.report.savedTokens);
    if (Number.isFinite(saved) && saved > 0) {
      bumpStats((s) => { s.byMethod.toolInject = (s.byMethod.toolInject || 0) + 1; addSaved(s, 'toolInject', saved); });
    }
  } catch (_) {}
  return r;
}

// =========================================================================== OPTIMIZE (one-call)
// The drop-in pre-processor: run all three per-call savers on a full request object —
// select the tools this turn needs, distill the system prompt, compress the history — and
// return a NEW request ready to send (never mutates the caller's object). Each surface can
// be turned off or tuned via opts.{tools,distill,compress}: false | {options}.
// Tokens of a system prompt in any accepted shape (string, or Anthropic block array).
function _systemTokens(system) {
  if (typeof system === 'string') return estTokens(system);
  if (Array.isArray(system)) { let t = 0; for (const b of system) if (b && typeof b.text === 'string') t += estTokens(b.text); return t; }
  return 0;
}
// Content-based token estimate of a whole request (system + tools JSON + each message's
// content) — the SAME metric compress uses, so the budget verdict is consistent.
function _requestTokens(req) {
  let t = _systemTokens(req.system);
  if (Array.isArray(req.tools)) t += estTokens(JSON.stringify(req.tools));
  if (Array.isArray(req.messages)) for (const m of req.messages) t += estTokens(contextCompress.contentString(m && m.content));
  return t;
}

function optimize(request, opts = {}) {
  opts = opts || {};
  const req = (request && typeof request === 'object') ? Object.assign({}, request) : {};
  const report = { tools: null, instructions: null, history: null, tokensSaved: 0 };
  let saved = 0;

  // 1. TOOLS — send only the tools relevant to the latest user turn
  if (Array.isArray(req.tools) && req.tools.length && opts.tools !== false) {
    // pass the whole message array so a terse follow-up still resolves the right tools (context-aware)
    const r = toolSelect.selectTools(Array.isArray(req.messages) ? req.messages : [], req.tools, opts.tools || {});
    req.tools = r.tools;
    report.tools = { total: r.report.total, sent: r.report.sent, saved: r.report.savedTokens || 0 };
    saved += r.report.savedTokens || 0;
  }

  // 2. INSTRUCTIONS — distill the system prompt. Handles all three real shapes: a plain
  //    string (Anthropic), an array of content blocks (Anthropic, cache_control preserved),
  //    or a `system` role message (OpenAI). Distilling the system prompt is the highest-value
  //    cut because it is paid for on every call.
  if (opts.distill !== false) {
    if (typeof req.system === 'string' && req.system.trim()) {
      const d = promptDistill.distill(req.system, opts.distill || {});
      req.system = d.distilled;
      report.instructions = { saved: d.report.stats.saved, savedPct: d.report.stats.savedPct, removed: d.report.removed.length };
      saved += d.report.stats.saved || 0;
    } else if (Array.isArray(req.system) && req.system.length) {
      // Anthropic block array: distill each text block IN PLACE so structure + cache_control survive.
      req.system = req.system.map((b) => Object.assign({}, b));
      let dSaved = 0, dRemoved = 0, dPct = 0, hit = false;
      req.system.forEach((b) => {
        if (b && typeof b.text === 'string' && b.text.trim()) {
          const d = promptDistill.distill(b.text, opts.distill || {});
          b.text = d.distilled; dSaved += d.report.stats.saved; dRemoved += d.report.removed.length; dPct = Math.max(dPct, d.report.stats.savedPct); hit = true;
        }
      });
      if (hit) { report.instructions = { saved: dSaved, savedPct: dPct, removed: dRemoved }; saved += dSaved; }
    } else if (Array.isArray(req.messages)) {
      req.messages = req.messages.map((m) => Object.assign({}, m)); // clone before touching system content
      let dSaved = 0, dRemoved = 0, dPct = 0, hit = false;
      req.messages.forEach((m) => {
        if (m.role === 'system' && typeof m.content === 'string' && m.content.trim()) {
          const d = promptDistill.distill(m.content, opts.distill || {});
          m.content = d.distilled; dSaved += d.report.stats.saved; dRemoved += d.report.removed.length; dPct = d.report.stats.savedPct; hit = true;
        }
      });
      if (hit) { report.instructions = { saved: dSaved, savedPct: dPct, removed: dRemoved }; saved += dSaved; }
    }
  }

  // 3. HISTORY — compress the message array (protects system/task/recent, dedups re-reads).
  //    If a whole-request maxTokens budget is set, derive a history budget (total minus the
  //    system + tools overhead) so compression drops enough to make the WHOLE request fit.
  if (Array.isArray(req.messages) && req.messages.length && opts.compress !== false) {
    const compressOpts = Object.assign({}, opts.compress || {});
    if (Number(opts.maxTokens) > 0) {
      const overhead = _systemTokens(req.system) +
        (Array.isArray(req.tools) ? estTokens(JSON.stringify(req.tools)) : 0);
      const historyBudget = Math.max(50, Math.round(Number(opts.maxTokens) - overhead));
      compressOpts.maxTokens = Number(compressOpts.maxTokens) > 0 ? Math.min(compressOpts.maxTokens, historyBudget) : historyBudget;
    }
    const c = contextCompress.compress(req.messages, compressOpts);
    req.messages = c.messages;
    report.history = {
      messagesBefore: (request && Array.isArray(request.messages) ? request.messages.length : 0),
      messagesAfter: c.messages.length, saved: c.stats.saved, elided: c.stats.elided, dropped: c.stats.dropped,
    };
    saved += c.stats.saved || 0;
  }

  // 4. CACHE — insert provider prompt-cache breakpoints on the STABLE prefix (opt-in via
  //    opts.cache). The system prompt is identical every turn, so marking it cacheable saves
  //    ~90% on it after the first call. Tools are cached ONLY when not being trimmed — a
  //    per-turn tool subset changes the prefix and would miss the cache every turn. OpenAI
  //    caches prefixes automatically, so for that shape this is a no-op beyond a note.
  if (opts.cache) {
    const cc = { type: 'ephemeral' };
    const rep = { system: false, tools: false, note: '' };
    if (typeof req.system === 'string' && req.system.trim()) {
      req.system = [{ type: 'text', text: req.system, cache_control: cc }];
      rep.system = true;
    } else if (Array.isArray(req.system) && req.system.length) {
      req.system = req.system.slice();
      const li = req.system.length - 1;
      req.system[li] = Object.assign({}, req.system[li], { cache_control: cc });
      rep.system = true;
    }
    if (opts.tools === false && Array.isArray(req.tools) && req.tools.length) {
      req.tools = req.tools.slice();
      const li = req.tools.length - 1;
      req.tools[li] = Object.assign({}, req.tools[li], { cache_control: cc });
      rep.tools = true;
    }
    rep.note = rep.system
      ? 'cache_control set on the stable system prefix' + (rep.tools ? ' + tools' : '')
      : 'no block-shaped system to mark — OpenAI caches long prefixes automatically';
    report.cache = rep;
  }

  report.tokensSaved = Math.round(saved);
  // whole-request budget verdict — measured the same (content-based) way compress counts, so
  // `fit` is reliable: true means the returned request is guaranteed at/under maxTokens.
  if (Number(opts.maxTokens) > 0) {
    const finalTokens = _requestTokens(req);
    report.budget = { limit: Math.round(Number(opts.maxTokens)), finalTokens, fit: finalTokens <= Number(opts.maxTokens) };
  }
  try {
    bumpStats((s) => {
      if (report.tools && report.tools.saved > 0) { s.byMethod.toolInject = (s.byMethod.toolInject || 0) + 1; addSaved(s, 'toolInject', report.tools.saved); }
      if (report.instructions && report.instructions.saved > 0) { s.byMethod.distill = (s.byMethod.distill || 0) + 1; addSaved(s, 'distill', report.instructions.saved); }
      if (report.history && report.history.saved > 0) { s.byMethod.compress = (s.byMethod.compress || 0) + 1; addSaved(s, 'compress', report.history.saved); }
    });
  } catch (_) {}

  return { request: req, report };
}

// =========================================================================== SKILLS REGISTRY (Stage 2)
/**
 * A "compiled program": define a named, deterministic skill
 * ONCE (a pattern -> action) and run it forever with NO LLM call.
 *
 * Persisted at <AURA_HOME>/skills.json as an array of:
 *   { name, match, action, createdAt }
 *
 *   match  — a string. If wrapped in /.../  (optionally /.../i) it is treated as a
 *            REGEX; otherwise it is a keyword/substring match (case-insensitive, and
 *            also matches if ALL whitespace-separated words appear in the prompt).
 *   action — a safe, deterministic op (NO eval / Function):
 *            { type:'answer',   text }   fixed/templated answer ($1,$2 = regex capture groups)
 *            { type:'template', text }   same as 'answer' (alias; reads as "fill a template")
 *            { type:'adapter', adapter, args }  call a registered free data adapter (async; via ask())
 *
 * matchSkill(prompt) is SYNCHRONOUS and only resolves answer/template skills (used by
 * route()). Adapter skills are resolved by ask() because they do network I/O.
 */
const MAX_SKILLS      = 2000;   // load-time cap (skills.json can be hand-edited)
const MAX_MATCH_CHARS = 500;    // mirror the validator's match cap at load
const MAX_TEXT_CHARS  = 10000;  // mirror the validator's answer/text cap at load

// loadSkills — read + defensively sanitize the (possibly hand-edited) registry.
// Anything that could hang or bloat matching is dropped here so it can never execute,
// not just so it can't be added: over-cap count, oversized fields, and regexes that
// fail the ReDoS screen. Well-formed keyword/answer skills are untouched.
function loadSkills() {
  const s = readJson(SKILLS_FILE, []);
  if (!Array.isArray(s)) return [];
  const capped = s.length > MAX_SKILLS ? s.slice(0, MAX_SKILLS) : s;
  return capped.filter((sk) => {
    if (!sk || typeof sk !== 'object') return false;
    if (typeof sk.match === 'string' && sk.match.length > MAX_MATCH_CHARS) return false;
    const a = sk.action;
    if (a && typeof a.text === 'string' && a.text.length > MAX_TEXT_CHARS) return false;
    if (!isRegexSafe(sk)) return false; // inert: a catastrophic regex never reaches p.match()
    return true;
  });
}
function saveSkills(arr) { return writeJson(SKILLS_FILE, Array.isArray(arr) ? arr : []); }

// Parse a /.../ or /.../flags string into a RegExp; returns null if not a regex literal or invalid.
function parseRegexLiteral(str) {
  const m = String(str || '').match(/^\/(.*)\/([a-z]*)$/i);
  if (!m) return null;
  try { return new RegExp(m[1], m[2]); } catch (_) { return null; }
}
// Build a RegExp for a skill's match. If `match` is a /.../ literal use it; else if the
// skill was added with regex:true treat the raw string as a pattern; else return null
// (caller falls back to keyword matching).
function skillRegex(skill) {
  const lit = parseRegexLiteral(skill && skill.match);
  if (lit) return lit;
  if (skill && skill.regex) { try { return new RegExp(skill.match, 'i'); } catch (_) { return null; } }
  return null;
}
// Keyword match: every whitespace-separated token of `match` appears in the prompt (case-insensitive).
function keywordMatch(prompt, match) {
  const p = String(prompt || '').toLowerCase();
  const words = String(match || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => p.includes(w));
}
// Fill $1,$2,... in a template from a regex match array.
function fillTemplate(text, m) {
  return String(text == null ? '' : text).replace(/\$(\d+)/g, (whole, n) => {
    const v = m && m[Number(n)];
    return v === undefined || v === null ? whole : String(v);
  });
}

/**
 * matchSkill(prompt) — find the FIRST skill whose match applies and which can be
 * resolved deterministically WITHOUT I/O (answer/template). Returns
 *   { name, action, text, match }   on a hit (text = filled answer), or null.
 * Adapter skills are reported via { name, action, adapter:true } so ask() can run them,
 * but route() will treat that as "no sync answer". Never throws.
 */
// specificity(skill) — how "targeted" a skill's match is, used only as a tiebreak
// when two skills share the same priority. More match words = more specific = wins.
function specificity(skill) {
  return String((skill && skill.match) || '').trim().split(/\s+/).filter(Boolean).length;
}
// Resolve a skill's effective priority for sorting. Honors any finite value in 0..1000
// (including a numeric string like "999" from a hand-edited skills.json); otherwise the
// documented default of 100. Never NaN, so the sort stays deterministic.
function skillPriority(skill) {
  const n = Number(skill && skill.priority);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 100;
}

function matchSkill(prompt) {
  try {
    const p = String(prompt || '');
    if (!p.trim()) return null;
    // Collect EVERY applicable skill, then apply conflict precedence rather than
    // taking the first insertion-order match: explicit `priority` (higher wins),
    // then keyword count / specificity, then original insertion order.
    const candidates = [];
    const skills = loadSkills();
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];
      if (!skill || !skill.action || !skill.match) continue;
      const re = skillRegex(skill);
      let m = null, applies = false;
      if (re) { m = p.match(re); applies = !!m; }
      else { applies = keywordMatch(p, skill.match); }
      if (!applies) continue;
      candidates.push({ skill, m, index: i });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const pa = skillPriority(a.skill), pb = skillPriority(b.skill);
      if (pb !== pa) return pb - pa;                     // higher priority first
      const sb = specificity(b.skill), sa = specificity(a.skill);
      if (sb !== sa) return sb - sa;                     // more specific first
      return a.index - b.index;                          // else insertion order
    });
    const { skill, m } = candidates[0];
    const a = skill.action;
    if (a.type === 'answer' || a.type === 'template') {
      return { name: skill.name, action: a, text: fillTemplate(a.text, m || []), match: m || null };
    }
    if (a.type === 'adapter') {
      // network-bound — resolved by ask(), not route()
      return { name: skill.name, action: a, adapter: true, match: m || null };
    }
    return null;
  } catch (_) { return null; }
}

/**
 * addSkill(skill) — validate then persist (replacing any existing skill of the same
 * name). Returns true on save, or an { ok:false, errors } object when the skill is
 * rejected by the validator so callers can surface why. A bare `false` means a write
 * failure. Invalid skills are NEVER written to skills.json.
 */
function addSkill(skill) {
  try {
    if (!skill || typeof skill !== 'object') return false;
    const name = String(skill.name);
    const candidate = {
      name,
      match: String(skill.match),
      regex: !!skill.regex,
      priority: Number.isInteger(skill.priority) ? skill.priority : 100,
      action: skill.action,
      createdAt: new Date().toISOString()
    };
    const others = loadSkills().filter((s) => s && String(s.name).toLowerCase() !== name.toLowerCase());
    const { ok, errors } = validateSkill(candidate, others);
    if (!ok) return { ok: false, errors };
    others.push(candidate); // replace existing by name = keep others + this one
    return saveSkills(others);
  } catch (_) { return false; }
}
function listSkills() { return loadSkills(); }
function removeSkill(name) {
  try {
    const arr = loadSkills();
    const next = arr.filter((s) => s && s.name !== String(name));
    if (next.length === arr.length) return false; // nothing removed
    return saveSkills(next);
  } catch (_) { return false; }
}

// --------------------------------------------------------------------------- adapters (free, no-key data fetchers)
/**
 * Adapter registry. Each adapter is an async fn(args) -> string|null. They gracefully
 * degrade: any error / offline / not-found returns null (a soft miss) — never throws.
 * Adapters run through ask() (async), so route() stays synchronous.
 */
const ADAPTERS = {
  // Crypto spot price via CoinLore (free, no key). args: { coin: 'bitcoin'|'btc'|... }
  async price(args = {}) {
    try {
      const coin = String(args.coin || '').trim();
      if (!coin) return null;
      if (typeof fetch !== 'function') return null;
      // resolve a coin id from CoinLore's ticker list (cached lookup by symbol or name)
      const r = await fetch('https://api.coinlore.net/api/tickers/?start=0&limit=100');
      if (!r || !r.ok) return null;
      const j = await r.json();
      const list = (j && Array.isArray(j.data)) ? j.data : [];
      const q = coin.toLowerCase();
      const hit = list.find((c) => c && (String(c.symbol).toLowerCase() === q || String(c.nameid).toLowerCase() === q || String(c.name).toLowerCase() === q));
      if (!hit) return null;
      return `${hit.name} (${hit.symbol}): $${hit.price_usd}`;
    } catch (_) { return null; }
  }
};
/** runAdapter(name, args) — async, resolves template $n in string args first. Returns string|null. */
async function runAdapter(name, args, m) {
  try {
    const fn = ADAPTERS[name];
    if (typeof fn !== 'function') return null;
    const filled = {};
    for (const k of Object.keys(args || {})) {
      const v = args[k];
      filled[k] = (typeof v === 'string') ? fillTemplate(v, m || []) : v;
    }
    const out = await fn(filled);
    return (out === undefined || out === null) ? null : String(out);
  } catch (_) { return null; }
}

// =========================================================================== cheapest-capable routing
/**
 * classifyTier(prompt) — pick the SMALLEST capable tier so a miss costs the least.
 *   light    — short, simple Q&A / rewrite / classify (cheapest model)
 *   balanced — multi-step reasoning, summaries, medium length
 *   heavy    — code, long context, math proofs, "explain in depth"
 * Heuristic only (free): length + keyword signals. Keep intelligence
 * off the hot path; a tiny deterministic classifier replaces a model-picks-model call.
 */
function classifyTier(prompt) {
  const p = String(prompt || '');
  const len = p.length;
  const heavy = /\b(code|function|debug\w*|algorithm\w*|proof|prove|refactor\w*|architect\w*|step[- ]by[- ]step|in depth|comprehensive|essay|analyze deeply)\b/i.test(p);
  const balanced = /\b(summar\w*|explain\w*|compar\w*|plan\w*|outline\w*|reason\w*|why|how does|pros and cons|strateg\w*)\b/i.test(p);
  if (heavy || len > 800) return 'heavy';
  if (balanced || len > 240) return 'balanced';
  return 'light';
}
// Cheapest capable model per provider per tier.
const MODEL_TIERS = {
  openrouter: { light: 'openai/gpt-4o-mini', balanced: 'openai/gpt-4o-mini', heavy: 'openai/gpt-4o' },
  openai:     { light: 'gpt-4o-mini',        balanced: 'gpt-4o-mini',        heavy: 'gpt-4o' },
  anthropic:  { light: 'claude-haiku-4-5-20251001', balanced: 'claude-haiku-4-5-20251001', heavy: 'claude-sonnet-4-6' }
};
function pickModel(provider, prompt, override) {
  if (override) return { model: override, tier: 'override' };
  const tier = classifyTier(prompt);
  return { model: (MODEL_TIERS[provider] || {})[tier], tier };
}

// =========================================================================== LLM fallback (optional, only if a key is present)
/**
 * Detect a provider from env and call it. Returns { ok, answer, provider, model, tier } or { ok:false, reason }.
 * Providers (first key found wins): OpenRouter, OpenAI, Anthropic. Picks the cheapest
 * capable model for the prompt's tier (override with opts.model). Uses global fetch — no deps.
 */
async function askLLM(prompt, opts = {}) {
  try {
    if (process.env.OPENROUTER_API_KEY) {
      const { model: m, tier } = pickModel('openrouter', prompt, opts.model);
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }] })
      });
      const j = await r.json();
      const a = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (a) return { ok: true, answer: a.trim(), provider: 'openrouter', model: m, tier };
      return { ok: false, reason: (j && j.error && j.error.message) || 'no content' };
    }
    if (process.env.OPENAI_API_KEY) {
      const { model: m, tier } = pickModel('openai', prompt, opts.model);
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }] })
      });
      const j = await r.json();
      const a = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (a) return { ok: true, answer: a.trim(), provider: 'openai', model: m, tier };
      return { ok: false, reason: (j && j.error && j.error.message) || 'no content' };
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { model: m, tier } = pickModel('anthropic', prompt, opts.model);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
      });
      const j = await r.json();
      const a = j && j.content && j.content[0] && j.content[0].text;
      if (a) return { ok: true, answer: a.trim(), provider: 'anthropic', model: m, tier };
      return { ok: false, reason: (j && j.error && j.error.message) || 'no content' };
    }
    return { ok: false, reason: 'no-key' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/**
 * ask(prompt, opts) — the full saver flow.
 *   1. route() (cache/compute). If hit, return it (free).
 *   2. else, if opts.llm AND a provider key exists, call the LLM, record the answer, return it.
 *   3. else return { hit:false } (caller decides).
 */
async function ask(prompt, opts = {}) {
  const r = route(prompt, opts);
  if (r.hit) return { ...r, source: 'aura' };
  // Adapter skills (network-bound) run here — route() can't (it's sync). They degrade
  // gracefully: a null/offline result falls through to the normal miss/LLM path.
  try {
    const sk = matchSkill(prompt);
    if (sk && sk.adapter) {
      const ans = await runAdapter(sk.action.adapter, sk.action.args, sk.match);
      if (ans !== null) {
        const saved = estTokens(prompt) + estTokens(ans);
        bumpStats((s) => { s.hits++; s.byMethod.skill++; addSaved(s, "skill", saved); });
        try { recordAnswer(prompt, ans, opts); } catch (_) {}
        return { hit: true, method: 'skill', answer: ans, savedTokensEst: saved, skill: sk.name, source: 'aura' };
      }
    }
  } catch (_) {}
  if (opts.llm) {
    const llm = await askLLM(prompt, opts);
    if (llm.ok) { recordAnswer(prompt, llm.answer, opts); return { hit: false, method: 'llm', answer: llm.answer, provider: llm.provider, model: llm.model, tier: llm.tier, source: 'llm' }; }
    return { hit: false, method: 'miss', reason: llm.reason };
  }
  return { hit: false, method: 'miss' };
}

module.exports = {
  route, recordAnswer, recordDistill, selectTools, optimize, stats, clearCache, ask, askLLM, compute, cosineSim, classifyTier, pickModel,
  // context-optimizer surfaces (also usable standalone)
  distill: promptDistill.distill, compress: contextCompress.compress,
  // Stage 2 — saved-skills registry
  addSkill, listSkills, removeSkill, matchSkill, runAdapter, ADAPTERS,
  // Phase 1 — schema validation
  validateSkill,
  CACHE_FILE, SKILLS_FILE, DATA_DIR
};
