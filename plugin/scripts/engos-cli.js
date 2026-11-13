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
    if (profile.status === 'needs_human') fail(id + ' is waiting for a human decision (' + (profile.needs_human_reason || '') + "). It can't be closed until that is resolved.");
    // Evidence requirements arrive in build phase 4.
    profile.status = 'closed';
    profile.closed_at = new Date().toISOString();
    profile.close_note = 'closed without evidence checks: evidence rules arrive in build phase 4';
    core.saveProfile(root, profile);
    core.ledger(root, { type: 'task.closed', actor: { kind: 'cli' }, task_id: id, evidence_checked: false });
    const sid = sessionId();
    if (sid) { const s = core.loadSession(root, sid); if (s && s.active_task === id) { s.active_task = null; core.saveSession(root, sid, s); } }
    console.log(id + ' closed.');
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
    steps: list(args.steps).map((s) => { const parts = s.split(':'); return { id: parts[0], kind: parts[1] || 'implement' }; }),
    set_at: new Date().toISOString(),
  };
  core.ledger(root, { type: 'plan.set', actor: { kind: 'cli' }, task_id: task.task_id, scope_write: write });
  const r = core.ratchet(root, task, 'plan', protectedPaths(root));
  report(root, task, r);
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
    case 'version':
    case '--version': return console.log('engos ' + VERSION);
    case undefined:
    case 'help':
    case '--help':
      return console.log('engos ' + VERSION + '\n\nCommands:\n  init [--models haiku,sonnet,opus] [--check name=cmd]... [--known cmd]... [--deny-rules] [--git-init]\n  doctor\n  task open --summary "..." | task status [TASK-ID] | task close TASK-ID\n  profile set --kind <kind> [--sensitivity a,b] [--reversibility easy|hard|irreversible] [--task ID]\n  plan set --scope-write "glob,glob" [--scope-read "..."] [--steps "S1:locate"] [--task ID]\n  scope amend --add "glob" --reason "..." [--task ID]\n  version');
    default:
      return fail('unknown command "' + cmd + '". Run engos help.');
  }
}

main();
