'use strict';
// Phase 1 unit tests: hook fast exit, self-check, read-only gate, init, tasks.
// Run: node --test tests/unit
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'plugin', 'scripts', 'engos-hook.js');
const CLI = path.join(REPO, 'plugin', 'scripts', 'engos-cli.js');
const core = require(path.join(REPO, 'plugin', 'scripts', 'engos-core.js'));

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-' + name + '-'));
  return d;
}

function gitInit(dir) {
  cp.execFileSync('git', ['init', '-q'], { cwd: dir });
}

function runHook(mode, input, env) {
  const res = cp.spawnSync(process.execPath, [HOOK, mode], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '' }, env || {}),
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runCli(args, cwd) {
  const res = cp.spawnSync(process.execPath, [CLI].concat(args), { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function initProject(name, extra) {
  const dir = tmpDir(name);
  gitInit(dir);
  const r = runCli(['init', '--check', 'test=npm test'].concat(extra || []), dir);
  assert.strictEqual(r.code, 0, r.stderr);
  return dir;
}

test('hooks stay silent outside an Engineering OS project', () => {
  const dir = tmpDir('plain');
  for (const mode of ['session-start', 'pre-tool-use']) {
    const r = runHook(mode, { session_id: 's1', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'a.txt') } });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout, '');
  }
});

test('init creates project files, gitignore entries and is idempotent (F1)', () => {
  const dir = initProject('init', ['--deny-rules', '--known', 'npm run build']);
  for (const f of ['config.yaml', 'BRIEF.md', 'STATE.yaml']) assert.ok(fs.existsSync(path.join(dir, '.engos', f)), f);
  const cfg = core.loadProjectConfig(dir);
  assert.ok(cfg.ok, cfg.error);
  assert.deepStrictEqual(cfg.config.models.available, ['haiku', 'sonnet', 'opus']);
  assert.strictEqual(cfg.config.checks.test, 'npm test');
  assert.deepStrictEqual(cfg.config.known_commands, ['npm run build']);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  for (const l of ['.engos/tasks/', '.engos/approvals/', '.engos/ledger.jsonl', '.engos/sessions/']) assert.ok(gi.includes(l), l);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes('Edit(./.engos/approvals/**)'));

  fs.writeFileSync(path.join(dir, '.engos', 'BRIEF.md'), 'my brief');
  const again = runCli(['init'], dir);
  assert.strictEqual(again.code, 0, again.stderr);
  assert.match(again.stdout, /left unchanged/);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.engos', 'BRIEF.md'), 'utf8'), 'my brief');
  const gi2 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.strictEqual(gi2.split('.engos/tasks/').length - 1, 1, 'gitignore lines not duplicated');
});

test('session start in a healthy project: normal mode, context, ledger', () => {
  const dir = initProject('healthy');
  const r = runHook('session-start', { session_id: 'sess-ok', cwd: dir, source: 'startup' });
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Session mode: normal/);
  const s = core.loadSession(dir, 'sess-ok');
  assert.strictEqual(s.mode, 'normal');
  const led = fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8');
  assert.match(led, /"type":"session.started"/);
  assert.doesNotMatch(led, /@/, 'ledger must not contain emails or env data');
});

test('broken config makes the session read-only and tells the user', () => {
  const dir = initProject('broken');
  fs.writeFileSync(path.join(dir, '.engos', 'config.yaml'), 'schema: [unclosed');
  const r = runHook('session-start', { session_id: 'sess-bad', cwd: dir });
  assert.strictEqual(r.code, 0, 'session start never blocks');
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /read-only/);
  assert.strictEqual(core.loadSession(dir, 'sess-bad').mode, 'read_only');
});

test('a folder without git is read-only (D11)', () => {
  const dir = tmpDir('nogit');
  const r0 = runCli(['init'], dir);
  assert.strictEqual(r0.code, 0, r0.stderr);
  assert.match(r0.stdout, /read-only/);
  const r = runHook('session-start', { session_id: 'sess-ng', cwd: dir });
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('not a git repo'), true);
});

test('read-only gate blocks writes, allows other tools, and logs the denial', () => {
  const dir = initProject('gate');
  fs.writeFileSync(path.join(dir, '.engos', 'config.yaml'), 'schema: nope\n');
  runHook('session-start', { session_id: 'sess-g', cwd: dir });
  const w = runHook('pre-tool-use', { session_id: 'sess-g', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'x.txt') } });
  assert.strictEqual(w.code, 2);
  assert.match(w.stderr, /read-only/);
  const b = runHook('pre-tool-use', { session_id: 'sess-g', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(b.code, 0);
  assert.match(fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8'), /"rule_id":"G-read-only-session"/);
});

test('healthy session allows writes', () => {
  const dir = initProject('allow');
  runHook('session-start', { session_id: 'sess-a', cwd: dir });
  const w = runHook('pre-tool-use', { session_id: 'sess-a', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'x.txt') } });
  assert.strictEqual(w.code, 0, w.stderr);
});

test('gate runs the self-check itself when session start did not run', () => {
  const dir = initProject('lazy');
  fs.writeFileSync(path.join(dir, '.engos', 'config.yaml'), 'schema: nope\n');
  const w = runHook('pre-tool-use', { session_id: 'sess-lazy', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'x.txt') } });
  assert.strictEqual(w.code, 2);
  assert.strictEqual(core.loadSession(dir, 'sess-lazy').source, 'lazy_check');
});

test('an internal gate error blocks; a session-start error does not (D42)', () => {
  const dir = initProject('throw');
  const g = runHook('pre-tool-use', { session_id: 's', cwd: dir, tool_name: 'Write' }, { ENGOS_TEST_THROW: 'pre-tool-use' });
  assert.strictEqual(g.code, 2);
  assert.match(g.stderr, /internal gate error/);
  const s = runHook('session-start', { session_id: 's', cwd: dir }, { ENGOS_TEST_THROW: 'session-start' });
  assert.strictEqual(s.code, 0);
  assert.match(JSON.parse(s.stdout).systemMessage, /session check failed/);
});

test('an older Claude Code makes the project read-only; unknown only warns (B9)', () => {
  const dir = initProject('ver');
  const old = core.selfCheck(dir, { version: [2, 1, 100] });
  assert.strictEqual(old.mode, 'read_only');
  assert.match(old.hard.join(' '), /older than 2\.1\.321/);
  const same = core.selfCheck(dir, { version: [2, 1, 321] });
  assert.strictEqual(same.mode, 'normal');
  const unknown = runHook('session-start', { session_id: 'sv', cwd: dir });
  const out = JSON.parse(unknown.stdout);
  assert.match(out.systemMessage, /Could not read the Claude Code version/);
  assert.strictEqual(core.loadSession(dir, 'sv').mode, 'normal');
});

test('task open, status and close', () => {
  const dir = initProject('tasks');
  const o = runCli(['task', 'open', '--summary', 'Fix login timeout'], dir);
  assert.strictEqual(o.code, 0, o.stderr);
  assert.strictEqual(o.stdout.trim(), 'TASK-001');
  assert.match(runCli(['task', 'status'], dir).stdout, /TASK-001\s+open\s+question\s+Fix login timeout/);
  assert.strictEqual(runCli(['task', 'open', '--summary', 'Second'], dir).stdout.trim(), 'TASK-002');
  const c = runCli(['task', 'close', 'TASK-001'], dir);
  assert.strictEqual(c.code, 0, c.stderr);
  assert.doesNotMatch(runCli(['task', 'status'], dir).stdout, /TASK-001/);
  assert.notStrictEqual(runCli(['task', 'close', 'TASK-001'], dir).code, 0);
});

test('version parsing and comparison', () => {
  assert.deepStrictEqual(core.parseVersion('2.1.321 (Claude Code)'), [2, 1, 321]);
  assert.strictEqual(core.parseVersion('nope'), null);
  assert.strictEqual(core.compareVersions([2, 1, 300], [2, 1, 321]), -1);
  assert.strictEqual(core.compareVersions([2, 2, 0], [2, 1, 321]), 1);
});
