'use strict';
// Engineering OS — observer (H7/H9, D37): what actually changed since the task opened.
// Uses git for tracked/untracked changes and a size+mtime snapshot for protected and `never`
// files, because those are often gitignored (.env, approvals, ledger) and invisible to git.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const rules = require('./engos-rules.js');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const IGNORE_PREFIXES = ['.engos/', '.git/'];

function git(root, args, opts) {
  return cp.execFileSync('git', ['-C', root].concat(args), Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, opts || {}));
}

function headSha(root) {
  try { return git(root, ['rev-parse', 'HEAD']).trim(); } catch (_) { return null; }
}

function ignored(rel) {
  return IGNORE_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
}

function hashFile(abs) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch (_) { return null; }
}

// Parse `git status --porcelain=v2 -z --untracked-files=all`.
function statusEntries(root) {
  const out = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const recs = out.split('\0');
  const entries = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const kind = r[0];
    if (kind === '1') {
      const f = r.split(' ');
      const xy = f[1];
      entries.push({ path: f.slice(8).join(' '), xy, kind: xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : 'modified' });
    } else if (kind === '2') {
      const f = r.split(' ');
      const p = f.slice(9).join(' ');
      const orig = recs[++i];
      entries.push({ path: p, from: orig, xy: f[1], kind: 'renamed' });
    } else if (kind === 'u') {
      const f = r.split(' ');
      entries.push({ path: f.slice(10).join(' '), xy: f[1], kind: 'modified' });
    } else if (kind === '?') {
      entries.push({ path: r.slice(2), kind: 'untracked' });
    }
  }
  return entries.filter((e) => !ignored(e.path));
}

// Lines changed per tracked path between base and the working tree (staged + unstaged).
function numstat(root, base) {
  const map = {};
  let out = '';
  try { out = git(root, ['diff', base || EMPTY_TREE, '--numstat', '-z', '-M']); } catch (_) { return map; }
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(r);
    if (!m) continue;
    let p = m[3];
    if (p === '') { i++; p = recs[++i]; } // rename: "" then from, to
    map[p] = { added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) };
  }
  return map;
}

function countLines(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) return 0;
    const t = fs.readFileSync(abs, 'utf8');
    if (!t) return 0;
    return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
  } catch (_) { return 0; }
}

// Files matching protected or `never` patterns, including gitignored ones (D37).
function protectedCandidates(root, protectedPaths) {
  const all = [];
  try {
    for (const f of git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')) if (f) all.push(f);
  } catch (_) { /* not git */ }
  try {
    for (const f of git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0')) if (f && !f.endsWith('/')) all.push(f);
  } catch (_) { /* ignore */ }
  // .engos never-files are excluded from git listings above by the ignore rules; add them explicitly.
  for (const rel of ['.engos/ledger.jsonl']) all.push(rel);
  for (const dir of ['.engos/approvals', '.engos/sessions']) {
    try { for (const f of fs.readdirSync(path.join(root, dir))) all.push(dir + '/' + f); } catch (_) { /* none */ }
  }
  const out = {};
  for (const rel of new Set(all)) {
    const lvl = rules.protectedLevel(rel, protectedPaths);
    if (lvl) out[rel] = lvl;
  }
  return out;
}

// Engineering OS writes these itself on every event, so a size/mtime snapshot would flag its own writes.
// They are still `never` for Edit/Write and for any command that names them (G-self).
const SELF_WRITTEN = ['.engos/tasks/', '.engos/sessions/', '.engos/view/', '.engos/status.json', '.engos/statusline.js'];

function snapshotProtected(root, protectedPaths, limit) {
  const snap = {};
  const cands = protectedCandidates(root, protectedPaths);
  let n = 0;
  for (const rel of Object.keys(cands)) {
    if (SELF_WRITTEN.some((p) => rel === p || rel.startsWith(p))) continue;
    if (n++ >= (limit || 2000)) break;
    try {
      const st = fs.statSync(path.join(root, rel));
      snap[rel] = { level: cands[rel], size: st.size, mtime: Math.round(st.mtimeMs) };
    } catch (_) { /* vanished */ }
  }
  return snap;
}

// Baseline taken when a task opens.
// The check commands when the task opened: evidence from a check whose command changed later doesn't count.
function checksAtOpen(root) {
  try {
    const core = require('./engos-core.js');
    const cfg = core.loadProjectConfig(root);
    return cfg.ok ? Object.assign({}, cfg.config.checks || {}) : {};
  } catch (_) { return {}; }
}

function baseline(root, protectedPaths) {
  const base = headSha(root);
  const dirty = {};
  try {
    for (const e of statusEntries(root)) dirty[e.path] = hashFile(path.join(root, e.path));
  } catch (_) { /* not git */ }
  return {
    git_head: base,
    dirty_at_open: dirty,
    protected_snapshot: snapshotProtected(root, protectedPaths),
    checks: checksAtOpen(root),
    taken_at: new Date().toISOString(),
  };
}

// Observe everything changed since the baseline. withSnapshot: also compare protected files.
// A hash of what the task changed: the tracked diff against the task base plus each changed file's content.
// "Changed since the last check" compares this, so an edit that keeps line counts still counts (Fable review).
function diffHash(root, base, touched) {
  const h = crypto.createHash('sha1');
  try { h.update(git(root, ['diff', base.git_head || EMPTY_TREE, '--binary', '--no-color'])); } catch (_) { h.update('nodiff'); }
  for (const p of (touched || []).slice().sort()) h.update(p + ':' + (hashFile(path.join(root, p)) || '-') + ';');
  return h.digest('hex');
}

// After a re-baseline (branch switch, pull, merge), keep what the task had already changed.
function mergeObserved(frozen, obs) {
  if (!frozen) return obs;
  const files = Array.from(new Set((frozen.files_touched || []).concat(obs.files_touched || []))).sort();
  return Object.assign({}, obs, {
    files_touched: files,
    files_count: files.length,
    files_created: (frozen.files_created || 0) + (obs.files_created || 0),
    files_deleted: (frozen.files_deleted || 0) + (obs.files_deleted || 0),
    lines_added: (frozen.lines_added || 0) + (obs.lines_added || 0),
    lines_deleted: (frozen.lines_deleted || 0) + (obs.lines_deleted || 0),
    doc_lines: (frozen.doc_lines || 0) + (obs.doc_lines || 0),
    modules: Array.from(new Set((frozen.modules || []).concat(obs.modules || []))).sort(),
    protected_hits: (frozen.protected_hits || []).concat((obs.protected_hits || []).filter((h) => !(frozen.protected_hits || []).some((x) => x.path === h.path))),
    diff_hash: (frozen.diff_hash || '') + ':' + obs.diff_hash,
  });
}

function observe(root, base, protectedPaths, opts) {
  const o = opts || {};
  const entries = statusEntries(root);
  const lines = numstat(root, base.git_head);
  const touched = [];
  let added = 0;
  let deleted = 0;
  let docLines = 0; // D51: lines in docs files, not counted against the trivial budget
  const notCounted = (((o.budget || {}).lines_not_counted) || ((require('./engos-core.js').defaults().rules.budgets || {}).trivial_edit || {}).lines_not_counted || []);
  const isDoc = (p) => rules.matchAny(p, notCounted);
  let created = 0;
  let removed = 0;
  const dirty = base.dirty_at_open || {};

  for (const e of entries) {
    if (Object.prototype.hasOwnProperty.call(dirty, e.path) && dirty[e.path] === hashFile(path.join(root, e.path))) continue; // unchanged since open
    touched.push(e.path);
    if (e.kind === 'untracked' || e.kind === 'added') {
      created++;
      const n = lines[e.path] ? lines[e.path].added : countLines(path.join(root, e.path));
      added += n;
      if (isDoc(e.path)) docLines += n;
    } else if (e.kind === 'deleted') {
      removed++;
      const n = lines[e.path] ? lines[e.path].deleted : 0;
      deleted += n;
      if (isDoc(e.path)) docLines += n;
    } else {
      const l = lines[e.path] || { added: 0, deleted: 0 };
      added += l.added;
      deleted += l.deleted;
      if (isDoc(e.path)) docLines += l.added + l.deleted;
    }
  }
  // Committed since the task opened: git status is clean for those files, numstat against base still sees them.
  for (const p of Object.keys(lines)) {
    if (ignored(p) || touched.includes(p)) continue;
    if (Object.prototype.hasOwnProperty.call(dirty, p)) continue;
    touched.push(p);
    added += lines[p].added;
    deleted += lines[p].deleted;
    if (isDoc(p)) docLines += lines[p].added + lines[p].deleted;
  }

  const modules = Array.from(new Set(touched.map((p) => path.posix.dirname(rules.normRel(p))))).sort();
  const protectedHits = [];
  for (const p of touched) {
    const lvl = rules.protectedLevel(p, protectedPaths);
    if (lvl) protectedHits.push({ path: p, level: lvl, via: 'git' });
  }

  if (o.withSnapshot) {
    const now = snapshotProtected(root, protectedPaths);
    const before = base.protected_snapshot || {};
    for (const rel of new Set(Object.keys(now).concat(Object.keys(before)))) {
      const a = before[rel];
      const b = now[rel];
      const changed = !a || !b || a.size !== b.size || a.mtime !== b.mtime;
      if (!changed) continue;
      // Written by Engineering OS itself; the ledger is checked against its recorded size below instead.
      if (rel === '.engos/ledger.jsonl' || rel.startsWith('.engos/sessions/')) continue;
      // Approval records: fine only if the file is exactly what a hook last wrote.
      if (rel.startsWith('.engos/approvals/') && b && require('./engos-approvals.js').isOwnRecord(root, rel)) continue;
      if (!protectedHits.some((h) => h.path === rel)) protectedHits.push({ path: rel, level: (b || a).level, via: 'snapshot' });
    }
    // Ledger: only hooks and the CLI append to it, and they record its size after each append.
    try {
      const expected = Number(fs.readFileSync(path.join(root, '.engos', 'sessions', 'ledger.size'), 'utf8'));
      const actual = fs.statSync(path.join(root, '.engos', 'ledger.jsonl')).size;
      if (!isNaN(expected) && expected !== actual) protectedHits.push({ path: '.engos/ledger.jsonl', level: 'never', via: 'ledger_size' });
    } catch (_) { /* no record yet */ }
  }

  return {
    files_touched: touched.sort(),
    files_count: touched.length,
    files_created: created,
    files_deleted: removed,
    lines_added: added,
    lines_deleted: deleted,
    doc_lines: docLines,
    diff_hash: diffHash(root, base, touched),
    modules,
    protected_hits: protectedHits,
  };
}

module.exports = { baseline, observe, mergeObserved, diffHash, snapshotProtected, statusEntries, numstat, headSha, EMPTY_TREE };
