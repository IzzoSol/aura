#!/usr/bin/env node
'use strict';
/**
 * aura — terminal token saver. Wraps aura-core.
 *
 *   aura ask "what is 12*9"          answer from cache/compute (free), else miss
 *   aura ask "..." --llm             on a miss, call your LLM (needs a provider key), then cache it
 *   aura learn "q" "a"               teach AURA an answer (so next time is free)
 *   aura stats                       show savings
 *   aura clear                       wipe the cache
 *   aura where                       show where the cache lives
 *
 * Provider keys (set whichever you have): OPENROUTER_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY
 */

const A = require('./aura-core');
const fs = require('fs');
const { validateAll } = require('./lib/validate-skill');
const LS = require('./lib/learn-sessions');
const IN = require('./lib/ingest');

const C = { g: '\x1b[32m', c: '\x1b[36m', y: '\x1b[33m', d: '\x1b[2m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
const out = (s) => process.stdout.write(s + '\n');

function usage() {
  out(`${C.b}AURA${C.x} — terminal token saver (cache + local compute, optional LLM fallback)

${C.b}USAGE${C.x}
  aura ask "<prompt>" [--llm] [--model <id>]   answer it the cheapest way
  aura learn "<prompt>" "<answer>"             cache an answer for next time
  aura skill add "<name>" --match "<pat>" --do "<answer>" [--regex] [--priority N]
                                               save a reusable skill (free forever)
  aura skill list                              list saved skills
  aura skill remove "<name>"                   delete a saved skill
  aura skill validate <file.json>              validate skills in a JSON file (no save)
  aura skill lint                              validate the installed skills.json
  aura learn-sessions [--apply] [--dir <path>] [--min-repeat N]
                                               teach AURA from your Claude Code history
                                               (dry-run by default; --apply to save)
  aura ingest <path> [--apply]                 load a .md/.txt file or a folder of docs
                                               into AURA as facts (dry-run by default;
                                               --apply to save)
  aura stats                                   show tokens/cost saved
  aura clear                                   wipe the cache
  aura where                                   show the cache location

${C.b}EXAMPLES${C.x}
  aura ask "what is 15% of 240"
  aura ask "convert 10 km to miles"
  aura ask "summarize the french revolution" --llm
  aura learn "our refund policy" "30 days, no questions asked"
  aura skill add "support" --match "support email" --do "cloudzncrownz@gmail.com"
  aura skill add "greet" --match "/^hi (\\w+)/" --do "Hello, \$1!" --regex
  aura skill list

${C.d}LLM fallback runs only with --llm AND a provider key set in your environment:
  OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY${C.x}`);
}

function fmtStats(s) {
  out(`${C.b}AURA savings${C.x}`);
  out(`  hits        ${C.g}${s.hits}${C.x}   misses ${s.misses}   hit-rate ${C.c}${(s.hitRate * 100).toFixed(1)}%${C.x}`);
  out(`  tokens saved ${C.g}${s.tokensSaved.toLocaleString()}${C.x}`);
  out(`  cost saved   ${C.y}$${s.costSavedUsd.toFixed(6)}${C.x}`);
  out(`  by method    fetch ${s.byMethod.fetch} · query ${s.byMethod.query} · skill ${s.byMethod.skill || 0} · compute ${s.byMethod.compute}`);
  out(`  ${C.d}cache: ${s.cacheFile}${C.x}`);
}

function printLint(report, label) {
  if (report.ok) {
    out(`${C.g}✓ valid${C.x} — ${label}`);
    return;
  }
  out(`${C.r}✗ invalid${C.x} — ${label}`);
  for (const r of report.results) {
    if (r.ok) { out(`  ${C.g}✓${C.x} ${r.name}`); continue; }
    out(`  ${C.r}✗ ${r.name}${C.x}`);
    for (const e of r.errors) out(`      ${C.r}•${C.x} ${e}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { usage(); return; }

  if (cmd === 'stats') { fmtStats(A.stats()); return; }
  if (cmd === 'where') { out(A.CACHE_FILE); return; }
  if (cmd === 'clear') { A.clearCache(); out(`${C.g}cache cleared${C.x}`); return; }

  if (cmd === 'learn-sessions') {
    const apply = argv.includes('--apply');
    const di = argv.indexOf('--dir');
    const mri = argv.indexOf('--min-repeat');
    const dir = di >= 0 && argv[di + 1] ? argv[di + 1] : LS.defaultTranscriptDir();
    const minRepeat = mri >= 0 ? parseInt(argv[mri + 1], 10) || 3 : 3;

    out(`${C.b}AURA — learning from your sessions${C.x}`);
    out(`${C.d}scanning ${dir}${C.x}`);
    const { files, pairs } = LS.collectPairs(dir);
    if (!files.length) { out(`${C.y}no transcripts found under ${dir}${C.x}`); process.exitCode = 1; return; }
    const plan = LS.planFromPairs(pairs, { minRepeat });
    const s = plan.stats;

    out(`  transcripts     ${C.c}${files.length}${C.x}   turns scanned ${s.scanned}   unique prompts ${s.uniquePrompts}`);
    out(`  ${C.r}secrets dropped ${s.secretsDropped}${C.x}   volatile skipped ${s.volatileDropped}   low-quality ${s.lowQuality}`);
    out(`  ${C.g}stable facts  ${plan.facts.length}${C.x}   ${C.g}recurring→skills ${plan.skills.length}${C.x} ${C.d}(seen ≥${minRepeat}×)${C.x}`);

    // show a few samples so the user can eyeball quality before applying
    for (const f of plan.facts.slice(0, 3)) out(`    ${C.d}fact:${C.x} "${f.prompt.slice(0, 60)}" ${C.d}→${C.x} ${f.answer.slice(0, 50).replace(/\n/g, ' ')}`);
    for (const sk of plan.skills.slice(0, 3)) out(`    ${C.d}skill:${C.x} [${sk.match}] ${C.d}(${sk.count}×)${C.x}`);

    if (!apply) {
      out(`\n${C.y}dry run — nothing saved.${C.x} re-run with ${C.b}--apply${C.x} to teach AURA.`);
      return;
    }

    let facts = 0, madeSkills = 0, rejected = 0;
    for (const f of plan.facts) { if (A.recordAnswer(f.prompt, f.answer)) facts++; }
    for (const sk of plan.skills) {
      const res = A.addSkill({ name: sk.name, match: sk.match, action: sk.action });
      if (res === true) madeSkills++; else rejected++;
    }
    out(`\n${C.g}✓ taught AURA:${C.x} ${facts} cached facts, ${madeSkills} skills` + (rejected ? ` ${C.d}(${rejected} skills rejected by validator)${C.x}` : ''));
    out(`${C.d}these prompts now answer free. check: aura stats${C.x}`);
    return;
  }

  if (cmd === 'ingest') {
    const apply = argv.includes('--apply');
    // path = first non-flag arg after "ingest"
    const target = argv.slice(1).find((a) => !a.startsWith('--'));
    if (!target) { out(`${C.r}usage: aura ingest <path> [--apply]${C.x}`); process.exitCode = 1; return; }

    out(`${C.b}AURA — ingesting docs${C.x}`);
    out(`${C.d}reading ${target}${C.x}`);
    const sources = IN.readSources(target);
    if (!sources.length) { out(`${C.y}no .md/.txt docs found at ${target}${C.x}`); process.exitCode = 1; return; }
    const plan = IN.planIngest(sources);
    const s = plan.stats;

    out(`  docs read       ${C.c}${sources.length}${C.x}   chunks scanned ${s.scanned}   empty skipped ${s.empty}   oversized ${s.tooLong}`);
    out(`  ${C.r}secrets dropped ${s.secretsDropped}${C.x}   ${C.g}facts ${plan.facts.length}${C.x}`);

    // show a few samples so the user can eyeball quality before applying
    for (const f of plan.facts.slice(0, 4)) out(`    ${C.d}fact:${C.x} "${f.prompt.slice(0, 60)}" ${C.d}→${C.x} ${f.answer.slice(0, 50).replace(/\n/g, ' ')}`);

    if (!apply) {
      out(`\n${C.y}dry run — nothing saved.${C.x} re-run with ${C.b}--apply${C.x} to teach AURA.`);
      return;
    }

    let facts = 0;
    for (const f of plan.facts) { if (A.recordAnswer(f.prompt, f.answer)) facts++; }
    out(`\n${C.g}✓ taught AURA:${C.x} ${facts} cached facts from ${sources.length} doc${sources.length === 1 ? '' : 's'}`);
    out(`${C.d}these questions now answer free. check: aura stats${C.x}`);
    return;
  }

  if (cmd === 'learn') {
    const q = argv[1], a = argv[2];
    if (!q || !a) { out(`${C.r}usage: aura learn "<prompt>" "<answer>"${C.x}`); process.exitCode = 1; return; }
    A.recordAnswer(q, a);
    out(`${C.g}learned${C.x} — next time "${q}" is free`);
    return;
  }

  if (cmd === 'skill') {
    const sub = argv[1];

    if (sub === 'list') {
      const skills = A.listSkills();
      if (!skills.length) { out(`${C.d}no saved skills yet. add one: aura skill add "<name>" --match "..." --do "..."${C.x}`); return; }
      out(`${C.b}AURA skills${C.x} (${skills.length})`);
      for (const s of skills) {
        const a = s.action || {};
        const what = a.type === 'adapter' ? `adapter:${a.adapter}` : (a.text || '');
        const kind = s.regex ? 'regex' : 'match';
        out(`  ${C.c}${s.name}${C.x}  ${C.d}[${kind}]${C.x} ${s.match}  ${C.d}→${C.x} ${what}`);
      }
      return;
    }

    if (sub === 'remove') {
      const name = argv[2];
      if (!name) { out(`${C.r}usage: aura skill remove "<name>"${C.x}`); process.exitCode = 1; return; }
      const ok = A.removeSkill(name);
      if (ok) out(`${C.g}removed${C.x} skill "${name}"`);
      else { out(`${C.y}no skill named "${name}"${C.x}`); process.exitCode = 1; }
      return;
    }

    if (sub === 'add') {
      const name = argv[2];
      const mi = argv.indexOf('--match');
      const di = argv.indexOf('--do');
      const pi = argv.indexOf('--priority');
      const match = mi >= 0 ? argv[mi + 1] : null;
      const doText = di >= 0 ? argv[di + 1] : null;
      const isRegex = argv.includes('--regex');
      const priority = pi >= 0 ? parseInt(argv[pi + 1], 10) : undefined;
      if (!name || name.startsWith('--') || !match || doText == null) {
        out(`${C.r}usage: aura skill add "<name>" --match "<pattern>" --do "<answer>" [--regex] [--priority N]${C.x}`);
        process.exitCode = 1; return;
      }
      const res = A.addSkill({ name, match, regex: isRegex, priority, action: { type: 'answer', text: doText } });
      if (res === true) {
        out(`${C.g}saved${C.x} skill "${name}" — prompts matching ${C.c}${match}${C.x} now answer free`);
      } else if (res && res.ok === false) {
        // rejected by the validator — show exactly why, don't persist
        out(`${C.r}invalid skill — not saved:${C.x}`);
        for (const e of res.errors) out(`  ${C.r}•${C.x} ${e}`);
        process.exitCode = 1;
      } else {
        out(`${C.r}could not save skill (write failure)${C.x}`);
        process.exitCode = 1;
      }
      return;
    }

    if (sub === 'validate') {
      const file = argv[2];
      if (!file) { out(`${C.r}usage: aura skill validate <file.json>${C.x}`); process.exitCode = 1; return; }
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { out(`${C.r}cannot read/parse ${file}: ${e.message}${C.x}`); process.exitCode = 1; return; }
      const skills = Array.isArray(data) ? data : [data];
      const report = validateAll(skills);
      printLint(report, `${file} (${skills.length} skill${skills.length === 1 ? '' : 's'})`);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    if (sub === 'lint') {
      const skills = A.listSkills();
      const report = validateAll(skills);
      printLint(report, `installed skills.json (${skills.length} skill${skills.length === 1 ? '' : 's'})`);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    out(`${C.r}usage: aura skill <add|list|remove|validate|lint> ...${C.x}`);
    process.exitCode = 1;
    return;
  }

  if (cmd === 'ask') {
    const flags = { llm: argv.includes('--llm') };
    const mi = argv.indexOf('--model');
    if (mi >= 0 && argv[mi + 1]) flags.model = argv[mi + 1];
    // prompt = all non-flag args after "ask"
    const parts = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--llm') continue;
      if (argv[i] === '--model') { i++; continue; }
      parts.push(argv[i]);
    }
    const prompt = parts.join(' ').trim();
    if (!prompt) { out(`${C.r}usage: aura ask "<prompt>"${C.x}`); process.exitCode = 1; return; }

    const res = await A.ask(prompt, flags);
    if (res.hit) {
      const tag = res.method === 'skill' ? `skill "${res.skill}"`
        : res.method === 'compute' ? 'computed locally'
        : res.method === 'query' ? `cache (fuzzy ${res.similarity})`
        : 'cache (exact)';
      out(res.answer);
      out(`${C.d}↳ ${C.g}free${C.d} via ${tag} · ~${res.savedTokensEst} tokens saved${C.x}`);
    } else if (res.method === 'llm') {
      out(res.answer);
      out(`${C.d}↳ ${C.y}LLM${C.d} (${res.provider}/${res.model}${res.tier ? ` · ${res.tier} tier` : ''}) · cached for next time${C.x}`);
    } else {
      out(`${C.y}no local answer.${C.x}`);
      if (res.reason === 'no-key') out(`${C.d}add --llm and set a provider key (OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY) to fall back to a model.${C.x}`);
      else if (res.reason) out(`${C.d}llm: ${res.reason}${C.x}`);
      else out(`${C.d}re-run with --llm to call a model, or 'aura learn' to teach the answer.${C.x}`);
      process.exitCode = 2;
    }
    return;
  }

  out(`${C.r}unknown command: ${cmd}${C.x}`);
  usage();
  process.exitCode = 1;
}

main();
