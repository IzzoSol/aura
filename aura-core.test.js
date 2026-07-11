'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the cache into a throwaway dir so tests never touch the real ~/.shaddai-aura
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-test-' + Date.now());
const A = require('./aura-core');

test('compute: math', () => {
  const r = A.route('what is 12 * 9');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'compute');
  assert.strictEqual(r.answer, '108');
});

test('compute: percent via math (15% of 240 not supported, but 0.15*240 is)', () => {
  const r = A.route('0.15 * 240');
  assert.strictEqual(r.answer, '36');
});

test('compute: unit convert', () => {
  const r = A.route('convert 10 km to miles');
  assert.strictEqual(r.hit, true);
  assert.match(r.answer, /^6\.21/);
});

test('compute: base64 round-trip', () => {
  assert.strictEqual(A.route('base64 encode hello').answer, 'aGVsbG8=');
  assert.strictEqual(A.route('base64 decode aGVsbG8=').answer, 'hello');
});

test('compute: word count', () => {
  assert.strictEqual(A.route('word count of: the quick brown fox').answer, '4');
});

test('safeMath rejects code injection', () => {
  const r = A.route('process.exit(1)');
  assert.strictEqual(r.hit, false); // not arithmetic, no cache, no compute
});

test('cache: learn then exact fetch is free', () => {
  A.recordAnswer('our refund policy', '30 days');
  const r = A.route('our refund policy');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'fetch');
  assert.strictEqual(r.answer, '30 days');
});

test('cache: fuzzy query hit', () => {
  A.recordAnswer('what is the capital of france', 'Paris');
  const r = A.route('what is the capital of France?');
  assert.strictEqual(r.hit, true);
  assert.ok(r.method === 'fetch' || r.method === 'query');
  assert.strictEqual(r.answer, 'Paris');
});

test('stats accumulate and tokensSaved > 0', () => {
  const s = A.stats();
  assert.ok(s.hits > 0);
  assert.ok(s.tokensSaved > 0);
  assert.ok(s.hitRate >= 0 && s.hitRate <= 1);
});

test('ask without --llm returns miss for novel prose', async () => {
  const r = await A.ask('write a haiku about quantum entanglement and breakfast');
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.method, 'miss');
});

// --- AINL-inspired upgrades ---
test('template: percent of', () => {
  assert.strictEqual(A.route('what is 15% of 240').answer, '36');
  assert.strictEqual(A.route('15 percent of 240').answer, '36');
});

test('template: percent off (with savings)', () => {
  assert.strictEqual(A.route('20% off 50').answer, '40 (you save 10)');
});

test('template: tip both phrasings agree', () => {
  assert.strictEqual(A.route('tip on 80 at 18%').answer, 'tip 14.4, total 94.4');
  assert.strictEqual(A.route('18% tip on $80').answer, 'tip 14.4, total 94.4');
});

test('template: percent change', () => {
  assert.strictEqual(A.route('percent change from 80 to 100').answer, '25%');
});

test('template: days between', () => {
  assert.strictEqual(A.route('days between 2026-01-01 and 2026-06-15').answer, '165');
});

test('smarter fuzzy: stopword-stripped query now hits', () => {
  A.recordAnswer('shaddai support email', 'cloudzncrownz@gmail.com');
  const r = A.route("what's the shaddai support email?");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.answer, 'cloudzncrownz@gmail.com');
});

test('routing: cheapest-capable tiers', () => {
  assert.strictEqual(A.classifyTier('what is the capital of france'), 'light');
  assert.strictEqual(A.classifyTier('summarize the causes of the french revolution'), 'balanced');
  assert.strictEqual(A.classifyTier('write a python function to debug this recursive algorithm'), 'heavy');
  assert.strictEqual(A.pickModel('anthropic', 'hi there').tier, 'light');
});

// --- Stage 2: saved-skills registry ---
test('skill: add then route() hits it (method skill)', () => {
  assert.strictEqual(A.addSkill({ name: 'support', match: 'support email', action: { type: 'answer', text: 'cloudzncrownz@gmail.com' } }), true);
  const r = A.route('hey what is your support email please');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'skill');
  assert.strictEqual(r.skill, 'support');
  assert.strictEqual(r.answer, 'cloudzncrownz@gmail.com');
});

test('skill: regex with $1 capture substitution', () => {
  assert.strictEqual(A.addSkill({ name: 'greet', match: '/^hi (\\w+)/i', action: { type: 'answer', text: 'Hello, $1!' } }), true);
  const r = A.route('hi Brittany');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'skill');
  assert.strictEqual(r.answer, 'Hello, Brittany!');
});

test('skill: --regex flag (raw pattern, not /.../) with $1', () => {
  assert.strictEqual(A.addSkill({ name: 'order', match: 'order (\\d+)', regex: true, action: { type: 'template', text: 'Order #$1 is on its way.' } }), true);
  const r = A.route('where is order 4471');
  assert.strictEqual(r.method, 'skill');
  assert.strictEqual(r.answer, 'Order #4471 is on its way.');
});

test('skill: list and remove', () => {
  const before = A.listSkills();
  assert.ok(before.some((s) => s.name === 'support'));
  assert.strictEqual(A.removeSkill('support'), true);
  assert.ok(!A.listSkills().some((s) => s.name === 'support'));
  assert.strictEqual(A.removeSkill('nope-not-here'), false); // nothing removed
});

test('skill: matchSkill returns null for non-matching prompt', () => {
  assert.strictEqual(A.matchSkill('totally unrelated prose about whales'), null);
});

test('skill: adapter is a soft miss in sync route(), resolved by ask()', () => {
  assert.strictEqual(A.addSkill({ name: 'btc', match: 'btc price', action: { type: 'adapter', adapter: 'price', args: { coin: 'btc' } } }), true);
  // route() is synchronous and must NOT resolve a network adapter
  const r = A.route('btc price');
  assert.notStrictEqual(r.method, 'skill');
});

test('skill: adapter path via ask() (mocked fetch, offline-safe)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ name: 'Bitcoin', symbol: 'BTC', nameid: 'bitcoin', price_usd: '75840.00' }] })
  });
  try {
    const r = await A.ask('btc price');
    assert.strictEqual(r.hit, true);
    assert.strictEqual(r.method, 'skill');
    assert.match(r.answer, /Bitcoin \(BTC\): \$75840/);
  } finally { global.fetch = realFetch; }
});

test('skill: adapter degrades gracefully when fetch fails (no throw, miss)', async () => {
  A.clearCache(); // drop the answer the previous (mocked-success) test cached
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await A.ask('btc price'); // no --llm
    assert.strictEqual(r.hit, false);
    assert.strictEqual(r.method, 'miss');
  } finally { global.fetch = realFetch; }
});

test('skill: stats now track byMethod.skill', () => {
  const s = A.stats();
  assert.ok(typeof s.byMethod.skill === 'number');
  assert.ok(s.byMethod.skill > 0);
});

// --- regression: deterministic compute must beat an approximate fuzzy match ---
test('route: compute beats a fuzzy calc collision (15% of 240 -> 36, not cached 3600)', () => {
  A.clearCache();
  A.recordAnswer('what is 15 * 240', '3600'); // a DIFFERENT calc that shares "15"/"240"
  const r = A.route('what is 15% of 240');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.method, 'compute');
  assert.strictEqual(r.answer, '36');
});

test.after(() => { try { fs.rmSync(process.env.AURA_HOME, { recursive: true, force: true }); } catch (_) {} });
