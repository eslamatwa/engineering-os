'use strict';
// Phase 4 tests: engos check (D36), evidence rules for closing a task, close confirmation for
// high_risk, criteria amendments. Run: node --test tests/unit/phase4.test.js
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

const SID = 'sess-p4';

function git(dir, args) {
  return cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, encoding: 'utf8' });
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function env(sid) {
  return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: sid || SID });
}
function hook(mode, dir, input, sid) {
  const s = sid || SID;
  const res = cp.spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(Object.assign({ session_id: s, cwd: dir }, input)), encoding: 'utf8', env: env(s) });
  let json = null; try { json = JSON.parse(res.stdout); } catch (_) { /* none */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}
function cli(dir, args, sid) {
  const res = cp.spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: env(sid) });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
function edit(dir, rel, text) {
  const pre = hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) } });
  assert.strictEqual(pre.code, 0, pre.stderr);
  write(dir, rel, text);
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) } });
}
function project(name, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p4-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'src/a.ts', 'a\n');
  write(dir, 'src/b.ts', 'b\n');
  write(dir, 'lib/c.ts', 'c\n');
  write(dir, 'src/d.ts', 'd\n');
  write(dir, 'src/e.ts', 'e\n');
  write(dir, 'src/auth/session.ts', 'export const timeout = 30;\n');
  const args = ['init'];
  for (const c of checks === undefined ? ['test=node -e 0'] : checks) args.push('--check', c);
  const r = cli(dir, args);
  assert.strictEqual(r.code, 0, r.stderr);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  hook('session-start', dir, { source: 'startup' });
  return dir;
}
function ledger(dir) {
  return fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}
function task(dir) {
  return core.activeTask(dir, SID);
}

// ---------------------------------------------------------------------------

test('A1 close path and C6: a trivial edit closes only after the check runs after the last change', () => {
  const dir = project('c6');
  edit(dir, 'src/a.ts', 'a2\n');
  const id = task(dir).task_id;
  let c = cli(dir, ['task', 'close', id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /run `engos check test`/);

  const chk = cli(dir, ['check', 'test']);
  assert.strictEqual(chk.code, 0, chk.stderr);
  assert.match(chk.stdout, /engos check test: passed \(exit 0/);
  assert.match(chk.stdout, new RegExp('recorded on ' + id));

  edit(dir, 'src/a.ts', 'a3\n'); // change after the check
  c = cli(dir, ['task', 'close', id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /again: it last ran before the latest change/);

  cli(dir, ['check', 'test']);
  c = cli(dir, ['task', 'close', id]);
  assert.strictEqual(c.code, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /Changed files: src\/a\.ts/);
  assert.match(c.stdout, /Evidence: E-diff-shown; E-checks \(test\)/);
  const closed = core.loadProfile(dir, id);
  assert.strictEqual(closed.status, 'closed');
  assert.ok(ledger(dir).some((e) => e.type === 'task.closed' && e.evidence_checked === true));
});

test('C7: running the check command by hand is not evidence', () => {
  const dir = project('c7');
  edit(dir, 'src/a.ts', 'x\n');
  const id = task(dir).task_id;
  const pre = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node -e 0; echo $?' } });
  assert.strictEqual(pre.code, 0);
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node -e 0; echo $?' } });
  assert.ok(!ledger(dir).some((e) => e.type === 'evidence.recorded'));
  assert.strictEqual(cli(dir, ['task', 'close', id]).code, 1);
});

test('a failing check is recorded with its real exit code and blocks closing', () => {
  const dir = project('fail', ['test=node -e "process.exit(3)"']);
  edit(dir, 'src/a.ts', 'x\n');
  const id = task(dir).task_id;
  const chk = cli(dir, ['check', 'test']);
  assert.strictEqual(chk.code, 1);
  assert.match(chk.stdout, /FAILED \(exit 3/);
  const ev = ledger(dir).find((e) => e.type === 'evidence.recorded');
  assert.strictEqual(ev.exit, 3);
  assert.ok(!('output' in ev), 'command output is never stored');
  assert.ok(!('output' in task(dir).evidence.checks[0]));
  const c = cli(dir, ['task', 'close', id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /must pass \(last exit code 3\)/);
});

test('an unknown check name is refused with the configured names', () => {
  const dir = project('unknown');
  const r = cli(dir, ['check', 'lint']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no check named "lint".*Configured: test/);
});

test('a trivial task with no checks configured closes and says so', () => {
  const dir = project('nochecks', []);
  edit(dir, 'src/a.ts', 'x\n');
  const c = cli(dir, ['task', 'close', task(dir).task_id]);
  assert.strictEqual(c.code, 0, c.stdout);
  assert.match(c.stdout, /no checks configured/);
});

test('a standard task needs scope, checks and residual risk; pre-upgrade changes count as in scope', () => {
  const dir = project('standard');
  edit(dir, 'src/a.ts', 'x\n');
  edit(dir, 'src/b.ts', 'y\n');
  edit(dir, 'src/d.ts', 'y\n');
  edit(dir, 'src/e.ts', 'y\n');
  const pre = hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'lib/c.ts') } });
  assert.strictEqual(pre.code, 2, 'fifth file raises to standard');
  const id = task(dir).task_id;
  assert.deepStrictEqual(task(dir).pre_upgrade_files.sort(), ['src/a.ts', 'src/b.ts', 'src/d.ts', 'src/e.ts']);
  cli(dir, ['profile', 'set', '--kind', 'refactor']);
  cli(dir, ['plan', 'set', '--scope-write', 'lib/**', '--acceptance', 'tests pass; c is renamed']);
  edit(dir, 'lib/c.ts', 'c2\n');
  cli(dir, ['check', 'test']);
  let c = cli(dir, ['task', 'close', id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /residual risk/);
  assert.doesNotMatch(c.stdout, /outside the plan scope/, 'files changed before the upgrade are in scope');
  c = cli(dir, ['task', 'close', id, '--residual-risk', 'none']);
  assert.strictEqual(c.code, 0, c.stdout);
  assert.match(c.stdout, /E-scope; E-residual-risk/);
  assert.strictEqual(core.loadProfile(dir, id).residual_risk, 'none');
});

test('a high_risk task needs the user to confirm the close, from the same session', () => {
  const dir = project('highrisk');
  cli(dir, ['task', 'open', '--summary', 'auth timeout']);
  cli(dir, ['profile', 'set', '--kind', 'bugfix', '--sensitivity', 'auth']);
  cli(dir, ['plan', 'set', '--scope-write', 'src/auth/**']);
  const id = task(dir).task_id;
  hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } }); // asks
  write(dir, 'src/auth/session.ts', 'export const timeout = 60;\n');
  hook('post-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } }); // allowed
  cli(dir, ['check', 'test']);
  let c = cli(dir, ['task', 'close', id, '--residual-risk', 'sessions last longer']);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /E-review-record: an independent validator review/); // phase 5
  assert.notStrictEqual(core.loadProfile(dir, id).awaiting_close_ack, true);
  // A validator review as the SubagentStop hook records it (tested end to end in phase5.test.js).
  const p = core.loadProfile(dir, id);
  p.reviews = [{ step: 'S9', verdict: 'pass', refs_ok: true, report_ok: true, at: new Date().toISOString() }];
  core.saveProfile(dir, p);
  c = cli(dir, ['task', 'close', id, '--residual-risk', 'sessions last longer']);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /\/engos:decide .* close/);
  assert.match(c.stdout, /E-review-record \(S9\)/);
  assert.strictEqual(core.loadProfile(dir, id).awaiting_close_ack, true);

  const other = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + id + ' close' }, 'another-session');
  assert.match(other.json.systemMessage, /another session/);
  const ok = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + id + ' close' });
  assert.match(ok.json.systemMessage, /close confirmed/);
  c = cli(dir, ['task', 'close', id]);
  assert.strictEqual(c.code, 0, c.stdout);
  assert.ok(ledger(dir).some((e) => e.type === 'close.acknowledged' && e.actor.kind === 'human'));
});

test('criteria amendments: recorded in standard, decided by the user in high_risk', () => {
  const dir = project('criteria');
  cli(dir, ['task', 'open', '--summary', 'x']);
  cli(dir, ['profile', 'set', '--kind', 'feature']);
  cli(dir, ['plan', 'set', '--scope-write', 'src/**', '--acceptance', 'a works']);
  const t = task(dir); t.effective.class = 'standard'; core.saveProfile(dir, t);
  let r = cli(dir, ['criteria', 'amend', '--set', 'a works; b works', '--reason', 'b was missing']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(task(dir).planned.acceptance.length, 2);
  assert.ok(ledger(dir).some((e) => e.type === 'criteria.amended' && e.reason === 'b was missing'));

  const t2 = task(dir); t2.effective.class = 'high_risk'; core.saveProfile(dir, t2);
  r = cli(dir, ['criteria', 'amend', '--set', 'only a', '--reason', 'b is hard']);
  assert.match(r.stdout, /the user decides/);
  assert.strictEqual(task(dir).status, 'needs_human');
  const d = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + t2.task_id + ' reject_amendment' });
  assert.match(d.json.systemMessage, /amendment rejected/);
  const after = task(dir);
  assert.strictEqual(after.status, 'open');
  assert.strictEqual(after.planned.acceptance.length, 2, 'rejected: criteria unchanged');
});

test('a task waiting for a decision cannot close', () => {
  const dir = project('blocked');
  write(dir, 'tool.js', "require('fs').writeFileSync('src/auth/session.ts', 'x\\n');\n");
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'tool']);
  cli(dir, ['task', 'open', '--summary', 'x']);
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node tool.js' } });
  cp.spawnSync('node tool.js', { cwd: dir, shell: true });
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node tool.js' } });
  const c = cli(dir, ['task', 'close', task(dir).task_id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /a decision from the user/);
});
