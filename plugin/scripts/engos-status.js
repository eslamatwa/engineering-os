'use strict';
// Engineering OS — visibility (build phase 6, D33).
// One picture of the project, written to .engos/status.json whenever the ledger changes.
// The status line, /engos:status and the live view (/engos:view) all read this same picture.
// It never contains command output, prompts or environment values: only task state and short labels.

const fs = require('fs');
const path = require('path');

const TIMELINE_MAX = 40;
const LEDGER_TAIL_BYTES = 96 * 1024;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function ledgerTail(root) {
  const file = path.join(root, '.engos', 'ledger.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, LEDGER_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // partial first line
    const out = [];
    for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) { /* skip */ } }
    return out;
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

function short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// A plain-language line for each ledger event. tone: ok | bad | run | warn | '' (neutral).
function describe(e) {
  const t = e.task_id ? e.task_id + ' ' : '';
  switch (e.type) {
    case 'task.opened': return { text: t + 'opened as ' + e.class + (e.opened_by === 'auto' ? ' (automatically)' : ''), who: e.actor && e.actor.kind, tone: '' };
    case 'task.closed': return { text: t + 'closed with evidence', who: 'engos', tone: 'ok' };
    case 'task.close_refused': return { text: t + 'close refused: ' + short((e.missing || [])[0], 90), who: 'engos', tone: 'bad' };
    case 'class.changed': return { text: t + 'class ' + e.from + ' → ' + e.to, who: (e.actor && e.actor.kind) === 'human' ? 'you' : 'classifier · ' + short(e.rule_id, 40), tone: 'warn' };
    case 'plan.set': return { text: t + 'plan set: ' + short((e.scope_write || []).join(', '), 60), who: 'lead', tone: '' };
    case 'step.assigned': return e.agent_type
      ? { text: (e.step ? e.step + ' ' : '') + 'started on ' + e.agent_type + (e.model_requested ? ' · ' + e.model_requested : '') + (e.attempt > 1 ? ' · attempt ' + e.attempt : ''), who: 'lead → ' + e.agent_type, tone: 'run' }
      : { text: e.step + ' planned: ' + e.kind + ' by ' + e.by + (e.tier ? ' (' + e.tier + ')' : ''), who: 'router', tone: '' };
    case 'step.ended': return { text: (e.step || e.launch) + ' finished' + (e.status ? ' (' + e.status + ')' : ''), who: (e.model_actual || e.model_requested || ''), tone: 'ok' };
    case 'step.failed': return { text: (e.step || e.launch) + ' agent call failed', who: 'hook', tone: 'bad' };
    case 'step.report_rejected': return { text: 'report sent back to fix: ' + short((e.problems || [])[0], 80), who: 'hook', tone: 'warn' };
    case 'step.report_problems': return { text: 'report still unverified: ' + short((e.problems || [])[0], 80), who: 'hook', tone: 'bad' };
    case 'evidence.recorded': return { text: 'check ' + e.name + (e.passed ? ' passed' : ' failed') + ' (exit ' + e.exit + ')' + (e.label && e.label !== 'passed' ? ' · ' + e.label : ''), who: 'engos check', tone: e.passed ? 'ok' : 'bad' };
    case 'validation.verdict': return { text: (e.step || '') + ' review: ' + e.verdict + (e.refs_ok ? '' : ' (refs unverified)'), who: 'validator', tone: e.verdict === 'pass' ? 'ok' : 'bad' };
    case 'gate.denied': return { text: 'blocked ' + (e.tool || '') + ' · ' + e.rule_id, who: 'gate', tone: 'bad' };
    case 'approval.requested': return { text: 'asked you to allow ' + (e.kind === 'file' ? 'editing ' + (e.path || 'a protected file') : (e.command_class || 'an action').replace('_', ' ') + ' command'), who: 'gate · ' + e.approval_id, tone: 'warn' };
    case 'approval.granted': return { text: 'you allowed ' + e.approval_id, who: 'you', tone: 'ok' };
    case 'model.asked': return { text: (e.step || '') + ' asks to use Fable', who: 'lead', tone: 'warn' };
    case 'model.answered': return { text: 'Fable ' + (e.answer === 'yes' ? 'approved' : 'declined'), who: 'you', tone: 'ok' };
    case 'model.unavailable': return { text: e.model + ' marked unavailable', who: 'hook', tone: 'warn' };
    case 'responsibility.transferred': return { text: t + 'handed to you (' + e.reason + ')', who: 'engos', tone: 'warn' };
    case 'decision.recorded': return { text: t + 'your decision: ' + e.option, who: 'you', tone: 'ok' };
    case 'dispute.opened': return { text: t + 'dispute about ' + e.about + ', settled by ' + (e.settler === 'human' ? 'you' : 'the lead'), who: 'lead', tone: 'warn' };
    case 'dispute.resolved': return { text: t + 'dispute settled for the ' + e.outcome, who: e.resolved_by === 'human' ? 'you' : 'lead', tone: 'ok' };
    case 'violation.detected': return { text: t + 'protected files changed without approval', who: 'observer', tone: 'bad' };
    case 'criteria.amended': return { text: t + 'acceptance criteria changed', who: (e.actor && e.actor.kind) || '', tone: 'warn' };
    case 'scope.amended': return { text: t + 'scope widened', who: 'lead', tone: 'warn' };
    case 'engos.paused': return { text: 'Engineering OS paused', who: 'you', tone: 'warn' };
    case 'engos.resumed': return { text: 'Engineering OS resumed', who: 'you', tone: 'ok' };
    default: return null;
  }
}

function pendingApprovals(root) {
  const dir = path.join(root, '.engos', 'approvals');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^APR-.*\.json$/.test(f)); } catch (_) { return out; }
  const now = Date.now();
  for (const f of files) {
    const r = readJson(path.join(dir, f), null);
    if (!r || r.decision !== 'requested') continue;
    if (now - Date.parse(r.requested_at) > 60 * 60 * 1000) continue;
    out.push({ approval_id: r.approval_id, kind: r.kind, action: short(r.action, 300), command_class: r.command_class || null, task_id: r.task_id || null, session_id: r.session_id || null, requested_at: r.requested_at, expires_at: r.expires_at || null, context: r.context ? { branch: r.context.branch || null, outgoing_commits: (r.context.outgoing_commits || []).slice(0, 10) } : null });
  }
  return out.sort((a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at));
}

function taskView(t, D) {
  const O = require('./engos-orchestrate.js');
  const E = require('./engos-evidence.js');
  const steps = ((t.planned && t.planned.steps) || []).map((s) => {
    const st = (t.step_state || {})[s.id] || {};
    let status = st.status || 'pending';
    // A worker step stays running until its checks pass; between attempts it is waiting for the lead's check.
    if (status === 'running' && !(t.agents || []).some((a) => a.step === s.id && O.isRunning(a))) status = s.by === 'worker' ? 'awaiting_check' : 'done';
    return { id: s.id, kind: s.kind, by: s.by, role: s.role, tier: s.tier, status, failures: s.by === 'worker' ? O.failuresFor(t, s.id) : 0, allowed: st.allowed_attempts || ((D.rules.escalation || {}).attempts_per_step || 3) };
  });
  const agents = (t.agents || []).map((a) => ({ id: a.id, type: a.type, role: a.role, role_card: a.role_card, step: a.step, tier: a.tier, model: a.model_requested, model_actual: a.model_actual, status: a.status === 'launched' || a.status === 'running' ? (O.isRunning(a) ? a.status : 'stale') : a.status, attempt: a.attempt, result: a.result || null, report_status: a.report_status || null, launched_at: a.launched_at, ended_at: a.ended_at || null, files: (a.files || []).slice(0, 20) }));
  const runs = E.latestRuns(t);
  const checks = Object.keys(runs).map((n) => ({ name: n, passed: runs[n].passed, exit: runs[n].exit, at: runs[n].at, label: runs[n].label || null, before_last_change: !!(t.last_change_at && Date.parse(runs[n].at) < Date.parse(t.last_change_at)) }));
  const o = t.observed || {};
  return {
    task_id: t.task_id,
    status: t.status,
    class: (t.effective && t.effective.class) || 'question',
    kind: (t.declared || {}).kind || null,
    summary: short((t.request || {}).summary, 140),
    session_id: t.session_id || null,
    opened_at: t.opened_at,
    closed_at: t.closed_at || null,
    needs_human: t.status === 'needs_human' ? { reason: short(t.needs_human_reason, 240), options: t.decision_options || ['accept', 'stop'] } : null,
    deep_pending: t.deep_pending ? { step: t.deep_pending.step } : null,
    files: { count: o.files_count || 0, added: o.lines_added || 0, deleted: o.lines_deleted || 0, list: (o.files_touched || []).slice(0, 30) },
    steps,
    agents,
    checks,
    reviews: (t.reviews || []).map((r) => ({ step: r.step, verdict: r.verdict, refs_ok: r.refs_ok, at: r.at })),
    disputes_open: (t.disputes || []).filter((d) => !d.resolved_by).length,
    cross_system: !!t.cross_system,
  };
}

function buildStatus(root) {
  const core = require('./engos-core.js');
  const D = core.defaults();
  const all = core.listTasks(root);
  const open = all.filter(core.isOpen);
  const closed = all.filter((t) => t.status === 'closed').sort((a, b) => Date.parse(b.closed_at || 0) - Date.parse(a.closed_at || 0));
  const tail = ledgerTail(root);
  const timeline = [];
  for (let i = tail.length - 1; i >= 0 && timeline.length < TIMELINE_MAX; i--) {
    const d = describe(tail[i]);
    if (d) timeline.push(Object.assign({ at: tail[i].at, type: tail[i].type, task_id: tail[i].task_id || null }, d));
  }
  const denied = tail.filter((e) => e.type === 'gate.denied');
  const sessions = {};
  try {
    for (const f of fs.readdirSync(path.join(root, '.engos', 'sessions'))) {
      if (!f.endsWith('.json') || f.includes('approvals') || f === 'warned.json' || f === 'models.json') continue;
      const s = readJson(path.join(root, '.engos', 'sessions', f), null);
      if (s && s.session_id) sessions[s.session_id] = { mode: s.mode, paused: !!s.paused, active_task: s.active_task || null };
    }
  } catch (_) { /* none yet */ }
  return {
    schema: 'engos/status@1',
    generated_at: new Date().toISOString(),
    project: path.basename(root),
    sessions,
    tasks: open.map((t) => taskView(t, D)),
    last_closed: closed[0] ? { task_id: closed[0].task_id, summary: short((closed[0].request || {}).summary, 100), closed_at: closed[0].closed_at, evidence: closed[0].close_evidence || [] } : null,
    approvals: pendingApprovals(root),
    gate: { denied_recent: denied.length, last_denied: denied.length ? { at: denied[denied.length - 1].at, rule_id: denied[denied.length - 1].rule_id, tool: denied[denied.length - 1].tool } : null },
    timeline,
  };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// Write status.json, and the data file the live view polls when the view has been opened once.
function writeStatus(root, opts) {
  const o = opts || {};
  const status = buildStatus(root);
  const json = JSON.stringify(status);
  writeAtomic(path.join(root, '.engos', 'status.json'), json);
  const viewDir = path.join(root, '.engos', 'view');
  if (o.view || fs.existsSync(viewDir)) writeAtomic(path.join(viewDir, 'status.js'), 'window.__engosStatus(' + json.replace(/</g, '\\u003c') + ');\n');
  return status;
}

// The page itself, copied from the plugin so it updates with the plugin.
function installView(root) {
  const core = require('./engos-core.js');
  const src = path.join(core.PLUGIN_ROOT, 'view', 'index.html');
  const dest = path.join(root, '.engos', 'view', 'index.html');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  writeStatus(root, { view: true });
  return dest;
}

// The status line script lives in the project so settings can point at a stable path.
function installStatusLine(root) {
  const core = require('./engos-core.js');
  const src = path.join(core.PLUGIN_ROOT, 'scripts', 'engos-statusline.js');
  const dest = path.join(root, '.engos', 'statusline.js');
  const text = fs.readFileSync(src, 'utf8');
  let cur = null;
  try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* missing */ }
  if (cur !== text) writeAtomic(dest, text);
  return dest;
}

module.exports = { buildStatus, writeStatus, installView, installStatusLine, describe, ledgerTail };
