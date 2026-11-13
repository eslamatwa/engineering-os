#!/usr/bin/env node
'use strict';
// Engineering OS status line (D33). Standalone: copied to .engos/statusline.js so settings can point
// at a stable path. Reads .engos/status.json (written by the hooks) and the JSON Claude Code sends on
// stdin (session id, model, workspace). Prints one line. Never fails loudly: a broken status line
// must not get in the way of the session.

const fs = require('fs');
const path = require('path');

const C = process.env.NO_COLOR ? null : { dim: '\x1b[2m', haiku: '\x1b[36m', sonnet: '\x1b[34m', opus: '\x1b[35m', fable: '\x1b[33m', warn: '\x1b[33m', ok: '\x1b[32m', bad: '\x1b[31m', reset: '\x1b[0m' };
function paint(color, text) { return C && C[color] ? C[color] + text + C.reset : text; }

function family(m) {
  const s = String(m || '').toLowerCase();
  for (const f of ['haiku', 'sonnet', 'opus', 'fable']) if (s.includes(f)) return f;
  return s || '?';
}

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    try { if (fs.statSync(path.join(dir, '.engos')).isDirectory()) return dir; } catch (_) { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function agentLabel(a, steps) {
  const step = a.step ? steps.find((s) => s.id === a.step) : null;
  const name = String(a.type || '').replace(/^engos:/, '');
  const model = family(a.model_actual || a.model);
  let mark;
  if (a.status === 'running' || a.status === 'launched') mark = '⟳';
  else if (a.status === 'failed' || a.result === 'check_failed') mark = '✗';
  else if (a.status === 'stale') mark = '?';
  else mark = '✓';
  let s = name + ' ' + paint(model, model) + (a.step ? ' ' + a.step : '') + ' ' + mark;
  if (step && step.by === 'worker' && (a.status === 'running' || a.status === 'launched' || step.failures)) s += ' ' + Math.max(a.attempt || 1, step.failures) + '/' + step.allowed;
  return s;
}

// Exported for tests and for `engos status`.
function render(status, input) {
  const sep = paint('dim', ' │ ');
  const head = paint('dim', '◆ engos');
  if (!status) return head + '  waiting for the first event';
  const sid = input && input.session_id;
  const session = sid && status.sessions ? status.sessions[sid] : null;
  const tasks = status.tasks || [];
  const t = (session && session.active_task && tasks.find((x) => x.task_id === session.active_task)) || tasks.filter((x) => x.session_id === sid).pop() || tasks[tasks.length - 1];
  const approvals = (status.approvals || []).filter((a) => !sid || !a.session_id || a.session_id === sid);
  const parts = [];
  if (session && session.mode === 'read_only') parts.push(paint('warn', 'read-only'));
  if (session && session.paused) parts.push(paint('warn', 'paused'));
  if (!t) {
    parts.unshift('idle');
    if (status.last_closed) parts.push(paint('ok', 'last: ' + status.last_closed.task_id + ' closed ✓'));
  } else {
    parts.push(t.task_id + ' ' + t.class + (t.status !== 'open' ? ' ' + paint('warn', t.status) : ''));
    const lead = input && input.model ? family(input.model.id || input.model.display_name) : null;
    if (lead) parts.push('lead ' + paint(lead, lead));
    const steps = t.steps || [];
    const latest = {};
    const free = [];
    for (const a of t.agents || []) { if (a.step) latest[a.step] = a; else if (a.status === 'running' || a.status === 'launched') free.push(a); }
    for (const s of steps) {
      if (latest[s.id]) parts.push(agentLabel(latest[s.id], steps));
      else parts.push(paint('dim', (s.by === 'lead' ? 'lead' : s.by) + ' ' + s.id + ' …'));
    }
    for (const a of free) parts.push(agentLabel(a, steps));
    const failing = (t.checks || []).filter((c) => !c.passed);
    if (failing.length) parts.push(paint('bad', '✗ ' + failing.map((c) => c.name).join(',')));
    if (t.needs_human) parts.push(paint('warn', '⚠ needs you: /engos:decide ' + t.task_id));
    else if (t.deep_pending) parts.push(paint('fable', '⚠ Fable? /engos:decide ' + t.task_id + ' fable|no_fable'));
  }
  if (approvals.length) parts.push(paint('warn', '⚠ ' + approvals.length + ' approval' + (approvals.length > 1 ? 's' : '')));
  if (!t) parts.push(paint('dim', '/engos:view'));
  return head + '  ' + parts.join(sep);
}

function main() {
  let input = {};
  try { const raw = fs.readFileSync(0, 'utf8'); input = raw ? JSON.parse(raw) : {}; } catch (_) { input = {}; }
  const start = (input.workspace && (input.workspace.project_dir || input.workspace.current_dir)) || input.cwd || process.cwd();
  const root = findRoot(start) || findRoot(__dirname);
  if (!root) return;
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(root, '.engos', 'status.json'), 'utf8')); } catch (_) { /* not written yet */ }
  process.stdout.write(render(status, input) + '\n');
}

if (require.main === module) {
  try { main(); } catch (_) { process.stdout.write('◆ engos\n'); }
}

module.exports = { render, family };
