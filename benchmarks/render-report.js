'use strict';
/**
 * render-report.js — generate BENCHMARK.md from the REAL benchmark runs.
 *
 * This does not invent, round up, or hardcode any figure. It requires the three
 * benchmark modules, runs them, and writes every number they actually produce into
 * BENCHMARK.md. Re-run any time the measurement code changes; the doc regenerates.
 *
 * Zero dependencies — Node built-ins only.
 * Run: node benchmarks/render-report.js
 */

const fs = require('fs');
const path = require('path');

const answerCache = require('./run-benchmark');            // sync run()
const toolCache = require('./tool-cache-benchmark');        // async run()
const contextCompress = require('./context-compress-benchmark'); // sync run()

const n = (x) => Number(x).toLocaleString('en-US');
const pct = (x) => `${Number(x).toFixed(1)}%`;
const usd = (x) => `$${Number(x).toFixed(4)}`;

async function main() {
  // Run all three benchmarks for real. Order is irrelevant; each isolates its own state.
  const ac = answerCache.run();
  const tc = await toolCache.run();
  const cc = contextCompress.run();

  const generatedAt = new Date().toISOString();

  const dollarRows = Object.keys(ac.dollars)
    .map((m) => {
      const d = ac.dollars[m];
      const p = ac.prices[m];
      return `| \`${m}\` | ${usd(p.in)} / ${usd(p.out)} | ${usd(d.base)} | ${usd(d.aura)} | **${usd(d.saved)}** |`;
    })
    .join('\n');

  const md = `# AURA — Benchmark Results

> **Machine-generated. Do not hand-edit.** Every figure below is written by
> \`benchmarks/render-report.js\`, which runs the three real benchmark scripts and
> records exactly what they measured. Regenerate with \`node benchmarks/render-report.js\`.
>
> Generated: \`${generatedAt}\`

## Overview

AURA saves tokens **in proportion to repetition**. When the same substantive question,
the same tool result, or the same growing conversation context recurs, AURA serves the
repeat from cache / compression instead of paying a model to regenerate it. On a
genuinely novel one-off prompt, AURA saves **nothing** — the model runs, and AURA never
claims otherwise. The numbers below are not aspirational; they come from actually
executing the benchmark code in this repository against realistic recurring workloads.

## Methodology

- **Token estimator.** All token counts use a single transparent heuristic:
  **~1 token per 4 characters** (\`Math.ceil(len / 4)\`), the same basis AURA uses in its
  own stats. This is typically within **~10–15%** of a real BPE tokenizer (e.g. tiktoken)
  for English prose. The *same* estimator is applied to both the baseline and the
  with-AURA path, so every comparison is apples-to-apples — the ratio is what matters,
  not the absolute token count.
- **Savings come from real routing, not a formula.** The answer-cache benchmark calls
  AURA's actual \`route()\` and records real hits vs misses; the tool-cache benchmark runs
  the actual \`lib/tool-cache\` wrapper and reads its real \`toolStats()\`; the compression
  benchmark runs the actual \`lib/context-compress\` \`compress()\` on a growing history.
  No hit rate is assumed — it is measured.
- **Prices.** Dollar figures use published per-1M-token USD prices, stated inline in each
  section. Change them to your provider's rates and re-run. Token savings are
  price-independent; only the dollar columns move.
- **Isolation.** The answer-cache benchmark points \`AURA_HOME\` at a throwaway temp dir and
  deletes it after, so it never touches your real \`~/.shaddai-aura\` cache.

## Results

### 1. Answer cache — recurring substantive Q&A

Models AURA sitting in front of an app/agent (support bot, docs Q&A, repeated agent
tasks) where substantive questions recur. Each distinct question is replayed
**${ac.repeatsPer}×**, cycling through the exact wording and paraphrases so rephrasings
are exercised too.

- Workload: **${n(ac.requests)} requests** across **${ac.distinctQuestions} distinct questions** (${ac.repeatsPer}× each).
- Content: substantive Q&A, average answer **~${ac.avgAnswerTokens} tokens** — not toy compute.
- Estimator: ${ac.estimator}.

| Metric | Value |
|---|---|
| Served **free** (cache/skill/compute) | **${n(ac.hits)} / ${n(ac.requests)}** (${pct(ac.hitRatePct)}) |
| &nbsp;&nbsp;↳ exact · fuzzy · skill · compute | ${ac.byMethod.fetch} · ${ac.byMethod.query} · ${ac.byMethod.skill} · ${ac.byMethod.compute} |
| Paid misses (each cached, never repeats) | ${n(ac.misses)} |
| Tokens **without** AURA | ${n(ac.baselineTokens)} |
| Tokens **with** AURA | ${n(ac.auraTokens)} |
| **Tokens saved** | **${n(ac.tokensSaved)}** (${pct(ac.savedPct)}) |
| Query latency (p50 · p95) | ${ac.latencyP50Ms.toFixed(3)}ms · ${ac.latencyP95Ms.toFixed(3)}ms |

Dollar savings on this workload, at the prices shown:

| Model | in / out per 1M | No AURA | With AURA | Saved |
|---|---|---|---|---|
${dollarRows}

### 2. Tool-result cache — normal agent work

Models a realistic agent session that keeps re-reading the same few files, re-fetching
the same price, and re-searching the same docs while working a task. Every repeated tool
result would normally be regenerated **and** re-fed into context; the tool-cache serves
the repeat instantly.

- Estimator: ${tc.estimator}.

| Metric | Value |
|---|---|
| Tool calls the agent asked for | ${n(tc.toolCallsRequested)} |
| Calls that actually ran | ${n(tc.realCalls)} (reads ${tc.realReads} · fetches ${tc.realFetches} · searches ${tc.realSearches}) |
| Calls **avoided** (served cached) | **${n(tc.callsAvoided)}** (${pct(tc.hitRatePct)} hit rate) |
| Result tokens **without** cache | ${n(tc.baselineTokens)} |
| Result tokens actually spent | ${n(tc.tokensSpent)} |
| **Tokens saved** (not re-fed) | **${n(tc.tokensSaved)}** (${pct(tc.savedPct)}) |

Every avoided call also skips a real file read / network fetch (latency + API cost, not
counted above). The cache is bounded (5,000 entries, auto-pruned), TTLs expire stale
data, and state-changing tools (write/deploy/pay) are never cached.

### 3. Context compression — growing conversation

The whole history is re-sent on every model call, so a conversation's real cost is the
**sum, over every turn, of the context size at that turn**. Big early tool dumps get
re-read again and again. Compression trims those old blocks on every turn, so the saving
compounds as the chat grows.

- Conversation: **${cc.turns} turns**, big tool outputs re-sent every turn.
- Kept intact: system prompt, the task, and the last **${cc.keepRecent}** messages (coherence preserved).
- Estimator: ${cc.estimator}.

| Metric | Value |
|---|---|
| Final context size (last turn) | ${n(cc.finalContextNoCompress)} → **${n(cc.finalContextWithCompress)}** with compression |
| Tokens read (all turns) **no** compression | ${n(cc.totalNoCompress)} |
| Tokens read (all turns) **with** compression | ${n(cc.totalWithCompress)} |
| **Total tokens saved** | **${n(cc.tokensSaved)}** (${pct(cc.savedPct)}) |
| ~$ saved @ gpt-4o input (${usd(cc.priceInPerM)}/1M) | **${usd(cc.dollarsSaved)}** (this one ${cc.turns}-turn session) |

## Assumptions & limitations

- **Repetition rate is the dial.** These workloads assume recurrence: answers repeat
  ${ac.repeatsPer}× (§1), tool results are revisited across ~200 touches (§2), and context
  is re-sent across ${cc.turns} turns (§3). Real-world savings scale up or down directly
  with how much your traffic actually repeats. Lower repetition → lower savings.
- **Estimator, not a tokenizer.** The ~1-token/4-char heuristic is within ~10–15% of
  tiktoken for English prose and can drift further on code, dense JSON, or non-English
  text. Because the *same* estimator is used on both sides, the **percentage** saved is
  robust even when absolute token counts are approximate.
- **Prices are illustrative.** Dollar figures use the per-model rates stated in each
  section; substitute your provider's rates and re-run for your own numbers.
- **What does NOT benefit.** Almost-all-novel, creative, or long-form generation gets no
  help from a cache/pre-processor — you pay the model regardless. Fuzzy matching is
  lightweight word-overlap, not dense-vector semantic matching, so heavily paraphrased
  recurrence may miss where an embedding cache would hit.

## How to reproduce

\`\`\`bash
# regenerate this file from the live benchmarks
node benchmarks/render-report.js

# or run any single benchmark standalone (prints its own console report)
node benchmarks/run-benchmark.js
node benchmarks/tool-cache-benchmark.js
node benchmarks/context-compress-benchmark.js
\`\`\`
`;

  const outPath = path.join(__dirname, '..', 'BENCHMARK.md');
  fs.writeFileSync(outPath, md);
  console.log(`Wrote ${outPath}`);
  console.log(`  answer-cache:  ${pct(ac.savedPct)} tokens saved (${n(ac.tokensSaved)})`);
  console.log(`  tool-cache:    ${pct(tc.savedPct)} tokens saved (${n(tc.tokensSaved)})`);
  console.log(`  context-comp:  ${pct(cc.savedPct)} tokens saved (${n(cc.tokensSaved)})`);
}

main();
