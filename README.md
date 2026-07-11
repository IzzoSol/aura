<div align="center">

# 💾 AURA

### The dependency-free LLM token-saver

*Part of the [⚡ SHADDAI](https://github.com/IzzoIzzoIzzo/Shaddai) family*

Answer recurring prompts for **free** — cache, compute, seed, and skill fast-paths that
never touch the model. Ships as a **CLI**, an **MCP server** (Claude / Cursor / Claude Code),
and a **library**. Zero dependencies. Pure JSON-RPC. Security-hardened.

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

> **Inspired by [AINL (AI Native Lang)](https://github.com/sbhooley/ainativelang).** AINL's core idea is to *keep the model off the hot path*: figure something out once, then run it deterministically forever. AURA applies that principle at the small end — cache, local compute, and author-defined skills mean recurring prompts cost nothing, with **no compiler, no graph runtime, and no dependencies**. AURA is complementary to AINL, not a replacement — see **[COMPARISON.md](COMPARISON.md)** for an honest side-by-side (and when to reach for AINL, GPTCache, or LangChain instead).

## ✦ Install

```bash
# one-shot MCP server (Claude Desktop / Cursor / Claude Code)
npx -y -p shaddai-aura aura-mcp

# or the CLI
npm i -g shaddai-aura
aura ask "recurring question"
aura stats
```

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

It exposes three zero-dependency tools:

| Tool | What it does |
|---|---|
| `aura_ask` | Try to answer a prompt for **free** (cache / saved skill / compute). The model calls this *first*; on a hit it skips its own reasoning. |
| `aura_remember` | Cache an answer the model just generated, so it's free next time. |
| `aura_stats` | Show tokens & dollars saved. |

**Claude Code:** `claude mcp add aura -- npx -y -p shaddai-aura aura-mcp`

## ✦ How it saves

| Path | What it does |
|------|--------------|
| **CACHE** | bounded TTL cache of prior answers |
| **COMPUTE** | deterministic math/logic answered locally |
| **SEED / QUERY** | seeded facts + structured lookups |
| **SKILL / RECIPE** | author-defined skills run without the model |

Core audited safe: no `eval` / `Function` / `child_process` / shell, bounded cache, zero deps.

---

## ✦ The SHADDAI Family

| Repo | What |
|------|------|
| **[Shaddai](https://github.com/IzzoIzzoIzzo/Shaddai)** | The sovereign AI agent empire — 7 agents, 200+ real tools |
| **[aura](https://github.com/IzzoIzzoIzzo/aura)** | *(this)* dependency-free token-saver · CLI + MCP + library |
| **[Shaddai-Clipper-Feature-](https://github.com/IzzoIzzoIzzo/Shaddai-Clipper-Feature-)** | Long video → captioned vertical shorts |

<div align="center">
<br>

**Built by [@IzzoSol](https://x.com/IzzoSol) · Follow [@shaddaiAI](https://x.com/shaddaiAI)** · MIT

</div>
