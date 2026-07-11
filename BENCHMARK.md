# AURA — Benchmark Results

> **Machine-generated. Do not hand-edit.** Every figure below is written by
> `benchmarks/render-report.js`, which runs the three real benchmark scripts and
> records exactly what they measured. Regenerate with `node benchmarks/render-report.js`.
>
> Generated: `2026-07-11T23:05:48.193Z`

## Overview

AURA saves tokens **in proportion to repetition**. When the same substantive question,
the same tool result, or the same growing conversation context recurs, AURA serves the
repeat from cache / compression instead of paying a model to regenerate it. On a
genuinely novel one-off prompt, AURA saves **nothing** — the model runs, and AURA never
claims otherwise. The numbers below are not aspirational; they come from actually
executing the benchmark code in this repository against realistic recurring workloads.

## Methodology

- **Token estimator.** All token counts use a single transparent heuristic:
  **~1 token per 4 characters** (`Math.ceil(len / 4)`), the same basis AURA uses in its
  own stats. This is typically within **~10–15%** of a real BPE tokenizer (e.g. tiktoken)
  for English prose. The *same* estimator is applied to both the baseline and the
  with-AURA path, so every comparison is apples-to-apples — the ratio is what matters,
  not the absolute token count.
- **Savings come from real routing, not a formula.** The answer-cache benchmark calls
  AURA's actual `route()` and records real hits vs misses; the tool-cache benchmark runs
  the actual `lib/tool-cache` wrapper and reads its real `toolStats()`; the compression
  benchmark runs the actual `lib/context-compress` `compress()` on a growing history.
  No hit rate is assumed — it is measured.
- **Prices.** Dollar figures use published per-1M-token USD prices, stated inline in each
  section. Change them to your provider's rates and re-run. Token savings are
  price-independent; only the dollar columns move.
- **Isolation.** The answer-cache benchmark points `AURA_HOME` at a throwaway temp dir and
  deletes it after, so it never touches your real `~/.shaddai-aura` cache.

## Results

### 1. Answer cache — recurring substantive Q&A

Models AURA sitting in front of an app/agent (support bot, docs Q&A, repeated agent
tasks) where substantive questions recur. Each distinct question is replayed
**60×**, cycling through the exact wording and paraphrases so rephrasings
are exercised too.

- Workload: **600 requests** across **10 distinct questions** (60× each).
- Content: substantive Q&A, average answer **~60 tokens** — not toy compute.
- Estimator: ~1 token / 4 chars.

| Metric | Value |
|---|---|
| Served **free** (cache/skill/compute) | **564 / 600** (94.0%) |
| &nbsp;&nbsp;↳ exact · fuzzy · skill · compute | 564 · 0 · 0 · 0 |
| Paid misses (each cached, never repeats) | 36 |
| Tokens **without** AURA | 40,860 |
| Tokens **with** AURA | 2,449 |
| **Tokens saved** | **38,411** (94.0%) |
| Query latency (p50 · p95) | 3.744ms · 5.077ms |

Dollar savings on this workload, at the prices shown:

| Model | in / out per 1M | No AURA | With AURA | Saved |
|---|---|---|---|---|
| `gpt-4o-mini` | $0.1500 / $0.6000 | $0.0223 | $0.0013 | **$0.0210** |
| `gpt-4o` | $2.5000 / $10.0000 | $0.3721 | $0.0223 | **$0.3498** |

### 2. Tool-result cache — normal agent work

Models a realistic agent session that keeps re-reading the same few files, re-fetching
the same price, and re-searching the same docs while working a task. Every repeated tool
result would normally be regenerated **and** re-fed into context; the tool-cache serves
the repeat instantly.

- Estimator: ~1 token / 4 chars.

| Metric | Value |
|---|---|
| Tool calls the agent asked for | 340 |
| Calls that actually ran | 6 (reads 3 · fetches 2 · searches 1) |
| Calls **avoided** (served cached) | **334** (98.2% hit rate) |
| Result tokens **without** cache | 30,911 |
| Result tokens actually spent | 477 |
| **Tokens saved** (not re-fed) | **30,434** (98.5%) |

Every avoided call also skips a real file read / network fetch (latency + API cost, not
counted above). The cache is bounded (5,000 entries, auto-pruned), TTLs expire stale
data, and state-changing tools (write/deploy/pay) are never cached.

### 3. Context compression — growing conversation

The whole history is re-sent on every model call, so a conversation's real cost is the
**sum, over every turn, of the context size at that turn**. Big early tool dumps get
re-read again and again. Compression trims those old blocks on every turn, so the saving
compounds as the chat grows.

- Conversation: **40 turns**, big tool outputs re-sent every turn.
- Kept intact: system prompt, the task, and the last **6** messages (coherence preserved).
- Estimator: ~1 token / 4 chars.

| Metric | Value |
|---|---|
| Final context size (last turn) | 12,796 → **4,265** with compression |
| Tokens read (all turns) **no** compression | 256,960 |
| Tokens read (all turns) **with** compression | 94,871 |
| **Total tokens saved** | **162,089** (63.1%) |
| ~$ saved @ gpt-4o input ($2.5000/1M) | **$0.4052** (this one 40-turn session) |

## Assumptions & limitations

- **Repetition rate is the dial.** These workloads assume recurrence: answers repeat
  60× (§1), tool results are revisited across ~200 touches (§2), and context
  is re-sent across 40 turns (§3). Real-world savings scale up or down directly
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

```bash
# regenerate this file from the live benchmarks
node benchmarks/render-report.js

# or run any single benchmark standalone (prints its own console report)
node benchmarks/run-benchmark.js
node benchmarks/tool-cache-benchmark.js
node benchmarks/context-compress-benchmark.js
```
