'use strict';
/**
 * AURA skill validator — zero-dependency (Node built-ins only).
 *
 * schema/skill-schema.json is the documented contract; this module is the enforced
 * one. Deterministic systems get their reliability from making structure explicit
 * BEFORE execution, so no invalid skill is ever persisted to skills.json.
 *
 * Beyond plain shape-checking it does semantic safety checks JSON Schema can't:
 *   - the `match` compiles as a RegExp when regex:true
 *   - the pattern is not an obvious catastrophic-backtracking (ReDoS) risk
 *   - the action payload required by its `type` is actually present
 *   - the adapter is on the allowlist (no arbitrary/shell adapters)
 *   - the skill name is unique within the given set
 *
 * validateSkill(skill, allSkills?) -> { ok: boolean, errors: string[] }
 */

// Adapters a skill is allowed to call. Kept in sync with ADAPTERS in aura-core.js.
// Hardcoded (not imported) to keep this module a dependency-free leaf with no cycle
// back into the core. Update both together when a new free adapter ships.
const SAFE_ADAPTERS = new Set(['price']);

// Action types AURA can execute deterministically. 'template' is a historical alias
// for 'answer' (fills $n / {{input}}), kept for backward compatibility.
const ACTION_TYPES = new Set(['answer', 'template', 'adapter', 'compute', 'chain']);
const STEP_TYPES = new Set(['answer', 'template', 'adapter', 'compute']);

const NAME_MAX = 120;
const MATCH_MAX = 500;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Best-effort static screen for catastrophic-backtracking (ReDoS) regex shapes.
 * A static string check can NEVER be sound (only a match-time deadline is), so this
 * is a screen, not a proof — it catches the well-known families and we make any skill
 * that fails it inert at load time too. Don't load a skills.json you don't trust.
 *
 * Two families are flagged:
 *  1. Nested quantifiers — a quantifier, ")", then another quantifier:
 *       (a+)+  (\w*)*  (.*)*  (x{2,})+  (a+)+b  …   A lone quantified group like
 *       (\d+) is SAFE and must pass, so a trailing `+)`/`*)` alone is not flagged.
 *  2. Quantified alternation with OVERLAP — (a|a)*  (a|ab)+  (x|xy)*  — where two
 *       branches are identical or one is a prefix of another. Non-overlapping
 *       alternation like (cat|dog)+ is SAFE and must pass.
 */
function looksCatastrophic(pattern) {
  const p = String(pattern);
  // Family 1: nested quantifier.
  if (/[+*}]\)[+*{]/.test(p)) return true;
  // Family 2: quantified alternation with overlapping branches. Scan simple
  // (non-nested) groups that are immediately quantified with * or + or {n,}.
  const groupRe = /\(([^()]*\|[^()]*)\)\s*(?:[*+]|\{\d+,\d*\})/g;
  let m;
  while ((m = groupRe.exec(p)) !== null) {
    const branches = m[1].split('|').map((b) => b.trim());
    for (let i = 0; i < branches.length; i++) {
      for (let j = 0; j < branches.length; j++) {
        if (i === j) continue;
        const a = branches[i], b = branches[j];
        if (!a && !b) continue;
        if (a === b) return true;                 // (a|a)*
        if (a && b.startsWith(a)) return true;    // (a|ab)+  — prefix overlap
      }
    }
  }
  return false;
}

// Return the pattern string a skill will actually compile to a RegExp, or null if
// the skill matches by keyword (never compiled). Mirrors skillRegex() in aura-core:
// a /.../-literal in `match` compiles to its inner source; regex:true uses match raw.
function effectiveRegexSource(skill) {
  const match = skill && skill.match;
  if (typeof match !== 'string') return null;
  const lit = match.match(/^\/(.*)\/([a-z]*)$/i);
  if (lit) return lit[1];
  if (skill.regex === true) return match;
  return null;
}

// True if the skill has no regex, or its effective regex compiles and passes the
// ReDoS screen. Never throws. Used at BOTH add-time (validateSkill) and load-time
// (matchSkill) so an unsafe pattern can neither be persisted nor executed.
function isRegexSafe(skill) {
  const src = effectiveRegexSource(skill);
  if (src === null) return true;
  try { new RegExp(src); } catch (_) { return false; }
  return !looksCatastrophic(src);
}

function validateAction(action, errors, { nested = false } = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    errors.push('action must be an object');
    return;
  }
  const t = action.type;
  const allowed = nested ? STEP_TYPES : ACTION_TYPES;
  if (!allowed.has(t)) {
    errors.push(`unknown action.type: ${JSON.stringify(t)}`);
    return;
  }
  if ((t === 'answer' || t === 'template') && !isNonEmptyString(action.text)) {
    errors.push(`${t} action requires non-empty text`);
  }
  if (t === 'adapter') {
    if (!isNonEmptyString(action.adapter)) errors.push('adapter action requires adapter');
    else if (!SAFE_ADAPTERS.has(action.adapter)) errors.push(`adapter not allowed: ${action.adapter}`);
  }
  if (t === 'compute' && !isNonEmptyString(action.expr)) {
    errors.push('compute action requires expr');
  }
  if (t === 'chain') {
    if (nested) { errors.push('chain steps cannot themselves be chains'); return; }
    if (!Array.isArray(action.steps) || action.steps.length === 0) {
      errors.push('chain action requires a non-empty steps array');
    } else if (action.steps.length > 20) {
      errors.push('chain action allows at most 20 steps');
    } else {
      action.steps.forEach((step, i) => {
        const stepErrors = [];
        validateAction(step, stepErrors, { nested: true });
        for (const e of stepErrors) errors.push(`step ${i + 1}: ${e}`);
      });
    }
  }
}

function validateSkill(skill, allSkills = []) {
  const errors = [];

  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    return { ok: false, errors: ['skill must be an object'] };
  }

  if (!isNonEmptyString(skill.name)) errors.push('name is required');
  else if (skill.name.length > NAME_MAX) errors.push(`name exceeds ${NAME_MAX} chars`);

  if (!isNonEmptyString(skill.match)) errors.push('match is required');
  else if (skill.match.length > MATCH_MAX) errors.push(`match exceeds ${MATCH_MAX} chars`);

  if (skill.priority !== undefined) {
    if (!Number.isInteger(skill.priority) || skill.priority < 0 || skill.priority > 1000) {
      errors.push('priority must be an integer 0..1000');
    }
  }

  // Regex safety on the EFFECTIVE compiled pattern — covers both regex:true and a
  // /.../-literal in `match`. A syntactically valid catastrophic regex does NOT throw,
  // it hangs at match time, so we must reject it here (and matchSkill also skips it on
  // load). Keyword skills (no compiled regex) are unaffected.
  const src = effectiveRegexSource(skill);
  if (src !== null) {
    try {
      new RegExp(src);
      if (looksCatastrophic(src)) {
        errors.push('regex has a catastrophic-backtracking shape (nested or overlapping-alternation quantifier); simplify it');
      }
    } catch (e) {
      errors.push(`invalid regex: ${e.message}`);
    }
  }

  if (skill.action === undefined) errors.push('action is required');
  else validateAction(skill.action, errors);

  // Duplicate name within the set (case-insensitive), ignoring the skill itself.
  if (isNonEmptyString(skill.name) && Array.isArray(allSkills)) {
    const lower = skill.name.toLowerCase();
    if (allSkills.some((s) => s && s !== skill && String(s.name).toLowerCase() === lower)) {
      errors.push(`duplicate skill name: ${skill.name}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * validateAll(skills) — validate an array of skills against each other (so duplicate
 * names surface). Returns { ok, results:[{index,name,ok,errors}], errors:[flat] }.
 */
function validateAll(skills) {
  if (!Array.isArray(skills)) {
    return { ok: false, results: [], errors: ['expected an array of skills'] };
  }
  const results = skills.map((s, index) => {
    const { ok, errors } = validateSkill(s, skills);
    return { index, name: (s && s.name) || `#${index}`, ok, errors };
  });
  const flat = [];
  for (const r of results) for (const e of r.errors) flat.push(`[${r.name}] ${e}`);
  return { ok: results.every((r) => r.ok), results, errors: flat };
}

module.exports = { validateSkill, validateAll, SAFE_ADAPTERS, ACTION_TYPES, looksCatastrophic, effectiveRegexSource, isRegexSafe };
