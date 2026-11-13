#!/usr/bin/env node
'use strict';
// Engineering OS hook entry. Usage: node engos-hook.js <session-start|pre-tool-use|post-tool-use>
// Phase 1: session self-check (H1). Phase 2: write gate (H3), Bash gate (H4), observer (H7/H9).
// Exit codes for gates: 0 = allow; 2 = block (stderr is the reason Claude sees).

// D44: reuse compiled code between runs (Node 22.1+); harmless no-op on older Node.
try { require('node:module').enableCompileCache(); } catch (_) { /* not available */ }

const fs = require('fs');
const path = require('path');

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PHASE3 = 'Approvals arrive in build phase 3; until then this is blocked.';

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function projectStart(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

function block(reason) {
  process.stderr.write('Engineering OS: ' + reason);
  process.exit(2);
}

function sessionIdOf(input) {
  return input.session_id || process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
}

// ---------------------------------------------------------------------------
// H1 · SessionStart. Never blocks (D42); a failure becomes read-only mode.
// ---------------------------------------------------------------------------
function sessionStart(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;

  const sessionId = sessionIdOf(input);
  const check = core.selfCheck(root);
  const prev = core.loadSession(root, sessionId);
  const session = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    source: input.source || 'startup',
    mode: check.mode,
    reasons: check.hard,
    warnings: check.warn,
    claude_code_version: check.claude_code_version,
    active_task: prev && prev.active_task ? prev.active_task : null,
  };
  core.saveSession(root, sessionId, session);
  core.ledger(root, { type: 'session.started', actor: { kind: 'hook' }, session_id: sessionId, source: session.source, mode: session.mode, claude_code_version: session.claude_code_version });

  const lines = [];
  lines.push('Engineering OS is active in this project (.engos/).');
  lines.push('Session mode: ' + session.mode + '.');
  if (check.hard.length) lines.push('Read-only because: ' + check.hard.join(' '));
  if (check.warn.length) lines.push('Warnings: ' + check.warn.join(' '));
  lines.push('How it works: small edits open a trivial task automatically. Bigger or sensitive work needs `engos profile set` and `engos plan set` (run with the Bash tool) before edits continue. Protected paths, risky commands and anything leaving the machine are gated. Every refusal says what is needed.');

  const brief = briefExcerpt(core, root);
  if (brief) lines.push('Project brief (excerpt):\n' + brief);

  const open = core.listTasks(root).filter(core.isOpen);
  if (open.length) lines.push('Open tasks: ' + open.map((t) => t.task_id + ' [' + t.status + ', ' + t.effective.class + ']: ' + (t.request.summary || '')).join('; '));

  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n').slice(0, 9500) } };
  if (check.hard.length) out.systemMessage = 'Engineering OS: this session is read-only. ' + check.hard.join(' ');
  else if (check.warn.length) out.systemMessage = 'Engineering OS: ' + check.warn.join(' ');
  process.stdout.write(JSON.stringify(out));
}

function briefExcerpt(core, root) {
  try {
    const text = fs.readFileSync(core.engosPath(root, 'BRIEF.md'), 'utf8').trim();
    return text.length > 3000 ? text.slice(0, 3000) + '\n…' : text;
  } catch (_) {
    return '';
  }
}

// Session state, running the self-check if session start didn't run for this session.
function ensureSession(core, root, sessionId) {
  let session = core.loadSession(root, sessionId);
  if (!session) {
    const check = core.selfCheck(root);
    session = { session_id: sessionId, started_at: new Date().toISOString(), source: 'lazy_check', mode: check.mode, reasons: check.hard, warnings: check.warn, claude_code_version: check.claude_code_version, active_task: null };
    core.saveSession(root, sessionId, session);
    core.ledger(root, { type: 'session.started', actor: { kind: 'hook' }, session_id: sessionId, source: 'lazy_check', mode: session.mode });
  }
  return session;
}

// Project config (protected paths, known commands), cached in the session by file mtime.
function projectRules(core, root, session) {
  const file = core.engosPath(root, 'config.yaml');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (_) { /* missing */ }
  if (session.config_cache && session.config_cache.mtime === mtime) return session.config_cache;
  const cfg = core.loadProjectConfig(root);
  const config = cfg.ok ? cfg.config : {};
  session.config_cache = { mtime, protected: core.protectedFor(config), known: config.known_commands || [] };
  core.saveSession(root, session.session_id, session);
  return session.config_cache;
}

function relPath(root, file) {
  if (!file) return null;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside the repo
  return rel.replace(/\\/g, '/');
}

function deny(core, root, sessionId, task, ruleId, tool, reason) {
  core.ledger(root, { type: 'gate.denied', actor: { kind: 'hook' }, session_id: sessionId, task_id: task ? task.task_id : null, tool, rule_id: ruleId });
  block(reason);
}

function needsText(task, missing) {
  return 'Task ' + task.task_id + ' is ' + task.effective.class + '. Before edits continue, add: ' + missing.join('; ') + '. Run these with the Bash tool.';
}

// ---------------------------------------------------------------------------
// H3 · PreToolUse on file writes
// ---------------------------------------------------------------------------
function gateWrite(core, root, session, input, cfg) {
  const R = require('./engos-rules.js');
  const sessionId = session.session_id;
  const ti = input.tool_input || {};
  const rel = relPath(root, ti.file_path || ti.notebook_path);
  if (!rel) return; // outside the repo: not observed in v0.1 (D7)

  const level = R.protectedLevel(rel, cfg.protected);
  if (level === 'never') deny(core, root, sessionId, null, 'G-never', input.tool_name, rel + ' is an Engineering OS record or Claude Code setting and can never be edited directly.');
  if (session.mode === 'read_only') deny(core, root, sessionId, null, 'G-read-only-session', input.tool_name, 'this session is read-only, so edits are blocked. ' + (session.reasons || []).join(' '));

  let task = core.activeTask(root, sessionId);
  if (!task) {
    if (level === 'high_risk' || level === 'standard') {
      task = core.openTask(root, sessionId, { cls: level, state: 'upgrade_pending', openedBy: 'auto', trigger: 'F-protected:' + rel, sources: ['F-protected'], summary: 'Edit to ' + rel });
      const why = level === 'high_risk' ? rel + ' is a protected path, so this is a high_risk task.' : rel + ' is a sensitive project file, so this is a standard task.';
      deny(core, root, sessionId, task, 'F-protected', input.tool_name, why + ' ' + needsText(task, R.missingRequirements(task)) + (level === 'high_risk' ? ' Editing protected files also needs your scope approval. ' + PHASE3 : ''));
    }
    task = core.openTask(root, sessionId, { cls: 'trivial_edit', openedBy: 'auto', trigger: 'first_edit', summary: 'Edit to ' + rel });
    core.saveProfile(root, task);
    return; // first small edit: allowed
  }

  if (task.status === 'needs_human') deny(core, root, sessionId, task, 'G-needs-human', input.tool_name, 'Task ' + task.task_id + ' is waiting for a human decision: ' + (task.needs_human_reason || '') + ' Edits are blocked until then.');

  // Prospective observation for the trivial budget: this file and whether it is new.
  const prospective = JSON.parse(JSON.stringify(task));
  const o = prospective.observed;
  if (!o.files_touched.includes(rel)) {
    o.files_touched.push(rel);
    o.files_count = o.files_touched.length;
    if (!fs.existsSync(path.join(root, rel))) o.files_created = (o.files_created || 0) + 1;
  }
  if (level) o.protected_hits = (o.protected_hits || []).concat([{ path: rel, level, via: 'planned_write' }]);

  const r = core.ratchet(root, prospective, 'write:' + rel, cfg.protected);
  if (r.raised) {
    task.effective = prospective.effective;
    task.history = prospective.history;
    task.status = r.missing.length ? 'upgrade_pending' : task.status;
    core.saveProfile(root, task);
    if (r.missing.length) deny(core, root, sessionId, task, 'class.raised', input.tool_name, 'This edit to ' + rel + ' raises the task from ' + r.from + ' to ' + r.to + '. ' + needsText(task, r.missing));
  }
  const missing = R.missingRequirements(task);
  if (missing.length) {
    if (task.status !== 'upgrade_pending') { task.status = 'upgrade_pending'; core.saveProfile(root, task); }
    deny(core, root, sessionId, task, 'G-requirements', input.tool_name, needsText(task, missing));
  }
  const cls = task.effective.class;
  if (cls === 'standard' || cls === 'high_risk') {
    const scope = (task.planned.scope && task.planned.scope.write) || [];
    if (!R.matchAny(rel, scope)) deny(core, root, sessionId, task, 'G-scope', input.tool_name, rel + ' is outside the plan\'s write scope (' + scope.join(', ') + '). Widen it with `engos scope amend --add "<glob>" --reason "..."` (at most twice per task, never to a protected path), or stay inside the scope.');
  }
  if (level === 'high_risk') deny(core, root, sessionId, task, 'G-protected', input.tool_name, rel + ' is a protected path. Editing it needs your scope approval for task ' + task.task_id + '. ' + PHASE3);
}

// ---------------------------------------------------------------------------
// H4 · PreToolUse on Bash
// ---------------------------------------------------------------------------
const DECISION_RANK = { allow: 0, allow_record: 0, allow_observe: 1, raise_to_standard: 2, approval: 3, deny: 4 };

function gateBash(core, root, session, input, cfg) {
  const R = require('./engos-rules.js');
  const D = core.defaults().rules;
  const sessionId = session.session_id;
  const cmd = (input.tool_input && input.tool_input.command) || '';
  const res = R.classifyCommand(cmd, D.bash_classes, cfg.protected.never);
  const harmless = (c) => c === 'read' || c === 'check' || c === 'engos';

  if (res.cls === 'self_protect') {
    deny(core, root, sessionId, null, 'G-self', 'Bash', 'this command runs `claude` or changes Engineering OS records or Claude Code settings, which is never allowed from Bash (D34).');
  }
  if (session.mode === 'read_only' && !res.parts.every((p) => harmless(p.cls))) {
    deny(core, root, sessionId, null, 'G-read-only-session', 'Bash', 'this session is read-only, so only read commands can run. ' + (session.reasons || []).join(' '));
  }

  let task = core.activeTask(root, sessionId);
  const taskCls = task ? task.effective.class : 'question';
  let worst = 'allow';
  let worstPart = null;
  for (const p of res.parts) {
    let d = R.bashDecision(p.cls, taskCls, D.bash_policy);
    if (p.cls === 'unknown' && d === 'approval' && R.isKnownCommand(p.part, cfg.known)) d = 'allow_observe'; // D38
    if (DECISION_RANK[d] > DECISION_RANK[worst]) { worst = d; worstPart = p; }
  }

  if (worst === 'deny') deny(core, root, sessionId, task, 'G-bash-deny', 'Bash', 'this command is not allowed: ' + (worstPart ? worstPart.part : cmd));
  if (worst === 'approval') {
    core.ledger(root, { type: 'approval.needed', actor: { kind: 'hook' }, session_id: sessionId, task_id: task ? task.task_id : null, command_class: worstPart.cls });
    deny(core, root, sessionId, task, 'G-approval:' + worstPart.cls, 'Bash', '`' + worstPart.part + '` is a ' + worstPart.cls.replace('_', ' ') + ' command' + (worstPart.cls === 'unknown' ? ' in a high_risk task' : '') + ' and needs your approval. ' + PHASE3 + (worstPart.cls === 'unknown' ? ' If it is a command this project runs routinely, the user can add it to known_commands in .engos/config.yaml.' : ''));
  }
  if (res.parts.every((p) => harmless(p.cls))) return; // reads, checks and engos don't open tasks

  if (task && (task.status === 'upgrade_pending' || task.status === 'needs_human')) {
    deny(core, root, sessionId, task, 'G-requirements', 'Bash', task.status === 'needs_human' ? 'Task ' + task.task_id + ' is waiting for a human decision. Only read commands can run.' : needsText(task, R.missingRequirements(task)));
  }

  if (worst === 'raise_to_standard') {
    if (!task) task = core.openTask(root, sessionId, { cls: 'standard', state: 'upgrade_pending', openedBy: 'auto', trigger: 'pkg_install', sources: ['F-pkg-install'], summary: 'Install packages' });
    else {
      task.observed.pkg_install = true;
      core.ratchet(root, task, 'bash:pkg_install', cfg.protected);
      core.saveProfile(root, task);
    }
    deny(core, root, sessionId, task, 'F-pkg-install', 'Bash', 'Installing packages makes this a standard task. ' + needsText(task, R.missingRequirements(task)));
  }

  if (!task) core.openTask(root, sessionId, { cls: 'trivial_edit', openedBy: 'auto', trigger: 'first_command', summary: 'Command: ' + cmd.slice(0, 80) });
}

// ---------------------------------------------------------------------------
// H7 / H9 · PostToolUse: observe what changed; raise the class; flag violations.
// ---------------------------------------------------------------------------
function postToolUse(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const sessionId = sessionIdOf(input);
  const session = core.loadSession(root, sessionId);
  if (!session) return;
  const task = core.activeTask(root, sessionId);
  if (!task) return;

  const R = require('./engos-rules.js');
  const observeLib = require('./engos-observe.js');
  const cfg = projectRules(core, root, session);
  const isBash = input.tool_name === 'Bash';
  let pkg = false;
  if (isBash) {
    const res = R.classifyCommand((input.tool_input && input.tool_input.command) || '', core.defaults().rules.bash_classes, cfg.protected.never);
    if (res.parts.every((p) => p.cls === 'read' || p.cls === 'check' || p.cls === 'engos')) return;
    pkg = res.parts.some((p) => p.cls === 'pkg_install');
  }

  const base = core.loadBaseline(root, task.task_id);
  const before = new Set(((task.observed && task.observed.protected_hits) || []).map((h) => h.path));
  const obs = observeLib.observe(root, base, cfg.protected, { withSnapshot: isBash });
  task.observed = Object.assign(task.observed || {}, obs, { pkg_install: (task.observed && task.observed.pkg_install) || pkg });

  const messages = [];
  // Violations: protected changes no gate saw coming. File writes to protected paths were already
  // checked before they ran, so only commands can cause them. Never-paths count from any source.
  const violations = obs.protected_hits.filter((h) => !before.has(h.path) && (h.level === 'never' || (h.level === 'high_risk' && isBash)));
  if (violations.length && task.status !== 'needs_human') {
    task.status = 'needs_human';
    task.needs_human_reason = 'a command changed protected files without approval: ' + violations.map((v) => v.path).join(', ');
    core.ledger(root, { type: 'violation.detected', actor: { kind: 'hook' }, task_id: task.task_id, paths: violations.map((v) => v.path), via: violations.map((v) => v.via) });
    messages.push('Engineering OS detected that this command changed protected files: ' + violations.map((v) => v.path + ' (' + v.level + ')').join(', ') + '. Task ' + task.task_id + ' now needs a human decision; stop and tell the user what changed.');
  }

  const r = core.ratchet(root, task, (isBash ? 'bash' : 'write') + ':observed', cfg.protected);
  if (r.raised && task.status !== 'needs_human') {
    messages.push('Engineering OS: task ' + task.task_id + ' is now ' + r.to + ' (was ' + r.from + ').' + (r.missing.length ? ' ' + needsText(task, r.missing) : ''));
  }
  core.saveProfile(root, task);

  if (messages.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: messages.join(' ') }));
}

// ---------------------------------------------------------------------------
function preToolUse(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const session = ensureSession(core, root, sessionIdOf(input));
  const cfg = projectRules(core, root, session);
  if (WRITE_TOOLS.has(input.tool_name)) return gateWrite(core, root, session, input, cfg);
  if (input.tool_name === 'Bash') return gateBash(core, root, session, input, cfg);
  // Agent / Task: gated in build phase 5.
}

function main() {
  const mode = process.argv[2];
  const input = readInput();
  let core;
  try {
    core = require('./engos-core.js');
  } catch (e) {
    if (mode === 'pre-tool-use') block('the plugin files are damaged (' + e.message + '). Reinstall Engineering OS.');
    return;
  }

  try {
    if (process.env.ENGOS_TEST_THROW === mode) throw new Error('test-induced failure');
    if (mode === 'session-start') return sessionStart(core, input);
    if (mode === 'pre-tool-use') return preToolUse(core, input);
    if (mode === 'post-tool-use') return postToolUse(core, input);
  } catch (e) {
    if (mode === 'pre-tool-use') block('internal gate error, so the call is blocked to stay safe: ' + e.message);
    if (mode === 'post-tool-use') {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Engineering OS could not check what this call changed (' + e.message + '). Tell the user.' }));
      return;
    }
    process.stdout.write(JSON.stringify({ systemMessage: 'Engineering OS: session check failed (' + e.message + '). Edits will be checked again on the first change.' }));
  }
}

main();
