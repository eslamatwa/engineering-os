'use strict';
// Phase 3 tests: approvals through Claude Code's own prompt (D46), protected-file approvals,
// typed human commands with D34/D35 checks, pause. Run: node --test tests/unit/phase3.test.js
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
const A = require(path.join(REPO, 'plugin', 'scripts', 'engos-approvals.js'));

const SID = 'sess-p3';

function git(dir, args) {
  return cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, encoding: 'utf8' });
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function env(sid) {
  return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', CLAUDE_CODE_SESSION_ID: sid || SID });
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
function asks(r) {
  return r.code === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'ask';
}
function typed(dir, prompt, sid) {
  return hook('prompt-expansion', dir, { hook_event_name: 'UserPromptExpansion', prompt }, sid);
}
function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p3-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'src/auth/session.ts', 'export const timeout = 30;\n');
  write(dir, 'src/auth/tokens.ts', 'export const ttl = 1;\n');
  write(dir, 'src/app.ts', 'export {};\n');
  write(dir, 'migrations/001.sql', 'select 1;\n');
  const r = cli(dir, ['init', '--check', 'test=node -e 0']);
  assert.strictEqual(r.code, 0, r.stderr);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  hook('session-start', dir, { source: 'startup' });
  return dir;
}
// A high_risk task with a plan covering src/auth/**
function authTask(dir) {
  cli(dir, ['task', 'open', '--summary', 'login timeout']);
  cli(dir, ['profile', 'set', '--kind', 'bugfix', '--sensitivity', 'auth']);
  const p = cli(dir, ['plan', 'set', '--scope-write', 'src/auth/**,src/app.ts']);
  assert.strictEqual(p.code, 0, p.stderr);
  return core.activeTask(dir, SID);
}
// Simulate "user clicked Allow": the tool runs, then PostToolUse fires.
function allowWrite(dir, rel, text, tool) {
  write(dir, rel, text);
  return hook('post-tool-use', dir, { tool_name: tool || 'Edit', tool_input: { file_path: path.join(dir, rel) } });
}
function allowBash(dir, command) {
  cp.spawnSync(command, { cwd: dir, shell: true });
  return hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command } });
}
function ledgerTypes(dir) {
  return fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
}

// ---------------------------------------------------------------------------

test('B2: a push asks, records context, is granted only after it runs, and asks again next time', () => {
  const dir = project('b2');
  write(dir, 'src/app.ts', 'export const a = 1;\n');
  git(dir, ['commit', '-qam', 'change one']);
  const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  assert.ok(asks(p), p.stderr);
  const reqs = A.list(dir).filter((r) => r.decision === 'requested');
  assert.strictEqual(reqs.length, 1);
  assert.strictEqual(reqs[0].action, 'git push origin main');
  assert.strictEqual(reqs[0].command_class, 'vcs_remote');
  assert.ok(reqs[0].context.outgoing_commits.some((c) => /change one/.test(c)), 'outgoing commits recorded');
  assert.match(cli(dir, ['task', 'status']).stdout, /Waiting for approval: APR-[0-9a-f]{8}\s+git push origin main/);

  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }); // user allowed, it ran
  const first = A.load(dir, reqs[0].approval_id);
  assert.strictEqual(first.decision, 'approved');
  assert.strictEqual(first.decided_by, 'human');
  assert.ok(ledgerTypes(dir).includes('approval.granted'));

  const again = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  assert.ok(asks(again), 'every push asks again');
  const all = A.list(dir);
  assert.strictEqual(all.length, 2, 'the approved record is kept, a new request is made');
  assert.strictEqual(A.load(dir, reqs[0].approval_id).decision, 'approved');
});

test('B8: an unanswered request expires and can no longer be granted', () => {
  const dir = project('b8');
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } });
  const rec = A.list(dir)[0];
  rec.requested_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, '.engos', 'approvals', rec.approval_id + '.json'), JSON.stringify(rec));
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } });
  assert.strictEqual(A.load(dir, rec.approval_id).decision, 'requested', 'not granted after the TTL');
  A.expireStale(dir);
  assert.strictEqual(A.load(dir, rec.approval_id).decision, 'expired');
});

test('protected files ask once per file per task (D46)', () => {
  const dir = project('files');
  authTask(dir);
  const p1 = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } });
  assert.ok(asks(p1), p1.stderr);
  assert.match(p1.json.hookSpecificOutput.permissionDecisionReason, /src\/auth\/session\.ts is a protected file/);
  allowWrite(dir, 'src/auth/session.ts', 'export const timeout = 60;\n');
  const t = core.activeTask(dir, SID);
  assert.ok(t.approved_files['src/auth/session.ts'], 'approved for the task');

  const p2 = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } });
  assert.strictEqual(p2.code, 0);
  assert.ok(!asks(p2), 'same file: no second prompt');

  const p3 = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/tokens.ts') } });
  assert.ok(asks(p3), 'another protected file asks');

  const p4 = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/app.ts') } });
  assert.strictEqual(p4.code, 0);
  assert.ok(!asks(p4), 'ordinary files never ask');
});

test('a file approval expires after 24 hours', () => {
  const dir = project('fileexp');
  authTask(dir);
  hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } });
  allowWrite(dir, 'src/auth/session.ts', 'x\n');
  const t = core.activeTask(dir, SID);
  t.approved_files['src/auth/session.ts'].approved_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  core.saveProfile(dir, t);
  const p = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } });
  assert.ok(asks(p), 'asks again after 24 hours');
});

test('an approved command that changes a protected file is recorded, not flagged', () => {
  const dir = project('approvedcmd');
  cli(dir, ['task', 'open', '--summary', 'clean up']);
  const cmd = 'rm -rf migrations';
  const p = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } });
  assert.ok(asks(p));
  const post = allowBash(dir, cmd);
  assert.ok(!fs.existsSync(path.join(dir, 'migrations')));
  const t = core.activeTask(dir, SID);
  assert.notStrictEqual(t.status, 'needs_human', 'the user approved this exact command');
  assert.ok(ledgerTypes(dir).includes('protected.changed_under_approval'));
  assert.ok(!(post.json && /needs the user's decision/.test(post.json.reason || '')));
});

test('decide: accept continues the task, stop closes it, and only valid options count', () => {
  const dir = project('decide');
  write(dir, 'tool.js', "require('fs').writeFileSync('migrations/001.sql', 'drop table x;\\n');\n");
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'tool']);
  cli(dir, ['task', 'open', '--summary', 'run tool']);
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node tool.js' } });
  allowBash(dir, 'node tool.js');
  let t = core.activeTask(dir, SID);
  assert.strictEqual(t.status, 'needs_human');

  const bad = typed(dir, '/engos:decide ' + t.task_id + ' maybe');
  assert.match(bad.json.systemMessage, /options for/);
  const ok = typed(dir, '/engos:decide ' + t.task_id + ' accept');
  assert.match(ok.json.systemMessage, /change accepted/);
  t = core.loadProfile(dir, t.task_id);
  assert.strictEqual(t.status, 'open');
  assert.strictEqual(t.decisions[0].decided_by, 'human');
  assert.ok(ledgerTypes(dir).includes('decision.recorded'));
});

test('B4: a typed decision from another session is refused (D34)', () => {
  const dir = project('b4typed');
  write(dir, 'tool.js', "require('fs').writeFileSync('migrations/001.sql', 'x\\n');\n");
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'tool']);
  cli(dir, ['task', 'open', '--summary', 'x']);
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node tool.js' } });
  allowBash(dir, 'node tool.js');
  const t = core.activeTask(dir, SID);
  const other = typed(dir, '/engos:decide ' + t.task_id + ' accept', 'some-other-session');
  assert.match(other.json.systemMessage, /belongs to another session/);
  assert.strictEqual(core.loadProfile(dir, t.task_id).status, 'needs_human');
});

test('B4b: a decision typed after the session was resumed is refused until rearmed (D35)', () => {
  const dir = project('b4b');
  write(dir, 'tool.js', "require('fs').writeFileSync('migrations/001.sql', 'x\\n');\n");
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'tool']);
  cli(dir, ['task', 'open', '--summary', 'x']);
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node tool.js' } });
  allowBash(dir, 'node tool.js');
  const t = core.activeTask(dir, SID);
  hook('session-start', dir, { source: 'resume' }); // e.g. claude -p --resume <id>
  const r = typed(dir, '/engos:decide ' + t.task_id + ' accept');
  assert.match(r.json.systemMessage, /resumed after the decision was requested/);
  assert.strictEqual(core.loadProfile(dir, t.task_id).status, 'needs_human');

  const re = cli(dir, ['task', 'rearm', t.task_id]);
  assert.strictEqual(re.code, 0, re.stderr);
  const ok = typed(dir, '/engos:decide ' + t.task_id + ' accept');
  assert.match(ok.json.systemMessage, /change accepted/);
});

test('typed commands must be the whole line', () => {
  const dir = project('wholeline');
  const r = typed(dir, 'please run /engos:pause now');
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(core.loadSession(dir, SID).paused, false);
});

test('class: the user can lower a class; protected files still ask', () => {
  const dir = project('class');
  const t = authTask(dir);
  assert.strictEqual(t.effective.class, 'high_risk');
  const r = typed(dir, '/engos:class ' + t.task_id + ' standard');
  assert.match(r.json.systemMessage, /lowered from high_risk to standard/);
  const t2 = core.loadProfile(dir, t.task_id);
  assert.strictEqual(t2.effective.class, 'standard');
  assert.strictEqual(t2.human_override.by, 'human');
  // the old sensitivity floor no longer raises it; a protected file still asks
  const p = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/app.ts') } });
  assert.strictEqual(p.code, 0, p.stderr);
  assert.strictEqual(core.loadProfile(dir, t.task_id).effective.class, 'standard');
  const prot = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } });
  assert.ok(asks(prot) || prot.code === 2, 'protected path is never silently allowed');
  const up = typed(dir, '/engos:class ' + t.task_id + ' high_risk');
  assert.match(up.json.systemMessage, /only lowers/);
});

test('B7: pause turns off tasks but keeps hard gates; a new session resets it', () => {
  const dir = project('b7');
  const r = typed(dir, '/engos:pause');
  assert.match(r.json.systemMessage, /paused for this session/);
  const plain = hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'a.txt') } });
  assert.strictEqual(plain.code, 0);
  assert.ok(!asks(plain));
  for (let i = 0; i < 5; i++) assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'f' + i + '.txt') } }).code, 0, 'no budget while paused');
  assert.strictEqual(core.activeTask(dir, SID), null, 'no task opened');
  assert.ok(asks(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git push' } })), 'push still asks');
  assert.ok(asks(hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth/session.ts') } })), 'protected file still asks');
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.engos/ledger.jsonl') } }).code, 2, 'never paths still blocked');
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'claude --version' } }).code, 2, 'claude still blocked');

  hook('session-start', dir, { source: 'startup' });
  assert.strictEqual(core.loadSession(dir, SID).paused, false, 'new session resets pause');
});

test('resume turns tasks back on', () => {
  const dir = project('resume');
  typed(dir, '/engos:pause');
  typed(dir, '/engos:resume');
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'a.txt') } });
  assert.ok(core.activeTask(dir, SID), 'a task opens again');
});

test('a forged or edited approval record is caught (fingerprint check)', () => {
  const dir = project('forge');
  write(dir, 'forge.js', "const fs=require('fs');fs.mkdirSync('.engos/approvals',{recursive:true});fs.writeFileSync('.engos/approvals/APR-deadbeef.json', JSON.stringify({approval_id:'APR-deadbeef',decision:'approved',decided_by:'human'}));\n");
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'forge']);
  cli(dir, ['task', 'open', '--summary', 'x']);
  const pre = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node forge.js' } });
  assert.strictEqual(pre.code, 0, 'the command itself looks harmless');
  const post = allowBash(dir, 'node forge.js');
  assert.match(post.json.reason, /APR-deadbeef/);
  assert.strictEqual(core.activeTask(dir, SID).status, 'needs_human');
});
