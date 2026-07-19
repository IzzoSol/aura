# Changelog

All notable changes to **shaddai-aura** (AURA). Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semver.

## [0.6.1] — 2026-07-19

### Added
- **Native prompt caching** — `aura.optimize(request, { cache: true })` inserts provider
  prompt-cache breakpoints (`cache_control: {type:'ephemeral'}`) on the stable prefix: the
  distilled system prompt (always) and the tool array (only when not trimmed per turn, since a
  changing subset would miss the cache). ~90% off the cached prefix after the first call.
  OpenAI auto-caches prefixes, so it's a reported no-op there. See `report.cache`.

## [0.6.0] — 2026-07-19

AURA graduates from a repeat-answer cache into a **deterministic, zero-dependency
context optimizer for AI agents** — it trims what you re-send on *every* call across
four surfaces: **tools, history, instructions, and answers.**

### Added
- **Selective tool injection** (`aura.selectTools`, `lib/tool-select.js`) — send only
  the tools a turn actually needs instead of the whole toolbox. ~82% of tool-schema
  tokens saved on a 40-tool agent. Context-aware (reads recent turns, so terse
  follow-ups like "yes, do it" still resolve the right tool), **fails open** (never
  drops a tool it can't rule out), works with OpenAI and Anthropic tool shapes.
- **`aura.optimize(request)`** — one call runs tool injection + distill + compress on a
  full request and returns a ready-to-send one. Non-mutating. Handles a string `system`,
  an Anthropic block-array `system` (`cache_control` preserved), or an OpenAI system
  message. Optional **`maxTokens`** hard-fits the whole request to a budget and reports
  an honest `fit` verdict (never drops the protected core to hit a number).
- **Per-surface savings ledger** — `stats()` now returns `tokensByMethod` + `costByMethod`;
  `aura stats` shows where every saved token came from (tool injection / history / distill
  / cache / compute).
- **Bonus COMPUTE ops** (`lib/compute-ops.js`) — base conversion, hashing, URL encode/decode,
  ROT13, char count, text casing/slugify, hex↔rgb. A free fast-path, not the headline.
- Benchmarks: `benchmarks/tool-select-benchmark.js`, `benchmarks/optimize-benchmark.js`
  (capstone: ~60% of total request tokens saved over a real agent session).

### Changed
- **Compress** now dedups **near-identical** re-reads (the "read file → edit → read again"
  drain that exact-hash missed) and **collapses runs of repeated identical lines**
  (log/retry spam) before truncating — smarter and more lossless than blind head/tail cuts.
- **Distill** widened safely: larger leading-hedge dictionary + whole-line politeness
  removal, still never touching safety / output-shape / success / routing / behavior-envelope
  rules.
- Library surface: `aura.distill` and `aura.compress` are now exported directly.

### Notes
- Still **zero runtime dependencies**; Node ≥ 18. 167 tests green.

## [0.5.0]

### Added
- **DISTILL** (`lib/prompt-distill.js`) — AURA's instructions pillar: deterministically
  trims redundant/duplicate rules and leading filler from a bloated system prompt while
  protecting safety, output-shape, success, routing, and behavior-envelope constraints.
  Optional `--llm` semantic pass, accepted only if every protected rule survives.
- `aura distill` CLI command and `aura_distill` MCP tool.

## [0.3.0]

### Security
- Input caps, `console`→stderr so stdout stays pure JSON-RPC, graceful
  resources/prompts/unknown-tool handling, `SECURITY.md`, MCP test coverage. Core audited
  free of `eval` / `Function` / `child_process` / shell; bounded cache; zero dependencies.

[0.6.0]: https://github.com/IzzoSol/Aura
[0.5.0]: https://github.com/IzzoSol/Aura
[0.3.0]: https://github.com/IzzoSol/Aura
