'use strict';
/**
 * ingest — load docs into AURA so it can answer from a knowledge base.
 *
 * Turns markdown / plain-text files into cache-worthy FACT entries: each heading (or
 * paragraph, for plain text) becomes a natural-question "prompt" and its following text
 * becomes the "answer". On --apply the CLI feeds each fact via recordAnswer(), so the
 * next identical/similar question is answered for FREE. AURA's "compile once, run
 * forever" grounded in YOUR docs.
 *
 * Zero-dependency (Node built-ins only). Two guarantees, reused from learn-sessions:
 *   1. SECRETS NEVER GET CACHED. Any chunk whose title OR body trips hasSecret is
 *      dropped whole — never taught.
 *   2. FACTS, NOT ESSAYS. A body over the cap is truncated to a fact-sized snippet;
 *      empty bodies are skipped.
 *
 * Pure, testable core: pass file text in, get a plan out. I/O (readSources) mirrors
 * learn-sessions' findTranscripts safety (depth-limited, symlink-safe).
 */

const fs = require('fs');
const path = require('path');
const { hasSecret } = require('./learn-sessions');

// A fact is a lookup, not a whole page. Bodies longer than this are truncated (kept, not
// dropped) to a sentence-ish snippet so a huge section still yields a usable answer.
const MAX_BODY_CHARS = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // skip absurdly large files (OOM guard)

// ------------------------------------------------------------------ markdown chunking
// A setext underline (=== or ---) promotes the LINE ABOVE to a heading.
const ATX = /^(#{1,6})\s+(.*)$/;                 // # Heading / ## Heading
const SETEXT = /^(=+|-+)\s*$/;                    // underline under a heading line
// Fence lines toggle a code block — headings inside code are literal, not structure.
const FENCE = /^\s*(```|~~~)/;

// Strip trailing '#' from ATX close, surrounding markdown emphasis, and trailing ':'
// so a heading reads as a clean question-ish title.
function cleanTitle(t) {
  return String(t || '')
    .replace(/#+\s*$/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .trim();
}

function tidyBody(b) {
  const s = String(b || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= MAX_BODY_CHARS) return s;
  // truncate on a sentence/word boundary near the cap — a fact-sized snippet, not a cliff
  const cut = s.slice(0, MAX_BODY_CHARS);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (at > MAX_BODY_CHARS * 0.5 ? cut.slice(0, at + 1) : cut).trim() + ' …';
}

/**
 * chunkMarkdown(text) -> [{ title, body }]
 * Split a markdown doc by headings (#, ##, ###, …). Each heading becomes a title and the
 * text up to the next heading becomes its body. Content before the first heading, and
 * plain (non-markdown) docs, are split into paragraph chunks with a title derived from
 * the paragraph's first line. Code fences are treated as opaque (no headings inside).
 */
function chunkMarkdown(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const chunks = [];
  let current = null;         // { title, lines: [] }
  const preamble = [];        // lines before the first heading
  let inFence = false;

  const push = () => { if (current) { chunks.push(current); current = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) { inFence = !inFence; (current ? current.lines : preamble).push(line); continue; }
    if (!inFence) {
      const atx = line.match(ATX);
      if (atx) { push(); current = { title: cleanTitle(atx[2]), lines: [] }; continue; }
      // setext: a non-empty line followed by ===/--- underline
      const next = lines[i + 1];
      if (next !== undefined && SETEXT.test(next) && line.trim() && !line.match(ATX)) {
        push(); current = { title: cleanTitle(line), lines: [] };
        i++; // consume the underline
        continue;
      }
    }
    (current ? current.lines : preamble).push(line);
  }
  push();

  const out = [];
  // Preamble / plain-text: split into paragraphs, first line becomes the title.
  const pre = preamble.join('\n').trim();
  if (pre) for (const para of splitParagraphs(pre)) out.push(para);
  for (const c of chunks) out.push({ title: c.title, body: tidyBody(c.lines.join('\n')) });
  return out;
}

// Split a plain block into paragraph chunks (blank-line separated). The first sentence /
// line of each paragraph becomes the title; the whole paragraph is the body.
function splitParagraphs(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n{2,}/)) {
    const para = raw.trim();
    if (!para) continue;
    const firstLine = para.split('\n')[0].trim();
    const sentence = (firstLine.match(/^.*?[.?!](?:\s|$)/) || [firstLine])[0].trim();
    const title = cleanTitle(sentence).slice(0, 120) || cleanTitle(firstLine).slice(0, 120);
    out.push({ title, body: tidyBody(para) });
  }
  return out;
}

/**
 * planIngest(files) where files is [{ path, text }]
 *   -> { facts: [{ prompt, answer, source }], stats: { scanned, secretsDropped, tooLong, empty } }
 *
 * Rules:
 *   - Chunk each file (chunkMarkdown).
 *   - Drop any chunk whose title OR body trips hasSecret (secretsDropped).
 *   - Skip chunks with an empty title or empty body (empty).
 *   - Bodies over the cap are truncated by chunkMarkdown, not dropped; a chunk that is
 *     STILL over-cap after tidy (shouldn't happen) is counted tooLong and skipped.
 *   - prompt = title (a natural question), answer = body, source = file path.
 */
function planIngest(files) {
  const stats = { scanned: 0, secretsDropped: 0, tooLong: 0, empty: 0 };
  const facts = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const src = (file && file.path) || '';
    const chunks = chunkMarkdown(file && file.text);
    for (const ch of chunks) {
      stats.scanned++;
      const title = String(ch.title || '').trim();
      const body = String(ch.body || '').trim();
      if (!title || !body) { stats.empty++; continue; }
      if (hasSecret(title) || hasSecret(body)) { stats.secretsDropped++; continue; }
      if (body.length > MAX_BODY_CHARS + 4) { stats.tooLong++; continue; } // +4 = " …" slack
      const key = title.toLowerCase();
      if (seen.has(key)) continue; // de-dupe repeated headings; first body wins
      seen.add(key);
      facts.push({ prompt: title, answer: body, source: src });
    }
  }
  return { facts, stats };
}

// ------------------------------------------------------------------ filesystem
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.text']);

// Recursively collect doc files under a dir (depth-limited, symlink-safe) — mirrors
// learn-sessions' findTranscripts.
function findDocs(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // avoid symlink cycles + duplicate scans
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findDocs(full, out, depth + 1);
    else if (e.isFile() && DOC_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

/**
 * readSources(pathOrDir) -> [{ path, text }]
 * Read a single .md/.txt file, or recursively every doc under a directory. Unreadable /
 * oversized files are skipped silently. Returns [] for a missing path.
 */
function readSources(pathOrDir) {
  const p = String(pathOrDir || '');
  let st;
  try { st = fs.statSync(p); } catch (_) { return []; }
  const files = st.isDirectory()
    ? findDocs(p)
    : (DOC_EXT.has(path.extname(p).toLowerCase()) ? [p] : []);
  const out = [];
  for (const f of files) {
    try {
      if (fs.statSync(f).size > MAX_FILE_BYTES) continue;
      out.push({ path: f, text: fs.readFileSync(f, 'utf8') });
    } catch (_) { /* skip unreadable */ }
  }
  return out;
}

module.exports = {
  chunkMarkdown, splitParagraphs, planIngest, readSources, findDocs,
  cleanTitle, tidyBody, MAX_BODY_CHARS, DOC_EXT
};
