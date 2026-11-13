#!/usr/bin/env node
'use strict';
// Engineering OS hook entry.
// Usage: node engos-hook.js <session-start|pre-tool-use|post-tool-use|post-tool-use-failure|subagent-start|subagent-stop|prompt-expansion>
// Phase 1: session self-check (H1). Phase 2: write gate (H3), Bash gate (H4), observer (H7/H9).
// Phase 3: approvals through Claude Code's own prompt (D46) and typed human commands (H2).
// Phase 5: Agent gate (H5), role cards (H10), report checks (H11), escalation and the Fable ask.
// Gate exit codes: 0 = allow (or `ask` JSON on stdout); 2 = block (stderr is the reason Claude sees).

// D44: reuse compiled code between runs (Node 22.1+); harmless no-op on older Node.
try { require('node:module').enableCompileCache(); } catch (_) { /* not available */ }

const fs = require('fs');
const path = require('path');

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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

// Show Claude Code's own Allow/Deny prompt (D46). The prompt shows the real action; the reason is for Claude.
function ask(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Engineering OS: ' + reason } }));
  process.exit(0);
}

function sessionIdOf(input) {
  return input.session_id || process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
}

// ---------------------------------------------------------------------------
// H1 · SessionStart. Never blocks (D42); a failure becomes read-only mode. Pause resets (D29).
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
    paused: false,
  };
  core.saveSession(root, sessionId, session);
  core.ledger(root, { type: 'session.started', actor: { kind: 'hook' }, session_id: sessionId, source: session.source, mode: session.mode, claude_code_version: session.claude_code_version });
  try { require('./engos-approvals.js').expireStale(root); } catch (_) { /* best effort */ }
  try { require('./engos-status.js').installStatusLine(root); } catch (_) { /* best effort */ }

  const lines = [];
  lines.push('Engineering OS is active in this project (.engos/).');
  lines.push('Session mode: ' + session.mode + '.');
  if (check.hard.length) lines.push('Read-only because: ' + check.hard.join(' '));
  if (check.warn.length) lines.push('Warnings: ' + check.warn.join(' '));
  lines.push('How it works: small edits open a trivial task automatically. Bigger or sensitive work needs `engos profile set` and `engos plan set` (run with the Bash tool) before edits continue. Protected files, push, network and destructive commands ask the user through Claude Code\'s own prompt. Every refusal says what is needed. Never try to work around a refusal.');
  lines.push('Agents: during a task, plan steps with `engos plan set --steps "S1:locate,S2:implement,S3:verify"` (or `engos step add`), then for each step run `engos step brief S2` and call the Agent tool with the subagent_type and model it prints and the brief as the prompt. Only engos:scout, engos:worker, engos:validator, Explore and Plan run during a task; one worker at a time. If a step is routed to Fable, ask the user first as the refusal explains.');

  const brief = briefExcerpt(core, root);
  if (brief) lines.push('Project brief (excerpt):\n' + brief);

  const open = core.listTasks(root).filter(core.isOpen);
  if (open.length) lines.push('Open tasks: ' + open.map((t) => t.task_id + ' [' + t.status + ', ' + t.effective.class + ']: ' + (t.request.summary || '')).join('; '));

  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n').slice(0, 9500) } };
  if (check.hard.length) out.systemMessage = 'Engineering OS: this session is read-only. ' + check.hard.join(' ');
  else if (check.warn.length && shouldWarn(core, root, check.warn)) out.systemMessage = 'Engineering OS: ' + check.warn.join(' ');
  process.stdout.write(JSON.stringify(out));
}

// Show the same warning to the user at most once a week; Claude still gets it in the session context.
function shouldWarn(core, root, warnings) {
  const file = core.engosPath(root, 'sessions', 'warned.json');
  const key = warnings.join('|');
  const seen = core.readJson(file, {});
  const last = seen[key] ? Date.parse(seen[key]) : 0;
  if (Date.now() - last < 7 * 24 * 60 * 60 * 1000) return false;
  seen[key] = new Date().toISOString();
  core.writeJson(file, seen);
  return true;
}

function briefExcerpt(core, root) {
  try {
    const text = fs.readFileSync(core.engosPath(root, 'BRIEF.md'), 'utf8').trim();
    return text.length > 3000 ? text.slice(0, 3000) + '\n…' : text;
  } catch (_) {
    return '';
  }
}

function ensureSession(core, root, sessionId) {
  let session = core.loadSession(root, sessionId);
  if (!session) {
    const check = core.selfCheck(root);
    session = { session_id: sessionId, started_at: new Date().toISOString(), source: 'lazy_check', mode: check.mode, reasons: check.hard, warnings: check.warn, claude_code_version: check.claude_code_version, active_task: null, paused: false };
    core.saveSession(root, sessionId, session);
    core.ledger(root, { type: 'session.started', actor: { kind: 'hook' }, session_id: sessionId, source: 'lazy_check', mode: session.mode });
  }
  return session;
}

function projectRules(core, root, session) {
  const file = core.engosPath(root, 'config.yaml');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (_) { /* missing */ }
  if (session.config_cache && session.config_cache.mtime === mtime && session.config_cache.models) return session.config_cache;
  const cfg = core.loadProjectConfig(root);
  const config = cfg.ok ? cfg.config : {};
  session.config_cache = { mtime, protected: core.protectedFor(config), known: config.known_commands || [], models: { available: (config.models && config.models.available) || [] } };
  core.saveSession(root, session.session_id, session);
  return session.config_cache;
}

function relPath(root, file) {
  if (!file) return null;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function deny(core, root, sessionId, task, ruleId, tool, reason) {
  core.ledger(root, { type: 'gate.denied', actor: { kind: 'hook' }, session_id: sessionId, task_id: task ? task.task_id : null, tool, rule_id: ruleId });
  block(reason);
}

// What's missing, with commands ready to run (so Claude doesn't have to look them up).
function needsText(task, missing, rel) {
  const lines = [];
  const needProfile = missing.some((m) => m.startsWith('profile'));
  const needPlan = missing.some((m) => m.startsWith('plan'));
  const scope = rel ? (path.posix.dirname(rel) === '.' ? rel : path.posix.dirname(rel) + '/**') : '<folder>/**';
  if (needProfile) lines.push('engos profile set --kind <bugfix|feature|refactor|docs|tests|debugging|migration|security_review|architecture|analysis>');
  if (needPlan) lines.push('engos plan set --scope-write "' + scope + '"   (comma-separate several globs; list every path you will change)');
  return 'Task ' + task.task_id + ' is ' + task.effective.class + '. Before edits continue, run with the Bash tool: ' + lines.join('  then  ') + '. Add --sensitivity auth (or payments, secrets, data_migration, deployment) to the profile if the request touches those.';
}

// Ask the person to approve editing one protected file (D46). Approval is recorded in PostToolUse.
function askFile(core, root, sessionId, task, rel) {
  const A = require('./engos-approvals.js');
  const rec = A.request(root, { kind: 'file', tool: 'file', action: rel, session_id: sessionId, task_id: task ? task.task_id : null, context: { task_summary: task ? task.request.summary : 'paused session' } });
  core.ledger(root, { type: 'approval.requested', actor: { kind: 'hook' }, approval_id: rec.approval_id, kind: 'file', path: rel, task_id: task ? task.task_id : null, session_id: sessionId });
  ask(rel + ' is a protected file. The user is being asked to allow editing it' + (task ? ' for task ' + task.task_id : '') + ' (' + rec.approval_id + '). If they allow it, the file stays approved for this task.');
}

// ---------------------------------------------------------------------------
// H3 · PreToolUse on file writes
// ---------------------------------------------------------------------------
function gateWrite(core, root, session, input, cfg) {
  const R = require('./engos-rules.js');
  const A = require('./engos-approvals.js');
  const sessionId = session.session_id;
  const ti = input.tool_input || {};
  const rel = relPath(root, ti.file_path || ti.notebook_path);
  if (!rel) return; // outside the repo: not observed in v0.1 (D7)

  const level = R.protectedLevel(rel, cfg.protected);
  if (level === 'never') deny(core, root, sessionId, null, 'G-never', input.tool_name, rel + ' is an Engineering OS record or Claude Code setting and can never be edited directly.');
  if (session.mode === 'read_only') deny(core, root, sessionId, null, 'G-read-only-session', input.tool_name, 'this session is read-only, so edits are blocked. ' + (session.reasons || []).join(' '));

  if (session.paused) { // D29: ceremony off, hard gates on
    if (level === 'high_risk' && !((session.approved_files || {})[rel])) askFile(core, root, sessionId, null, rel);
    return;
  }

  const O = require('./engos-orchestrate.js');
  const subRole = O.roleOfType(input.agent_type);
  if (input.agent_id && (subRole === 'scout' || subRole === 'validator')) deny(core, root, sessionId, null, 'G-agent-readonly', input.tool_name, input.agent_type + ' never edits files. Report what should change instead.');

  let task = core.activeTask(root, sessionId);
  if (task && O.readOnlyTask(task, core.defaults())) deny(core, root, sessionId, task, 'G-read-only-task', input.tool_name, task.task_id + ' is a ' + task.declared.kind + ' task, which is read-only: report findings and propose fixes as a new task instead of editing.');
  if (!task) {
    if (level === 'high_risk' || level === 'standard') {
      task = core.openTask(root, sessionId, { cls: level, state: 'upgrade_pending', openedBy: 'auto', trigger: 'F-protected:' + rel, sources: ['F-protected'], summary: 'Edit to ' + rel });
      const why = level === 'high_risk' ? rel + ' is a protected path, so this is a high_risk task.' : rel + ' is a sensitive project file, so this is a standard task.';
      deny(core, root, sessionId, task, 'F-protected', input.tool_name, why + ' ' + needsText(task, R.missingRequirements(task), rel) + (level === 'high_risk' ? ' Then the user will be asked to allow editing the protected file.' : ''));
    }
    task = core.openTask(root, sessionId, { cls: 'trivial_edit', openedBy: 'auto', trigger: 'first_edit', summary: 'Edit to ' + rel });
    return;
  }

  if (task.status === 'needs_human') deny(core, root, sessionId, task, 'G-needs-human', input.tool_name, 'Task ' + task.task_id + ' is waiting for the user\'s decision: ' + (task.needs_human_reason || '') + ' Ask the user to type /engos:decide ' + task.task_id + ' accept or /engos:decide ' + task.task_id + ' stop.');

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
    if (r.from === 'trivial_edit' && !task.pre_upgrade_files) task.pre_upgrade_files = (task.observed.files_touched || []).slice(); // D10
    task.effective = prospective.effective;
    task.history = prospective.history;
    task.status = r.missing.length ? 'upgrade_pending' : task.status;
    core.saveProfile(root, task);
    if (r.missing.length) deny(core, root, sessionId, task, 'class.raised', input.tool_name, 'This edit to ' + rel + ' raises the task from ' + r.from + ' to ' + r.to + '. ' + needsText(task, r.missing, rel));
  }
  const missing = R.missingRequirements(task);
  if (missing.length) {
    if (task.status !== 'upgrade_pending') { task.status = 'upgrade_pending'; core.saveProfile(root, task); }
    deny(core, root, sessionId, task, 'G-requirements', input.tool_name, needsText(task, missing, rel));
  }
  const cls = task.effective.class;
  if (cls === 'standard' || cls === 'high_risk') {
    const scope = (task.planned.scope && task.planned.scope.write) || [];
    if (!R.matchAny(rel, scope)) deny(core, root, sessionId, task, 'G-scope', input.tool_name, rel + ' is outside the plan\'s write scope (' + scope.join(', ') + '). Widen it with `engos scope amend --add "<glob>" --reason "..."` (at most twice per task, never to a protected path), or stay inside the scope.');
    // D47: once the plan gives implementation to workers, the lead's own edits are small integration fixes only.
    const workerSteps = ((task.planned && task.planned.steps) || []).filter((x) => x.by === 'worker');
    if (!input.agent_id && workerSteps.length) {
      const budget = (core.defaults().rules.budgets || {}).lead_integration_edit || { max_files: 2 };
      const mine = task.lead_files || [];
      if (!mine.includes(rel) && mine.length >= budget.max_files) deny(core, root, sessionId, task, 'G-lead-budget', input.tool_name, 'the plan gives implementation to workers (' + workerSteps.map((x) => x.id).join(', ') + '), and the lead already edited ' + mine.length + ' files itself (' + mine.join(', ') + '; limit ' + budget.max_files + '). Run `engos step brief ' + workerSteps[0].id + '` and start the worker.');
    }
  }
  if (level === 'high_risk' && !A.fileApproved(task, rel)) askFile(core, root, sessionId, task, rel);
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

  const O = require('./engos-orchestrate.js');
  const subRole = input.agent_id ? O.roleOfType(input.agent_type) : null;
  if (subRole === 'scout' && !res.parts.every((p) => p.cls === 'read')) deny(core, root, sessionId, null, 'G-agent-readonly', 'Bash', 'engos:scout can only run read commands.');
  if (subRole === 'validator' && !res.parts.every((p) => p.cls === 'read' || p.cls === 'check')) deny(core, root, sessionId, null, 'G-agent-readonly', 'Bash', 'engos:validator can only run read commands and `engos check <name>`.');

  let task = session.paused ? null : core.activeTask(root, sessionId);
  if (task && O.readOnlyTask(task, core.defaults()) && !res.parts.every((p) => harmless(p.cls))) deny(core, root, sessionId, task, 'G-read-only-task', 'Bash', task.task_id + ' is a ' + task.declared.kind + ' task, which is read-only: only read commands and checks run. Suggest other commands to the user instead.');
  const taskCls = task ? task.effective.class : 'question';
  let worst = 'allow';
  let worstPart = null;
  for (const p of res.parts) {
    let d = R.bashDecision(p.cls, taskCls, D.bash_policy);
    if (p.cls === 'unknown' && d === 'approval' && R.isKnownCommand(p.part, cfg.known)) d = 'allow_observe'; // D38
    if (session.paused && d === 'raise_to_standard') d = 'allow_observe';
    if (DECISION_RANK[d] > DECISION_RANK[worst]) { worst = d; worstPart = p; }
  }

  if (worst === 'deny') deny(core, root, sessionId, task, 'G-bash-deny', 'Bash', 'this command is not allowed: ' + (worstPart ? worstPart.part : cmd));

  if (!session.paused && task && (task.status === 'upgrade_pending' || task.status === 'needs_human') && !res.parts.every((p) => harmless(p.cls))) {
    deny(core, root, sessionId, task, 'G-requirements', 'Bash', task.status === 'needs_human' ? 'Task ' + task.task_id + ' is waiting for the user\'s decision (/engos:decide ' + task.task_id + ' accept|stop). Only read commands can run.' : needsText(task, R.missingRequirements(task)));
  }

  if (worst === 'approval') {
    if (!session.paused && !task) task = core.openTask(root, sessionId, { cls: 'trivial_edit', openedBy: 'auto', trigger: 'first_command', summary: 'Command: ' + cmd.slice(0, 80) });
    const A = require('./engos-approvals.js');
    const rec = A.request(root, { kind: 'action', tool: 'Bash', action: cmd, cls: worstPart.cls, session_id: sessionId, task_id: task ? task.task_id : null, context: A.contextFor(root, 'action', worstPart.cls, cmd) });
    core.ledger(root, { type: 'approval.requested', actor: { kind: 'hook' }, approval_id: rec.approval_id, kind: 'action', command_class: worstPart.cls, task_id: task ? task.task_id : null, session_id: sessionId });
    ask('`' + worstPart.part + '` is a ' + worstPart.cls.replace('_', ' ') + ' command' + (worstPart.cls === 'unknown' ? ' in a high_risk task' : '') + '. The user is being asked to allow it (' + rec.approval_id + '). If they say no, don\'t retry it unchanged; ask them what they want instead.');
  }
  if (res.parts.every((p) => harmless(p.cls))) return;
  if (session.paused) return;

  if (worst === 'raise_to_standard') {
    if (!task) task = core.openTask(root, sessionId, { cls: 'standard', state: 'upgrade_pending', openedBy: 'auto', trigger: 'pkg_install', sources: ['F-pkg-install'], summary: 'Install packages' });
    else {
      task.observed.pkg_install = true;
      core.ratchet(root, task, 'bash:pkg_install', cfg.protected);
      core.saveProfile(root, task);
    }
    if (R.missingRequirements(task).length) deny(core, root, sessionId, task, 'F-pkg-install', 'Bash', 'Installing packages makes this a standard task. ' + needsText(task, R.missingRequirements(task)));
    return;
  }

  if (!task) {
    const t = core.openTask(root, sessionId, { cls: 'trivial_edit', openedBy: 'auto', trigger: 'first_command', summary: 'Command: ' + cmd.slice(0, 200) });
    core.ledger(root, { type: 'task.opened_by_command', actor: { kind: 'hook' }, task_id: t.task_id, command: cmd.slice(0, 500), parts: res.parts.map((p) => p.cls) });
  }
}

// ---------------------------------------------------------------------------
// H7 / H9 · PostToolUse: record approvals that were granted, observe what changed.
// ---------------------------------------------------------------------------
function postToolUse(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const sessionId = sessionIdOf(input);
  const session = core.loadSession(root, sessionId);
  if (!session) return;

  const R = require('./engos-rules.js');
  const A = require('./engos-approvals.js');
  const cfg = projectRules(core, root, session);
  const isBash = input.tool_name === 'Bash';
  const task = session.paused ? null : core.activeTask(root, sessionId);
  const ti = input.tool_input || {};

  // 1. Approvals: the tool ran, so the person allowed it (D46).
  let grantedThisCall = null;
  if (isBash) {
    grantedThisCall = A.grantIfPending(root, { kind: 'action', tool: 'Bash', action: ti.command || '', session_id: sessionId, task_id: task ? task.task_id : null });
  } else {
    const rel = relPath(root, ti.file_path || ti.notebook_path);
    if (rel) {
      grantedThisCall = A.grantIfPending(root, { kind: 'file', tool: 'file', action: rel, session_id: sessionId, task_id: task ? task.task_id : null });
      if (grantedThisCall) {
        if (task) {
          task.approved_files = task.approved_files || {};
          task.approved_files[rel] = { approval_id: grantedThisCall.approval_id, approved_at: grantedThisCall.decided_at };
          core.saveProfile(root, task);
        } else {
          session.approved_files = session.approved_files || {};
          session.approved_files[rel] = { approval_id: grantedThisCall.approval_id, approved_at: grantedThisCall.decided_at };
          core.saveSession(root, sessionId, session);
        }
      }
    }
  }
  if (grantedThisCall && isBash) {
    const after = A.afterContext(root, grantedThisCall.command_class);
    if (after) A.annotate(root, grantedThisCall.approval_id, { context_after: after });
  }
  if (grantedThisCall) core.ledger(root, { type: 'approval.granted', actor: { kind: 'hook' }, approval_id: grantedThisCall.approval_id, kind: grantedThisCall.kind, method: 'native_prompt', decided_by: 'human', task_id: grantedThisCall.task_id, session_id: sessionId });

  if (!task) return;
  if (input.tool_name === 'Agent' || input.tool_name === 'Task') return agentPost(core, root, task, input);

  // 2. Observe.
  let pkg = false;
  if (isBash) {
    const res = R.classifyCommand(ti.command || '', core.defaults().rules.bash_classes, cfg.protected.never);
    if (res.parts.every((p) => p.cls === 'read' || p.cls === 'check' || p.cls === 'engos')) return;
    pkg = res.parts.some((p) => p.cls === 'pkg_install');
  }

  const observeLib = require('./engos-observe.js');
  const base = core.loadBaseline(root, task.task_id);
  const before = new Set(((task.observed && task.observed.protected_hits) || []).map((h) => h.path));
  const prevObs = task.observed || {};
  const sig = (o) => JSON.stringify([o.files_touched || [], o.lines_added || 0, o.lines_deleted || 0, o.files_created || 0, o.files_deleted || 0]);
  const obs = observeLib.observe(root, base, cfg.protected, { withSnapshot: isBash });
  // Checks must run after the latest change to count (phase 4).
  if (sig(prevObs) !== sig(obs) || !isBash) task.last_change_at = new Date().toISOString();
  task.observed = Object.assign(task.observed || {}, obs, { pkg_install: (task.observed && task.observed.pkg_install) || pkg });

  const messages = [];
  // Who changed what (H11 compares a subagent's report with this; D47 counts the lead's own files).
  const newFiles = (obs.files_touched || []).filter((x) => !(prevObs.files_touched || []).includes(x));
  const thisFile = !isBash ? relPath(root, ti.file_path || ti.notebook_path) : null;
  const changed = Array.from(new Set(newFiles.concat(thisFile ? [thisFile] : [])));
  if (input.agent_id) {
    const ag = (task.agents || []).find((x) => x.agent_id === input.agent_id);
    if (ag) ag.files = Array.from(new Set((ag.files || []).concat(changed)));
  } else if (thisFile) {
    task.lead_files = Array.from(new Set((task.lead_files || []).concat([thisFile])));
  }
  if (!input.agent_id && (task.notices || []).length) { messages.push(task.notices.join(' ')); task.notices = []; }
  let violations = obs.protected_hits.filter((h) => !before.has(h.path) && (h.level === 'never' || (h.level === 'high_risk' && isBash)));
  if (violations.length && grantedThisCall && isBash) {
    // The person approved this exact command; record what it changed instead of flagging it.
    const covered = violations.filter((v) => v.level !== 'never');
    if (covered.length) core.ledger(root, { type: 'protected.changed_under_approval', actor: { kind: 'hook' }, approval_id: grantedThisCall.approval_id, task_id: task.task_id, paths: covered.map((v) => v.path) });
    violations = violations.filter((v) => v.level === 'never');
  }
  if (violations.length && task.status !== 'needs_human') {
    task.status = 'needs_human';
    task.needs_human_reason = 'a command changed protected files without approval: ' + violations.map((v) => v.path).join(', ');
    task.needs_human_at = new Date().toISOString();
    task.decision_options = ['accept', 'stop'];
    core.ledger(root, { type: 'violation.detected', actor: { kind: 'hook' }, task_id: task.task_id, paths: violations.map((v) => v.path), via: violations.map((v) => v.via) });
    messages.push('Engineering OS detected that this command changed protected files: ' + violations.map((v) => v.path + ' (' + v.level + ')').join(', ') + '. Task ' + task.task_id + ' now needs the user\'s decision. Stop, tell the user what changed, and ask them to type /engos:decide ' + task.task_id + ' accept (keep the change) or /engos:decide ' + task.task_id + ' stop.');
  }

  const r = core.ratchet(root, task, (isBash ? 'bash' : 'write') + ':observed', cfg.protected);
  // D10: changes made while the task was trivial stay and count as part of the plan.
  if (r.raised && r.from === 'trivial_edit' && !task.pre_upgrade_files) task.pre_upgrade_files = (task.observed.files_touched || []).slice();
  if (r.raised && task.status !== 'needs_human') {
    messages.push('Engineering OS: task ' + task.task_id + ' is now ' + r.to + ' (was ' + r.from + ').' + (r.missing.length ? ' ' + needsText(task, r.missing) : ''));
  }
  core.saveProfile(root, task);

  if (messages.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: messages.join(' ') }));
}

// ---------------------------------------------------------------------------
// H5 · PreToolUse on Agent / Task
// ---------------------------------------------------------------------------
function gateAgent(core, root, session, input, cfg) {
  const O = require('./engos-orchestrate.js');
  const sessionId = session.session_id;
  if (input.agent_id) deny(core, root, sessionId, null, 'G-no-nesting', input.tool_name, 'subagents can\'t start other agents (D24). Finish your step and put what else is needed in next_action.');
  if (session.paused) return;
  const task = core.activeTask(root, sessionId);
  if (!task) return; // outside a task Claude Code's own rules apply
  const D = core.defaults();
  const models = { available: cfg.models.available, unavailable: O.loadUnavailable(root) };
  const dec = O.agentDecision(task, input.tool_input || {}, D, models);
  if (dec.deny) deny(core, root, sessionId, task, dec.deny, input.tool_name, dec.reason);
  if (dec.askDeep) {
    if (!task.deep_pending) {
      task.deep_pending = { step: dec.step.id, asked_at: new Date().toISOString() };
      core.saveProfile(root, task);
      core.ledger(root, { type: 'model.asked', actor: { kind: 'hook' }, task_id: task.task_id, step: dec.step.id, tier: 'deep', session_id: sessionId });
    }
    deny(core, root, sessionId, task, 'G-deep-ask', input.tool_name, 'step ' + dec.step.id + ' (' + dec.step.kind + ') is routed to the deep tier (Fable), and Fable needs the user\'s yes for this task (D32). Don\'t start the agent yet. Explain to the user in a sentence or two why this step benefits from Fable, then ask them to type /engos:decide ' + task.task_id + ' fable (use Fable) or /engos:decide ' + task.task_id + ' no_fable (use Opus).');
  }
  const a = O.recordLaunch(task, dec);
  core.saveProfile(root, task);
  core.ledger(root, { type: 'step.assigned', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, step: a.step, agent_type: a.type, role: a.role_card, tier: a.tier, model_requested: a.model_requested, attempt: a.attempt, session_id: sessionId });
  if (dec.notes && dec.notes.length) {
    process.stdout.write(JSON.stringify({ systemMessage: 'Engineering OS: ' + dec.notes.join('; ') + '.' }));
  }
}

// PostToolUse on Agent: the real model (P7: resolvedModel) and the agent id when the response has one.
function agentPost(core, root, task, input) {
  const O = require('./engos-orchestrate.js');
  const resp = input.tool_response || {};
  const type = (input.tool_input || {}).subagent_type || 'general-purpose';
  const list = (task.agents || []).filter((x) => x.type === type && !x.model_actual);
  const a = list[list.length - 1];
  if (!a) return;
  const resolved = resp.resolvedModel || resp.resolved_model || null;
  if (resolved) a.model_actual = String(resolved);
  const aid = resp.agentId || resp.agent_id;
  if (aid && !a.agent_id) a.agent_id = String(aid);
  core.saveProfile(root, task);
  core.ledger(root, { type: 'agent.model', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, model_requested: a.model_requested, model_actual: a.model_actual });
  if (a.model_requested && a.model_actual && O.modelAlias(a.model_actual) !== a.model_requested) {
    core.ledger(root, { type: 'model.mismatch', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, model_requested: a.model_requested, model_actual: a.model_actual });
  }
}

// PostToolUseFailure on Agent: free the launch; a model the account lacks is marked unavailable (D32).
function postToolUseFailure(core, input) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const sessionId = sessionIdOf(input);
  const task = core.activeTask(root, sessionId);
  if (!task) return;
  const O = require('./engos-orchestrate.js');
  const type = (input.tool_input || {}).subagent_type || 'general-purpose';
  const list = (task.agents || []).filter((x) => x.type === type && x.status === 'launched');
  const a = list[list.length - 1];
  if (!a) return;
  const err = String(input.error || '');
  let note = '';
  a.status = 'failed';
  a.error = err.slice(0, 300);
  if (a.model_requested && /model|not available|unavailable|not found|access|permission|entitle/i.test(err)) {
    O.markUnavailable(root, a.model_requested);
    core.ledger(root, { type: 'model.unavailable', actor: { kind: 'hook' }, task_id: task.task_id, model: a.model_requested });
    note = 'The ' + a.model_requested + ' model failed and is now marked unavailable for this project. Run the step brief again for the fallback model, and tell the user.';
  }
  core.saveProfile(root, task);
  core.ledger(root, { type: 'step.failed', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, step: a.step });
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'Engineering OS: ' + note } }));
}

// ---------------------------------------------------------------------------
// H10 · SubagentStart: role card and step contract
// ---------------------------------------------------------------------------
function subagentStart(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const sessionId = sessionIdOf(input);
  const session = core.loadSession(root, sessionId);
  if (!session || session.paused) return;
  const task = core.activeTask(root, sessionId);
  if (!task) return;
  const O = require('./engos-orchestrate.js');
  const a = O.bindStart(task, input.agent_id, input.agent_type);
  if (!a) return;
  core.saveProfile(root, task);
  core.ledger(root, { type: 'step.started', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, step: a.step, agent_id: a.agent_id, agent_type: a.type, model_requested: a.model_requested });
  if (!O.roleOfType(a.type)) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: O.startContext(task, a, core.defaults()) } }));
}

// ---------------------------------------------------------------------------
// H11 · SubagentStop: check the report, compare with what was observed, record the verdict
// ---------------------------------------------------------------------------
function subagentStop(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const sessionId = sessionIdOf(input);
  const task = core.activeTask(root, sessionId);
  if (!task) return;
  const O = require('./engos-orchestrate.js');
  const a = O.findByAgentId(task, input.agent_id);
  if (!a) return;
  const now = new Date().toISOString();
  if (!O.roleOfType(a.type)) { // Explore / Plan: just record
    a.status = 'ended';
    a.ended_at = now;
    core.saveProfile(root, task);
    core.ledger(root, { type: 'step.ended', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, agent_id: a.agent_id });
    return;
  }
  const chk = O.checkReport(root, task, a, input.last_assistant_message, core.yamlLib());
  if (chk.problems.length && !input.stop_hook_active && !(a.report_retries >= 1)) {
    a.report_retries = (a.report_retries || 0) + 1;
    core.saveProfile(root, task);
    core.ledger(root, { type: 'step.report_rejected', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, problems: chk.problems });
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Engineering OS: your report needs fixing before you stop: ' + chk.problems.join('; ') + '. End with the corrected engos/report@1 YAML block.' }));
    return;
  }
  a.status = 'ended';
  a.ended_at = now;
  a.report_status = chk.report ? chk.report.status : null;
  a.report_problems = chk.problems;
  if (chk.report) {
    const dir = path.join(core.tasksDir(root), task.task_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, (a.step || 'free') + '.report-' + a.id + '.json'), JSON.stringify(chk.report, null, 2));
  }
  const st = a.step ? O.stepState(task, a.step) : null;
  if (st && a.role !== 'worker') st.status = 'done';
  if (st && a.role === 'worker' && chk.report && chk.report.status === 'blocked') st.status = 'blocked_by_worker';
  if (chk.facts.components && chk.facts.components.length > 1 && !task.cross_system) {
    task.cross_system = true; // D22: later steps go one tier up
    core.ledger(root, { type: 'uncertainty.cross_system', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, components: chk.facts.components });
  }
  if (a.role === 'validator' && chk.report) {
    const rec = { step: a.step, launch: a.id, verdict: chk.report.verdict || null, refs_ok: !!chk.facts.refs_ok, findings: (chk.report.findings || []).length, max_severity: chk.facts.max_severity || 0, role: a.role_card, at: now, report_ok: !chk.problems.length };
    task.reviews = (task.reviews || []).concat([rec]);
    core.ledger(root, { type: 'validation.verdict', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, step: a.step, verdict: rec.verdict, refs_ok: rec.refs_ok, findings: rec.findings });
  }
  if (chk.problems.length) {
    const msg = 'Engineering OS: the report from ' + a.type + ' (' + (a.step || a.id) + ') still has problems: ' + chk.problems.join('; ') + '. Treat its claims as unverified.';
    task.notices = (task.notices || []).concat([msg]);
    core.ledger(root, { type: 'step.report_problems', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, problems: chk.problems });
  }
  core.saveProfile(root, task);
  core.ledger(root, { type: 'step.ended', actor: { kind: 'hook' }, task_id: task.task_id, launch: a.id, step: a.step, agent_id: a.agent_id, model_requested: a.model_requested, model_actual: a.model_actual, status: a.report_status, files: a.files });
  if (chk.problems.length) process.stdout.write(JSON.stringify({ systemMessage: 'Engineering OS: the ' + (a.step || a.id) + ' report had ' + chk.problems.length + ' problem(s); the lead was told to treat it as unverified.' }));
}

// ---------------------------------------------------------------------------
// H2 · UserPromptExpansion: typed human commands (D46, D34, D35).
// ---------------------------------------------------------------------------
const TYPED = [
  { name: 'decide', re: /^\/engos:decide\s+(TASK-\d+)\s+([a-z_]+)\s*$/i },
  { name: 'class', re: /^\/engos:class\s+(TASK-\d+)\s+(question|trivial_edit|standard|high_risk)\s*$/i },
  { name: 'pause', re: /^\/engos:pause\s*$/i },
  { name: 'resume', re: /^\/engos:resume\s*$/i },
];

function tell(msg) {
  process.stdout.write(JSON.stringify({ systemMessage: 'Engineering OS: ' + msg }));
}

// Was this session resumed or forked after `since`? Then a typed command may come from a script (D35).
function resumedAfter(session, since) {
  return (session.source === 'resume' || session.source === 'fork') && since && Date.parse(session.started_at) > Date.parse(since);
}

function promptExpansion(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const prompt = String(input.prompt || '').trim();
  if (!/^\/engos:/i.test(prompt)) return;
  const cmd = TYPED.find((c) => c.re.test(prompt));
  if (!cmd) return; // other /engos: commands (init, status, view) need no capture
  const m = cmd.re.exec(prompt);
  const sessionId = sessionIdOf(input);
  const session = ensureSession(core, root, sessionId);
  const R = require('./engos-rules.js');

  if (cmd.name === 'pause' || cmd.name === 'resume') {
    session.paused = cmd.name === 'pause';
    core.saveSession(root, sessionId, session);
    core.ledger(root, { type: cmd.name === 'pause' ? 'engos.paused' : 'engos.resumed', actor: { kind: 'human' }, session_id: sessionId });
    return tell(cmd.name === 'pause' ? 'paused for this session. Tasks, plans and checks are off; approvals for protected files, push, network and destructive commands stay on.' : 'resumed. Tasks and checks are back on.');
  }

  const id = m[1].toUpperCase();
  const task = core.loadProfile(root, id);
  if (!task) return tell('no task ' + id + '.');
  if (task.session_id && task.session_id !== sessionId) {
    core.ledger(root, { type: 'typed_command.refused', actor: { kind: 'hook' }, command: cmd.name, task_id: id, reason: 'other_session' });
    return tell(id + ' belongs to another session, so this command can\'t be accepted here (D34).');
  }

  if (cmd.name === 'decide') {
    const option = m[2].toLowerCase();
    if (option === 'close') { // high_risk close confirmation (D8)
      if (!task.awaiting_close_ack) return tell(id + ' isn\'t waiting for a close confirmation. Claude must run `engos task close ' + id + '` first.');
      if (resumedAfter(session, task.close_requested_at)) return tell('this session was resumed after the close was requested, so it can\'t be confirmed here (D35). Ask Claude to run `engos task close ' + id + '` again, then confirm.');
      task.close_acknowledged = { by: 'human', at: new Date().toISOString() };
      task.awaiting_close_ack = false;
      core.saveProfile(root, task);
      core.ledger(root, { type: 'close.acknowledged', actor: { kind: 'human' }, task_id: id, session_id: sessionId });
      return tell(id + ': close confirmed. Claude can now run `engos task close ' + id + '`.');
    }
    if ((option === 'fable' || option === 'no_fable') && task.deep_pending && task.status !== 'needs_human') { // D32 ask before Fable
      if (resumedAfter(session, task.deep_pending.asked_at)) return tell('this session was resumed after Claude asked, so the answer can\'t be accepted here (D35). Ask Claude to start the step again so it asks once more.');
      task.deep_answer = option === 'fable' ? 'yes' : 'no';
      const step = task.deep_pending.step;
      task.deep_pending = null;
      core.saveProfile(root, task);
      core.ledger(root, { type: 'model.answered', actor: { kind: 'human' }, task_id: id, tier: 'deep', step, answer: task.deep_answer, session_id: sessionId });
      return tell(id + ': ' + (task.deep_answer === 'yes' ? 'Fable approved for this task. Claude can start ' + step + ' with model "fable".' : 'no Fable. ' + step + ' runs on Opus (model "opus").'));
    }
    if (task.status !== 'needs_human') return tell(id + ' isn\'t waiting for a decision.');
    if (resumedAfter(session, task.needs_human_at)) {
      core.ledger(root, { type: 'typed_command.refused', actor: { kind: 'hook' }, command: 'decide', task_id: id, reason: 'resumed_after_request' });
      return tell('this session was resumed after the decision was requested, so the decision can\'t be accepted (D35). Ask Claude to run `engos task rearm ' + id + '`, then type the decision again.');
    }
    const options = task.decision_options || ['accept', 'stop'];
    if (!options.includes(option)) return tell('options for ' + id + ': ' + options.join(', ') + '.');
    task.decisions = (task.decisions || []).concat([{ at: new Date().toISOString(), option, reason: task.needs_human_reason, decided_by: 'human' }]);
    if (option === 'approve_amendment' || option === 'reject_amendment') {
      const am = task.pending_amendment;
      if (option === 'approve_amendment' && am && am.kind === 'criteria') task.planned.acceptance = am.after;
      core.ledger(root, { type: option === 'approve_amendment' ? 'criteria.amended' : 'criteria.amendment_rejected', actor: { kind: 'human' }, task_id: id, before: am ? am.before : null, after: am ? am.after : null, reason: am ? am.reason : null });
      task.pending_amendment = null;
      task.status = 'open';
      task.needs_human_reason = null;
      task.decision_options = null;
      core.saveProfile(root, task);
      core.ledger(root, { type: 'decision.recorded', actor: { kind: 'human' }, task_id: id, option, session_id: sessionId });
      return tell(id + ': amendment ' + (option === 'approve_amendment' ? 'approved' : 'rejected') + '; the task continues.');
    }
    if (option === 'retry' || option === 'fable') { // D20 handover answer
      require('./engos-orchestrate.js').applyRetry(task, option);
      task.status = 'open';
      task.needs_human_reason = null;
      task.decision_options = null;
      task.history.push({ at: new Date().toISOString(), from: 'needs_human', to: 'open', trigger: 'human_decision:' + option });
      core.saveProfile(root, task);
      core.ledger(root, { type: 'decision.recorded', actor: { kind: 'human' }, task_id: id, option, session_id: sessionId });
      if (option === 'fable') core.ledger(root, { type: 'model.answered', actor: { kind: 'human' }, task_id: id, tier: 'deep', answer: 'yes', session_id: sessionId });
      return tell(id + ': one more attempt on ' + (option === 'fable' ? 'Fable' : 'the frontier tier') + '. Claude can run the step brief again.');
    }
    if (option === 'validator' || option === 'worker') { // D25 dispute settled by the human
      const dsp = (task.disputes || []).filter((d) => !d.resolved_by).pop();
      if (dsp) { dsp.resolved_by = 'human'; dsp.outcome = option; dsp.resolved_at = new Date().toISOString(); }
      task.status = 'open';
      task.needs_human_reason = null;
      task.decision_options = null;
      core.saveProfile(root, task);
      core.ledger(root, { type: 'dispute.resolved', actor: { kind: 'human' }, task_id: id, dispute: dsp ? dsp.id : null, resolved_by: 'human', outcome: option, session_id: sessionId });
      return tell(id + ': dispute settled in favour of the ' + option + '. The task continues.');
    }
    if (option === 'accept') {
      task.status = 'open';
      task.needs_human_reason = null;
      task.history.push({ at: new Date().toISOString(), from: 'needs_human', to: 'open', trigger: 'human_decision:accept' });
    } else {
      task.status = 'closed';
      task.closed_at = new Date().toISOString();
      task.close_note = 'stopped by the user';
    }
    core.saveProfile(root, task);
    core.ledger(root, { type: 'decision.recorded', actor: { kind: 'human' }, task_id: id, option, session_id: sessionId });
    return tell(option === 'accept' ? id + ': change accepted, the task continues.' : id + ' stopped and closed.');
  }

  if (cmd.name === 'class') {
    const to = m[2].toLowerCase();
    const from = task.effective.class;
    if (R.classRank(to) >= R.classRank(from)) return tell(id + ' is already ' + from + '. /engos:class only lowers a class; it rises by itself.');
    if (resumedAfter(session, task.opened_at)) return tell('this session was resumed after ' + id + ' opened, so the change can\'t be accepted here (D35).');
    task.human_override = { class: to, at: new Date().toISOString(), by: 'human', ignore_floors: task.effective.floor_sources || [] };
    task.effective.class = to;
    task.history.push({ at: task.human_override.at, from, to, trigger: 'human_override' });
    const missing = R.missingRequirements(task);
    if (!missing.length && task.status === 'upgrade_pending') task.status = 'open';
    core.saveProfile(root, task);
    core.ledger(root, { type: 'class.changed', actor: { kind: 'human' }, task_id: id, from, to, rule_id: 'human_override' });
    return tell(id + ' lowered from ' + from + ' to ' + to + '. Protected files, push, network and destructive commands still need approval.');
  }
}

// ---------------------------------------------------------------------------
function preToolUse(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;
  const session = ensureSession(core, root, sessionIdOf(input));
  const cfg = projectRules(core, root, session);
  if (WRITE_TOOLS.has(input.tool_name)) return gateWrite(core, root, session, input, cfg);
  if (input.tool_name === 'Bash') return gateBash(core, root, session, input, cfg);
  if (input.tool_name === 'Agent' || input.tool_name === 'Task') return gateAgent(core, root, session, input, cfg);
}

function main() {
  const mode = process.argv[2];
  const input = readInput();
  let core;
  try {
    core = require('./engos-core.js');
    process.on('exit', () => { // phase 6: one status rebuild per hook run, only when the ledger changed
      try { const r = core.dirtyRoot(); if (r) require('./engos-status.js').writeStatus(r); } catch (_) { /* never break the hook */ }
    });
  } catch (e) {
    if (mode === 'pre-tool-use') block('the plugin files are damaged (' + e.message + '). Reinstall Engineering OS.');
    return;
  }

  try {
    if (process.env.ENGOS_TEST_THROW === mode) throw new Error('test-induced failure');
    if (mode === 'session-start') return sessionStart(core, input);
    if (mode === 'pre-tool-use') return preToolUse(core, input);
    if (mode === 'post-tool-use') return postToolUse(core, input);
    if (mode === 'prompt-expansion') return promptExpansion(core, input);
    if (mode === 'post-tool-use-failure') return postToolUseFailure(core, input);
    if (mode === 'subagent-start') return subagentStart(core, input);
    if (mode === 'subagent-stop') return subagentStop(core, input);
  } catch (e) {
    if (mode === 'pre-tool-use') block('internal gate error, so the call is blocked to stay safe: ' + e.message);
    if (mode === 'post-tool-use') {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Engineering OS could not check what this call changed (' + e.message + '). Tell the user.' }));
      return;
    }
    const what = mode === 'session-start' ? 'session check failed (' + e.message + '). Edits will be checked again on the first change.' : mode + ' failed (' + e.message + ').';
    process.stdout.write(JSON.stringify({ systemMessage: 'Engineering OS: ' + what }));
  }
}

main();
