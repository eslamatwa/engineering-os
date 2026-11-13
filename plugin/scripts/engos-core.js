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
  fs.mkdirSync(engosPath(root), { recursive: true });
  fs.appendFileSync(engosPath(root, 'ledger.jsonl'), line, 'utf8');
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

function listTasks(root) {
  const dir = tasksDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((d) => /^TASK-\d+$/.test(d))
    .sort()
    .map((id) => {
      const file = path.join(dir, id, 'profile.yaml');
      try { return readYaml(file); } catch (_) { return { task_id: id, status: 'unreadable' }; }
    });
}

function nextTaskId(root) {
  const nums = listTasks(root).map((t) => Number(String(t.task_id || '').replace('TASK-', ''))).filter((n) => !isNaN(n));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'TASK-' + String(n).padStart(3, '0');
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
  listTasks,
  nextTaskId,
};
