'use strict';
// Phase 1 — schema validation, precedence, and CLI-facing guarantees.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the registry so tests never touch the real ~/.shaddai-aura.
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-validate-test-' + Date.now());
const A = require('./aura-core');
const { validateSkill, validateAll, looksCatastrophic, isRegexSafe } = require('./lib/validate-skill');

// --- validateSkill: shape + semantic checks ---------------------------------
test('valid answer skill passes', () => {
  const r = validateSkill({ name: 'ok', match: 'hello', action: { type: 'answer', text: 'hi' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.errors, []);
});

test('template alias is accepted (backward compat)', () => {
  const r = validateSkill({ name: 't', match: 'order (\\d+)', regex: true, action: { type: 'template', text: 'Order #$1' } });
  assert.strictEqual(r.ok, true);
});

test('missing match is rejected with a readable error', () => {
  const r = validateSkill({ name: 'x', action: { type: 'answer', text: 'hi' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /match is required/.test(e)));
});

test('answer action without text is rejected', () => {
  const r = validateSkill({ name: 'x', match: 'y', action: { type: 'answer' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /answer action requires/.test(e)));
});

test('invalid regex syntax is rejected with the engine message', () => {
  const r = validateSkill({ name: 'bad', match: '(', regex: true, action: { type: 'answer', text: 'x' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /invalid regex/.test(e)));
});

test('safe single-quantifier group (\\d+) is NOT flagged as ReDoS', () => {
  assert.strictEqual(looksCatastrophic('order (\\d+)'), false);
  const r = validateSkill({ name: 'order', match: 'order (\\d+)', regex: true, action: { type: 'template', text: '#$1' } });
  assert.strictEqual(r.ok, true);
});

test('nested-quantifier ReDoS shape (\\w+)+ is flagged', () => {
  assert.strictEqual(looksCatastrophic('(\\w+)+'), true);
  const r = validateSkill({ name: 'evil', match: '(\\w+)+$', regex: true, action: { type: 'answer', text: 'x' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /backtracking/.test(e)));
});

test('unknown adapter (shell) is rejected; allowlisted price passes', () => {
  const bad = validateSkill({ name: 'sh', match: 'run', action: { type: 'adapter', adapter: 'shell' } });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((e) => /adapter not allowed/.test(e)));
  const good = validateSkill({ name: 'p', match: 'btc price', action: { type: 'adapter', adapter: 'price', args: { coin: 'btc' } } });
  assert.strictEqual(good.ok, true);
});

test('chain with empty steps is rejected', () => {
  const r = validateSkill({ name: 'c', match: 'go', action: { type: 'chain', steps: [] } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /chain action requires/.test(e)));
});

test('chain with a valid step passes; nested chain step is rejected', () => {
  const ok = validateSkill({ name: 'c', match: 'go', action: { type: 'chain', steps: [{ type: 'compute', expr: 'x' }] } });
  assert.strictEqual(ok.ok, true);
  const nested = validateSkill({ name: 'c2', match: 'go', action: { type: 'chain', steps: [{ type: 'chain', steps: [] }] } });
  assert.strictEqual(nested.ok, false);
  assert.ok(nested.errors.some((e) => /step 1:/.test(e)));
});

test('priority out of range is rejected', () => {
  const r = validateSkill({ name: 'x', match: 'y', priority: 5000, action: { type: 'answer', text: 'z' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /priority must be/.test(e)));
});

// --- validateAll: batch + duplicate names -----------------------------------
test('validateAll flags duplicate skill names', () => {
  const report = validateAll([
    { name: 'dup', match: 'a', action: { type: 'answer', text: '1' } },
    { name: 'dup', match: 'b', action: { type: 'answer', text: '2' } }
  ]);
  assert.strictEqual(report.ok, false);
  assert.ok(report.errors.some((e) => /duplicate skill name/.test(e)));
});

test('validateAll passes a clean set', () => {
  const report = validateAll([
    { name: 'a', match: 'x', action: { type: 'answer', text: '1' } },
    { name: 'b', match: 'y', action: { type: 'answer', text: '2' } }
  ]);
  assert.strictEqual(report.ok, true);
});

// --- addSkill enforcement ---------------------------------------------------
test('addSkill rejects an invalid skill and does NOT persist it', () => {
  const res = A.addSkill({ name: 'bad-adapter', match: 'go', action: { type: 'adapter', adapter: 'shell' } });
  assert.strictEqual(res.ok, false);
  assert.ok(!A.listSkills().some((s) => s.name === 'bad-adapter'), 'invalid skill was not written');
});

test('addSkill persists a valid skill and returns true', () => {
  assert.strictEqual(A.addSkill({ name: 'good', match: 'hello there', action: { type: 'answer', text: 'hi' } }), true);
  assert.ok(A.listSkills().some((s) => s.name === 'good'));
});

// --- precedence: priority > specificity > insertion order -------------------
test('higher priority skill wins when two match the same prompt', () => {
  A.addSkill({ name: 'low', match: 'deploy now', priority: 10, action: { type: 'answer', text: 'LOW' } });
  A.addSkill({ name: 'high', match: 'deploy now', priority: 900, action: { type: 'answer', text: 'HIGH' } });
  const r = A.route('please deploy now to prod');
  assert.strictEqual(r.method, 'skill');
  assert.strictEqual(r.answer, 'HIGH');
  assert.strictEqual(r.skill, 'high');
});

test('at equal priority the more specific (more keywords) skill wins', () => {
  A.clearCache();
  A.addSkill({ name: 'broad', match: 'refund', action: { type: 'answer', text: 'BROAD' } });
  A.addSkill({ name: 'narrow', match: 'refund policy details', action: { type: 'answer', text: 'NARROW' } });
  const r = A.route('what are the refund policy details here');
  assert.strictEqual(r.answer, 'NARROW');
});

// --- ReDoS hardening (P0 from review) ---------------------------------------
test('looksCatastrophic catches overlapping-alternation families', () => {
  assert.strictEqual(looksCatastrophic('(a|a)*'), true);   // identical branches
  assert.strictEqual(looksCatastrophic('(a|ab)+'), true);  // prefix overlap
  assert.strictEqual(looksCatastrophic('(x|xy)*'), true);
  assert.strictEqual(looksCatastrophic('(.*)*'), true);    // nested (family 1)
  assert.strictEqual(looksCatastrophic('(a+)+b'), true);
});

test('looksCatastrophic does NOT false-positive on safe alternation', () => {
  assert.strictEqual(looksCatastrophic('(cat|dog)+'), false);
  assert.strictEqual(looksCatastrophic('(\\d+)'), false);
  assert.strictEqual(looksCatastrophic('(red|green|blue)'), false);
});

test('regex:true alternation ReDoS is rejected by addSkill (was a hang)', () => {
  const res = A.addSkill({ name: 'evil-alt', match: '(a|a)*b', regex: true, action: { type: 'answer', text: 'x' } });
  assert.strictEqual(res.ok, false);
  assert.ok(!A.listSkills().some((s) => s.name === 'evil-alt'));
});

test('/.../ literal ReDoS is rejected by addSkill (was never checked)', () => {
  const res = A.addSkill({ name: 'evil-lit', match: '/(a+)+$/', action: { type: 'answer', text: 'x' } });
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /backtracking/.test(e)));
});

test('isRegexSafe: keyword skills always safe; catastrophic literal unsafe', () => {
  assert.strictEqual(isRegexSafe({ name: 'k', match: 'plain words' }), true);
  assert.strictEqual(isRegexSafe({ name: 'e', match: '/(a+)+$/' }), false);
  assert.strictEqual(isRegexSafe({ name: 'g', match: 'order (\\d+)', regex: true }), true);
});

test('hand-edited catastrophic skill in skills.json is INERT at load (no hang)', () => {
  // Write a malicious skill straight to disk, bypassing addSkill's guard.
  const file = path.join(process.env.AURA_HOME, 'skills.json');
  fs.writeFileSync(file, JSON.stringify([
    { name: 'planted', match: '/(a+)+$/', action: { type: 'answer', text: 'PWN' } },
    { name: 'clean', match: 'safe keyword', action: { type: 'answer', text: 'OK' } }
  ]));
  // route() must NOT hang on the pathological input, and must skip the planted skill.
  const r = A.route('a'.repeat(40) + '!');
  assert.notStrictEqual(r.answer, 'PWN');
  // the clean skill still loads and works
  assert.strictEqual(A.route('this is a safe keyword test').answer, 'OK');
});

test('load-time cap: oversized match field is dropped, not matched', () => {
  const file = path.join(process.env.AURA_HOME, 'skills.json');
  fs.writeFileSync(file, JSON.stringify([
    { name: 'huge', match: 'x'.repeat(600), action: { type: 'answer', text: 'BIG' } },
    { name: 'ok', match: 'tiny match', action: { type: 'answer', text: 'SMALL' } }
  ]));
  assert.ok(!A.listSkills().some((s) => s.name === 'huge'), 'oversized skill dropped at load');
  assert.strictEqual(A.route('here is a tiny match please').answer, 'SMALL');
});

test('hand-edited numeric-string priority is honored in sort', () => {
  const file = path.join(process.env.AURA_HOME, 'skills.json');
  fs.writeFileSync(file, JSON.stringify([
    { name: 'strhigh', match: 'ship it', priority: '900', action: { type: 'answer', text: 'STRHIGH' } },
    { name: 'intlow', match: 'ship it', priority: 10, action: { type: 'answer', text: 'INTLOW' } }
  ]));
  const r = A.route('please ship it now');
  assert.strictEqual(r.answer, 'STRHIGH');
});

test.after(() => { try { fs.rmSync(process.env.AURA_HOME, { recursive: true, force: true }); } catch (_) {} });
