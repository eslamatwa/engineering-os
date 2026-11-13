'use strict';
// engos CLI — the only writer of Engineering OS task state (docs/execution-contract.md).
// Phase 1 commands: init, doctor, task open|status|close, version.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require(path.join(__dirname, 'engos-core.js'));

const VERSION = require(path.join(core.PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version;

const GITIGNORE_LINES = [
  '# Engineering OS — local only (D28)',
  '.engos/tasks/',
  '.engos/approvals/',
  '.engos/ledger.jsonl',
  '.engos/status.json',
  '.engos/sessions/',
];

const DENY_RULES = [ // Edit(...) rules cover every file-editing tool; Write(...) rules are not matched
  'Edit(./.engos/approvals/**)',
  'Edit(./.engos/ledger.jsonl)',
  'Edit(./.engos/sessions/**)',
];

function parseArgs(argv) {
  const args = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      if (args[key] !== undefined) {
        args.multi[key] = (args.multi[key] || [args[key]]).concat([value]);
      }
      args[key] = value;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function all(args, key) {
  if (args.multi[key]) return args.multi[key];
  return args[key] === undefined ? [] : [args[key]];
}

function fail(msg) {
  process.stderr.write('engos: ' + msg + '\n');
  process.exit(1);
}

function gitTop(dir) {
  try {
    return cp.execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
}

function requireRoot() {
  const root = core.findProjectRoot(process.cwd());
  if (!root) fail('no .engos/ folder here or above. Run /engos:init first.');
  return root;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function configYaml(models, checks, known) {
  const lines = [];
  lines.push('# .engos/config.yaml — committed. Overrides Engineering OS defaults.');
  lines.push('# You can ADD protected paths and TIGHTEN limits. You can\'t remove `never` paths or hard gates.');
  lines.push('schema: engos/project-config@1');
  lines.push('');
  lines.push('models:');
  lines.push('  available: [' + models.join(', ') + ']   # models on your plan; add fable if you have it');
  lines.push('  ask_first: [deep]                  # tiers the lead must ask about per task (D32)');
  lines.push('');
  lines.push('checks:                              # commands that count as evidence, run via `engos check <name>` (D36)');
  const names = Object.keys(checks);
  if (names.length === 0) lines.push('  {}');
  for (const n of names) lines.push('  ' + n + ': ' + JSON.stringify(checks[n]));
  lines.push('');
  lines.push('protected_paths:                     # added to the built-in list');
  lines.push('  high_risk: []                      # e.g. "src/billing/**"');
  lines.push('  standard: []');
  lines.push('');
  lines.push('known_commands:                      # never need an approval, even in high_risk tasks (D38)');
  if (known.length === 0) lines.push('  []');
  for (const k of known) lines.push('  - ' + JSON.stringify(k));
  lines.push('');
  lines.push('mcp_allowlist: []                    # MCP tools that don\'t need an action approval');
  lines.push('');
  return lines.join('\n');
}

function cmdInit(args) {
  const start = process.cwd();
  let root = gitTop(start);
  const report = [];

  if (!root) {
    if (args['git-init']) {
      cp.execFileSync('git', ['init', '-q'], { cwd: start, stdio: 'ignore' });
      root = gitTop(start) || start;
      report.push('Ran git init.');
    } else {
      root = start;
      report.push('Not a git repo: the project will stay read-only until you run git init (D11).');
    }
  }

  const models = String(args.models || 'haiku,sonnet,opus').split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = new Set(['haiku', 'sonnet', 'opus', 'fable']);
  for (const m of models) if (!allowed.has(m)) fail('unknown model "' + m + '". Use haiku, sonnet, opus, fable.');

  const checks = {};
  for (const c of all(args, 'check')) {
    const eq = String(c).indexOf('=');
    if (eq < 1) fail('--check must look like name=command, got "' + c + '"');
    checks[String(c).slice(0, eq).trim()] = String(c).slice(eq + 1).trim();
  }
  const known = all(args, 'known').map(String);

  const dir = core.engosPath(root);
  fs.mkdirSync(dir, { recursive: true });

  const created = [];
  const kept = [];
  const put = (rel, content) => {
    const file = path.join(dir, rel);
    if (fs.existsSync(file)) { kept.push('.engos/' + rel); return; }
    fs.writeFileSync(file, content, 'utf8');
    created.push('.engos/' + rel);
  };
  put('config.yaml', configYaml(models, checks, known));
  put('BRIEF.md', fs.readFileSync(path.join(core.PLUGIN_ROOT, 'templates', 'BRIEF.md'), 'utf8'));
  put('STATE.yaml', fs.readFileSync(path.join(core.PLUGIN_ROOT, 'templates', 'STATE.yaml'), 'utf8'));

  // .gitignore
  const gi = path.join(root, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gi, existing + sep + (existing ? '\n' : '') + missing.join('\n') + '\n', 'utf8');
    report.push('Added ' + missing.filter((l) => !l.startsWith('#')).length + ' lines to .gitignore.');
  }

  // Optional deny rules (only when the user agreed)
  if (args['deny-rules']) {
    const sf = path.join(root, '.claude', 'settings.json');
    const settings = core.readJson(sf, {});
    settings.permissions = settings.permissions || {};
    const deny = new Set(settings.permissions.deny || []);
    let added = 0;
    for (const r of DENY_RULES) if (!deny.has(r)) { deny.add(r); added++; }
    settings.permissions.deny = Array.from(deny);
    core.writeJson(sf, settings);
    report.push('Added ' + added + ' deny rules to .claude/settings.json.');
  }

  core.ledger(root, { type: 'engos.initialized', actor: { kind: 'cli' }, created, kept, models, checks: Object.keys(checks) });

  const check = core.selfCheck(root, { skipVersion: true });
  console.log('Engineering OS initialised in ' + root);
  if (created.length) console.log('Created: ' + created.join(', '));
  if (kept.length) console.log('Already there, left unchanged: ' + kept.join(', '));
  for (const r of report) console.log(r);
  console.log('Mode for new sessions: ' + check.mode + (check.hard.length ? ' (' + check.hard.join(' ') + ')' : ''));
  if (Object.keys(checks).length === 0) console.log('No check commands set. Add them under checks: in .engos/config.yaml so tasks can prove they work.');
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
function cmdDoctor() {
  const root = requireRoot();
  const check = core.selfCheck(root);
  console.log('Project: ' + root);
  console.log('Node: ' + process.versions.node);
  console.log('Claude Code: ' + (check.claude_code_version || 'unknown'));
  console.log('Mode: ' + check.mode);
  for (const h of check.hard) console.log('BLOCKING: ' + h);
  for (const w of check.warn) console.log('WARNING: ' + w);
  if (!check.hard.length && !check.warn.length) console.log('All checks passed.');
  process.exit(check.hard.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// task, profile, plan, scope
// ---------------------------------------------------------------------------
const R = require(path.join(__dirname, 'engos-rules.js'));

function sessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

function protectedPaths(root) {
  const cfg = core.loadProjectConfig(root);
  return core.protectedFor(cfg.ok ? cfg.config : {});
}

// The task a command acts on: --task, else this session's active task, else the newest open task.
function targetTask(root, args) {
  if (args.task && args.task !== true) {
    const p = core.loadProfile(root, String(args.task));
    if (!p) fail('no task ' + args.task);
    return p;
  }
  const sid = sessionId();
  const t = sid ? core.activeTask(root, sid) : null;
  if (t) return t;
  const open = core.listTasks(root).filter(core.isOpen);
  if (!open.length) fail('no open task. Open one with: engos task open --summary "..."');
  return open[open.length - 1];
}

function list(v) {
  if (v === undefined || v === true) return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

function report(root, task, r) {
  core.saveProfile(root, task);
  console.log(task.task_id + ': class ' + task.effective.class + ', state ' + task.status + (r && r.raised ? ' (raised from ' + r.from + ')' : ''));
  const missing = R.missingRequirements(task);
  if (missing.length) console.log('Still needed before edits: ' + missing.join('; '));
  else if (task.status === 'open') console.log('Edits can continue' + (task.effective.class === 'high_risk' ? "; protected files still need the user's scope approval." : '.'));
}

function cmdTask(args) {
  const sub = args._[1];
  const root = requireRoot();
  if (sub === 'open') {
    const summary = args.summary || args._.slice(2).join(' ');
    if (!summary || summary === true) fail('task open needs --summary "what the task is"');
    const t = core.openTask(root, sessionId(), { summary: String(summary), openedBy: args.by === 'human' ? 'human' : 'lead', actor: 'cli' });
    console.log(t.task_id);
    return;
  }
  if (sub === 'status' || sub === undefined) {
    const tasks = core.listTasks(root);
    const want = args._[2];
    const shown = want ? tasks.filter((t) => t.task_id === want) : tasks.filter(core.isOpen);
    const pend = require(path.join(__dirname, 'engos-approvals.js')).pending(root, null);
    for (const p of pend) {
      console.log('Waiting for approval: ' + p.approval_id + '  ' + p.action + (p.context && p.context.outgoing_commits && p.context.outgoing_commits.length ? '  (commits: ' + p.context.outgoing_commits.join('; ') + ')' : ''));
    }
    if (!shown.length) { console.log(want ? 'No task ' + want + '.' : 'No open tasks.'); return; }
    for (const t of shown) {
      const o = t.observed || {};
      console.log(t.task_id + '  ' + t.status + '  ' + ((t.effective && t.effective.class) || '?') + '  ' + ((t.request && t.request.summary) || ''));
      if (want) {
        console.log('  files: ' + (o.files_count || 0) + ' (+' + (o.lines_added || 0) + ' -' + (o.lines_deleted || 0) + ' lines)' + (o.files_touched && o.files_touched.length ? ': ' + o.files_touched.join(', ') : ''));
        if (t.planned && t.planned.scope) console.log('  write scope: ' + (t.planned.scope.write || []).join(', '));
        if (t.needs_human_reason) console.log('  needs human: ' + t.needs_human_reason + ' (user types /engos:decide ' + t.task_id + ' accept|stop)');
        const runs = require(path.join(__dirname, 'engos-evidence.js')).latestRuns(t);
        for (const n of Object.keys(runs)) console.log('  check ' + n + ': ' + (runs[n].passed ? 'passed' : 'failed (exit ' + runs[n].exit + ')') + ' at ' + runs[n].at.slice(11, 19) + (t.last_change_at && Date.parse(runs[n].at) < Date.parse(t.last_change_at) ? ' (before the latest change)' : ''));
        if (t.planned && (t.planned.acceptance || []).length) console.log('  acceptance: ' + t.planned.acceptance.map((a) => a.id + ' ' + a.statement).join('; '));
        for (const st of (t.planned && t.planned.steps) || []) console.log('  step ' + stepLine(t, st));
        for (const a of t.agents || []) console.log('  agent ' + a.id + ' ' + a.type + (a.step ? ' ' + a.step : '') + ' ' + (a.model_actual || a.model_requested || '') + ' ' + a.status + (a.result ? ' (' + a.result + ')' : ''));
        for (const d of t.disputes || []) console.log('  dispute ' + d.id + ' about ' + d.about + ': ' + (d.resolved_by ? 'settled by the ' + d.resolved_by + ' for the ' + d.outcome : 'open, settled by the ' + d.settler));
        const files = Object.keys(t.approved_files || {});
        if (files.length) console.log('  protected files approved: ' + files.join(', '));
        const missing = R.missingRequirements(t);
        if (missing.length) console.log('  still needed: ' + missing.join('; '));
      }
    }
    return;
  }
  if (sub === 'close') {
    const id = args._[2];
    if (!id) fail('task close needs a task id, e.g. engos task close TASK-001');
    const profile = core.loadProfile(root, id);
    if (!profile) fail('no task ' + id);
    if (profile.status === 'closed') fail(id + ' is already closed');
    const E = require(path.join(__dirname, 'engos-evidence.js'));
    const cfg = core.loadProjectConfig(root);
    if (args['residual-risk'] && args['residual-risk'] !== true) profile.residual_risk = String(args['residual-risk']);
    const ev = E.evaluateClose(profile, cfg.ok ? cfg.config : {}, {});
    const base = core.loadBaseline(root, id);
    const stat = E.diffStat(root, base.git_head);
    console.log(id + ' (' + ev.cls + '): ' + ((profile.request && profile.request.summary) || ''));
    const touched = (profile.observed && profile.observed.files_touched) || [];
    if (touched.length) console.log('Changed files: ' + touched.join(', '));
    if (stat) console.log(stat);
    if (ev.met.length) console.log('Evidence: ' + ev.met.join('; '));
    for (const n of ev.notYet) console.log('Not enforced yet: ' + n);
    if (!ev.ok) {
      if (ev.cls === 'high_risk' && !profile.close_acknowledged && ev.missing.length === 1 && ev.missing[0].startsWith('the user')) {
        profile.awaiting_close_ack = true;
        profile.close_requested_at = new Date().toISOString();
      }
      core.saveProfile(root, profile);
      core.ledger(root, { type: 'task.close_refused', actor: { kind: 'cli' }, task_id: id, missing: ev.missing });
      console.log('Not closed. Still needed:');
      for (const m of ev.missing) console.log('  - ' + m);
      process.exit(1);
    }
    profile.status = 'closed';
    profile.closed_at = new Date().toISOString();
    profile.close_evidence = ev.met;
    delete profile.close_note;
    core.saveProfile(root, profile);
    core.ledger(root, { type: 'task.closed', actor: { kind: 'cli' }, task_id: id, evidence_checked: true, evidence: ev.met, residual_risk: profile.residual_risk || null });
    const sid = sessionId();
    if (sid) { const s2 = core.loadSession(root, sid); if (s2 && s2.active_task === id) { s2.active_task = null; core.saveSession(root, sid, s2); } }
    console.log(id + ' closed. Show the user the changed files and the evidence above.');
    return;
  }
  if (sub === 'rearm') {
    const id = args._[2];
    if (!id) fail('task rearm needs a task id');
    const profile = core.loadProfile(root, id);
    if (!profile) fail('no task ' + id);
    if (profile.status !== 'needs_human') fail(id + " isn't waiting for a decision.");
    profile.needs_human_at = new Date().toISOString();
    core.saveProfile(root, profile);
    core.ledger(root, { type: 'decision.rearmed', actor: { kind: 'cli' }, task_id: id });
    console.log(id + " is waiting for the user's decision again." + ' Ask them to type /engos:decide ' + id + ' accept or /engos:decide ' + id + ' stop.');
    return;
  }
  fail('unknown task command "' + sub + '". Use open, status, close or rearm.');
}

const KINDS = ['question', 'analysis', 'docs', 'tests', 'bugfix', 'feature', 'refactor', 'debugging', 'security_review', 'architecture', 'migration'];
const FLAGS = ['auth', 'payments', 'secrets', 'data_migration', 'deployment', 'other'];

function cmdProfile(args) {
  if (args._[1] !== 'set') fail('use: engos profile set --kind <kind> [--sensitivity auth,payments] [--reversibility easy|hard|irreversible] [--unknowns "a;b"]');
  const root = requireRoot();
  const task = targetTask(root, args);
  if (task.status === 'needs_human') fail(task.task_id + ' is waiting for a human decision.');
  const d = task.declared || {};
  if (args.kind !== undefined) {
    if (!KINDS.includes(String(args.kind))) fail('kind must be one of: ' + KINDS.join(', '));
    d.kind = String(args.kind);
  }
  if (args.sensitivity !== undefined) {
    const flags = list(args.sensitivity);
    for (const fl of flags) if (!FLAGS.includes(fl)) fail('sensitivity flags: ' + FLAGS.join(', '));
    d.sensitivity = Array.from(new Set((d.sensitivity || []).concat(flags))); // can only add (D13)
  }
  if (args.reversibility !== undefined) {
    const v = String(args.reversibility);
    if (!['easy', 'hard', 'irreversible'].includes(v)) fail('reversibility: easy, hard or irreversible');
    d.reversibility = v;
  }
  if (args.unknowns !== undefined) d.unknowns = String(args.unknowns).split(';').map((x) => x.trim()).filter(Boolean);
  d.mutates = args.mutates === undefined ? (d.mutates !== false) : String(args.mutates) !== 'false';
  if (!d.kind) fail('profile needs --kind');
  task.declared = d;
  core.ledger(root, { type: 'profile.declared', actor: { kind: 'cli' }, task_id: task.task_id, declared: d });
  const r = core.ratchet(root, task, 'profile', protectedPaths(root));
  report(root, task, r);
}

function cmdPlan(args) {
  if (args._[1] !== 'set') fail('use: engos plan set --scope-write "src/x/**,tests/x/**" [--scope-read "src/**"] [--steps "S1:locate,S2:implement"]');
  const root = requireRoot();
  const task = targetTask(root, args);
  if (task.status === 'needs_human') fail(task.task_id + ' is waiting for a human decision.');
  const write = list(args['scope-write']);
  if (!write.length) fail('plan needs --scope-write with at least one path or glob');
  const prev = (task.planned && task.planned.scope && task.planned.scope.write) || [];
  if (prev.length) fail(task.task_id + ' already has a plan. Use engos scope amend to widen it.');
  task.planned = {
    scope: { write, read: list(args['scope-read']) },
    steps: [],
    acceptance: criteria(args.acceptance),
    set_at: new Date().toISOString(),
  };
  core.ledger(root, { type: 'plan.set', actor: { kind: 'cli' }, task_id: task.task_id, scope_write: write });
  const r = core.ratchet(root, task, 'plan', protectedPaths(root));
  const specs = list(args.steps).concat(all(args, 'step'));
  if (specs.length) addSteps(root, task, specs);
  report(root, task, r);
  for (const st of task.planned.steps) console.log('  ' + stepLine(task, st));
  if (task.planned.steps.length) console.log('Start a step with: engos step brief ' + task.planned.steps[0].id);
}

function criteria(v) {
  if (v === undefined || v === true) return [];
  return String(v).split(';').map((x) => x.trim()).filter(Boolean).map((statement, i) => ({ id: 'AC-' + (i + 1), statement }));
}

function cmdCheck(args) {
  const name = args._[1];
  if (!name) fail('use: engos check <name>   (names come from checks: in .engos/config.yaml)');
  const root = requireRoot();
  const cfg = core.loadProjectConfig(root);
  if (!cfg.ok) fail(cfg.error);
  const E = require(path.join(__dirname, 'engos-evidence.js'));
  const r = E.runCheck(root, cfg.config, String(name), { timeoutSec: Number(args.timeout) || 900 });
  if (r.error) fail(r.error);
  if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n');
  const sid = sessionId();
  let task = null;
  if (args.task && args.task !== true) task = core.loadProfile(root, String(args.task));
  else if (sid) task = core.activeTask(root, sid);
  else { const open = core.listTasks(root).filter(core.isOpen); task = open[open.length - 1] || null; }
  const rec = { name: r.name, command: r.command, exit: r.exit, passed: r.passed, timed_out: r.timed_out, duration_ms: r.duration_ms, output_sha256: r.output_sha256, output_lines: r.output_lines, at: r.at };
  if (task) {
    task.evidence = task.evidence || {};
    task.evidence.checks = (task.evidence.checks || []).concat([rec]);
    rec.label = O.labelCheck(r.exit, r.output);
    core.saveProfile(root, task);
  }
  core.ledger(root, Object.assign({ type: 'evidence.recorded', actor: { kind: 'cli' }, task_id: task ? task.task_id : null }, rec));
  console.log('engos check ' + r.name + ': ' + (r.passed ? 'passed' : 'FAILED') + ' (exit ' + r.exit + (r.timed_out ? ', timed out' : '') + ', ' + Math.round(r.duration_ms / 1000) + 's)' + (task ? ', recorded on ' + task.task_id : ', no open task to record it on'));
  if (task) { escalateAfterCheck(root, task, r); core.saveProfile(root, task); }
  process.exit(r.exit === 0 ? 0 : 1);
}

function cmdCriteria(args) {
  if (args._[1] !== 'amend') fail('use: engos criteria amend --set "criterion; criterion" --reason "..."');
  const root = requireRoot();
  const task = targetTask(root, args);
  const next = criteria(args.set);
  const reason = args.reason;
  if (!next.length || !reason || reason === true) fail('criteria amend needs --set "a; b" and --reason "..."');
  if (!task.planned || !task.planned.scope) fail(task.task_id + ' has no plan yet. Use engos plan set first.');
  const before = task.planned.acceptance || [];
  if (task.effective.class === 'high_risk') {
    task.pending_amendment = { kind: 'criteria', before, after: next, reason: String(reason), at: new Date().toISOString() };
    task.status = 'needs_human';
    task.needs_human_reason = 'the lead wants to change the acceptance criteria: ' + String(reason);
    task.needs_human_at = new Date().toISOString();
    task.decision_options = ['approve_amendment', 'reject_amendment'];
    core.saveProfile(root, task);
    core.ledger(root, { type: 'criteria.amendment_requested', actor: { kind: 'cli' }, task_id: task.task_id, before, after: next, reason: String(reason) });
    console.log(task.task_id + ' is high_risk, so the user decides. Show them the change and ask them to type /engos:decide ' + task.task_id + ' approve_amendment (or reject_amendment).');
    return;
  }
  task.planned.acceptance = next;
  core.saveProfile(root, task);
  core.ledger(root, { type: 'criteria.amended', actor: { kind: 'cli' }, task_id: task.task_id, before, after: next, reason: String(reason) });
  console.log(task.task_id + ': acceptance criteria updated and recorded.');
}

function cmdScope(args) {
  if (args._[1] !== 'amend') fail('use: engos scope amend --add "<glob>" --reason "..."');
  const root = requireRoot();
  const task = targetTask(root, args);
  const add = list(args.add);
  const reason = args.reason;
  if (!add.length || !reason || reason === true) fail('scope amend needs --add "<glob>" and --reason "..."');
  if (!task.planned || !task.planned.scope) fail(task.task_id + ' has no plan yet. Use engos plan set first.');
  const max = core.defaults().rules.scope.lead_widen_max_per_task;
  if ((task.scope_amendments || 0) >= max) fail('scope was already widened ' + max + ' times for ' + task.task_id + '. Ask the user instead (D12).');
  const prot = protectedPaths(root);
  for (const g of add) {
    const sample = String(g).replace(/\*.*$/, '').replace(/\/$/, '') || '.';
    const lvl = R.protectedLevel(sample + '/x', prot) || R.protectedLevel(String(g).replace(/\*/g, 'x'), prot);
    if (lvl) fail(g + ' touches a ' + lvl + " protected path, so it can't be added by a scope amendment (D12).");
  }
  const before = task.planned.scope.write.slice();
  task.planned.scope.write = Array.from(new Set(before.concat(add)));
  task.scope_amendments = (task.scope_amendments || 0) + 1;
  core.ledger(root, { type: 'scope.amended', actor: { kind: 'cli' }, task_id: task.task_id, before, after: task.planned.scope.write, reason: String(reason) });
  report(root, task, null);
}

// ---------------------------------------------------------------------------
// steps, disputes, facts (phase 5)
// ---------------------------------------------------------------------------
const O = require(path.join(__dirname, 'engos-orchestrate.js'));

function modelsFor(root) {
  const cfg = core.loadProjectConfig(root);
  const c = cfg.ok ? cfg.config : {};
  return { available: (c.models && c.models.available) || [], unavailable: O.loadUnavailable(root) };
}

function addSteps(root, task, specs) {
  const D = core.defaults();
  let steps;
  try { steps = O.planSteps(task, specs, D); } catch (e) { fail(e.message); }
  const have = new Set(((task.planned && task.planned.steps) || []).map((s) => s.id));
  for (const s of steps) if (have.has(s.id)) fail('step ' + s.id + ' already exists in ' + task.task_id);
  task.planned.steps = ((task.planned && task.planned.steps) || []).concat(steps);
  task.effective.roles = O.rolesFor(task, D);
  for (const s of steps) core.ledger(root, { type: 'step.assigned', actor: { kind: 'cli' }, task_id: task.task_id, step: s.id, kind: s.kind, by: s.by, role: s.role, tier: s.tier, rule_id: s.rule_id });
  return steps;
}

function stepLine(task, s) {
  const st = (task.step_state || {})[s.id] || { status: 'pending' };
  const tries = O.launchesFor(task, s.id).length;
  return s.id + '  ' + s.kind + '  by ' + (s.by === 'lead' ? 'the lead' : 'engos:' + s.by) + (s.tier ? '  tier ' + s.tier : '') + '  role ' + s.role + '  [' + st.status + (tries ? ', ' + tries + ' launch' + (tries > 1 ? 'es' : '') : '') + ']';
}

function cmdStep(args) {
  const sub = args._[1];
  const root = requireRoot();
  const task = targetTask(root, args);
  const D = core.defaults();
  if (sub === 'add') {
    if (!task.planned || !task.planned.scope) fail(task.task_id + ' has no plan yet. Use engos plan set first.');
    const specs = all(args, 'step').concat(list(args.steps));
    if (!specs.length) fail('use: engos step add --step "S3:verify"   (kinds: ' + Object.keys(D.agents.step_kinds || {}).join(', ') + ')');
    const added = addSteps(root, task, specs);
    core.saveProfile(root, task);
    for (const s of added) console.log('added ' + stepLine(task, s));
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const steps = (task.planned && task.planned.steps) || [];
    if (!steps.length) return console.log(task.task_id + ' has no steps. The lead does the work itself, or add steps with engos step add.');
    for (const s of steps) console.log(stepLine(task, s));
    return;
  }
  if (sub === 'brief') {
    const id = String(args._[2] || '').toUpperCase();
    const step = ((task.planned && task.planned.steps) || []).find((s) => s.id === id);
    if (!step) fail('no step ' + (id || '?') + ' in ' + task.task_id + '. Steps: ' + (((task.planned && task.planned.steps) || []).map((s) => s.id).join(', ') || 'none'));
    if (task.status === 'needs_human') fail(task.task_id + ' is waiting for the user\'s decision: ' + (task.needs_human_reason || '') + ' (options: ' + (task.decision_options || []).join(', ') + ').');
    const exp = O.expectedFor(task, step, D, modelsFor(root));
    if (exp.lead) return console.log(step.id + ' is a trivial edit: the lead does it itself, no agent.');
    if (exp.blocked) fail(step.id + ' has used its attempts; the user decides next.');
    if (exp.ask) {
      console.log(step.id + ' (' + step.kind + ') is routed to the deep tier (Fable), which needs the user\'s yes for this task (D32).');
      console.log('Explain to the user why this step benefits from Fable, then ask them to type /engos:decide ' + task.task_id + ' fable  or  /engos:decide ' + task.task_id + ' no_fable');
      return;
    }
    const scope = (task.planned.scope || {});
    const runs = require(path.join(__dirname, 'engos-evidence.js')).latestRuns(task);
    const prev = O.launchesFor(task, step.id).filter((a) => a.result === 'check_failed').pop();
    const failed = Object.keys(runs).filter((n) => !runs[n].passed);
    const brief = {
      schema: 'engos/brief@1',
      task_id: task.task_id,
      step_id: step.id,
      attempt: exp.attempt,
      role: step.role,
      tier: exp.tier,
      objective: args.objective && args.objective !== true ? String(args.objective) : (task.request.summary || '') + ' (step ' + step.id + ': ' + step.kind + ')',
      scope: { write: step.by === 'worker' ? (scope.write || []) : [], read: scope.read && scope.read.length ? scope.read : ['**'] },
      acceptance: (task.planned.acceptance || []).map((a) => ({ id: a.id, statement: a.statement })),
      checks: step.by === 'scout' ? [] : require(path.join(__dirname, 'engos-evidence.js')).requiredChecks((core.loadProjectConfig(root).config) || {}).map((n) => 'engos check ' + n),
      prior_failure: prev ? { attempt: prev.attempt, tier: prev.tier, failing_checks: failed, output: 'PASTE the failing output from your last engos check run here (D20: the retry gets the exact output)' } : null,
      return: 'engos/report@1',
    };
    console.log('Start ' + step.id + ' with the Agent tool:');
    console.log('  subagent_type: engos:' + step.by);
    console.log('  model: ' + exp.model + '   (' + exp.tier + ' tier' + (exp.notes.length ? '; ' + exp.notes.join('; ') : '') + ')');
    console.log('  prompt: the brief below, with objective filled in. Keep the step_id line: the gate reads it.');
    console.log('');
    console.log(core.yamlLib().dump(brief, { lineWidth: 140 }).trim());
    core.ledger(root, { type: 'step.briefed', actor: { kind: 'cli' }, task_id: task.task_id, step: step.id, attempt: exp.attempt, tier: exp.tier, model: exp.model });
    return;
  }
  fail('use: engos step add --step "S3:verify" | engos step list | engos step brief S2 [--objective "..."]');
}

function cmdDispute(args) {
  const sub = args._[1];
  const root = requireRoot();
  const task = targetTask(root, args);
  task.disputes = task.disputes || [];
  if (sub === 'open') {
    const about = args.about; const reason = args.reason;
    if (!about || about === true || !reason || reason === true) fail('use: engos dispute open --about AC-2 --reason "..." [--step S3] [--security --severity medium]');
    const who = O.disputeSettler(task, { security: !!args.security, severity: args.severity }, core.defaults());
    const d = { id: 'DSP-' + (task.disputes.length + 1), about: String(about), step: args.step && args.step !== true ? String(args.step) : null, reason: String(reason), security: !!args.security, severity: args.severity && args.severity !== true ? String(args.severity) : null, settler: who.by, opened_at: new Date().toISOString() };
    task.disputes.push(d);
    core.ledger(root, { type: 'dispute.opened', actor: { kind: 'cli' }, task_id: task.task_id, dispute: d.id, about: d.about, settler: who.by, why: who.why });
    if (who.by === 'human') {
      task.status = 'needs_human';
      task.needs_human_reason = 'dispute ' + d.id + ' about ' + d.about + ': ' + d.reason + ' (' + who.why + ')';
      task.needs_human_at = new Date().toISOString();
      task.decision_options = ['validator', 'worker'];
      core.saveProfile(root, task);
      console.log(d.id + ' goes to the user: ' + who.why + '. Show them both sides, then ask them to type /engos:decide ' + task.task_id + ' validator  or  /engos:decide ' + task.task_id + ' worker');
      return;
    }
    core.saveProfile(root, task);
    console.log(d.id + ': ' + who.why + '. Settle it with: engos dispute settle ' + d.id + ' --side validator|worker --reason "..."');
    return;
  }
  if (sub === 'settle') {
    const id = String(args._[2] || '');
    const d = task.disputes.find((x) => x.id === id);
    if (!d) fail('no dispute ' + id + ' in ' + task.task_id);
    if (d.resolved_by) fail(id + ' is already settled by the ' + d.resolved_by);
    if (d.settler !== 'lead') fail(id + ' is settled by the user, not the lead (D25).');
    const side = String(args.side || '');
    if (!['validator', 'worker'].includes(side) || !args.reason || args.reason === true) fail('use: engos dispute settle ' + id + ' --side validator|worker --reason "..."');
    d.resolved_by = 'lead'; d.outcome = side; d.resolution_reason = String(args.reason); d.resolved_at = new Date().toISOString();
    core.saveProfile(root, task);
    core.ledger(root, { type: 'dispute.resolved', actor: { kind: 'cli' }, task_id: task.task_id, dispute: id, resolved_by: 'lead', outcome: side, reason: d.resolution_reason });
    console.log(id + ' settled for the ' + side + ' and recorded. Any further dispute in ' + task.task_id + ' goes to the user.');
    return;
  }
  fail('use: engos dispute open --about AC-2 --reason "..." | engos dispute settle DSP-1 --side validator|worker --reason "..."');
}

function cmdFacts(args) {
  if (args._[1] !== 'add') fail('use: engos facts add --fact "..." --source path:line|human   or   engos facts add --assumption "..."');
  const root = requireRoot();
  const task = targetTask(root, args);
  task.facts = task.facts || [];
  if (args.assumption && args.assumption !== true) {
    task.facts.push({ kind: 'assumed', text: String(args.assumption), at: new Date().toISOString() });
    core.saveProfile(root, task);
    core.ledger(root, { type: 'fact.added', actor: { kind: 'cli' }, task_id: task.task_id, kind: 'assumed' });
    return console.log('recorded as an assumption.');
  }
  const fact = args.fact; const source = args.source;
  if (!fact || fact === true || !source || source === true) fail('a fact needs --fact "..." and --source path:line (or --source human for output the user gave you)');
  const src = String(source);
  if (src !== 'human' && !O.refExists(root, src)) fail(src + ' doesn\'t exist in the repo (or the line is past the end), so this can\'t be stored as a verified fact. Fix the source or store it with --assumption.');
  task.facts.push({ kind: 'verified', text: String(fact), source: src, at: new Date().toISOString() });
  core.saveProfile(root, task);
  core.ledger(root, { type: 'fact.added', actor: { kind: 'cli' }, task_id: task.task_id, kind: 'verified', source: src });
  console.log('recorded as a verified fact (source ' + src + ').');
}

// After a check: label it and move escalation on (D20, D21).
function escalateAfterCheck(root, task, r) {
  const D = core.defaults();
  const label = O.labelCheck(r.exit, r.output);
  const esc = O.applyCheck(task, label, D);
  if (!esc.step) return label;
  const E = require(path.join(__dirname, 'engos-evidence.js'));
  if (esc.blocked || esc.envLimit) {
    const reason = esc.blocked ? 'attempts_exhausted' : 'env_error_limit';
    const h = O.handover(task, reason, E.latestRuns(task), D, modelsFor(root));
    fs.writeFileSync(path.join(core.tasksDir(root), task.task_id, 'handover.json'), JSON.stringify(h, null, 2));
    task.status = 'needs_human';
    task.needs_human_reason = esc.blocked ? 'step ' + esc.step + ' failed its checks ' + esc.failures + ' times' : 'step ' + esc.step + ' hit two environment errors';
    task.needs_human_at = new Date().toISOString();
    task.decision_options = h.options.map((o) => o.id);
    core.ledger(root, { type: 'responsibility.transferred', actor: { kind: 'cli' }, task_id: task.task_id, from: 'lead', to: 'human', reason, step: esc.step });
    console.log('');
    console.log(task.task_id + ' is blocked and goes to the user (' + reason + '). Handover:');
    console.log(core.yamlLib().dump(h, { lineWidth: 140 }).trim());
    console.log('Tell the user what was tried, add your recommendation, and ask them to type /engos:decide ' + task.task_id + ' <' + task.decision_options.join('|') + '>.');
  } else if (label === 'env_error') {
    console.log('Labelled env_error (missing command or dependency): it doesn\'t count as an attempt for ' + esc.step + '. Fix the environment and run the check again. A second env_error in this step goes to the user.');
  } else if (label === 'check_failed') {
    const st = (task.step_state || {})[esc.step] || {};
    console.log('Attempt ' + esc.failures + ' of ' + (st.allowed_attempts || 3) + ' for ' + esc.step + ' failed. For the next attempt run `engos step brief ' + esc.step + '` (it gives the tier) and include the failing output above as prior_failure.');
  } else if (label === 'passed') {
    console.log(esc.step + ' passes its checks.');
  }
  return label;
}

// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'init': return cmdInit(args);
    case 'doctor': return cmdDoctor();
    case 'task': return cmdTask(args);
    case 'profile': return cmdProfile(args);
    case 'plan': return cmdPlan(args);
    case 'scope': return cmdScope(args);
    case 'check': return cmdCheck(args);
    case 'criteria': return cmdCriteria(args);
    case 'step': return cmdStep(args);
    case 'dispute': return cmdDispute(args);
    case 'facts': return cmdFacts(args);
    case 'version':
    case '--version': return console.log('engos ' + VERSION);
    case undefined:
    case 'help':
    case '--help':
      return console.log('engos ' + VERSION + '\n\nCommands:\n  init [--models haiku,sonnet,opus] [--check name=cmd]... [--known cmd]... [--deny-rules] [--git-init]\n  doctor\n  task open --summary "..." | task status [TASK-ID] | task close TASK-ID\n  profile set --kind <kind> [--sensitivity a,b] [--reversibility easy|hard|irreversible] [--task ID]\n  plan set --scope-write "glob,glob" [--acceptance "a; b"] [--scope-read "..."] [--steps "S1:locate,S2:implement,S3:verify"] [--task ID]\n  scope amend --add "glob" --reason "..." [--task ID]\n  check <name> [--task ID]            run a configured check and record its exit code\n  criteria amend --set "a; b" --reason "..."\n  step add --step "S3:verify" | step list | step brief S2 [--objective "..."]\n  dispute open --about AC-2 --reason "..." [--security --severity medium] | dispute settle DSP-1 --side validator|worker --reason "..."\n  facts add --fact "..." --source path:line|human | facts add --assumption "..."\n  task close TASK-ID [--residual-risk "..."]\n  version');
    default:
      return fail('unknown command "' + cmd + '". Run engos help.');
  }
}

main();
