'use strict';
// Engineering OS — visibility (build phase 6, D33).
// One picture of the project, written to .engos/status.json whenever the ledger changes.
// The status line, /engos:status and the live view (/engos:view) all read this same picture.
// It never contains command output, prompts or environment values: only task state and short labels.

const fs = require('fs');
const path = require('path');

const TIMELINE_MAX = 80;
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
    case 'step.started': return { text: (e.step || e.launch) + ' ' + (e.agent_type || 'agent') + ' started', who: e.model_requested || '', tone: 'run' };
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

function eventData(e) {
  const out = {};
  for (const k of Object.keys(e)) {
    if (k === 'at' || k === 'type' || k === 'session_id') continue;
    const v = e[k];
    out[k] = typeof v === 'string' ? short(v, 200) : Array.isArray(v) ? v.slice(0, 10) : v;
  }
  return out;
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

// A subagent's stored report, cut down for display. Reports are model text written by hooks; shown, never trusted.
function reportSummary(root, t, a) {
  if (!root) return null;
  const r = readJson(path.join(root, '.engos', 'tasks', t.task_id, (a.step || 'free') + '.report-' + a.id + '.json'), null);
  if (!r) return null;
  const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => short(typeof x === 'string' ? x : JSON.stringify(x), 200));
  return {
    status: r.status || null,
    next_action: short(r.next_action, 240),
    inputs_read: list(r.inputs_read, 12),
    outputs_changed: list(r.outputs_changed, 20),
    limitations: list(r.limitations, 6),
    assumptions: list(r.assumptions, 6),
    hypothesis: r.hypothesis ? short(r.hypothesis, 300) : null,
    verdict: r.verdict || null,
    findings: (Array.isArray(r.findings) ? r.findings : []).slice(0, 12).map((x) => ({ ref: short(x && x.ref, 80), severity: short(x && x.severity, 12), text: short(x && x.text, 240) })),
  };
}

// A check that both passed and failed on the same diff is flaky: its result doesn't depend on the code.
function flakyChecks(runs) {
  const seen = {};
  const out = [];
  for (const r of runs) {
    if (!r.diff_hash) continue;
    const k = r.name + '|' + r.diff_hash;
    seen[k] = seen[k] || new Set();
    seen[k].add(!!r.passed);
    if (seen[k].size > 1 && !out.includes(r.name)) out.push(r.name);
  }
  return out;
}

function taskView(t, D, root) {
  const O = require('./engos-orchestrate.js');
  const E = require('./engos-evidence.js');
  const steps = ((t.planned && t.planned.steps) || []).map((s) => {
    const st = (t.step_state || {})[s.id] || {};
    let status = st.status || 'pending';
    // A worker step stays running until its checks pass; between attempts it is waiting for the lead's check.
    if (status === 'running' && !(t.agents || []).some((a) => a.step === s.id && O.isRunning(a))) status = s.by === 'worker' ? 'awaiting_check' : 'done';
    return { id: s.id, kind: s.kind, by: s.by, role: s.role, tier: s.tier, status, failures: s.by === 'worker' ? O.failuresFor(t, s.id) : 0, allowed: st.allowed_attempts || ((D.rules.escalation || {}).attempts_per_step || 3) };
  });
  const agents = (t.agents || []).map((a) => ({ id: a.id, type: a.type, role: a.role, role_card: a.role_card, step: a.step, tier: a.tier, model: a.model_requested, model_actual: a.model_actual, status: a.status === 'launched' || a.status === 'running' ? (O.isRunning(a) ? a.status : 'stale') : a.status, attempt: a.attempt, result: a.result || null, report_status: a.report_status || null, launched_at: a.launched_at, ended_at: a.ended_at || null, files: (a.files || []).slice(0, 20), usage: a.usage ? { tokens: a.usage.tokens, cost_usd: a.usage.cost_usd, by_model: a.usage.by_model } : null, report_problems: (a.report_problems || []).slice(0, 4).map((p) => short(p, 200)), report: reportSummary(root, t, a) }));
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
    sensitivity: (t.declared || {}).sensitivity || [],
    scope_write: ((t.planned || {}).scope || {}).write || [],
    acceptance: ((t.planned || {}).acceptance || []).map((a) => ({ id: a.id, statement: short(a.statement, 200) })),
    lead_files: (t.lead_files || []).slice(0, 30),
    approved_files: Object.keys(t.approved_files || {}).slice(0, 30),
    history: (t.history || []).slice(-12).map((h) => ({ at: h.at, from: h.from, to: h.to, trigger: short(h.trigger, 80) })),
    disputes: (t.disputes || []).slice(-6).map((d) => ({ id: d.id, about: d.about, settler: d.settler, resolved_by: d.resolved_by || null, outcome: d.outcome || null })),
    facts: (t.facts || []).slice(-10).map((x) => ({ kind: x.kind, text: short(x.text, 200), source: x.source || null })),
    residual_risk: t.residual_risk ? short(t.residual_risk, 300) : null,
    close_evidence: t.close_evidence || [],
    check_runs: ((t.evidence && t.evidence.checks) || []).slice(-40).map((c) => ({ name: c.name, passed: c.passed, exit: c.exit, label: c.label || null, at: c.at, duration_ms: c.duration_ms || null, diff: c.diff_hash ? String(c.diff_hash).slice(-8) : null })),
    flaky_checks: flakyChecks((t.evidence && t.evidence.checks) || []),
    tier_mismatches: (t.agents || []).filter((a) => a.model_requested && a.model_actual && O.modelAlias(a.model_actual) !== a.model_requested).map((a) => a.id),
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
    if (d) timeline.push(Object.assign({ at: tail[i].at, type: tail[i].type, task_id: tail[i].task_id || null }, d, { data: eventData(tail[i]) }));
  }
  const denied = tail.filter((e) => e.type === 'gate.denied');
  const sessions = {};
  const sessionsRaw = {};
  try {
    for (const f of fs.readdirSync(path.join(root, '.engos', 'sessions'))) {
      if (!f.endsWith('.json') || f.includes('approvals') || f === 'warned.json' || f === 'models.json' || f.startsWith('usage-')) continue;
      const s = readJson(path.join(root, '.engos', 'sessions', f), null);
      if (s && s.session_id) { sessions[s.session_id] = { mode: s.mode, paused: !!s.paused, active_task: s.active_task || null }; sessionsRaw[s.session_id] = s; }
    }
  } catch (_) { /* none yet */ }
  // Lead tokens and cost per task, from each session's transcript (incremental).
  const U = require('./engos-usage.js');
  const prices = (D.policies.usage || {}).prices;
  const leadByTask = {};
  let sessionCost = 0;
  for (const sid of Object.keys(sessionsRaw)) {
    const s = sessionsRaw[sid];
    if (!s.transcript_path) continue;
    const u = U.sessionUsage(root, sid, s.transcript_path, all, prices);
    if (!u) continue;
    sessionCost += u.session.cost_usd;
    for (const [id, v] of Object.entries(u.tasks)) leadByTask[id] = v;
  }
  const withUsage = (v) => {
    const lead = leadByTask[v.task_id] || null;
    const agentsCost = v.agents.reduce((n, a) => n + ((a.usage && a.usage.cost_usd) || 0), 0);
    const agentsTokens = v.agents.reduce((n, a) => n + ((a.usage && a.usage.tokens) || 0), 0);
    v.usage = { lead: lead ? { tokens: lead.tokens, cost_usd: lead.cost_usd, by_model: lead.by_model } : null, agents_cost_usd: Math.round(agentsCost * 10000) / 10000, agents_tokens: agentsTokens, total_cost_usd: Math.round(((lead ? lead.cost_usd : 0) + agentsCost) * 10000) / 10000 };
    return v;
  };
  const sessionsList = Object.values(sessionsRaw);
  const health = {
    plugin_version: (() => { try { return require(path.join(core.PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version; } catch (_) { return null; } })(),
    claude_code_version: (sessionsList.map((s) => s.claude_code_version).filter(Boolean).pop() || null),
    modes: Array.from(new Set(sessionsList.map((s) => s.mode))),
    paused: sessionsList.some((s) => s.paused),
    warnings: Array.from(new Set([].concat(...sessionsList.map((s) => s.warnings || [])))).slice(0, 5),
    read_only_reasons: Array.from(new Set([].concat(...sessionsList.map((s) => s.reasons || [])))).slice(0, 5),
    models_unavailable: (() => { try { return require('./engos-orchestrate.js').loadUnavailable(root); } catch (_) { return []; } })(),
    session_cost_usd: Math.round(sessionCost * 10000) / 10000,
  };

  return {
    schema: 'engos/status@1',
    health,
    generated_at: new Date().toISOString(),
    project: path.basename(root),
    sessions,
    tasks: open.map((t) => withUsage(taskView(t, D, root))),
    recent: closed.slice(0, 8).map((t) => withUsage(taskView(t, D, root))),
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

// All projects on this machine that use Engineering OS (live view idea 10): a list of local paths, nothing else.
function registryFile() {
  const os = require('os');
  // Not a folder named .engos: that name marks a project (findProjectRoot).
  const base = process.env.ENGOS_HOME || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'engos') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'engos'));
  return path.join(base, 'projects.json');
}
function registerProject(root) {
  const os = require('os');
  // Throwaway folders (tests, temp checkouts) are not projects; set ENGOS_HOME to register them on purpose.
  if (!process.env.ENGOS_HOME && (path.resolve(root).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()) || /[\\/]\.tmp[\\/]/.test(root))) return;
  const file = registryFile();
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { reg = {}; }
  for (const r of Object.keys(reg)) if (!fs.existsSync(path.join(r, '.engos'))) delete reg[r]; // projects that were removed
  reg[root] = { name: path.basename(root), last_seen: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(reg, null, 2));
}
// A short summary of each registered project, read from its own status.json (read-only).
function projectsOverview() {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(registryFile(), 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const [root, meta] of Object.entries(reg)) {
    const s = readJson(path.join(root, '.engos', 'status.json'), null);
    if (!s) { out.push({ name: meta.name, root, missing: true, last_seen: meta.last_seen }); continue; }
    const waiting = (s.approvals || []).length + (s.tasks || []).filter((t) => t.needs_human || t.deep_pending).length;
    out.push({ name: s.project || meta.name, root, generated_at: s.generated_at, open: (s.tasks || []).map((t) => ({ task_id: t.task_id, class: t.class, status: t.status, summary: t.summary })), waiting, last_closed: s.last_closed || null, cost_usd: (s.health || {}).session_cost_usd || 0 });
  }
  return out.sort((a, b) => String(b.generated_at || b.last_seen).localeCompare(String(a.generated_at || a.last_seen)));
}

// Server-side helpers for the live view (only used by `engos view --serve`, never by hooks).
// The diff of one file the task changed, secrets redacted, size capped.
function taskFileDiff(root, taskId, file) {
  const core = require('./engos-core.js');
  const R = require('./engos-rules.js');
  const t = core.loadProfile(root, taskId);
  if (!t) return { error: 'no such task' };
  const files = (t.observed && t.observed.files_touched) || [];
  if (!files.includes(file)) return { error: 'that file is not one this task changed' };
  const base = core.loadBaseline(root, taskId);
  const cp = require('child_process');
  let diff = '';
  try {
    diff = cp.execFileSync('git', ['-C', root, 'diff', base.git_head || '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '--no-color', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch (_) { diff = ''; }
  if (!diff) {
    try { // untracked: show the file as added
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      diff = '--- /dev/null\n+++ b/' + file + '\n' + text.split('\n').map((l) => '+' + l).join('\n');
    } catch (_) { diff = '(no changes, or the file was deleted)'; }
  }
  const cap = 300 * 1024;
  return { file, diff: R.redact(diff.length > cap ? diff.slice(0, cap) + '\n… (cut at 300 KB)' : diff) };
}
// Every ledger event of one task, for replay (the status data only carries the latest events).
function taskEvents(root, taskId) {
  const out = [];
  try {
    for (const line of fs.readFileSync(path.join(root, '.engos', 'ledger.jsonl'), 'utf8').split('\n')) {
      if (!line.includes(taskId)) continue;
      let e; try { e = JSON.parse(line); } catch (_) { continue; }
      if (e.task_id !== taskId) continue;
      const d = describe(e);
      out.push(Object.assign({ at: e.at, type: e.type }, d || { text: e.type, who: (e.actor && e.actor.kind) || '', tone: '' }, { data: eventData(e) }));
      if (out.length >= 3000) break;
    }
  } catch (_) { /* no ledger */ }
  return out;
}

module.exports = { taskFileDiff, taskEvents, registerProject, projectsOverview, registryFile, buildStatus, writeStatus, installView, installStatusLine, describe, ledgerTail };
