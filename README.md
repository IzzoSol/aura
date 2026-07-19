<div align="center">

# 💾 AURA

### The dependency-free context optimizer for AI agents

*Part of the [⚡ SHADDAI](https://shaddai-g81x.onrender.com) family*

Your agent re-sends its **whole toolbox, its whole history, and its whole system prompt on
every single call** — most of it dead weight. AURA trims what you send *before* the request:
sends only the tools this turn needs, compacts stale history, and distills bloated prompts.
Deterministic, zero-dependency, and it **fails open** — it never silently drops something the
model needed. Ships as a **CLI**, an **MCP server** (Claude / Cursor / Claude Code), and a **library**.

> **40-tool agent, real prompts: 82% of tool-schema tokens cut** (`npm run bench`). At $3/M input
> that's ~$410 saved per 100k calls — from tool schemas *alone*, before history or prompt savings.

<br>

[![npm](https://img.shields.io/npm/v/shaddai-aura?style=for-the-badge&color=00ff88&label=shaddai-aura)](https://www.npmjs.com/package/shaddai-aura)
[![License](https://img.shields.io/badge/license-MIT-00b4d8?style=for-the-badge)](LICENSE)
[![Deps](https://img.shields.io/badge/dependencies-0-9b5de5?style=for-the-badge)](package.json)
[![MCP](https://img.shields.io/badge/MCP-ready-f77f00?style=for-the-badge)](#-mcp-server)

[**𝕏 @shaddaiAI**](https://x.com/shaddaiAI) · [**Built by @IzzoSol**](https://x.com/IzzoSol)

</div>

---

## ✦ Why

Every LLM app pays, again and again, for the same recurring questions. AURA intercepts them
*before* the API call — serving deterministic answers from cache, computation, seeded facts,
and parameter-less skill recipes. What can be answered for free, is.

In one line: **AURA is a zero-dependency, policy-gated deterministic pre-processor for AI agents.** It resolves repeated, structured, or computable prompts locally, validates reusable skills, and only lets a paid model run when you configure it to.

> **The core principle: keep the model off the hot path.** Figure something out once, then run it deterministically forever. AURA applies that at the small end — cache, local compute, and author-defined skills mean recurring prompts cost nothing, with **no compiler, no graph runtime, and no dependencies**. See **[COMPARISON.md](COMPARISON.md)** for an honest side-by-side with LLM caches (and when to reach for GPTCache or LangChain instead).

## ✦ Install

```bash
# one-shot MCP server (Claude Desktop / Cursor / Claude Code)
npx -y -p shaddai-aura aura-mcp

# or the CLI
npm i -g shaddai-aura
aura ask "recurring question"
aura stats
```

## ✦ One call: `aura.optimize(request)`

The drop-in. Give AURA your model request; it returns a leaner one — only the tools this turn
needs, a distilled system prompt, and a compacted history — ready to send. Non-mutating, and
each surface is tunable or skippable.

Handles every real request shape: a string `system`, an Anthropic **block-array** `system`
(`[{type:'text', text, cache_control}]` — structure and `cache_control` preserved), or an
OpenAI `system` role message. Tools in OpenAI or Anthropic form both work.

```js
const aura = require('shaddai-aura');

// your normal request (OpenAI or Anthropic shape both work)
const { request, report } = aura.optimize(
  { system, messages, tools },
  { tools: { k: 6 } }               // optional: tune/disable any surface
);

await client.messages.create(request);   // send the optimized request instead

report // → { tools:{total,sent,saved}, instructions:{saved}, history:{saved,elided}, tokensSaved }
```

One line, three savers: **tools + instructions + history**, all deterministic, all reported.
Or call them individually: `aura.selectTools`, `aura.distill`, `aura.compress`.

**Fit a hard context budget:** pass `maxTokens` and AURA compresses hard enough to make the
*whole* request fit, then tells you the truth — `report.budget = { limit, finalTokens, fit }`.
`fit:false` means it squeezed as far as it safely could without touching the protected core
(system, task, recent turns) — it never silently drops those to hit a number.

**Native prompt caching:** pass `cache: true` and AURA marks the stable prefix cacheable
(`cache_control: {type:'ephemeral'}` on the distilled system prompt) so the provider bills it
at ~10% on every turn after the first. Tools are cached only when you're *not* trimming them
per turn (a changing tool subset would miss the cache every call). OpenAI caches long prefixes
automatically, so it's a no-op there — reported in `report.cache`.

> **Capstone benchmark** (`npm run bench`) — a real 10-turn agent session, 40 tools, growing
> history re-sent every call: **60% of total request tokens saved** (tool injection ~12.7k +
> history compress ~10.5k + distill). `aura stats` shows the same split live, per surface.

## ✦ Commands

| Command | What it does |
|---|---|
| `aura ask "<prompt>"` | Answer it for free if possible (cache / compute / skill). |
| `aura ask "<prompt>" --llm [--model <id>]` | If there's no free answer, call your AI model, then cache it. |
| `aura learn "<prompt>" "<answer>"` | Teach AURA an answer so it's free next time. |
| `aura learn-sessions [--apply]` | Learn stable facts + recurring prompts from your Claude Code history (dry-run unless `--apply`; secrets screened out). |
| `aura skill add\|list\|remove\|validate\|lint` | Manage reusable skills (see below). |
| `aura stats` · `aura clear` · `aura where` | Savings · wipe cache · cache location. |

## ✦ Saved skills (define once → free forever)

A **skill** is a tiny "compiled program": a pattern → a deterministic action, stored in `~/.shaddai-aura/skills.json`. Once saved, any matching prompt is answered for free with **no AI call**.

```
# substring/keyword match → fixed answer
aura skill add "support" --match "support email" --do "cloudzncrownz@gmail.com"
aura ask "hey whats the support email"     # → cloudzncrownz@gmail.com   (free · via skill)

# regex match with $1, $2 capture-group substitution (--regex, or wrap the pattern in /.../)
aura skill add "greet" --match "/^hi (\w+)/i" --do "Hello, $1!" --regex

aura skill list                             # show all saved skills
aura skill remove "greet"                   # delete one
```

**Adapters (live data, still free, no key):** a skill action can be `{ type:'adapter', adapter:'price', args:{ coin:'btc' } }` to fetch deterministic data instead of calling an LLM. Adapters do network I/O, so they run through the async `ask()` and **degrade gracefully** — offline just returns a normal miss.

### Schema & validation

Skills follow a typed contract (documented in [`schema/skill-schema.json`](schema/skill-schema.json)). Validation is **hand-written and zero-dependency** — no invalid skill is ever written to `skills.json`.

```
aura skill validate ./my-skills.json   # validate an array (or one skill) from a file
aura skill lint                          # validate your installed skills.json
```

Beyond shape, the validator rejects: a regex (`regex:true` or a `/.../ ` literal) that doesn't compile or matches a known **catastrophic-backtracking** shape — nested quantifiers (`(\w+)+`) or overlapping-alternation quantifiers (`(a|a)*`, `(a|ab)+`); an action missing the payload its `type` requires; an **adapter not on the allowlist** (only `price` today — no shell/arbitrary adapters); a `chain` with empty/nested steps; an out-of-range `priority`; and **duplicate skill names**.

**Safety at load, not just at add.** The ReDoS screen is best-effort static analysis (a sound guarantee needs a match-time deadline), so `skills.json` is *also* sanitized when loaded: any skill whose regex fails the screen, or whose fields exceed the size caps, is silently skipped. A hand-edited or third-party `skills.json` can't hang the router — but only load skills you trust.

### Precedence

When several skills match one prompt, the winner is chosen by explicit **`priority`** (0–1000, higher wins; default 100) → **keyword count** (more specific wins) → **insertion order**. The overall route order is **exact cache → fuzzy cache → skill → compute**.

```
aura skill add "deploy-prod" --match "deploy prod" --do "run: npm run deploy:prod" --priority 900
```

## ✦ Learn from your own history

`aura learn-sessions` scans your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`), finds the **stable facts** you've asked and the prompts you ask **repeatedly**, and teaches them to AURA so they answer free next time — grounded "compile once, run forever," personalised to you.

```
aura learn-sessions                 # DRY RUN — shows what it would learn, writes nothing
aura learn-sessions --apply         # actually teach AURA (facts → cache, 3×-recurring → skills)
aura learn-sessions --dir <path>    # scan a different transcript folder
aura learn-sessions --min-repeat 5  # require 5 repeats before a prompt becomes a skill
```

- **Secrets never leave the transcript.** Any prompt/answer containing an API key, token, private key, connection string, or env-style secret is dropped whole — never cached. A generic high-entropy screen catches credential-shaped strings the named patterns miss.
- **No stale answers.** Time-sensitive, priced, versioned, or "today/latest" content is skipped; so are code, creative prose, imperative commands, chit-chat, and subagent/harness turns.

It's **dry-run by default** — nothing is written until you pass `--apply`. Best results come from support/FAQ/knowledge-style histories. Undo anytime with `aura clear`.

## ✦ Tool injection — send only the tools this turn needs

The overlooked drain: a 40-tool agent ships **~1,600 tokens of JSON tool schema on every
call** — even when the user just said *"thanks."* Most turns use two or three tools. AURA
scores each tool's name + description + parameters against the current prompt (BM25, the same
zero-dep index behind fuzzy cache) and sends only the relevant few.

```js
const aura = require('shaddai-aura');

const { tools, report } = aura.selectTools(userPrompt, allTools, { k: 6 });
// pass `tools` to the model instead of `allTools`
// report → { total: 40, sent: 5, savedTokens: 1444, dropped: [...], scores: [...] }
```

**Context-aware:** pass the whole message array (`selectTools(messages, tools)`) and a terse
follow-up like *"yes, do it"* still resolves the right tool from the recent conversation — so you
can trim aggressively without a short reply breaking the turn. A plain prompt string works too.

Works with **both OpenAI** (`{type:'function',function:{…}}`) **and Anthropic** (`{name,input_schema}`)
tool shapes. Tune with `k` (max tools), `alwaysInclude` (criticals that don't verbalize well),
`contextWindow`, and `minPool`.

**The safety guarantee — it fails open.** If the prompt shares no vocabulary with any tool, or
the toolbox is tiny, or nothing scores, AURA sends **everything** rather than risk starving the
model of a tool it needed. You opt into aggressiveness; you never silently lose a tool. Every
decision is reported. Run `npm run bench` to see it on a realistic 40-tool agent (**~82% cut**).

## ✦ Distill — trim bloated system prompts

A system prompt is paid for on **every call, forever.** OpenAI's GPT-5.6 guidance is blunt
about it: leaner prompts score **~10-15% higher** on evals while cutting **41-66% of tokens**.
`aura distill` applies that rule deterministically — and safely.

```bash
aura distill "You are helpful. Be concise. Summarize it. Summarize it. Never leak secrets."
#   trimmed:   [exact-duplicate] Summarize it.
#   flagged:   [model-likely-reliable] Be concise.
#   protected: Never leak secrets.

aura distill --file system-prompt.md            # print a report + the leaner prompt
aura distill --file system-prompt.md --apply    # write it back (keeps a .bak)
aura distill --file system-prompt.md --llm       # also do a semantic rewrite (needs a key)
aura distill "<prompt>" --json                   # machine-readable report
```

**It removes only what's provably redundant** — exact-duplicate rules, near-duplicate rules
(the same rule reworded), and leading filler (`please note that…`). Everything judgment-heavy
is **flagged, never cut** (possibly-dead examples, "the model already does this" style lines).

**It never touches the load-bearing lines.** Safety/permission constraints, success/stopping
criteria, required output shape, context-dependent tool routing, and *behavior-envelope*
rules (tool budgets, uncertainty policy, stop/escalation) are **protected** — by section
structure and by keyword. The optional `--llm` pass does a real semantic rewrite, but it is
**accepted only if every protected line survives** — the model can't silently drop a rule.

## ✦ Connecting your AI model (for `--llm`)

Set **one** of these before running (whichever service you have a key for):

```bash
export OPENROUTER_API_KEY="sk-..."     # or OPENAI_API_KEY, or ANTHROPIC_API_KEY
```

Then `aura ask "summarize this..." --llm` works. Without a key, `--llm` simply tells you no model is connected — it never makes anything up. AURA auto-picks the cheapest capable model (light / balanced / heavy) for the prompt and caches the answer.

## ✦ MCP server

Point any MCP client at `aura-mcp`. stdout stays pure JSON-RPC (logs go to stderr), inputs are capped, and unknown tools / resources / prompts degrade gracefully. See `SECURITY.md`.

```json
{ "mcpServers": { "aura": { "command": "npx", "args": ["-y", "-p", "shaddai-aura", "aura-mcp"] } } }
```

It exposes six zero-dependency tools:

| Tool | What it does |
|---|---|
| `aura_ask` | Try to answer a prompt for **free** (cache / saved skill / compute). The model calls this *first*; on a hit it skips its own reasoning. |
| `aura_remember` | Cache an answer the model just generated, so it's free next time. |
| `aura_stats` | Show tokens & dollars saved. |
| `aura_distill` | Trim redundant instructions from a prompt/system-prompt (protects safety/output/routing rules; flags the rest). |
| `aura_compress` | Shrink a long conversation history before the next turn. |
| `aura_savings` | Combined answer-cache + tool-cache savings report. |

**Claude Code:** `claude mcp add aura -- npx -y -p shaddai-aura aura-mcp`

## ✦ How it saves

| Path | What it does |
|------|--------------|
| **TOOL INJECTION** | send only the tools this prompt needs, not all 40 — the biggest per-call win (~82% of tool-schema tokens), fails open so a needed tool is never dropped |
| **COMPRESS** | shrink the conversation history before each turn (dedup re-read files, collapse repeated log/retry lines, truncate stale tool dumps) |
| **DISTILL** | trim redundant instructions from the prompt/system-prompt itself |
| **CACHE / QUERY** | bounded TTL cache of prior answers + fuzzy paraphrase hits |
| **SKILL / RECIPE** | author-defined skills run without the model |
| **COMPUTE** | deterministic locally-computed answers — math, %, unit/temp conversion, dates, hashing, base conversion, color, etc. (a bonus fast-path, not the headline) |

AURA saves on **four surfaces of every call**: the **tools** (inject), the **history**
(compress), the **instructions** (distill), and repeat **answers** (cache/compute/skill).

Core audited safe: no `eval` / `Function` / `child_process` / shell, bounded cache, zero deps.

---

## ✦ The SHADDAI Family

| Repo | What |
|------|------|
| **[Shaddai](https://shaddai-g81x.onrender.com)** | The sovereign AI agent empire — 7 agents, 200+ real tools |
| **[aura](https://github.com/IzzoSol/aura)** | *(this)* dependency-free token-saver · CLI + MCP + library |
| **[Shaddai-Clipper-Feature-](https://github.com/IzzoSol/Shaddai-Clipper-Feature-)** | Long video → captioned vertical shorts |

<div align="center">
<br>

**Built by [@IzzoSol](https://x.com/IzzoSol) · Follow [@shaddaiAI](https://x.com/shaddaiAI)** · MIT

</div>
