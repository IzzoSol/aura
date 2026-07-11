# How AURA compares

AURA is a **zero-dependency, policy-gated deterministic pre-processor for AI agents.** It resolves repeated, structured, or computable prompts locally — from an exact/fuzzy cache, author-defined skills, or built-in compute — and only lets a paid model run when you configure it to. It is deliberately small and complementary to the larger systems below, not a replacement for them.

This document is honest on purpose: it names what AURA does *not* do.

## At a glance

| Capability | AURA | AINL | LangChain LLM cache | GPTCache |
|---|---|---|---|---|
| Zero-dependency runtime | ✅ (Node built-ins only) | ➖ lean core, broad optional extras | ❌ part of a framework | ❌ Python lib + backends |
| Deterministic pre-processing | ✅ | ✅ | ⚠️ partial | ⚠️ partial |
| Policy gate before an LLM call | ✅ (skill `policy`, roadmap) | ✅ | ❌ not a primary feature | ❌ not a primary feature |
| Graph IR + compiler | ❌ (not a language) | ✅ canonical graph IR + compiler | ❌ | ❌ |
| Multi-target emit (LangGraph/Temporal/…) | ❌ | ✅ | ❌ | ❌ |
| MCP server | ✅ | ✅ | ➖ via integrations | ➖ not core |
| Semantic cache | ⚠️ word-overlap today | ➖ not core | ➖ via backends | ✅ embeddings |
| Learns from your own history | ✅ `learn-sessions` | ❌ | ❌ | ❌ |
| Install footprint | one `npx`, no deps | Python pkg + extras | framework | Python + vector store |

✅ yes · ⚠️ limited · ➖ partial/optional · ❌ no

## Versus AINL (`ainativelang`)

[AINL](https://github.com/sbhooley/ainativelang) is the closest reference for AURA's *direction* and is a much larger system: a real workflow **language** with a compiler, a canonical graph IR, a verified deterministic runtime, policy-gated execution, a broad adapter catalog, record/replay, audit trails, an LSP, and multi-target emitters (LangGraph, Temporal, FastAPI, Solana). It is Apache-2.0, ~100K+ lines of Python with a Rust production sibling.

**AURA does not compete with that scope, and shouldn't.** AURA is a pre-processor you drop in front of an agent in one line; AINL is a language you author programs in. Where they overlap is the core idea both share — *don't re-prompt the model to orchestrate the same workflow on every run.* AINL is refreshingly honest that this "compile once, run many" win is large only versus a baseline that re-prompts routing each time, and roughly break-even versus a hand-written deterministic runner.

AURA's bet is the **small end** of that same idea: the most common recurring prompts (lookups, calculations, transforms, canned answers) shouldn't reach a model at all, and you shouldn't need a compiler, a graph runtime, or any dependencies to get that. If you need graph compilation, multi-runtime emit, or sandboxed capability isolation, use AINL — and consider AURA as a zero-dep cache/policy layer in front of it.

## Versus LangChain's LLM cache

LangChain offers optional cache backends to avoid repeated model calls. That's a **framework cache layer**, useful if you're already in LangChain. AURA is a standalone, dependency-free runtime with explicit skill contracts and a policy object — usable from any language via its CLI or MCP server, with no framework buy-in.

## Versus GPTCache

GPTCache is strong prior art for **semantic caching**: it answers equivalent prompts from embeddings before the model is called, and AURA acknowledges it directly. GPTCache is the better tool if dense-vector semantic matching is your primary need. AURA's fuzzy match is intentionally lighter (stopword-aware word-overlap, no embedding model, no vector store) and it adds things GPTCache doesn't center on — deterministic compute, author-defined skills with validation, and a policy gate.

## When NOT to use AURA

- You need dense **semantic** matching across paraphrases at scale → GPTCache (or an embedding layer in front of AURA).
- You need to author and compile **multi-step workflow graphs** with typed IR and multi-runtime emit → AINL.
- Your prompts are almost all novel, creative, long-form generation → a cache/pre-processor can't help; you're paying for the model regardless.
- You need distributed, high-throughput, multi-tenant caching with shared state → use a real cache tier (Redis) with semantic keys.

## What AURA is genuinely best at

- **Zero-dependency, single-file drop-in.** No framework, no vector DB, no service. `npx -y -p shaddai-aura aura-mcp` and an agent saves tokens before it thinks.
- **Deterministic free answers** for the boring-but-frequent: math, unit/temperature conversion, dates, percentages, base64, word counts, plus your own saved skills.
- **A policy boundary you own** — skills declare what may run, and (roadmap) `maxCostUSD: 0` can make an LLM fallback impossible for a class of prompts.
- **Learning from your real usage** — `learn-sessions` turns your own history into free future answers, with secrets screened out.
