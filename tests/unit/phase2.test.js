'use strict';
// Phase 2 tests: write gate, Bash gate, observer, class ratchet.
// Scenario IDs refer to tests/acceptance-scenarios.md. Run: node --test tests/unit/phase2.test.js
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
const rules = require(path.join(REPO, 'plugin', 'scripts', 'engos-rules.js'));

const SID = 'sess-p2';
const ENV = { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: SID };

function git(dir, args) {
  return cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, encoding: 'utf8' });
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function lines(n, tag) {
  return Array.from({ length: n }, (_, i) => (tag || 'line') + ' ' + i).join('\n') + '\n';
}

// A committed repo with Engineering OS initialised and a session started.
function project(name, initArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p2-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'utils/io.py', 'tmp = 1\nprint(tmp)\n');
  write(dir, 'src/auth/session.ts', 'export const timeout = 30;\n');
  write(dir, 'src/session/refresh.ts', 'export function refresh() {}\n');
  write(dir, 'src/billing/x.ts', 'export const price = 1;\n');
  write(dir, 'README.md', '# demo\n');
  write(dir, '.gitignore', '.env\n');
  write(dir, '.env', 'SECRET=a\n');
  const r = cli(dir, ['init', '--check', 'test=node -e 0'].concat(initArgs || []));
  assert.strictEqual(r.code, 0, r.stderr);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  hook('session-start', dir, {});
  return dir;
}

function hook(mode, dir, input) {
  const res = cp.spawnSync(process.execPath, [HOOK, mode], {
    input: JSON.stringify(Object.assign({ session_id: SID, cwd: dir }, input)),
    encoding: 'utf8',
    env: Object.assign({}, process.env, ENV),
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json: safeJson(res.stdout) };
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

function cli(dir, args) {
  const res = cp.spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, ENV) });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Simulate a file edit: gate, then write if allowed, then observe.
function edit(dir, rel, text, tool) {
  const t = tool || 'Write';
  const pre = hook('pre-tool-use', dir, { tool_name: t, tool_input: { file_path: path.join(dir, rel) } });
  if (pre.code !== 0) return { allowed: false, pre };
  if (asks(pre)) return { allowed: false, asked: true, pre };
  write(dir, rel, text);
  const post = hook('post-tool-use', dir, { tool_name: t, tool_input: { file_path: path.join(dir, rel) } });
  return { allowed: true, pre, post };
}

// Simulate a Bash call: gate, then run if allowed, then observe.
function bash(dir, command) {
  const pre = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command } });
  if (pre.code !== 0) return { allowed: false, pre };
  if (asks(pre)) return { allowed: false, asked: true, pre };
  cp.spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8' });
  const post = hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command } });
  return { allowed: true, pre, post };
}

function asks(r) {
  return r.code === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'ask';
}

function active(dir) {
  return core.activeTask(dir, SID);
}

// ---------------------------------------------------------------------------

test('A1: a small edit opens a trivial task by itself and is allowed', () => {
  const dir = project('a1');
  const e = edit(dir, 'utils/io.py', 'buffer = 1\nprint(buffer)\n', 'Edit');
  assert.ok(e.allowed, e.pre && e.pre.stderr);
  const t = active(dir);
  assert.strictEqual(t.effective.class, 'trivial_edit');
  assert.strictEqual(t.opened_by, 'auto');
  assert.strictEqual(t.status, 'open');
  assert.deepStrictEqual(t.observed.files_touched, ['utils/io.py']);
  assert.strictEqual(t.observed.lines_added, 2);
  assert.strictEqual(e.post.json, null, 'no message for a normal small edit');
});

test('A2: going past the trivial budget raises the class and waits for a plan', () => {
  const dir = project('a2');
  assert.ok(edit(dir, 'a.txt', 'a\n').allowed);
  assert.ok(edit(dir, 'utils/io.py', 'x = 2\n').allowed);
  const third = edit(dir, 'README.md', '# changed\n');
  assert.strictEqual(third.allowed, false);
  assert.match(third.pre.stderr, /raises the task from trivial_edit to standard/);
  let t = active(dir);
  assert.strictEqual(t.effective.class, 'standard');
  assert.strictEqual(t.status, 'upgrade_pending');
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'earlier changes stay');

  assert.strictEqual(cli(dir, ['profile', 'set', '--kind', 'refactor']).code, 0);
  const plan = cli(dir, ['plan', 'set', '--scope-write', 'README.md,utils/**,a.txt']);
  assert.strictEqual(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /Edits can continue/);
  t = active(dir);
  assert.strictEqual(t.status, 'open');
  assert.ok(edit(dir, 'README.md', '# changed\n').allowed);
});

test('A2: too many changed lines raises the class after the edit', () => {
  const dir = project('a2b');
  const e = edit(dir, 'notes.js', lines(60));
  assert.ok(e.allowed);
  assert.match(e.post.json.reason, /now standard/);
  assert.strictEqual(active(dir).effective.class, 'standard');
  assert.strictEqual(edit(dir, 'utils/io.py', 'y\n').allowed, false);
});

test('A3: an edit to a protected path is blocked before it happens', () => {
  const dir = project('a3');
  const before = fs.readFileSync(path.join(dir, 'src/auth/session.ts'), 'utf8');
  const e = edit(dir, 'src/auth/session.ts', 'export const timeout = 60;\n', 'Edit');
  assert.strictEqual(e.allowed, false);
  assert.match(e.pre.stderr, /protected path, so this is a high_risk task/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'src/auth/session.ts'), 'utf8'), before);
  const t = active(dir);
  assert.strictEqual(t.effective.class, 'high_risk');
  assert.strictEqual(t.status, 'upgrade_pending');

  // With a profile and plan, the protected file itself asks the user (D46).
  cli(dir, ['profile', 'set', '--kind', 'bugfix']);
  cli(dir, ['plan', 'set', '--scope-write', 'src/auth/**']);
  const again = edit(dir, 'src/auth/session.ts', 'x\n', 'Edit');
  assert.strictEqual(again.asked, true);
  assert.match(again.pre.json.hookSpecificOutput.permissionDecisionReason, /protected file/);
});

test('A4: a sensitivity flag in any language raises the class before any edit', () => {
  const dir = project('a4');
  const o = cli(dir, ['task', 'open', '--summary', 'عدّل مدة انتهاء جلسة تسجيل الدخول']);
  assert.strictEqual(o.code, 0, o.stderr);
  const p = cli(dir, ['profile', 'set', '--kind', 'bugfix', '--sensitivity', 'auth']);
  assert.match(p.stdout, /class high_risk/);
  const t = active(dir);
  assert.ok(t.effective.floor_sources.includes('F-sensitivity:auth'));
  assert.strictEqual(t.status, 'upgrade_pending');
});

test('A5: writes outside the plan scope are blocked; scope widens at most twice and never to protected paths', () => {
  const dir = project('a5');
  cli(dir, ['task', 'open', '--summary', 'refresh fix']);
  cli(dir, ['profile', 'set', '--kind', 'feature']);
  cli(dir, ['plan', 'set', '--scope-write', 'src/session/**']);
  // a feature task: force standard so scope applies
  const t0 = active(dir); t0.effective.class = 'standard'; core.saveProfile(dir, t0);

  assert.ok(edit(dir, 'src/session/refresh.ts', 'export function refresh() { return 1; }\n').allowed);
  const out = edit(dir, 'src/billing/x.ts', 'export const price = 2;\n');
  assert.strictEqual(out.allowed, false);
  assert.match(out.pre.stderr, /outside the plan's write scope/);

  assert.strictEqual(cli(dir, ['scope', 'amend', '--add', 'src/auth/**', '--reason', 'need it']).code, 1, 'protected path refused');
  assert.strictEqual(cli(dir, ['scope', 'amend', '--add', 'src/billing/**', '--reason', 'price lives here']).code, 0);
  assert.ok(edit(dir, 'src/billing/x.ts', 'export const price = 2;\n').allowed);
  assert.strictEqual(cli(dir, ['scope', 'amend', '--add', 'docs/**', '--reason', 'docs']).code, 0);
  const third = cli(dir, ['scope', 'amend', '--add', 'lib/**', '--reason', 'more']);
  assert.strictEqual(third.code, 1);
  assert.match(third.stderr, /already widened 2 times/);
});

test('A6: a script that rewrites a gitignored protected file is caught after the fact', () => {
  const dir = project('a6');
  write(dir, 'scripts/setup.js', "require('fs').writeFileSync('.env', 'SECRET=changed-by-script\\n');\n");
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'script']);
  cli(dir, ['task', 'open', '--summary', 'setup']);
  const b = bash(dir, 'node scripts/setup.js');
  assert.ok(b.allowed, b.pre && b.pre.stderr);
  assert.match(b.post.json.reason, /\.env/);
  assert.match(b.post.json.reason, /needs the user's decision/);
  const t = active(dir);
  assert.strictEqual(t.status, 'needs_human');
  assert.strictEqual(edit(dir, 'utils/io.py', 'z\n').allowed, false, 'edits blocked until a human decides');
  assert.match(fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8'), /"type":"violation.detected"/);
});

test('A7: new, staged and renamed files all count toward the budget', () => {
  const dir = project('a7');
  const b = bash(dir, 'node -e "require(\'fs\').writeFileSync(\'new.txt\',\'n\\n\');require(\'fs\').appendFileSync(\'README.md\',\'more\\n\')" && git add README.md && git mv utils/io.py utils/io2.py');
  assert.ok(b.allowed, b.pre && b.pre.stderr);
  const t = active(dir);
  const touched = t.observed.files_touched.join(' ');
  assert.match(touched, /new\.txt/);
  assert.match(touched, /README\.md/, 'staged change counts');
  assert.match(touched, /utils\/io2\.py/);
  assert.ok(t.observed.files_created >= 1);
  assert.strictEqual(t.effective.class, 'standard', 'more than 2 files: raised');
});

test('A8: unknown commands need approval in high_risk tasks unless listed as known', () => {
  const dir = project('a8', ['--known', 'npm run build']);
  cli(dir, ['task', 'open', '--summary', 'migration']);
  cli(dir, ['profile', 'set', '--kind', 'migration', '--reversibility', 'hard']);
  assert.strictEqual(active(dir).effective.class, 'high_risk');
  const early = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'python migrate_helper.py' } });
  assert.strictEqual(early.code, 2, 'without a plan the task is still waiting on its requirements');
  cli(dir, ['plan', 'set', '--scope-write', 'db/**']);
  const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'python migrate_helper.py' } });
  assert.ok(asks(p), p.stderr);
  assert.match(p.json.hookSpecificOutput.permissionDecisionReason, /being asked to allow/);
  const k = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'npm run build' } });
  assert.strictEqual(k.code, 0, k.stderr);
});

test('B4 (Bash part): running claude from Bash is always blocked', () => {
  const dir = project('b4');
  for (const cmd of ['claude -p "/engos:approve APR-12345678"', 'echo $(claude -p hi)', 'FOO=1 /usr/local/bin/claude --resume abc']) {
    const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } });
    assert.strictEqual(p.code, 2, cmd);
    assert.match(p.stderr, /never allowed from Bash/);
  }
});

test('B7 (never part): Engineering OS records and Claude settings can never be edited', () => {
  const dir = project('b7');
  for (const rel of ['.engos/ledger.jsonl', '.engos/approvals/APR-1.yaml', '.claude/settings.json', '.claude/settings.local.json']) {
    const e = edit(dir, rel, 'x');
    assert.strictEqual(e.allowed, false, rel);
    assert.match(e.pre.stderr, /can never be edited directly/);
  }
  const redirect = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'echo forged >> .engos/ledger.jsonl' } });
  assert.strictEqual(redirect.code, 2);
});

test('ledger tampering by a script is detected', () => {
  const dir = project('tamper');
  write(dir, 'tamper.js', "require('fs').appendFileSync(require('path').join('.engos','ledger' + '.jsonl'), '{\"type\":\"approval.granted\"}\\n');\n");
  cli(dir, ['task', 'open', '--summary', 'x']);
  const b = bash(dir, 'node tamper.js');
  assert.ok(b.allowed, 'the command itself looks harmless');
  assert.match(b.post.json.reason, /ledger/);
  assert.strictEqual(active(dir).status, 'needs_human');
});

test('installing packages makes the task standard', () => {
  const dir = project('pkg');
  const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } });
  assert.strictEqual(p.code, 2);
  assert.match(p.stderr, /Installing packages makes this a standard task/);
  assert.strictEqual(active(dir).effective.class, 'standard');
});

test('reads, checks and engos commands never open tasks', () => {
  const dir = project('reads');
  for (const cmd of ['ls -la', 'git status && git log -1', 'cat .engos/ledger.jsonl', 'engos task status', 'engos check test']) {
    const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } });
    assert.strictEqual(p.code, 0, cmd + ': ' + p.stderr);
  }
  assert.strictEqual(active(dir), null);
});

test('push, network and destructive commands ask the user in any class', () => {
  const dir = project('approval');
  for (const cmd of ['git push origin main', 'curl https://example.com', 'rm -rf build', 'git reset --hard HEAD~1']) {
    const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } });
    assert.ok(asks(p), cmd + ': ' + p.stderr);
  }
});

test('a read-only session lets read commands through and blocks the rest', () => {
  const dir = project('ro');
  fs.writeFileSync(path.join(dir, '.engos', 'config.yaml'), 'schema: broken\n');
  hook('session-start', dir, {});
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git status' } }).code, 0);
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node build.js' } }).code, 2);
});

test('changes that existed before the task opened are not counted', () => {
  const dir = project('dirty');
  write(dir, 'README.md', '# edited by the user before\n' + lines(50, 'user'));
  const e = edit(dir, 'utils/io.py', 'a = 1\n');
  assert.ok(e.allowed);
  const t = active(dir);
  assert.deepStrictEqual(t.observed.files_touched, ['utils/io.py']);
  assert.strictEqual(t.effective.class, 'trivial_edit');
});

test('rules: glob, split and classify edge cases', () => {
  const R = rules;
  assert.strictEqual(R.protectedLevel('a/b/.env.production', { high_risk: ['**/.env*'] }), 'high_risk');
  assert.strictEqual(R.protectedLevel('package.json', { standard: ['package.json'] }), 'standard');
  assert.deepStrictEqual(R.splitCommand('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(R.splitCommand('git commit -m "a && b"'), ['git commit -m "a && b"']);
  assert.deepStrictEqual(R.splitCommand('echo "$(claude x)"').includes('claude x'), true);
  assert.strictEqual(R.hasOutputRedirect('npm test 2>&1'), false);
  assert.strictEqual(R.hasOutputRedirect('echo a > out.txt'), true);
  assert.strictEqual(R.hasOutputRedirect('ls > /dev/null'), false);
});
