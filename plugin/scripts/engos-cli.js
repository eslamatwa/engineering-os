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
// task
// ---------------------------------------------------------------------------
function cmdTask(args) {
  const sub = args._[1];
  const root = requireRoot();
  if (sub === 'open') {
    const summary = args.summary || args._.slice(2).join(' ');
    if (!summary || summary === true) fail('task open needs --summary "what the task is"');
    const id = core.nextTaskId(root);
    const profile = {
      schema: 'engos/task-profile@1',
      task_id: id,
      status: 'open',
      session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
      opened_at: new Date().toISOString(),
      opened_by: args.by === 'human' ? 'human' : 'lead',
      request: { summary: String(summary) },
      effective: { class: 'question' },
      history: [{ at: new Date().toISOString(), from: null, to: 'question', trigger: 'opened' }],
    };
    core.writeYaml(path.join(core.tasksDir(root), id, 'profile.yaml'), profile);
    core.ledger(root, { type: 'task.opened', actor: { kind: 'cli' }, task_id: id, opened_by: profile.opened_by });
    console.log(id);
    return;
  }
  if (sub === 'status' || sub === undefined) {
    const tasks = core.listTasks(root);
    const want = args._[2];
    const shown = want ? tasks.filter((t) => t.task_id === want) : tasks.filter((t) => t.status !== 'closed');
    if (!shown.length) { console.log(want ? 'No task ' + want + '.' : 'No open tasks.'); return; }
    for (const t of shown) {
      console.log(t.task_id + '  ' + (t.status || '?') + '  ' + ((t.effective && t.effective.class) || '?') + '  ' + ((t.request && t.request.summary) || ''));
    }
    return;
  }
  if (sub === 'close') {
    const id = args._[2];
    if (!id) fail('task close needs a task id, e.g. engos task close TASK-001');
    const file = path.join(core.tasksDir(root), id, 'profile.yaml');
    if (!fs.existsSync(file)) fail('no task ' + id);
    const profile = core.readYaml(file);
    if (profile.status === 'closed') fail(id + ' is already closed');
    // Phase 1: evidence requirements are not enforced yet (phase 4 adds them).
    profile.status = 'closed';
    profile.closed_at = new Date().toISOString();
    profile.close_note = 'closed without evidence checks: evidence rules arrive in build phase 4';
    core.writeYaml(file, profile);
    core.ledger(root, { type: 'task.closed', actor: { kind: 'cli' }, task_id: id, evidence_checked: false });
    console.log(id + ' closed.');
    return;
  }
  fail('unknown task command "' + sub + '". Use open, status or close.');
}

// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'init': return cmdInit(args);
    case 'doctor': return cmdDoctor();
    case 'task': return cmdTask(args);
    case 'version':
    case '--version': return console.log('engos ' + VERSION);
    case undefined:
    case 'help':
    case '--help':
      return console.log('engos ' + VERSION + '\n\nCommands:\n  init [--models haiku,sonnet,opus] [--check name=cmd]... [--known cmd]... [--deny-rules] [--git-init]\n  doctor\n  task open --summary "..." | task status [TASK-ID] | task close TASK-ID\n  version');
    default:
      return fail('unknown command "' + cmd + '". Run engos help.');
  }
}

main();
