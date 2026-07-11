'use strict';
// Knowledge ingestion: markdown/plain-text chunking + fact planning + safe file reads.
// Hermetic — writes synthetic docs into an isolated tmp AURA_HOME/dir, never reads the
// user's real files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate AURA_HOME to a throwaway tmp dir BEFORE requiring anything that touches it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ingest-'));
process.env.AURA_HOME = path.join(TMP, 'home');

const IN = require('./lib/ingest');

// --- chunkMarkdown ----------------------------------------------------------
test('chunkMarkdown splits on ATX headings; title cleaned, body captured', () => {
  const md = [
    '# What is AURA',
    'AURA is a zero-dependency token saver.',
    '',
    '## How does caching work',
    'It normalizes a prompt to a sha256 key, then does a fuzzy fallback.',
    '',
    '### Refund policy:',
    '30 days, no questions asked.'
  ].join('\n');
  const chunks = IN.chunkMarkdown(md);
  const titles = chunks.map((c) => c.title);
  assert.deepStrictEqual(titles, ['What is AURA', 'How does caching work', 'Refund policy']);
  assert.match(chunks[0].body, /zero-dependency token saver/);
  assert.match(chunks[2].body, /30 days/);
});

test('chunkMarkdown handles setext headings and code fences (no headings inside code)', () => {
  const md = [
    'Overview',
    '========',
    'Intro text here.',
    '',
    '```',
    '# not a heading (inside a fence)',
    '```',
    'more intro'
  ].join('\n');
  const chunks = IN.chunkMarkdown(md);
  assert.strictEqual(chunks[0].title, 'Overview');
  // the "# not a heading" must NOT have created a second chunk
  assert.strictEqual(chunks.length, 1);
  assert.match(chunks[0].body, /not a heading/);
});

test('chunkMarkdown splits plain text (no headings) into paragraph chunks', () => {
  const txt = 'The support email is help@example.com.\nContact us anytime.\n\nRefunds take five business days.';
  const chunks = IN.chunkMarkdown(txt);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].title, 'The support email is help@example.com.');
  assert.match(chunks[1].body, /five business days/);
});

// --- planIngest -------------------------------------------------------------
test('planIngest builds valid facts with prompt/answer/source', () => {
  const files = [{ path: '/doc.md', text: '# What is the capital of France\nParis is the capital.' }];
  const plan = IN.planIngest(files);
  assert.strictEqual(plan.facts.length, 1);
  const f = plan.facts[0];
  assert.strictEqual(f.prompt, 'What is the capital of France');
  assert.strictEqual(f.answer, 'Paris is the capital.');
  assert.strictEqual(f.source, '/doc.md');
  assert.strictEqual(plan.stats.secretsDropped, 0);
});

test('planIngest DROPS a chunk containing a fake secret (title or body)', () => {
  const files = [{
    path: '/secrets.md',
    text: [
      '# Public fact',
      'The sky is blue.',
      '',
      '# Deploy key',
      'Use ghp_abcdefghijklmnopqrstuvwxyz0123456 to push.'
    ].join('\n')
  }];
  const plan = IN.planIngest(files);
  assert.strictEqual(plan.stats.secretsDropped, 1);
  assert.strictEqual(plan.facts.length, 1);
  assert.strictEqual(plan.facts[0].prompt, 'Public fact');
  // the secret body must never appear in any taught fact
  assert.ok(!plan.facts.some((f) => /ghp_/.test(f.answer)));
});

test('planIngest skips empty bodies; truncates (not drops) oversized bodies', () => {
  const big = 'x'.repeat(IN.MAX_BODY_CHARS + 500);
  const files = [{
    path: '/mixed.md',
    text: `# Empty section\n\n# Big section\n${big}`
  }];
  const plan = IN.planIngest(files);
  assert.strictEqual(plan.stats.empty, 1);              // "Empty section" had no body
  const bigFact = plan.facts.find((f) => f.prompt === 'Big section');
  assert.ok(bigFact, 'oversized body is kept as a truncated fact, not dropped');
  assert.ok(bigFact.answer.length <= IN.MAX_BODY_CHARS + 4); // capped + " …" slack
  assert.strictEqual(plan.stats.tooLong, 0);
});

test('planIngest de-dupes repeated headings (first body wins)', () => {
  const files = [{ path: '/d.md', text: '# FAQ\nfirst answer\n\n# FAQ\nsecond answer' }];
  const plan = IN.planIngest(files);
  assert.strictEqual(plan.facts.length, 1);
  assert.strictEqual(plan.facts[0].answer, 'first answer');
});

// --- readSources (hermetic filesystem) --------------------------------------
test('readSources reads a single .md file', () => {
  const p = path.join(TMP, 'single.md');
  fs.writeFileSync(p, '# Title\nBody text.');
  const sources = IN.readSources(p);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].path, p);
  assert.match(sources[0].text, /Body text/);
});

test('readSources recurses a directory, keeps only .md/.txt, skips others', () => {
  const dir = path.join(TMP, 'docs');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '# A\nalpha');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'beta paragraph');
  fs.writeFileSync(path.join(dir, 'c.json'), '{"x":1}');   // must be ignored
  fs.writeFileSync(path.join(dir, 'sub', 'd.markdown'), '# D\ndelta');
  const sources = IN.readSources(dir);
  const names = sources.map((s) => path.basename(s.path)).sort();
  assert.deepStrictEqual(names, ['a.md', 'b.txt', 'd.markdown']);
});

test('readSources returns [] for a missing path', () => {
  assert.deepStrictEqual(IN.readSources(path.join(TMP, 'nope-does-not-exist')), []);
});

// --- end-to-end: read -> plan -> shape valid for recordAnswer ---------------
test('end-to-end: docs on disk become well-formed facts', () => {
  const dir = path.join(TMP, 'kb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kb.md'), '# What is our refund window\n30 days, no questions asked.');
  const plan = IN.planIngest(IN.readSources(dir));
  assert.ok(plan.facts.length >= 1);
  for (const f of plan.facts) {
    assert.strictEqual(typeof f.prompt, 'string');
    assert.strictEqual(typeof f.answer, 'string');
    assert.ok(f.prompt.length > 0 && f.answer.length > 0);
  }
});
