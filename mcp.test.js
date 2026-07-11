// Verifies the AURA MCP server: handshake, tools, graceful method handling,
// a free compute answer, and that oversized input is capped (never crashes).
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

// Isolate into a throwaway cache so the test never reads/writes the real ~/.shaddai-aura
// (otherwise a stale fuzzy cache entry can shadow the expected compute answer).
const TEST_HOME = path.join(os.tmpdir(), 'aura-mcp-test-' + process.pid);

function run(frames) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mcp.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AURA_HOME: TEST_HOME }
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      try { resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))); }
      catch (e) { reject(new Error('bad stdout (protocol pollution?): ' + out.slice(0, 200))); }
    });
    for (const f of frames) p.stdin.write(JSON.stringify(f) + '\n');
    p.stdin.end();
  });
}

(async () => {
  const msgs = await run([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_ask', arguments: { prompt: 'what is 15 * 240' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_ask', arguments: { prompt: 'x'.repeat(500000) } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope_unknown' } },
    // aura_compress: a history with a big repeated tool output that should compress away.
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aura_compress', arguments: {
      keepRecent: 2,
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: 'Read the config file.' },
        { role: 'tool', content: 'CONFIG '.repeat(400) },   // big old block
        { role: 'assistant', content: 'Done, here is the config.' },
        { role: 'user', content: 'Read the config file again.' },
        { role: 'tool', content: 'CONFIG '.repeat(400) },   // identical -> dedup keeps this one
        { role: 'assistant', content: 'Same config as before.' }
      ]
    } } },
    // aura_compress malformed input -> isError, no crash.
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'aura_compress', arguments: { messages: 'not-an-array' } } },
    // aura_savings: combined answer-cache + tool-cache view.
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'aura_savings' } }
  ]);
  const byId = {};
  for (const m of msgs) if (m.id != null) byId[m.id] = m;

  assert.equal(byId[1].result.serverInfo.name, 'aura', 'initialize returns serverInfo');
  const toolNames = byId[2].result.tools.map((t) => t.name);
  assert.ok(Array.isArray(byId[2].result.tools) && byId[2].result.tools.length === 5, '5 tools listed');
  assert.ok(toolNames.includes('aura_compress'), 'tools/list advertises aura_compress');
  assert.ok(toolNames.includes('aura_savings'), 'tools/list advertises aura_savings');
  const compressTool = byId[2].result.tools.find((t) => t.name === 'aura_compress');
  assert.ok(compressTool.inputSchema.properties.messages, 'aura_compress schema has messages');
  assert.deepEqual(byId[3].result.resources, [], 'resources/list returns empty (no client error noise)');
  const ask = JSON.parse(byId[4].result.content[0].text);
  assert.equal(ask.answer, '3600', 'aura_ask computed 15*240=3600 for free (no LLM)');
  assert.ok(byId[5] && byId[5].result, 'oversized 500k-char prompt handled (capped), no crash');
  assert.ok(byId[6] && byId[6].result && byId[6].result.isError, 'unknown tool returns isError, not a crash');

  // aura_compress returns compressed messages + a positive saved count.
  const comp = JSON.parse(byId[7].result.content[0].text);
  assert.ok(Array.isArray(comp.messages), 'aura_compress returns a messages array');
  assert.ok(comp.stats && comp.stats.saved > 0, 'aura_compress saved > 0 tokens (dedup/truncate)');
  assert.ok(comp.stats.tokensBefore > comp.stats.tokensAfter, 'aura_compress tokensAfter < tokensBefore');

  // aura_compress malformed input -> isError, not a crash.
  assert.ok(byId[8] && byId[8].result && byId[8].result.isError, 'aura_compress malformed input returns isError');

  // aura_savings returns combined answer-cache + tool-cache payload.
  const savings = JSON.parse(byId[9].result.content[0].text);
  assert.ok(savings.answerCache && typeof savings.answerCache === 'object', 'aura_savings includes answerCache');
  assert.ok(savings.toolCache && typeof savings.toolCache.tokensSaved === 'number', 'aura_savings includes toolCache stats');

  try { require('node:fs').rmSync(TEST_HOME, { recursive: true, force: true }); } catch (_) {}
  console.log('✅ mcp.test PASS — handshake · 5 tools · resources · free compute · oversized-input · unknown-tool · compress · savings');
})().catch((e) => { console.error('❌ mcp.test FAIL:', e.message); process.exit(1); });
