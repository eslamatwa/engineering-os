'use strict';
// Engineering OS — rules engine: path globs, Bash splitting and classification, class ratchet.
// Pure functions only (no file or process access), so they are easy to test.

const CLASSES = ['question', 'trivial_edit', 'standard', 'high_risk'];
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function classRank(c) {
  const i = CLASSES.indexOf(c);
  return i < 0 ? 0 : i;
}

function maxClass(...cs) {
  return cs.filter(Boolean).reduce((a, b) => (classRank(b) > classRank(a) ? b : a), 'question');
}

// ---------------------------------------------------------------------------
// Globs (gitignore-like). Patterns without "/" match the file name anywhere.
// ---------------------------------------------------------------------------
const _globCache = new Map();
function globToRegex(pattern) {
  const key = pattern;
  if (_globCache.has(key)) return _globCache.get(key);
  let p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  const anywhere = !p.includes('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const full = anywhere ? '^(?:.*/)?' + re + '$' : '^' + re + '$';
  const rx = new RegExp(full, CASE_INSENSITIVE ? 'i' : '');
  _globCache.set(key, rx);
  return rx;
}

function normRel(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function matchAny(rel, patterns) {
  const r = normRel(rel);
  return (patterns || []).some((p) => globToRegex(p).test(r) || globToRegex(p).test(r + '/'));
}

// Protected level of a repo-relative path: 'never' | 'high_risk' | 'standard' | null
function protectedLevel(rel, protectedPaths) {
  const pp = protectedPaths || {};
  if (matchAny(rel, pp.never)) return 'never';
  if (matchAny(rel, pp.high_risk)) return 'high_risk';
  if (matchAny(rel, pp.standard)) return 'standard';
  return null;
}

// Merge defaults with project config: projects may add, never remove (D9).
function effectiveProtected(defaultsRules, projectConfig) {
  const d = (defaultsRules && defaultsRules.protected_paths) || {};
  const p = (projectConfig && projectConfig.protected_paths) || {};
  const merge = (a, b) => Array.from(new Set([].concat(a || [], b || [])));
  return { high_risk: merge(d.high_risk, p.high_risk), standard: merge(d.standard, p.standard), never: merge(d.never, []) };
}

// ---------------------------------------------------------------------------
// Bash: split a command line into simple parts.
// Handles quotes, escapes, && || ; | & newlines, $( ) and backticks (recursively).
// ---------------------------------------------------------------------------
function splitCommand(cmd) {
  const parts = [];
  let cur = '';
  let quote = null;
  const s = String(cmd || '');
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += ch + s[++i]; continue; }
      if (ch === quote) quote = null;
      if (quote === '"' || quote === null) {
        // command substitution inside double quotes still runs
        if (ch === '$' && s[i + 1] === '(' && quote === '"') {
          const end = matchParen(s, i + 1);
          parts.push(...splitCommand(s.slice(i + 2, end)));
          cur += '"$()"';
          i = end;
          continue;
        }
      }
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '$' && s[i + 1] === '(') {
      const end = matchParen(s, i + 1);
      parts.push(...splitCommand(s.slice(i + 2, end)));
      cur += '$()';
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      const stop = end < 0 ? s.length : end;
      parts.push(...splitCommand(s.slice(i + 1, stop)));
      cur += '``';
      i = stop;
      continue;
    }
    if (ch === '&' && s[i + 1] === '&') { push(); i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { push(); i++; continue; }
    if (ch === '&' && s[i + 1] === '>') { cur += ch; continue; } // &> redirect
    if (ch === '&' && s[i - 1] === '>') { cur += ch; continue; } // 2>&1
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '&') { push(); continue; }
    cur += ch;
  }
  push();
  return parts;
}

function matchParen(s, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return s.length;
}

// Strip leading env assignments and wrappers; return { text, first }.
function normalizePart(part) {
  let t = String(part).trim();
  for (;;) {
    const before = t;
    t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '');
    t = t.replace(/^(?:sudo|env|command|time|nohup|exec)\s+(?:-\S+\s+)*/, '');
    if (t === before) break;
  }
  const firstRaw = (t.match(/^("[^"]+"|'[^']+'|\S+)/) || [''])[0].replace(/^["']|["']$/g, '');
  const first = firstRaw.replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return { text: t, first };
}

function hasOutputRedirect(text) {
  // a > or >> outside quotes, not to /dev/null and not 2>&1
  const stripped = text.replace(/"[^"]*"|'[^']*'/g, '""');
  const m = stripped.match(/(?:^|[^0-9&])>>?\s*([^\s&|;]+)/g);
  if (!m) return false;
  return m.some((x) => !/\/dev\/null|^\s*>&|NUL$/i.test(x.replace(/^[^>]*>>?\s*/, '')) && !/>&\d/.test(x));
}

function startsWithPrefix(text, prefixes) {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  return (prefixes || []).some((p) => {
    const q = String(p).toLowerCase();
    return t === q || t.startsWith(q + ' ');
  });
}

const SEVERITY = { read: 0, check: 1, engos: 1, vcs_local: 2, unknown: 3, pkg_install: 4, network: 5, vcs_remote: 5, destructive: 5, self_protect: 9 };

// Classify one part. neverPatterns: list of `never` globs (repo-relative).
function classifyPart(part, bashClasses, neverPatterns) {
  const bc = bashClasses || {};
  const { text, first } = normalizePart(part);
  const firstL = first.toLowerCase();
  const lower = text.toLowerCase();
  const inList = (list) => (list || []).some((c) => String(c).toLowerCase() === firstL);

  if (inList(bc.self_protect && bc.self_protect.commands)) return 'self_protect';
  if (startsWithPrefix(text, bc.destructive && bc.destructive.prefixes)) return 'destructive';
  if ((bc.destructive && bc.destructive.sql || []).some((q) => lower.includes(String(q).toLowerCase()))) return 'destructive';
  if (startsWithPrefix(text, bc.vcs_remote && bc.vcs_remote.prefixes)) return 'vcs_remote';
  if (inList(bc.network && bc.network.commands)) return 'network';
  if (startsWithPrefix(text, bc.pkg_install && bc.pkg_install.prefixes)) return 'pkg_install';

  // read candidates may still write
  const readish = inList(bc.read && bc.read.commands) || startsWithPrefix(text, bc.read && bc.read.prefixes);
  const writes = hasOutputRedirect(text) || /\bsed\s+(?:-\S*\s+)*-i/.test(text) || /^find\b.*\s-(delete|exec|execdir|ok)\b/.test(text);

  if (!readish || writes) {
    if (bc.self_protect && bc.self_protect.touches_never_paths && mentionsNeverPath(text, neverPatterns)) return 'self_protect';
  }
  if (startsWithPrefix(text, bc.check && bc.check.prefixes)) return 'check';
  if (inList(bc.engos && bc.engos.commands)) return 'engos';
  if (startsWithPrefix(text, bc.vcs_local && bc.vcs_local.prefixes)) return 'vcs_local';
  if (readish && !writes) return 'read';
  return 'unknown';
}

// Does the text name a path matching a `never` pattern? Checks every token that looks like a path.
function mentionsNeverPath(text, neverPatterns) {
  const tokens = String(text).replace(/["'`]/g, ' ').split(/[\s=<>|;&()]+/).filter((t) => t && /[\/\\.]/.test(t));
  return tokens.some((tok) => matchAny(tok.replace(/^\.\//, ''), neverPatterns) || (neverPatterns || []).some((p) => {
    const lit = String(p).replace(/\*.*$/, '').replace(/\/$/, '');
    return lit.length > 3 && tok.replace(/\\/g, '/').includes(lit);
  }));
}

function classifyCommand(cmd, bashClasses, neverPatterns) {
  const parts = splitCommand(cmd);
  const classified = parts.map((p) => ({ part: p, cls: classifyPart(p, bashClasses, neverPatterns) }));
  let worst = 'read';
  for (const c of classified) if (SEVERITY[c.cls] > SEVERITY[worst]) worst = c.cls;
  if (!classified.length) worst = 'read';
  return { parts: classified, cls: worst };
}

function isKnownCommand(part, knownCommands) {
  const { text } = normalizePart(part);
  return startsWithPrefix(text, knownCommands);
}

// Policy for a command class given the task class: allow | allow_observe | allow_record | raise_to_standard | approval | deny
function bashDecision(cls, taskClass, bashPolicy) {
  const row = (bashPolicy || {})[cls];
  if (!row) return 'approval';
  const idx = taskClass === 'high_risk' ? 2 : taskClass === 'standard' ? 1 : 0;
  return row[idx];
}

// ---------------------------------------------------------------------------
// Class ratchet: recompute the effective class from declared, planned and observed signals.
// Never lower than the previous effective class (D12).
// ---------------------------------------------------------------------------
function recompute(profile, rules, protectedPaths) {
  const floors = [];
  const declared = profile.declared || {};
  const planned = profile.planned || {};
  const observed = profile.observed || {};
  const prev = (profile.effective && profile.effective.class) || 'question';

  const flags = rules.sensitivity_flags || {};
  for (const f of declared.sensitivity || []) {
    if (flags[f]) floors.push({ cls: flags[f], rule: 'F-sensitivity:' + f });
  }
  if (['hard', 'irreversible'].includes(declared.reversibility)) floors.push({ cls: 'high_risk', rule: 'F-irreversible' });
  if (declared.mutates) floors.push({ cls: 'trivial_edit', rule: 'F-mutates' });

  for (const pat of (planned.scope && planned.scope.write) || []) {
    const sample = String(pat).replace(/\*.*$/, '').replace(/\/$/, '') || '.';
    const lvl = protectedLevel(sample + '/x', protectedPaths) || protectedLevel(String(pat).replace(/\*/g, 'x'), protectedPaths);
    if (lvl === 'high_risk' || lvl === 'never') floors.push({ cls: 'high_risk', rule: 'F-protected-planned' });
    else if (lvl === 'standard') floors.push({ cls: 'standard', rule: 'F-standard-path-planned' });
  }

  if ((observed.files_count || 0) > 0) floors.push({ cls: 'trivial_edit', rule: 'F-trivial' });
  const b = (rules.budgets && rules.budgets.trivial_edit) || {};
  if (exceedsTrivial(observed, b)) floors.push({ cls: 'standard', rule: 'F-over-trivial' });
  for (const hit of observed.protected_hits || []) {
    if (hit.level === 'high_risk' || hit.level === 'never') floors.push({ cls: 'high_risk', rule: 'F-protected' });
    else if (hit.level === 'standard') floors.push({ cls: 'standard', rule: 'F-standard-path' });
  }
  if ((observed.modules || []).length >= 3) floors.push({ cls: 'standard', rule: 'F-multi-module' });
  if (observed.pkg_install) floors.push({ cls: 'standard', rule: 'F-pkg-install' });

  // A class the human lowered (D12) ignores the floors that were active when they lowered it;
  // new signals can still raise it.
  const ignore = new Set((profile.human_override && profile.human_override.ignore_floors) || []);
  for (let i = floors.length - 1; i >= 0; i--) if (ignore.has(floors[i].rule)) floors.splice(i, 1);

  let cls = prev;
  const sources = [];
  for (const f of floors) {
    if (classRank(f.cls) > classRank(cls)) cls = f.cls;
  }
  for (const f of floors) if (f.cls === cls) sources.push(f.rule);
  return { cls, raised: classRank(cls) > classRank(prev), from: prev, sources: Array.from(new Set(sources)) };
}

function exceedsTrivial(observed, b) {
  const o = observed || {};
  return (o.files_count || 0) > (b.max_files == null ? 2 : b.max_files)
    || ((o.lines_added || 0) + (o.lines_deleted || 0) - (o.doc_lines || 0)) > (b.max_changed_lines == null ? 40 : b.max_changed_lines) // D51
    || (o.files_created || 0) > (b.max_created_files == null ? 1 : b.max_created_files)
    || (o.files_deleted || 0) > (b.max_deleted_files == null ? 0 : b.max_deleted_files);
}

// What a class needs before writes may continue.
// D49: is this MCP tool allowed without an approval? Host tools by default, plus the project's mcp_allowlist.
function mcpAllowed(name, policies, config) {
  const m = (policies && policies.mcp) || {};
  const hit = (list) => (list || []).some((g) => globToRegex(String(g)).test(name) || g === name);
  if (hit(m.always_ask)) return false;
  return hit(m.host_tools_allowed) || hit(config && config.mcp_allowlist);
}

// Short, stable text for an MCP call: the tool and its input, so the approval record names the real action.
function mcpAction(name, input) {
  let args = '';
  try { args = JSON.stringify(input || {}); } catch (_) { args = '{}'; }
  return name + ' ' + (args.length > 400 ? args.slice(0, 399) + '…' : args);
}

function missingRequirements(profile) {
  const cls = (profile.effective && profile.effective.class) || 'question';
  const missing = [];
  if (cls === 'standard' || cls === 'high_risk') {
    if (!profile.declared || !profile.declared.kind) missing.push('profile (engos profile set --kind ...)');
    if (!profile.planned || !profile.planned.scope || !(profile.planned.scope.write || []).length) missing.push('plan with write scope (engos plan set --scope-write ...)');
  }
  return missing;
}

module.exports = {
  mcpAllowed,
  mcpAction,
  CLASSES,
  classRank,
  maxClass,
  globToRegex,
  matchAny,
  normRel,
  protectedLevel,
  effectiveProtected,
  splitCommand,
  normalizePart,
  hasOutputRedirect,
  classifyPart,
  classifyCommand,
  mentionsNeverPath,
  isKnownCommand,
  bashDecision,
  recompute,
  exceedsTrivial,
  missingRequirements,
  SEVERITY,
};
