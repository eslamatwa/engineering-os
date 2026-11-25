'use strict';
// Fixes from the first real install on a remote Linux machine (D55): a doctor that can't pass while the hooks
// are off, strict options, CR-safe arguments, an empty STATE template, the live view over an SSH tunnel.
// Run: node --test tests/unit/field-report.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');

const REPO = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugin');
const CLI = path.join(PLUGIN, 'scripts', 'engos-cli.js');
const HOOK = path.join(PLUGIN, 'scripts', 'engos-hook.js');
const SID = 'sess-field';

function env(extra) {
  const e = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', ENGOS_HOME: path.join(os.tmpdir(), 'engos-field-home'), SSH_CONNECTION: '', SSH_CLIENT: '' }, extra || {});
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}
function cli(dir, args, extra, cliPath) { return cp.spawnSync(process.execPath, [cliPath || CLI].concat(args), { cwd: dir, encoding: 'utf8', env: env(extra) }); }
function hook(mode, dir, input) { return cp.spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(Object.assign({ session_id: SID, cwd: dir }, input)), encoding: 'utf8', env: env({ CLAUDE_CODE_SESSION_ID: SID }) }); }
function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-field-' + name + '-'));
  cp.execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
function noSession() { return { CLAUDE_CODE_SESSION_ID: undefined }; }

test('--help never runs a command; unknown options are refused and change nothing', () => {
  const dir = repo('help');
  const h = cli(dir, ['init', '--help']);
  assert.strictEqual(h.status, 0);
  assert.match(h.stdout, /Commands/);
  assert.ok(!fs.existsSync(path.join(dir, '.engos')), 'init --help must not initialise');
  const bad = cli(dir, ['init', '--modles', 'haiku']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown option for "init": --modles/);
  assert.ok(!fs.existsSync(path.join(dir, '.engos')), 'nothing created on a typo');
  assert.match(cli(dir, ['--version']).stdout, /^engos \d+\.\d+\.\d+/);
});

test('a CR at the end of an argument (launcher saved with Windows line endings) changes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-field-cr-'));
  const r = cli(dir, ['init\r', '--git-init\r']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ran git init/);
  const d = cli(dir, ['doctor\r'], noSession());
  assert.doesNotMatch(d.stderr, /unknown command/);
  assert.match(d.stdout, /Project:/);
});

test('running init again says which answers were not applied', () => {
  const dir = repo('rerun');
  assert.strictEqual(cli(dir, ['init', '--models', 'haiku,sonnet']).status, 0);
  const again = cli(dir, ['init', '--models', 'haiku,sonnet,opus', '--check', 'test=node -e 0']);
  assert.strictEqual(again.status, 0);
  assert.match(again.stdout, /NOT APPLIED: --models, --check/);
  assert.match(fs.readFileSync(path.join(dir, '.engos', 'config.yaml'), 'utf8'), /available: \[haiku, sonnet\]/);
});

test('the STATE template records no example as a fact', () => {
  const dir = repo('state');
  cli(dir, ['init']);
  const s = fs.readFileSync(path.join(dir, '.engos', 'STATE.yaml'), 'utf8');
  const live = s.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.doesNotMatch(live, /verified|F-001|Example|PD-001/);
  assert.match(live, /facts: \[\]/);
});

test('doctor fails inside Claude Code when no hook has seen the session, and passes once one has', () => {
  const dir = repo('doctor');
  cli(dir, ['init']);
  const off = cli(dir, ['doctor'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.strictEqual(off.status, 1);
  assert.match(off.stdout, /BLOCKING: no Engineering OS hook has run in this Claude Code session/);
  assert.doesNotMatch(off.stdout, /All checks passed/);
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'engos doctor' } });
  const on = cli(dir, ['doctor'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.doesNotMatch(on.stdout, /no Engineering OS hook has run/);
  assert.strictEqual(on.status, 0, on.stdout);
  const outside = cli(dir, ['doctor'], noSession());
  assert.match(outside.stdout, /WARNING: not running inside Claude Code/);
});

test('doctor fails when the installed copy has no hooks/hooks.json (a synced copy that dropped it)', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-field-copy-'));
  fs.cpSync(PLUGIN, copy, { recursive: true });
  fs.rmSync(path.join(copy, 'hooks'), { recursive: true, force: true });
  const dir = repo('nohooks');
  cli(dir, ['init']);
  const r = cli(dir, ['doctor'], noSession(), path.join(copy, 'scripts', 'engos-cli.js'));
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /BLOCKING: this copy of the plugin has no working hooks\/hooks\.json/);
});

function get(port, p, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

test('live view over SSH: prints the tunnel command, accepts any loopback port, refuses other hosts', async () => {
  const dir = repo('ssh');
  cli(dir, ['init']);
  const port = 47000 + Math.floor(Math.random() * 2000);
  const child = cp.spawn(process.execPath, [CLI, 'view', '--serve', '--port', String(port)], { cwd: dir, env: env({ SSH_CONNECTION: '10.0.0.5 51000 192.168.100.66 22' }) });
  const out = await new Promise((resolve, reject) => {
    let o = '';
    child.stdout.on('data', (d) => { o += d; if (/Keep step 1 running/.test(o)) resolve(o); });
    setTimeout(() => reject(new Error('no output: ' + o)), 10000);
  });
  try {
    assert.match(out, new RegExp('ssh -N -L ' + port + ':127\\.0\\.0\\.1:' + port + ' \\S*@?192\\.168\\.100\\.66'));
    const prefix = /http:\/\/127\.0\.0\.1:\d+(\/[A-Za-z0-9_-]+\/)/.exec(out)[1];
    assert.strictEqual(await get(port, prefix, '127.0.0.1:9000'), 200, 'a tunnel on another local port works');
    assert.strictEqual(await get(port, prefix, 'localhost'), 200);
    assert.strictEqual(await get(port, prefix, 'evil.example:' + port), 403, 'DNS rebinding still refused');
  } finally { child.kill(); }
});

test('release hygiene: the sh launcher is LF and executable; attributes never rewrite content', () => {
  const run = (args) => cp.execFileSync('git', ['-C', REPO].concat(args), { encoding: 'utf8' });
  assert.match(run(['ls-files', '-s', 'plugin/bin/engos']), /^100755 /);
  assert.match(run(['ls-files', '--eol', 'plugin/bin/engos']), /^i\/lf\s/);
  assert.match(run(['ls-files', '--eol', 'plugin/hooks/hooks.json']), /^i\/lf\s/);
  const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
  assert.doesNotMatch(attrs, /export-ignore|filter=|eol=crlf/);
  const bin = fs.readFileSync(path.join(PLUGIN, 'bin', 'engos'), 'utf8');
  assert.ok(!bin.includes('\r'), 'no CR in the checked-out launcher');
});
