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

function snapshotProtected(root, protectedPaths, limit) {
  const snap = {};
  const cands = protectedCandidates(root, protectedPaths);
  let n = 0;
  for (const rel of Object.keys(cands)) {
    if (n++ >= (limit || 2000)) break;
    try {
      const st = fs.statSync(path.join(root, rel));
      snap[rel] = { level: cands[rel], size: st.size, mtime: Math.round(st.mtimeMs) };
    } catch (_) { /* vanished */ }
  }
  return snap;
}

// Baseline taken when a task opens.
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
    taken_at: new Date().toISOString(),
  };
}

// Observe everything changed since the baseline. withSnapshot: also compare protected files.
function observe(root, base, protectedPaths, opts) {
  const o = opts || {};
  const entries = statusEntries(root);
  const lines = numstat(root, base.git_head);
  const touched = [];
  let added = 0;
  let deleted = 0;
  let created = 0;
  let removed = 0;
  const dirty = base.dirty_at_open || {};

  for (const e of entries) {
    if (Object.prototype.hasOwnProperty.call(dirty, e.path) && dirty[e.path] === hashFile(path.join(root, e.path))) continue; // unchanged since open
    touched.push(e.path);
    if (e.kind === 'untracked' || e.kind === 'added') {
      created++;
      added += lines[e.path] ? lines[e.path].added : countLines(path.join(root, e.path));
    } else if (e.kind === 'deleted') {
      removed++;
      deleted += lines[e.path] ? lines[e.path].deleted : 0;
    } else {
      const l = lines[e.path] || { added: 0, deleted: 0 };
      added += l.added;
      deleted += l.deleted;
    }
  }
  // Committed since the task opened: git status is clean for those files, numstat against base still sees them.
  for (const p of Object.keys(lines)) {
    if (ignored(p) || touched.includes(p)) continue;
    if (Object.prototype.hasOwnProperty.call(dirty, p)) continue;
    touched.push(p);
    added += lines[p].added;
    deleted += lines[p].deleted;
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
    modules,
    protected_hits: protectedHits,
  };
}

module.exports = { baseline, observe, snapshotProtected, statusEntries, numstat, headSha, EMPTY_TREE };
