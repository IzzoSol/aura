'use strict';
/**
 * learn-sessions — teach AURA from your own AI history.
 *
 * Scans Claude Code transcripts (~/.claude/projects/<slug>/*.jsonl), extracts stable
 * question -> answer pairs and prompts you ask repeatedly, and (on --apply) feeds them
 * into AURA so the next identical/similar prompt is answered for FREE. This is AURA's
 * "compile once, run forever" grounded in YOUR real usage.
 *
 * Zero-dependency (Node built-ins only). Two guarantees baked in:
 *   1. SECRETS NEVER LEAVE THE TRANSCRIPT. Any pair whose prompt or answer contains an
 *      API key / token / private key / env-secret is dropped whole — never cached.
 *   2. VOLATILE ANSWERS ARE SKIPPED. Time-sensitive / priced / "today"/"latest" content
 *      is not cached (a stale answer is worse than a miss).
 *
 * Pure, testable core: pass transcript text in, get a plan out. I/O lives in the CLI.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------------------------------------------------ secret screen
// If ANY of these hit the prompt or answer, the whole pair is discarded.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,                 // OpenAI / Anthropic style
  /gsk_[A-Za-z0-9]{20,}/,                   // Groq
  /ghp_[A-Za-z0-9]{20,}/,                   // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/,
  /npm_[A-Za-z0-9]{20,}/,                    // npm access token
  /\bglpat-[A-Za-z0-9_-]{16,}/,             // GitLab PAT
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,            // Anthropic (explicit)
  /xox[baprs]-[A-Za-z0-9-]{10,}/,           // Slack
  /AKIA[0-9A-Z]{16}/,                       // AWS access key id
  /AIza[0-9A-Za-z_-]{20,}/,                 // Google API key
  /r8_[A-Za-z0-9]{20,}/,                    // Replicate
  /hf_[A-Za-z0-9]{20,}/,                    // Hugging Face
  /\b[rspw]k_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe secret/publishable/restricted
  /\bwhsec_[A-Za-z0-9]{10,}/,               // Stripe webhook signing secret
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // scheme://user:PASSWORD@host (DB/conn strings)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, // JWT
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  // Any env/kv assignment to a key/token/secret/password/credential — short values too
  // (a 4-char password is still a password). Broadened from the API|SECRET|… prefix set.
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PWD|CREDENTIAL)S?\s*[=:]\s*['"]?\S{4,}/i,
  /\bpass(?:word|phrase)?\s*[=:]\s*\S{4,}/i,
  // Generic high-entropy token: 28+ chars, no spaces, containing BOTH a letter and a
  // digit. Catches key/token/hash pastes the named patterns miss (npm/other providers,
  // commit SHAs, ids) — none of which are reusable "facts" — while sparing normal prose
  // (which lacks the digit) and ordinary long words.
  /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{28,}\b/
];

function hasSecret(text) {
  const s = String(text || '');
  return SECRET_PATTERNS.some((re) => re.test(s));
}

// ------------------------------------------------------------------ quality screens
// Volatile: an answer that will go stale. Caching these is a footgun. Includes pricing /
// version / cost churn (a "$49/mo" answer is wrong the moment pricing changes).
const VOLATILE = /\b(today|tonight|yesterday|tomorrow|right now|currently|current|latest|as of|this (?:week|month|year)|the time|what time|weather|news|breaking|price|pricing|cost|how much|fee|rate|version|release|balance|subscription|tier|stock|\$\s?\d|\d+\s*(?:dollars|usd|eur|per month|\/mo(?:nth)?))\b/i;
// Chit-chat / reactions: not lookups, must never become facts.
const CHITCHAT = /^(?:thanks?|thank you|ty|nice|great|awesome|perfect|cool|good|well done|amazing|lol|haha|ok|okay|yes|no|yep|nope|sure|got it|nvm|works?|it works|that works?|worked|done|nice work)\b/i;
// First/second-person pronouns signal a conversational turn, not a reference query.
const PRONOUN = /\b(?:i|me|my|we|our|us|you|your|it|this|that|they|them)\b/i;
const DATE_LIKE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\s?(?:am|pm)?\b/i;
// Creative / code answers make poor deterministic cache entries.
const CODEY = /```|\bfunction\b|\bconst \w+\s*=|\bimport \w|\bclass \w|=>|;\s*$/m;
// An answer that narrates work ("Now commit…", "Got it — …", "I'll add…") or reacts
// ("Sure", "Great") is not a reusable fact. A fact states something; it doesn't report
// what the assistant just did.
const HEDGE = /^(?:i\b|i'?ll|i'?ve|i'?m|as an ai|i'?m sorry|i can'?t|i cannot|i don'?t|let me|let'?s|sure[,!.]?|here'?s|here\b|okay|ok[,!.]?|got it|now\b|then\b|next\b|first\b|done\b|great\b|perfect\b|added\b|created\b|updated\b|fixed\b|committing|running|verifying|yes\b|no\b|yep|nope|correct\b|right\b|exactly|got\b|alright)/i;
// Imperatives / task commands. These are the bulk of a coding session ("keep working",
// "open X", "finish building") and their "answer" is whatever Claude did that time —
// caching it is worse than useless. A reusable fact is a LOOKUP, not a command.
const IMPERATIVE = /^(?:keep|open|continue|finish|do|don'?t|make|build|fix|run|go|let'?s|show|find|create|update|use|write|check|test|review|help|start|stop|proceed|next|redo|retry|again|scan|deploy|commit|push|pull|install|save|send|edit|remove|delete|add|move|change|generate|design|draw|look|try|please|can you|could you|would you|i want|i need|i'?d like)\b/i;

// A cache-worthy prompt is a stable factual LOOKUP: either interrogative, or a short
// noun-phrase reference query — but never an imperative command.
function isReusablePrompt(prompt) {
  const p = String(prompt || '').trim();
  if (IMPERATIVE.test(p)) return false;
  if (CHITCHAT.test(p)) return false;                    // "thanks that worked" etc.
  const interrogative = p.endsWith('?') ||
    /^(?:what|whats|who|whose|whom|where|when|which|why|how|is|are|was|were|does|did|list|define|explain|name|give me|tell me)\b/i.test(p);
  // A short noun-phrase lookup ("shaddai support email") — but only if it's not a
  // first/second-person conversational turn.
  const shortLookup = p.split(/\s+/).length <= 8 && !PRONOUN.test(p);
  return interrogative || shortLookup;
}

function isStableFact(prompt, answer) {
  const p = String(prompt || '').trim();
  const a = String(answer || '').trim();
  if (p.length < 8 || p.length > 200) return false;
  if (a.length < 2 || a.length > 600) return false;
  if (!isReusablePrompt(p)) return false;               // no imperatives / commands
  if ((a.match(/\n/g) || []).length > 6) return false; // multi-paragraph = not a fact
  if (VOLATILE.test(p) || VOLATILE.test(a)) return false;
  if (DATE_LIKE.test(a)) return false;
  if (CODEY.test(a)) return false;
  if (HEDGE.test(a)) return false;
  return true;
}

// ------------------------------------------------------------------ transcript parse
// Pull the plain text out of a Claude Code message.content (string OR block array).
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

// Harness / system-injected turns that aren't real user prompts — interrupt markers,
// pasted-image placeholders, slash-command tags, caveats, system reminders.
const META_NOISE = /request interrupted|interrupted by user|^\s*\[(?:image|pasted|screenshot|request|no response)/i;
const META_TAG = /<\/?(?:command-name|command-message|command-args|system-reminder|local-command)/i;
function isMetaNoise(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (META_NOISE.test(t) || META_TAG.test(t)) return true;
  if (/^\[.*\]$/.test(t) && t.length < 80) return true;   // a bare "[...]" meta line
  if (/^Caveat: The messages below/i.test(t)) return true;
  return false;
}

// Parse one JSONL transcript string into ordered {role, text} turns (user/assistant
// text only; tool calls, tool results, summaries, and thinking are ignored).
function parseTranscript(jsonl) {
  const turns = [];
  for (const line of String(jsonl || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch (_) { continue; }
    // Structural drops: subagent/sidechain turns (internal Task-agent prompts + tool
    // echoes the user never typed) and harness-injected meta turns. These carry private
    // internal context and pollute recurrence counts.
    if (obj.isSidechain || obj.isMeta) continue;
    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = obj.message || {};
    if (msg.role && msg.role !== type) { /* trust type over role */ }
    // skip tool_result-only user turns (content is an array of tool_result blocks)
    if (Array.isArray(msg.content) && msg.content.every((b) => b && b.type !== 'text')) continue;
    const text = messageText(msg.content);
    if (!text) continue;
    if (type === 'user' && isMetaNoise(text)) continue; // drop harness/system injections
    turns.push({ role: type, text: text.trim() });
  }
  return turns;
}

// Pair each user turn with the FINAL assistant text turn before the next user turn.
// Tool-using sessions split the reply around tool_use/tool_result, leaving a preamble
// ("Let me check.") and then the real answer as separate assistant turns; pairing with
// the first would cache the preamble. We keep the last assistant text as the answer.
function pairTurns(turns) {
  const pairs = [];
  let pendingUser = null;
  let lastAnswer = null;
  const flush = () => {
    if (pendingUser && lastAnswer) pairs.push({ prompt: pendingUser, answer: lastAnswer });
    lastAnswer = null;
  };
  for (const turn of turns) {
    if (turn.role === 'user') {
      flush();               // commit the previous user's final answer first
      pendingUser = turn.text;
      lastAnswer = null;
    } else if (turn.role === 'assistant' && pendingUser) {
      lastAnswer = turn.text; // overwrite so the LAST assistant text wins
    }
  }
  flush();
  return pairs;
}

// Normalize a prompt for recurrence counting (same shape as aura-core's normalize).
function normPrompt(p) {
  return String(p || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Derive a keyword `match` for a recurring-prompt skill: the 3-5 longest content words.
const SKILL_STOP = new Set(['what', 'whats', 'the', 'is', 'are', 'how', 'do', 'does', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'my', 'me', 'you', 'your', 'i', 'can', 'please', 'with', 'about', 'this', 'that']);
function skillMatchFrom(prompt) {
  const words = normPrompt(prompt).split(' ').filter((w) => w.length > 2 && !SKILL_STOP.has(w));
  const uniq = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 4);
  return uniq.sort().join(' ');
}

/**
 * planFromPairs(pairs, opts) — the pure planner. Given raw {prompt,answer} pairs,
 * decide what to teach. Returns:
 *   {
 *     facts:      [{prompt, answer}],            // -> recordAnswer (stable cache)
 *     skills:     [{name, match, action, count}],// -> addSkill (recurring, count>=minRepeat)
 *     stats: { scanned, secretsDropped, volatileDropped, lowQuality, uniquePrompts }
 *   }
 * opts.minRepeat (default 3) — how many times a prompt must recur to become a skill.
 * opts.maxFacts / opts.maxSkills — caps.
 */
function planFromPairs(pairs, opts = {}) {
  const minRepeat = Number(opts.minRepeat) > 0 ? Number(opts.minRepeat) : 3;
  const maxFacts = Number(opts.maxFacts) > 0 ? Number(opts.maxFacts) : 1000;
  const maxSkills = Number(opts.maxSkills) > 0 ? Number(opts.maxSkills) : 200;

  const stats = { scanned: 0, secretsDropped: 0, volatileDropped: 0, lowQuality: 0, uniquePrompts: 0 };
  const counts = new Map();        // normalized prompt -> occurrences
  const bestAnswer = new Map();     // normalized prompt -> {prompt, answer} (last seen)
  const factKeys = new Set();

  for (const pair of pairs) {
    stats.scanned++;
    const { prompt, answer } = pair;
    if (hasSecret(prompt) || hasSecret(answer)) { stats.secretsDropped++; continue; }
    const norm = normPrompt(prompt);
    if (!norm) continue;
    counts.set(norm, (counts.get(norm) || 0) + 1);
    // keep the freshest well-formed answer for this prompt
    if (isStableFact(prompt, answer)) {
      bestAnswer.set(norm, { prompt, answer });
    } else {
      // distinguish why it was rejected for reporting
      if (VOLATILE.test(prompt) || VOLATILE.test(answer) || DATE_LIKE.test(answer)) stats.volatileDropped++;
      else stats.lowQuality++;
    }
  }
  stats.uniquePrompts = counts.size;

  const facts = [];
  const skills = [];
  for (const [norm, occ] of counts.entries()) {
    const qa = bestAnswer.get(norm);
    if (!qa) continue; // no cache-worthy answer captured for this prompt
    if (occ >= minRepeat && skills.length < maxSkills) {
      const match = skillMatchFrom(qa.prompt) || norm.split(' ').slice(0, 3).join(' ');
      skills.push({
        name: 'learned-' + norm.split(' ').slice(0, 3).join('-').slice(0, 40),
        match,
        action: { type: 'answer', text: qa.answer },
        count: occ
      });
    } else if (facts.length < maxFacts) {
      facts.push(qa);
    }
  }
  return { facts, skills, stats };
}

// ------------------------------------------------------------------ filesystem
// Default transcript root for Claude Code on this machine.
function defaultTranscriptDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Recursively collect *.jsonl under a dir (depth-limited, symlink-safe-ish).
function findTranscripts(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // avoid symlink cycles + duplicate scans
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findTranscripts(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

const MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024; // skip absurdly large files (OOM guard)

// Read + parse + pair every transcript under `dir`. Returns all {prompt,answer} pairs.
function collectPairs(dir) {
  const files = findTranscripts(dir);
  const pairs = [];
  for (const f of files) {
    let text;
    try {
      if (fs.statSync(f).size > MAX_TRANSCRIPT_BYTES) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch (_) { continue; }
    for (const p of pairTurns(parseTranscript(text))) pairs.push(p);
  }
  return { files, pairs };
}

module.exports = {
  hasSecret, isStableFact, isReusablePrompt, isMetaNoise, parseTranscript, pairTurns, planFromPairs,
  skillMatchFrom, normPrompt, findTranscripts, collectPairs, defaultTranscriptDir,
  SECRET_PATTERNS
};
