'use strict';
// D56: fixes from a real high_risk task on a server. Read-only system commands, an unknown command allowed once
// per task, re-routing after a class change, features on Sonnet, and Claude Code's own "don't ask again" writes.
// Run: node --test tests/unit/d56.test.js
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
const R = require(path.join(REPO, 'plugin', 'scripts', 'engos-rules.js'));
const RULES = require(path.join(REPO, 'plugin', 'defaults', 'rules.json'));

const SID = 'sess-d56';

function git(dir, args) {
  return cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, encoding: 'utf8' });
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function env() {
  return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: SID });
}
function hook(mode, dir, input) {
  const res = cp.spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(Object.assign({ session_id: SID, cwd: dir }, input)), encoding: 'utf8', env: env() });
  let json = null; try { json = JSON.parse(res.stdout); } catch (_) { /* none */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}
function cli(dir, args) {
  const res = cp.spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: env() });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
function asks(r) {
  return r.code === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'ask';
}
function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-d56-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'agent/install.sh', '#!/bin/sh\n');
  assert.strictEqual(cli(dir, ['init']).code, 0);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  hook('session-start', dir, { source: 'startup' });
  return dir;
}
function deployTask(dir, kind) {
  cli(dir, ['task', 'open', '--summary', 'deploy the agent']);
  cli(dir, ['profile', 'set', '--kind', kind || 'feature', '--sensitivity', 'deployment']);
  const p = cli(dir, ['plan', 'set', '--scope-write', 'agent/**', '--steps', 'S1:implement,S2:verify']);
  assert.strictEqual(p.code, 0, p.stderr);
  return core.activeTask(dir, SID);
}
function ledger(dir) {
  return fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}
const cls = (c) => R.classifyCommand(c, RULES.bash_classes, RULES.protected_paths.never).cls;

test('read-only server commands are read; the same tools changing things are not', () => {
  for (const c of [
    'S=/tmp/x/src; ls $S; ls $S/doc', 'A=1 B="x y"', 'journalctl _UID=975 --since "6 min ago" --no-pager 2>&1 | tail',
    'systemctl is-active firewalld', 'systemctl --user status hermes', 'hostname; ip -4 -o addr show', 'bash -n agent/install.sh && echo ok',
    'firewall-cmd --get-active-zones; firewall-cmd --list-all | grep port', 'pgrep -a -f vim; true',
    'runuser -u hermes -- env HOME=/home/hermes XDG_RUNTIME_DIR=/run/user/975 podman logs --since 10m hermes',
  ]) assert.strictEqual(cls(c), 'read', c);
  for (const c of [
    'systemctl restart hermes', 'journalctl --vacuum-size=1M', 'hostname evil', 'ip addr add 10.0.0.9/24 dev eth0',
    'firewall-cmd --permanent --add-port=9119/tcp', 'runuser -u hermes -- podman rm -f hermes', 'ps aux > /tmp/out', 'X=1 make install',
  ]) assert.notStrictEqual(cls(c), 'read', c);
  assert.strictEqual(cls('X=$(rm -rf /tmp/a)'), 'destructive');
});

test('an unknown command allowed once is not asked again in the task; network still asks every time', () => {
  const dir = project('once');
  const t = deployTask(dir);
  assert.strictEqual(t.effective.class, 'high_risk');
  const cmd = 'node -e "1"';
  assert.ok(asks(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } })), 'first run asks');
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } }); // the user clicked Allow
  const again = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } });
  assert.ok(!asks(again), 'second run of the same command does not ask: ' + again.stdout);
  assert.strictEqual(again.code, 0, again.stderr);
  assert.ok(ledger(dir).some((e) => e.type === 'approval.reused'));
  assert.ok(asks(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node -e "2"' } })), 'a different command asks');
  const net = 'curl -s https://example.invalid';
  assert.ok(asks(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: net } })));
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: net } });
  assert.ok(asks(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: net } })), 'network asks every time (D46)');
});

test('features route to Sonnet below high_risk; lowering the class re-routes planned steps', () => {
  const std = project('route-std');
  cli(std, ['task', 'open', '--summary', 'small feature']);
  cli(std, ['profile', 'set', '--kind', 'feature']);
  cli(std, ['plan', 'set', '--scope-write', 'agent/**', '--steps', 'S1:implement']);
  assert.strictEqual(core.activeTask(std, SID).planned.steps[0].tier, 'balanced');

  const dir = project('route');
  const t = deployTask(dir);
  const s = (task) => Object.fromEntries(task.planned.steps.map((x) => [x.id, x.tier]));
  assert.deepStrictEqual(s(t), { S1: 'frontier', S2: 'frontier' });
  const r = hook('prompt-expansion', dir, { hook_event_name: 'UserPromptExpansion', prompt: '/engos:class ' + t.task_id + ' standard' });
  assert.match(r.json.systemMessage, /lowered from high_risk to standard/);
  assert.deepStrictEqual(s(core.loadProfile(dir, t.task_id)), { S1: 'balanced', S2: 'balanced' });
});

test('a "don\'t ask again" rule written by Claude Code is not a violation; any other change to the file is', () => {
  const dir = project('local');
  write(dir, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, statusLine: { type: 'command', command: 'x' } }, null, 2));
  fs.appendFileSync(path.join(dir, '.gitignore'), '\n.claude/settings.local.json\n'); // as Claude Code sets it up
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'settings']);
  const t = deployTask(dir);
  const run = (command, change) => {
    hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command } });
    change();
    return hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command } });
  };
  const ok = run('node -e "1"', () => write(dir, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(node -e:*)'] }, statusLine: { type: 'command', command: 'x' } }, null, 2)));
  assert.match(ok.stdout, /don't ask again/);
  let p = core.loadProfile(dir, t.task_id);
  assert.notStrictEqual(p.status, 'needs_human');
  assert.ok(ledger(dir).some((e) => e.type === 'harness.settings_changed'));
  run('node -e "3"', () => write(dir, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(node -e:*)'] }, statusLine: { type: 'command', command: 'evil' } }, null, 2)));
  p = core.loadProfile(dir, t.task_id);
  assert.strictEqual(p.status, 'needs_human', 'a change beyond allow rules still stops the task');
});
