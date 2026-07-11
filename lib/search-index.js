'use strict';
/**
 * AURA search index — zero-dependency (Node built-ins only).
 *
 * route()'s fuzzy path used to scan EVERY cache entry with cosineSim (O(N) per lookup),
 * which collapses at 100k entries. This module replaces that with an inverted word-index
 * + BM25 ranker: a query only scores the (few) docs that share a CONTENT word with it,
 * and BM25 downweights words common across the cache (df) and long docs (dl) so the best
 * paraphrase wins, not just the biggest bag-of-words overlap.
 *
 * Tokenization is the SAME stopword-aware scheme as aura-core's simToks so index hits and
 * the SIM_THRESHOLD gate stay consistent (filler stripped; falls back to raw tokens if
 * stripping would empty the text). Kept self-contained (no import back into the core) so
 * this stays a dependency-free leaf.
 *
 *   buildIndex(entries) -> index   entries = [{ key, prompt, answer }]
 *   search(index, queryText, { limit=5 }) -> [{ key, score }]  (BM25, candidates only)
 *
 * Uses ONLY node built-ins (none needed — pure JS).
 */

// --------------------------------------------------------------------------- tokenization (mirror of aura-core simToks)
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'what', 'whats', 's', 'please', 'me', 'tell', 'give', 'do', 'you', 'can', 'how', 'i', 'my', 'it', 'this', 'that', 'with', 'about', 'show']);
function normalize(p) { return String(p || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
function toks(s) { return normalize(s).split(' ').filter(Boolean); }
// Stopword-aware tokens: strip filler so CONTENT words dominate ranking, but fall back to
// raw tokens if stripping would leave nothing (a prompt that is ALL stopwords still indexes).
function simToks(s) {
  const all = toks(s);
  const kept = all.filter((t) => !STOP.has(t));
  return kept.length ? kept : all;
}

// --------------------------------------------------------------------------- BM25 params
const K1 = 1.2;   // term-frequency saturation
const B  = 0.75;  // document-length normalization

// buildIndex(entries) — build the inverted index once from the cache.
//   postings: word -> [{ i, tf }]  (i = doc index into docs[])
//   df:       word -> #docs containing it
//   dl:       per-doc token length; avgdl = mean(dl)
// Malformed / empty entries are skipped (never throw). Order of docs is preserved so the
// same input yields the same index (determinism).
function buildIndex(entries) {
  const docs = [];
  const postings = new Map();
  const df = new Map();
  let totalLen = 0;
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const tokens = simToks(e.prompt);
    const i = docs.length;
    docs.push({ key: e.key, answer: e.answer, dl: tokens.length });
    totalLen += tokens.length;
    // term frequencies for this doc
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      let arr = postings.get(t);
      if (!arr) { arr = []; postings.set(t, arr); }
      arr.push({ i, tf: c });
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const avgdl = docs.length ? totalLen / docs.length : 0;
  return { docs, postings, df, avgdl, N: docs.length };
}

// idf(df, N) — BM25 probabilistic idf, floored at 0 so a word in nearly every doc can't
// drag a score negative. Rare words score high, common words low.
function idf(dfw, N) {
  return Math.max(0, Math.log(1 + (N - dfw + 0.5) / (dfw + 0.5)));
}

// search(index, queryText, { limit }) — rank ONLY the candidate docs that share at least
// one content word with the query (gathered from postings), never a full scan. Returns
// [{ key, score }] sorted by BM25 desc, ties broken by doc index for determinism.
function search(index, queryText, opts = {}) {
  if (!index || !index.postings || !index.N) return [];
  const limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 5;
  const qTokens = simToks(queryText);
  if (!qTokens.length) return [];
  // unique query terms
  const seen = new Set();
  const qTerms = [];
  for (const t of qTokens) { if (!seen.has(t)) { seen.add(t); qTerms.push(t); } }

  const { postings, df, avgdl, N, docs } = index;
  const scores = new Map(); // docIndex -> accumulated BM25
  for (const term of qTerms) {
    const arr = postings.get(term);
    if (!arr) continue; // term not in any doc — contributes nothing, adds no candidates
    const w = idf(df.get(term) || 0, N);
    if (w === 0) continue;
    for (const { i, tf } of arr) {
      const dl = docs[i].dl;
      const denom = tf + K1 * (1 - B + B * (avgdl ? dl / avgdl : 0));
      const contrib = denom ? w * (tf * (K1 + 1)) / denom : 0;
      scores.set(i, (scores.get(i) || 0) + contrib);
    }
  }
  if (!scores.size) return [];
  const ranked = [];
  for (const [i, score] of scores) ranked.push({ key: docs[i].key, score, i });
  ranked.sort((a, b) => (b.score - a.score) || (a.i - b.i)); // deterministic tiebreak
  return ranked.slice(0, limit).map((r) => ({ key: r.key, score: Math.round(r.score * 1e6) / 1e6 }));
}

module.exports = { buildIndex, search, simToks, STOP, normalize, toks };
