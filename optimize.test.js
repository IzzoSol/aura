'use strict';
/* Tests for aura.optimize() — the one-call context optimizer that runs tool injection +
   distill + history compress on a full request object. Run: node optimize.test.js */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
process.env.AURA_HOME = path.join(os.tmpdir(), 'aura-optimize-' + Date.now());
const A = require('./aura-core');

const TOOLS = [
  { name: 'get_weather', description: 'Get the current weather and forecast for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
  { name: 'send_email', description: 'Send an email message to a recipient', input_schema: { type: 'object', properties: { to: { type: 'string' } } } },
  { name: 'search_web', description: 'Search the internet for information', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'run_sql', description: 'Run a SQL query against the database', input_schema: { type: 'object', properties: { sql: { type: 'string' } } } },
  { name: 'create_file', description: 'Create or write a file on disk', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'delete_file', description: 'Delete a file from disk', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'book_flight', description: 'Book a flight between two airports', input_schema: { type: 'object', properties: { to: { type: 'string' } } } },
  { name: 'convert_currency', description: 'Convert money from one currency to another', input_schema: { type: 'object', properties: { amount: { type: 'number' } } } },
];

const SYSTEM = 'You are a helpful coding agent. Be concise. Be concise. Never delete files without explicit confirmation.';
const bigBlock = 'FILE DUMP:\n' + Array.from({ length: 30 }, (_, i) => `line ${i} of a big tool output`).join('\n');

function history() {
  return [
    { role: 'user', content: 'TASK: help me with my project' },
    { role: 'assistant', content: 'Sure, reading files.' },
    { role: 'user', content: bigBlock },              // big block (old)
    { role: 'assistant', content: 'Analyzed.' },
    { role: 'user', content: bigBlock },              // identical big block again -> dedup
    { role: 'assistant', content: 'Done analyzing.' },
    { role: 'user', content: 'what is the weather in Paris today?' }, // latest user turn drives tool pick
  ];
}

test('optimize() trims tools, distills the system prompt, and compresses history in one call', () => {
  const req = { system: SYSTEM, messages: history(), tools: TOOLS };
  const { request, report } = A.optimize(req, { tools: { k: 2 }, compress: { keepRecent: 2, dedupOver: 100 } });

  assert.ok(request.tools.length < TOOLS.length, 'tools trimmed');
  assert.ok(request.tools.map((t) => t.name).includes('get_weather'), 'kept the relevant tool');
  assert.ok(request.system.length < SYSTEM.length, 'system distilled (duplicate removed)');
  assert.ok(/identical to a later message/.test(JSON.stringify(request.messages)), 'history deduped');

  assert.ok(report.tokensSaved > 0, 'reported positive total savings');
  assert.ok(report.tools.sent < report.tools.total, 'tools surface reported');
  assert.ok(report.instructions.saved > 0, 'instructions surface reported');
  assert.ok(report.history.saved > 0, 'history surface reported');
});

test('optimize() is non-mutating — the original request is untouched', () => {
  const req = { system: SYSTEM, messages: history(), tools: TOOLS };
  const beforeTools = req.tools.length, beforeSystem = req.system, beforeMsgs = req.messages.length;
  A.optimize(req, { tools: { k: 2 } });
  assert.strictEqual(req.tools.length, beforeTools, 'original tools untouched');
  assert.strictEqual(req.system, beforeSystem, 'original system untouched');
  assert.strictEqual(req.messages.length, beforeMsgs, 'original messages untouched');
  assert.strictEqual(req.messages[2].content, bigBlock, 'original message content untouched');
});

test('optimize() handles the OpenAI shape (system as first message) without mutating it', () => {
  const msgs = [{ role: 'system', content: SYSTEM }, ...history()];
  const req = { model: 'gpt-4o', messages: msgs, tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) };
  const { request, report } = A.optimize(req, { tools: { k: 2 }, compress: { keepRecent: 2, dedupOver: 100 } });
  const sysOut = request.messages.find((m) => m.role === 'system');
  assert.ok(sysOut && sysOut.content.length < SYSTEM.length, 'system message distilled in place');
  assert.strictEqual(msgs[0].content, SYSTEM, 'original system message NOT mutated');
  assert.ok(report.instructions.saved > 0);
  assert.strictEqual(request.model, 'gpt-4o', 'unrelated request fields preserved');
});

test('optimize() distills an Anthropic block-array system prompt, preserving structure + cache_control', () => {
  const req = {
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: history(), tools: TOOLS,
  };
  const beforeText = req.system[0].text;
  const { request, report } = A.optimize(req, { tools: { k: 2 }, compress: { keepRecent: 2, dedupOver: 100 } });
  assert.ok(Array.isArray(request.system), 'still a block array');
  assert.strictEqual(request.system[0].type, 'text', 'block type preserved');
  assert.deepStrictEqual(request.system[0].cache_control, { type: 'ephemeral' }, 'cache_control preserved');
  assert.ok(request.system[0].text.length < beforeText.length, 'block text distilled');
  assert.ok(report.instructions.saved > 0, 'instructions surface reported');
  assert.strictEqual(req.system[0].text, beforeText, 'original block NOT mutated');
});

test('optimize({cache:true}) marks the distilled Anthropic system prompt cacheable', () => {
  const req = { system: SYSTEM, messages: history(), tools: TOOLS };
  const { request, report } = A.optimize(req, { tools: { k: 2 }, cache: true });
  assert.ok(Array.isArray(request.system), 'string system converted to block array for cache_control');
  const last = request.system[request.system.length - 1];
  assert.deepStrictEqual(last.cache_control, { type: 'ephemeral' }, 'cache breakpoint set');
  assert.ok(last.text.length < SYSTEM.length, 'the cached block is the DISTILLED system');
  assert.strictEqual(report.cache.system, true);
  assert.strictEqual(req.system, SYSTEM, 'original request not mutated');
});

test('optimize({cache:true}) does NOT cache tools while they are being trimmed (would miss every turn)', () => {
  const { request, report } = A.optimize({ system: SYSTEM, messages: history(), tools: TOOLS }, { tools: { k: 2 }, cache: true });
  assert.ok(!request.tools.some((t) => t.cache_control), 'no cache_control on a per-turn tool subset');
  assert.strictEqual(report.cache.tools, false);
});

test('optimize({cache:true, tools:false}) caches the stable (untrimmed) tool array', () => {
  const { request, report } = A.optimize({ system: SYSTEM, messages: history(), tools: TOOLS }, { tools: false, cache: true });
  const lastTool = request.tools[request.tools.length - 1];
  assert.deepStrictEqual(lastTool.cache_control, { type: 'ephemeral' });
  assert.strictEqual(report.cache.tools, true);
  assert.ok(!TOOLS[TOOLS.length - 1].cache_control, 'original tool not mutated');
});

test('optimize() adds no cache breakpoints by default, and OpenAI shape is a graceful no-op', () => {
  const plain = A.optimize({ system: SYSTEM, messages: history(), tools: TOOLS }, { tools: { k: 2 } });
  assert.ok(!plain.report.cache, 'no cache report without cache:true');
  const openai = A.optimize({ messages: [{ role: 'system', content: SYSTEM }, ...history()], tools: TOOLS }, { cache: true });
  assert.strictEqual(openai.report.cache.system, false, 'OpenAI system-message shape: no block cache_control');
  assert.ok(/automatic/i.test(openai.report.cache.note), 'notes OpenAI auto-caches prefixes');
});

test('optimize() respects per-surface disable flags', () => {
  const req = { system: SYSTEM, messages: history(), tools: TOOLS };
  const { request, report } = A.optimize(req, { tools: false, distill: false });
  assert.strictEqual(request.tools.length, TOOLS.length, 'tools untouched when tools:false');
  assert.strictEqual(request.system, SYSTEM, 'system untouched when distill:false');
  assert.strictEqual(report.tools, null);
  assert.strictEqual(report.instructions, null);
});

test('optimize() degrades gracefully on empty / partial input', () => {
  assert.doesNotThrow(() => A.optimize({}, {}));
  assert.doesNotThrow(() => A.optimize(null));
  const { request } = A.optimize({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(Array.isArray(request.messages));
});

test('optimize() books savings into the ledger', () => {
  const before = A.stats().tokensSaved;
  A.optimize({ system: SYSTEM, messages: history(), tools: TOOLS }, { tools: { k: 2 }, compress: { keepRecent: 2, dedupOver: 100 } });
  assert.ok(A.stats().tokensSaved > before, 'ledger total grew');
  assert.ok((A.stats().byMethod.compress || 0) >= 1, 'compress surface counted');
});

function bigHistory() {
  const msgs = [{ role: 'user', content: 'TASK: build the big project' }];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'assistant', content: 'working on step ' + i });
    msgs.push({ role: 'user', content: 'DATA ' + i + '\n' + Array.from({ length: 25 }, (_, j) => `row ${i}-${j} payload value here`).join('\n') });
  }
  msgs.push({ role: 'user', content: 'what is the weather in Paris' });
  return msgs;
}
const reqTokens = (r) => {
  let t = 0;
  if (typeof r.system === 'string') t += Math.max(1, Math.ceil(r.system.length / 4));
  if (Array.isArray(r.tools)) t += Math.max(1, Math.ceil(JSON.stringify(r.tools).length / 4));
  if (Array.isArray(r.messages)) for (const m of r.messages) t += Math.max(1, Math.ceil(String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length / 4));
  return t;
};

test('optimize({ maxTokens }) compresses hard enough to fit the whole request under budget', () => {
  const req = { system: SYSTEM, messages: bigHistory(), tools: TOOLS };
  const before = reqTokens(req);
  const { request, report } = A.optimize(req, { tools: { k: 2 }, compress: { keepRecent: 2, dedupOver: 100 }, maxTokens: 500 });
  assert.ok(before > 500, 'baseline was over budget (otherwise the test proves nothing)');
  assert.ok(report.budget, 'budget reported');
  assert.strictEqual(report.budget.limit, 500);
  assert.ok(report.budget.fit, 'reported fit');
  assert.ok(reqTokens(request) <= 500, 'actually under the 500-token budget');
});

test('optimize({ maxTokens }) reports fit:false honestly when the budget is impossible', () => {
  const req = { system: SYSTEM, messages: bigHistory(), tools: TOOLS };
  const { report } = A.optimize(req, { tools: { k: 2 }, compress: { keepRecent: 2 }, maxTokens: 15 });
  assert.strictEqual(report.budget.fit, false, 'cannot fit under 15 tokens → honest false, no throw');
});

test('optimize() adds no budget field when maxTokens is not set', () => {
  const { report } = A.optimize({ system: SYSTEM, messages: bigHistory(), tools: TOOLS }, { tools: { k: 2 } });
  assert.ok(!report.budget, 'no budget field without maxTokens');
});

test('stats() breaks savings down PER SURFACE (tokens + cost), not just a lump total', () => {
  const s0 = A.stats();
  const t0 = (s0.tokensByMethod && s0.tokensByMethod.toolInject) || 0;
  const c0 = (s0.tokensByMethod && s0.tokensByMethod.compress) || 0;
  const d0 = (s0.tokensByMethod && s0.tokensByMethod.distill) || 0;
  A.optimize({ system: SYSTEM, messages: history(), tools: TOOLS }, { tools: { k: 2 }, compress: { keepRecent: 2, dedupOver: 100 } });
  const s = A.stats();
  assert.ok(s.tokensByMethod, 'tokensByMethod present');
  assert.ok(s.tokensByMethod.toolInject > t0, 'tool-injection tokens tracked');
  assert.ok(s.tokensByMethod.compress > c0, 'history-compression tokens tracked');
  assert.ok(s.tokensByMethod.distill > d0, 'distillation tokens tracked');
  // per-surface subtotals never exceed the grand total
  const sum = Object.values(s.tokensByMethod).reduce((a, b) => a + b, 0);
  assert.ok(sum <= s.tokensSaved + 1, 'surface subtotals reconcile with the total');
  // cost breakdown is derived and present
  assert.ok(s.costByMethod && typeof s.costByMethod.toolInject === 'number', 'costByMethod present');
});

test('compute hits are attributed to the compute surface in the ledger', () => {
  const before = (A.stats().tokensByMethod || {}).compute || 0;
  A.route('what is 123 * 7');
  assert.ok(((A.stats().tokensByMethod || {}).compute || 0) > before, 'compute surface tokens grew');
});

// library surface: distill + compress are exposed directly too
test('aura-core exposes distill and compress helpers', () => {
  assert.strictEqual(typeof A.distill, 'function');
  assert.strictEqual(typeof A.compress, 'function');
  assert.strictEqual(typeof A.optimize, 'function');
});
