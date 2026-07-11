'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the cache into a throwaway dir so tests never touch the real ~/.shaddai-aura
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-searchidx-test-' + Date.now());
const SI = require('./lib/search-index');
const A = require('./aura-core');

// --- shared corpus -----------------------------------------------------------
const ENTRIES = [
  { key: 'k1', prompt: 'what is the capital of france', answer: 'Paris' },
  { key: 'k2', prompt: 'shaddai support email address', answer: 'cloudzncrownz@gmail.com' },
  { key: 'k3', prompt: 'how do I reset my password', answer: 'Use the reset link.' },
  { key: 'k4', prompt: 'the quick brown fox jumps over the lazy dog', answer: 'a pangram' }
];

test('search-index: buildIndex produces df/avgdl/postings', () => {
  const idx = SI.buildIndex(ENTRIES);
  assert.strictEqual(idx.N, 4);
  assert.ok(idx.avgdl > 0);
  assert.ok(idx.postings.has('capital'));       // content word indexed
  assert.ok(!idx.postings.has('the'));          // stopword stripped by simToks
  assert.strictEqual(idx.df.get('capital'), 1); // appears in exactly one doc
});

test('search-index: paraphrase ranks the right doc first', () => {
  const idx = SI.buildIndex(ENTRIES);
  // shares content words "capital" + "france" with k1 only
  const ranked = SI.search(idx, "what's the capital city of France?", { limit: 5 });
  assert.ok(ranked.length >= 1);
  assert.strictEqual(ranked[0].key, 'k1');
  assert.ok(ranked[0].score > 0);
});

test('search-index: only word-sharing candidates are scored (not a full scan)', () => {
  const idx = SI.buildIndex(ENTRIES);
  // "support email" content words only touch k2
  const ranked = SI.search(idx, 'what is your support email', { limit: 10 });
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].key, 'k2');
});

test('search-index: no-match query returns []', () => {
  const idx = SI.buildIndex(ENTRIES);
  assert.deepStrictEqual(SI.search(idx, 'quantum entanglement breakfast haiku', { limit: 5 }), []);
});

test('search-index: empty query and empty index return []', () => {
  const idx = SI.buildIndex(ENTRIES);
  assert.deepStrictEqual(SI.search(idx, '', { limit: 5 }), []);
  assert.deepStrictEqual(SI.search(SI.buildIndex([]), 'anything', { limit: 5 }), []);
});

test('search-index: buildIndex tolerates malformed entries', () => {
  const idx = SI.buildIndex([null, 42, { key: 'ok', prompt: 'hello world', answer: 'x' }, {}]);
  // null/42 skipped; {} indexes as a zero-length doc, so N counts the two objects
  assert.ok(idx.N >= 1);
  const ranked = SI.search(idx, 'hello world', { limit: 5 });
  assert.strictEqual(ranked[0].key, 'ok');
});

test('search-index: BM25 downweights common words (rare term wins ranking)', () => {
  // "report" appears in every doc (common, low idf); "quarterly" in one (rare, high idf)
  const entries = [
    { key: 'a', prompt: 'annual report finance', answer: '1' },
    { key: 'b', prompt: 'weekly report team', answer: '2' },
    { key: 'c', prompt: 'quarterly report earnings', answer: '3' }
  ];
  const idx = SI.buildIndex(entries);
  const ranked = SI.search(idx, 'quarterly report', { limit: 5 });
  assert.strictEqual(ranked[0].key, 'c'); // the rare-word match, not just any "report"
});

test('search-index: deterministic across repeated calls', () => {
  const idx1 = SI.buildIndex(ENTRIES);
  const idx2 = SI.buildIndex(ENTRIES);
  const r1 = SI.search(idx1, 'capital of france', { limit: 5 });
  const r2 = SI.search(idx2, 'capital of france', { limit: 5 });
  assert.deepStrictEqual(r1, r2);
});

test('search-index: shares tokenization with aura-core (same simToks)', () => {
  // stopword stripping + fallback behavior must match the core's fuzzy path
  assert.deepStrictEqual(SI.simToks("what's the capital of france"), ['capital', 'france']);
  assert.deepStrictEqual(SI.simToks('the is of'), ['the', 'is', 'of']); // all-stopword fallback
});

// --- integration with route() ------------------------------------------------
test('route: index-backed fuzzy query still hits (semantics preserved)', () => {
  A.recordAnswer('what is the capital of france', 'Paris');
  const r = A.route('what is the capital of France?');
  assert.strictEqual(r.hit, true);
  assert.ok(r.method === 'fetch' || r.method === 'query');
  assert.strictEqual(r.answer, 'Paris');
});

test('route: weak match still MISSES under SIM_THRESHOLD', () => {
  A.recordAnswer('shaddai support email address', 'cloudzncrownz@gmail.com');
  // shares one word ("shaddai") but cosine stays below 0.82 -> must not fuzzy-hit
  const r = A.route('shaddai pricing tiers overview breakdown');
  assert.strictEqual(r.hit, false);
});

test('route: fuzzy query records similarity field on a real paraphrase hit', () => {
  A.clearCache();
  A.recordAnswer('shaddai support email', 'cloudzncrownz@gmail.com');
  const r = A.route("what's the shaddai support email?");
  assert.strictEqual(r.hit, true);
  if (r.method === 'query') assert.ok(typeof r.similarity === 'number' && r.similarity >= 0.82);
});

// --- REGRESSION: deterministic compute must beat an approximate fuzzy match ---
test('route: compute wins over a fuzzy calc collision (15% of 240 -> 36, NOT 3600)', () => {
  A.clearCache();
  A.recordAnswer('what is 15 * 240', '3600'); // cache a DIFFERENT calc sharing "15"/"240"
  const r = A.route('what is 15% of 240');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'compute'); // deterministic, not the fuzzy 3600
  assert.strictEqual(r.answer, '36');
});

test('route: exact cache STILL beats compute (exact stays authoritative)', () => {
  A.clearCache();
  // Cache the exact prompt with a (deliberately wrong) answer; exact hit must win.
  A.recordAnswer('what is 2 + 2', 'five');
  const r = A.route('what is 2 + 2');
  assert.strictEqual(r.method, 'fetch');
  assert.strictEqual(r.answer, 'five');
});

test.after(() => { try { fs.rmSync(process.env.AURA_HOME, { recursive: true, force: true }); } catch (_) {} });
