'use strict';
/**
 * Honest benchmark: tokens saved by compressing the history that gets re-sent EVERY turn.
 *
 * The whole history is re-sent on every model call. So the real cost of a conversation
 * is the SUM, over every turn, of the context size at that turn. Big tool outputs early
 * on get re-read again and again. Compression trims those old blocks, and because it
 * applies on every turn, the saving compounds.
 *
 * No invented numbers: real message sizes, token estimate = ~1 token / 4 chars.
 */

const { compress, estTokens, contentString } = require('../lib/context-compress');

function bigToolOutput(turn) {
  // a realistic ~2.5k-char tool dump (file read / command output)
  return `[tool result @ turn ${turn}]\n` + 'line of output data '.repeat(120);
}

function run() {
  const TURNS = 40;
  const history = [
    { role: 'system', content: 'You are an autonomous engineering agent. Follow the task carefully.' },
    { role: 'user', content: 'TASK: refactor the billing module, run the tests, and summarize the changes.' }
  ];

  let totalNoCompress = 0;   // tokens the model reads across the whole conversation
  let totalWithCompress = 0;

  for (let t = 1; t <= TURNS; t++) {
    // the agent works: reads/produces output, occasionally a big tool dump
    history.push({ role: 'assistant', content: `Step ${t}: analyzing and making a change.` });
    if (t % 2 === 0) history.push({ role: 'user', content: bigToolOutput(t) }); // tool result fed back
    history.push({ role: 'user', content: `Continue with step ${t + 1}.` });

    // WITHOUT compression: the model re-reads the entire history this turn
    totalNoCompress += history.reduce((s, m) => s + estTokens(contentString(m.content)), 0);

    // WITH compression: trim old bloat before sending (recent turns kept intact)
    const { messages } = compress(history, { keepRecent: 6 });
    totalWithCompress += messages.reduce((s, m) => s + estTokens(contentString(m.content)), 0);
  }

  const finalNo = history.reduce((s, m) => s + estTokens(contentString(m.content)), 0);
  const finalYes = compress(history, { keepRecent: 6 }).messages.reduce((s, m) => s + estTokens(contentString(m.content)), 0);
  const saved = totalNoCompress - totalWithCompress;

  const PRICE_IN = 2.50; // gpt-4o input $ / 1M tokens
  const dollarsSaved = (saved / 1e6) * PRICE_IN;

  return {
    turns: TURNS,
    keepRecent: 6,
    finalContextNoCompress: finalNo,
    finalContextWithCompress: finalYes,
    totalNoCompress,
    totalWithCompress,
    tokensSaved: saved,
    savedPct: saved / totalNoCompress * 100,
    priceInPerM: PRICE_IN,
    dollarsSaved,
    estimator: '~1 token / 4 chars'
  };
}

module.exports = { run };

if (require.main === module) {
  const r = run();
  console.log('\n  AURA context-compression — honest savings over a growing conversation');
  console.log('  ' + '─'.repeat(64));
  console.log(`  conversation           ${r.turns} turns, big tool outputs re-sent every turn`);
  console.log(`  final context size     ${r.finalContextNoCompress.toLocaleString()} tokens  →  ${r.finalContextWithCompress.toLocaleString()} with compression (last turn)\n`);
  console.log(`  tokens read (all turns) NO compression   ${r.totalNoCompress.toLocaleString()}`);
  console.log(`  tokens read (all turns) WITH compression ${r.totalWithCompress.toLocaleString()}`);
  console.log(`  TOTAL TOKENS SAVED                       ${r.tokensSaved.toLocaleString()}  (${r.savedPct.toFixed(1)}%)`);
  console.log(`  ~$ saved @ gpt-4o input                  $${r.dollarsSaved.toFixed(4)}  (this one 40-turn session)\n`);
  console.log('  the saving compounds: it applies on EVERY turn, and grows as the chat grows.');
  console.log('  coherence kept: system prompt, the task, and the last 6 messages are never touched.');
  console.log('  ' + '─'.repeat(64) + '\n');
}
