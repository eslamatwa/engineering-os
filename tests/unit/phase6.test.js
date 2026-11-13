'use strict';
// Phase 6 tests: status.json, the status line, `engos status`, the live view (D33, E1, E2).
// Run: node --test tests/unit/phase6.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'plugin', 'scripts', 'engos-hook.js');
const CLI = path.join(REPO, 'plugin', 'scripts', 'engos-cli.js');
const LINE = path.join(REPO, 'plugin', 'scripts', 'engos-statusline.js');
const core = require(path.join(REPO, 'plugin', 'scripts', 'engos-core.js'));

const SID = 'sess-p6';

function git(dir, args) {
  return cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, encoding: 'utf8' });
}
function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
function env(sid) {
  return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: sid || SID, NO_COLOR: '1' });
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
function statusLine(dir, input) {
  const res = cp.spawnSync(process.execPath, [path.join(dir, '.engos', 'statusline.js')], { input: JSON.stringify(input), encoding: 'utf8', env: env() });
  return res.stdout.trim();
}
function status(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.engos', 'status.json'), 'utf8')); }
function project(name, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p6-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'src/a.ts', 'a\n');
  const r = cli(dir, ['init', '--models', 'haiku,sonnet,opus', '--check', 'test=node -e 0'].concat(extra || []));
  assert.strictEqual(r.code, 0, r.stderr);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  hook('session-start', dir, { source: 'startup' });
  return dir;
}
const REPORT = '```yaml\nschema: engos/report@1\nstatus: done\ninputs_read: []\noutputs_changed: []\nevidence: []\nlimitations: []\nnext_action: x\n```';

// A standard task with a scout done and a worker running (E1's setup).
function busy(dir) {
  cli(dir, ['task', 'open', '--summary', 'Fix session expiry']);
  cli(dir, ['profile', 'set', '--kind', 'bugfix']);
  cli(dir, ['plan', 'set', '--scope-write', 'src/**', '--steps', 'S1:locate,S2:implement,S3:verify']);
  const t = core.activeTask(dir, SID); t.effective.class = 'standard'; core.saveProfile(dir, t);
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Agent', tool_input: { subagent_type: 'engos:scout', model: 'haiku', prompt: 'step_id: S1' } }).code, 0);
  hook('subagent-start', dir, { agent_id: 's1', agent_type: 'engos:scout' });
  hook('subagent-stop', dir, { agent_id: 's1', agent_type: 'engos:scout', last_assistant_message: REPORT.replace('next_action: x', 'next_action: x\nhypothesis: "expiry not refreshed"') });
  hook('post-tool-use', dir, { tool_name: 'Agent', tool_input: { subagent_type: 'engos:scout' }, tool_response: { resolvedModel: 'claude-haiku-5-5', status: 'completed' } });
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Agent', tool_input: { subagent_type: 'engos:worker', model: 'sonnet', prompt: 'step_id: S2' } }).code, 0);
  hook('subagent-start', dir, { agent_id: 'w1', agent_type: 'engos:worker' });
  // a pending push approval
  const ask = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  assert.match(ask.json.hookSpecificOutput.permissionDecision, /ask/);
  return t.task_id;
}

test('status.json is rebuilt by the hooks after ledger events, and holds no command output', () => {
  const dir = project('json');
  const before = status(dir).generated_at;
  const id = busy(dir);
  const s = status(dir);
  assert.notStrictEqual(s.generated_at, before);
  const t = s.tasks.find((x) => x.task_id === id);
  assert.deepStrictEqual(t.steps.map((x) => x.status), ['done', 'running', 'pending']);
  assert.deepStrictEqual(t.agents.map((a) => [a.type, a.status]), [['engos:scout', 'ended'], ['engos:worker', 'running']]);
  assert.strictEqual(t.agents[0].model_actual, 'claude-haiku-5-5');
  assert.strictEqual(s.approvals.length, 1);
  assert.strictEqual(s.approvals[0].action, 'git push origin main');
  assert.ok(s.timeline.some((e) => /started on engos:worker/.test(e.text)));
  cli(dir, ['check', 'test']);
  const raw = fs.readFileSync(path.join(dir, '.engos', 'status.json'), 'utf8');
  assert.ok(!/"output"/.test(raw), 'no command output in status.json');
  assert.ok(!/USERPROFILE|CLAUDE_CODE_SESSION_ID/.test(raw), 'no environment values');
});

test('E1: the status line shows task, class, each agent with model and step, attempts and approvals', () => {
  const dir = project('e1', ['--status-line']);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.match(settings.statusLine.command, /\.engos\/statusline\.js"$/);
  const id = busy(dir);
  const line = statusLine(dir, { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Opus' }, workspace: { current_dir: dir } });
  assert.match(line, new RegExp('◆ engos  ' + id + ' standard'));
  assert.match(line, /lead opus/);
  assert.match(line, /scout haiku S1 ✓/);
  assert.match(line, /worker sonnet S2 ⟳ 1\/3/);
  assert.match(line, /validator S3 …/);
  assert.match(line, /⚠ 1 approval/);
  // `engos status` prints the same picture as text
  const st = cli(dir, ['status']);
  assert.strictEqual(st.code, 0, st.stderr);
  assert.match(st.stdout, /worker sonnet S2 ⟳ 1\/3/);
  assert.match(st.stdout, /S2 implement · engos:worker · running/);
  assert.match(st.stdout, /WAITING FOR APPROVAL: APR-\w+ {2}git push origin main/);
  // idle after the task closes
  const dir2 = project('e1idle');
  assert.match(statusLine(dir2, { session_id: SID }), /◆ engos  idle .*\/engos:view/);
});

test('E1/E2: the live view gets the same data and has no control that approves or decides', () => {
  const dir = project('e2');
  const id = busy(dir);
  const v = cli(dir, ['view']);
  assert.strictEqual(v.code, 0, v.stderr);
  assert.match(v.stdout, /Live view: file:\/\/\/.*\.engos\/view\/index\.html/);
  const js = fs.readFileSync(path.join(dir, '.engos', 'view', 'status.js'), 'utf8');
  assert.match(js, /^window\.__engosStatus\(/);
  const data = JSON.parse(js.slice('window.__engosStatus('.length, js.lastIndexOf(');')));
  assert.strictEqual(data.tasks[0].task_id, id);
  assert.strictEqual(data.approvals[0].action, 'git push origin main');
  // later hook events keep the view data fresh
  hook('subagent-stop', dir, { agent_id: 'w1', agent_type: 'engos:worker', last_assistant_message: REPORT });
  const js2 = fs.readFileSync(path.join(dir, '.engos', 'view', 'status.js'), 'utf8');
  assert.match(js2, /"status":"ended"/);

  const html = fs.readFileSync(path.join(REPO, 'plugin', 'view', 'index.html'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|<form|method=/i.test(html), 'the page sends nothing anywhere');
  const buttons = html.match(/<button[^>]*>/g) || [];
  assert.ok(buttons.every((b) => /class="(tab|btn-s)/.test(b)), 'only task tabs, filters and pause are buttons');
  assert.ok(!/>\s*(Approve|Reject|Allow|Deny|Decide|Use Fable|Use Opus)\b/.test(html), 'no approve or decide control');
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external resources');
  // the approval is still pending: nothing in the view answered it
  assert.strictEqual(status(dir).approvals.length, 1);
});

test('the status line never fails loudly', () => {
  const dir = project('robust');
  fs.writeFileSync(path.join(dir, '.engos', 'status.json'), '{broken');
  const out = statusLine(dir, { session_id: SID, workspace: { current_dir: dir } });
  assert.match(out, /◆ engos/);
  const L = require(LINE);
  assert.match(L.render(null, {}), /waiting for the first event/);
});
