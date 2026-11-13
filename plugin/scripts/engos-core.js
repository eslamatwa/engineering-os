'use strict';
// Engineering OS — shared core for the hook script and the engos CLI.
// No dependencies beyond Node built-ins and the vendored js-yaml (D40).
// Never log or persist environment variables: they include the user's email and account IDs (D42).

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
// Loaded on first use: the gate's common path never parses YAML, and Node start-up dominates hook latency.
let _yaml = null;
function yamlLib() {
  if (!_yaml) _yaml = require('./vendor/js-yaml.min.js');
  return _yaml;
}

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const ENGOS_DIR = '.engos';

// ---------------------------------------------------------------------------
// Defaults (compiled from config/*.yaml by tools/build-defaults.js)
// ---------------------------------------------------------------------------
let _defaults = null;
function defaults() {
  if (_defaults) return _defaults;
  const dir = path.join(PLUGIN_ROOT, 'defaults');
  _defaults = {
    rules: JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8')),
    policies: JSON.parse(fs.readFileSync(path.join(dir, 'policies.json'), 'utf8')),
    agents: JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')),
  };
  return _defaults;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function findProjectRoot(start) {
  if (!start) return null;
  let dir = path.resolve(start);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, ENGOS_DIR)).isDirectory()) return dir;
    } catch (_) { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function engosPath(root, ...parts) {
  return path.join(root, ENGOS_DIR, ...parts);
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function readYaml(file) {
  return yamlLib().load(fs.readFileSync(file, 'utf8'));
}

function writeYaml(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yamlLib().dump(data, { lineWidth: 120, noRefs: true }), 'utf8');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Ledger (append-only; hooks and the CLI only)
// ---------------------------------------------------------------------------
function ledger(root, event) {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, event)) + '\n';
  fs.mkdirSync(engosPath(root, 'sessions'), { recursive: true });
  const file = engosPath(root, 'ledger.jsonl');
  fs.appendFileSync(file, line, 'utf8');
  // Record the expected size so the observer can tell our appends from anyone else's (D37).
  try { fs.writeFileSync(engosPath(root, 'sessions', 'ledger.size'), String(fs.statSync(file).size), 'utf8'); } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function claudeCodeVersion() {
  const exe = process.env.CLAUDE_CODE_EXECPATH;
  if (!exe) return null;
  try {
    const out = cp.execFileSync(exe, ['--version'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseVersion(out);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------
function loadProjectConfig(root) {
  const file = engosPath(root, 'config.yaml');
  if (!fs.existsSync(file)) return { ok: false, error: '.engos/config.yaml is missing' };
  let cfg;
  try {
    cfg = readYaml(file);
  } catch (e) {
    return { ok: false, error: '.engos/config.yaml is not valid YAML: ' + String(e.message).split('\n')[0] };
  }
  const problems = [];
  if (!cfg || typeof cfg !== 'object') problems.push('file is empty');
  else {
    if (cfg.schema !== 'engos/project-config@1') problems.push('schema must be engos/project-config@1');
    if (!cfg.models || !Array.isArray(cfg.models.available) || cfg.models.available.length === 0) problems.push('models.available must list at least one model');
    if (cfg.checks && typeof cfg.checks !== 'object') problems.push('checks must be a map of name: command');
    if (cfg.protected_paths && typeof cfg.protected_paths !== 'object') problems.push('protected_paths must be a map');
    if (cfg.known_commands && !Array.isArray(cfg.known_commands)) problems.push('known_commands must be a list');
  }
  if (problems.length) return { ok: false, error: '.engos/config.yaml: ' + problems.join('; ') };
  return { ok: true, config: cfg };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------
function isGitRepo(root) {
  try {
    const out = cp.execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() === 'true';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session self-check (H1). Result is cached per session in .engos/sessions/.
// mode: normal | read_only. Hard problems force read_only; soft ones only warn.
// ---------------------------------------------------------------------------
function selfCheck(root, opts) {
  const options = opts || {};
  const hard = [];
  const warn = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) hard.push('Node ' + process.versions.node + ' is too old; install Node 18 or newer.');

  if (!isGitRepo(root)) hard.push('This folder is not a git repo. Edits need git (D11). Run git init, or accept it in /engos:init.');

  const cfg = loadProjectConfig(root);
  if (!cfg.ok) hard.push(cfg.error + '. Fix the file or run /engos:init again.');

  let version = null;
  if (!options.skipVersion) {
    const min = parseVersion(defaults().policies.platform.min_claude_code_version);
    version = options.version || claudeCodeVersion();
    if (!version) warn.push('Could not read the Claude Code version. Make sure it is ' + defaults().policies.platform.min_claude_code_version + ' or newer.');
    else if (min && compareVersions(version, min) < 0) {
      hard.push('Claude Code ' + version.join('.') + ' is older than ' + min.join('.') + ', the oldest version Engineering OS is tested on. Update Claude Code.');
    }
  }

  return {
    mode: hard.length ? 'read_only' : 'normal',
    hard,
    warn,
    claude_code_version: version ? version.join('.') : null,
    config: cfg.ok ? cfg.config : null,
  };
}

function sessionFile(root, sessionId) {
  return engosPath(root, 'sessions', safeId(sessionId) + '.json');
}

function loadSession(root, sessionId) {
  return readJson(sessionFile(root, sessionId), null);
}

function saveSession(root, sessionId, data) {
  writeJson(sessionFile(root, sessionId), data);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
function tasksDir(root) {
  return engosPath(root, 'tasks');
}

// Task profiles are JSON: local machine state read on every gated call, written only by hooks and the CLI.
function profileFile(root, id) {
  return path.join(tasksDir(root), id, 'profile.json');
}

function loadProfile(root, id) {
  return readJson(profileFile(root, id), null);
}

function saveProfile(root, profile) {
  writeJson(profileFile(root, profile.task_id), profile);
}

function listTasks(root) {
  const dir = tasksDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => /^TASK-\d+$/.test(d))
    .sort()
    .map((id) => loadProfile(root, id) || { task_id: id, status: 'unreadable' });
}

function nextTaskId(root) {
  const dir = tasksDir(root);
  const nums = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^TASK-\d+$/.test(d)).map((d) => Number(d.slice(5))) : [];
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'TASK-' + String(n).padStart(3, '0');
}

function isOpen(t) {
  return t && t.status && t.status !== 'closed' && t.status !== 'unreadable';
}

// The task this session is working on: the one recorded in the session file, else the newest
// open task bound to this session, else the newest open task with no session (claimed now).
function activeTask(root, sessionId) {
  const s = loadSession(root, sessionId);
  if (s && s.active_task) {
    const p = loadProfile(root, s.active_task);
    if (isOpen(p)) return p;
  }
  const open = listTasks(root).filter(isOpen);
  let t = open.filter((x) => x.session_id === sessionId).pop();
  if (!t) {
    t = open.filter((x) => !x.session_id).pop();
    if (t && sessionId) { t.session_id = sessionId; saveProfile(root, t); }
  }
  if (t && s) { s.active_task = t.task_id; saveSession(root, sessionId, s); }
  return t || null;
}

function protectedFor(config) {
  return require('./engos-rules.js').effectiveProtected(defaults().rules, config || {});
}

// Open a task with a baseline of the repo so later changes can be measured (D37).
function openTask(root, sessionId, opts) {
  const o = opts || {};
  const observeLib = require('./engos-observe.js');
  const cfg = loadProjectConfig(root);
  const prot = protectedFor(cfg.ok ? cfg.config : {});
  const id = nextTaskId(root);
  const now = new Date().toISOString();
  const cls = o.cls || 'question';
  const profile = {
    schema: 'engos/task-profile@1',
    task_id: id,
    status: o.state || 'open',
    session_id: sessionId || null,
    opened_at: now,
    opened_by: o.openedBy || 'lead',
    request: { summary: o.summary || '' },
    declared: {},
    planned: {},
    observed: { files_touched: [], files_count: 0, files_created: 0, files_deleted: 0, lines_added: 0, lines_deleted: 0, modules: [], protected_hits: [] },
    effective: { class: cls, floor_sources: o.sources || [] },
    scope_amendments: 0,
    history: [{ at: now, from: null, to: cls, trigger: o.trigger || 'opened' }],
  };
  fs.mkdirSync(path.join(tasksDir(root), id), { recursive: true });
  writeJson(path.join(tasksDir(root), id, 'baseline.json'), observeLib.baseline(root, prot));
  saveProfile(root, profile);
  if (sessionId) {
    const s = loadSession(root, sessionId);
    if (s) { s.active_task = id; saveSession(root, sessionId, s); }
  }
  ledger(root, { type: 'task.opened', actor: { kind: o.actor || 'hook' }, task_id: id, opened_by: profile.opened_by, class: cls, session_id: sessionId || null });
  return profile;
}

function loadBaseline(root, id) {
  return readJson(path.join(tasksDir(root), id, 'baseline.json'), { git_head: null, dirty_at_open: {}, protected_snapshot: {} });
}

// Re-run the ratchet; record any change. Returns { raised, from, to, missing }.
function ratchet(root, profile, trigger, protectedPaths) {
  const R = require('./engos-rules.js');
  const r = R.recompute(profile, defaults().rules, protectedPaths);
  if (r.raised) {
    profile.effective.class = r.cls;
    profile.effective.floor_sources = r.sources;
    profile.history.push({ at: new Date().toISOString(), from: r.from, to: r.cls, trigger });
    ledger(root, { type: 'class.changed', actor: { kind: 'hook' }, task_id: profile.task_id, from: r.from, to: r.cls, rule_id: r.sources.join(','), trigger });
  }
  const missing = R.missingRequirements(profile);
  if (missing.length && profile.status === 'open') profile.status = 'upgrade_pending';
  if (!missing.length && profile.status === 'upgrade_pending') profile.status = 'open';
  return { raised: r.raised, from: r.from, to: profile.effective.class, missing };
}

module.exports = {
  PLUGIN_ROOT,
  ENGOS_DIR,
  yamlLib,
  defaults,
  findProjectRoot,
  engosPath,
  safeId,
  readYaml,
  writeYaml,
  readJson,
  writeJson,
  ledger,
  parseVersion,
  compareVersions,
  claudeCodeVersion,
  loadProjectConfig,
  isGitRepo,
  selfCheck,
  sessionFile,
  loadSession,
  saveSession,
  tasksDir,
  profileFile,
  loadProfile,
  saveProfile,
  listTasks,
  nextTaskId,
  isOpen,
  activeTask,
  protectedFor,
  openTask,
  loadBaseline,
  ratchet,
};
