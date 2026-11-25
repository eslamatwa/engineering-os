'use strict';
// Engineering OS — approvals (D46).
// Actions and protected files use Claude Code's own Allow/Deny prompt: the gate writes a request and
// returns `ask`; if the tool then runs, PostToolUse records the grant. A "No" is invisible to hooks,
// so an unanswered request simply stays `requested` and later shows as `expired`.
// Records live in .engos/approvals/ (a `never` path: only hooks write there).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const REQUEST_TTL_MS = 60 * 60 * 1000;          // an unanswered request expires after 1 hour
const FILE_APPROVAL_MAX_MS = 24 * 60 * 60 * 1000; // D46: a file stays approved for the task, max 24 hours

function dir(root) {
  return path.join(root, '.engos', 'approvals');
}

function actionHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function idFor(hash) {
  return 'APR-' + hash.slice(0, 8);
}

function load(root, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(root), id + '.json'), 'utf8')); } catch (_) { return null; }
}

// Fingerprints of the records hooks wrote, so the observer can tell our writes from anyone else's (D37).
function indexFile(root) {
  return path.join(root, '.engos', 'sessions', 'approvals.index.json');
}

function readIndex(root) {
  try { return JSON.parse(fs.readFileSync(indexFile(root), 'utf8')); } catch (_) { return {}; }
}

function save(root, rec) {
  fs.mkdirSync(dir(root), { recursive: true });
  const file = path.join(dir(root), rec.approval_id + '.json');
  const tmp = file + '.' + process.pid + '.tmp';
  const body = JSON.stringify(rec, null, 2);
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  const idx = readIndex(root);
  idx[rec.approval_id + '.json'] = crypto.createHash('sha1').update(body).digest('hex');
  fs.mkdirSync(path.dirname(indexFile(root)), { recursive: true });
  fs.writeFileSync(indexFile(root), JSON.stringify(idx), 'utf8');
}

// True when the file is exactly what a hook last wrote.
function isOwnRecord(root, rel) {
  const name = path.posix.basename(rel);
  const want = readIndex(root)[name];
  if (!want) return false;
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex') === want; } catch (_) { return false; }
}

function list(root) {
  try {
    return fs.readdirSync(dir(root)).filter((f) => /^APR-[0-9a-f]{8}\.json$/.test(f)).map((f) => load(root, f.slice(0, -5))).filter(Boolean);
  } catch (_) { return []; }
}

function git(root, args) {
  try { return cp.execFileSync('git', ['-C', root].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim(); } catch (_) { return ''; }
}

// Context the prompt itself can't show (D46): branch and outgoing commits for a push, files for a delete.
function contextFor(root, kind, cls, command) {
  const ctx = {};
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) ctx.branch = branch;
  if (cls === 'vcs_remote') {
    const out = git(root, ['log', '--oneline', '-n', '20', 'HEAD', '--not', '--remotes']);
    ctx.outgoing_commits = out ? out.split('\n') : [];
  }
  if (cls === 'destructive') ctx.note = 'destructive command: check what it removes before allowing';
  return ctx;
}

function findPending(root, hash) {
  const now = Date.now();
  return list(root)
    .filter((r) => r.decision === 'requested' && r.action_hash === 'sha256:' + hash && now - Date.parse(r.requested_at) <= REQUEST_TTL_MS)
    .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at))[0] || null;
}

// Create (or reuse) a pending request for an action. Every new request gets its own ID, so an approved
// record is never overwritten by the next request for the same action. Returns the record.
function request(root, o) {
  const hash = actionHash([o.kind, o.tool, o.action, o.session_id, o.task_id || null]);
  const now = Date.now();
  const existing = findPending(root, hash);
  if (existing) return existing;
  const id = idFor(actionHash([hash, now, process.pid, Math.random()]));
  const rec = {
    approval_id: id,
    kind: o.kind,                 // action | file
    tool: o.tool,
    action: require('./engos-rules.js').redact(o.action), // the command (secrets hidden) or the repo-relative path; the hash uses the original
    command_class: o.cls || null,
    task_id: o.task_id || null,
    session_id: o.session_id,
    action_hash: 'sha256:' + hash,
    context: o.context || {},
    requested_at: new Date(now).toISOString(),
    decision: 'requested',
    method: 'native_prompt',
  };
  save(root, rec);
  return rec;
}

// Called from PostToolUse: the tool ran, so the person clicked Allow. Returns the granted record or null.
function grantIfPending(root, o) {
  const hash = actionHash([o.kind, o.tool, o.action, o.session_id, o.task_id || null]);
  const rec = findPending(root, hash);
  if (!rec) return null;
  rec.decision = 'approved';
  rec.decided_by = 'human';
  rec.decided_at = new Date().toISOString();
  rec.used_at = rec.decided_at;
  save(root, rec);
  return rec;
}

// D56: the same exact command, already allowed once in this task and session (max 24 hours).
// Only for commands of class `unknown`; network, push and destructive commands ask every time (D46).
function allowedBefore(root, o) {
  if (!o.task_id) return null;
  const hash = 'sha256:' + actionHash([o.kind, o.tool, o.action, o.session_id, o.task_id]);
  const now = Date.now();
  return list(root).find((r) => r.action_hash === hash && r.decision === 'approved' && r.command_class === 'unknown'
    && now - Date.parse(r.decided_at) < FILE_APPROVAL_MAX_MS) || null;
}

// Add facts known only after the action ran (e.g. the commit a push actually sent).
function annotate(root, id, fields) {
  const rec = load(root, id);
  if (!rec) return;
  Object.assign(rec, fields);
  save(root, rec);
}

function afterContext(root, cls) {
  if (cls !== 'vcs_remote') return null;
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const subject = git(root, ['log', '-1', '--format=%s']);
  return { head, head_subject: subject, branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) };
}

// Is this protected file already approved for this task? (D46: per file, per task, max 24 hours)
function fileApproved(task, rel) {
  const a = (task.approved_files || {})[rel];
  return !!(a && Date.now() - Date.parse(a.approved_at) < FILE_APPROVAL_MAX_MS);
}

// Requests that were never answered within the TTL.
function expireStale(root) {
  const now = Date.now();
  const out = [];
  for (const rec of list(root)) {
    if (rec.decision === 'requested' && now - Date.parse(rec.requested_at) > REQUEST_TTL_MS) {
      rec.decision = 'expired';
      rec.decided_at = new Date(now).toISOString();
      save(root, rec);
      out.push(rec);
    }
  }
  return out;
}

function pending(root, sessionId) {
  const now = Date.now();
  return list(root).filter((r) => r.decision === 'requested' && (!sessionId || r.session_id === sessionId) && now - Date.parse(r.requested_at) <= REQUEST_TTL_MS);
}

module.exports = { allowedBefore, annotate, afterContext, isOwnRecord, request, grantIfPending, findPending, fileApproved, expireStale, pending, list, load, contextFor, actionHash, idFor, REQUEST_TTL_MS, FILE_APPROVAL_MAX_MS };
