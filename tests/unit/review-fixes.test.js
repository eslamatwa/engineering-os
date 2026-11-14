'use strict';
// Fixes from Fable's project review (docs/reviews/fable-project-review.md). Each test pins one finding.
// Run: node --test tests/unit/review-fixes.test.js
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
const O = require(path.join(REPO, 'plugin', 'scripts', 'engos-orchestrate.js'));
const SID = 'sess-review';

function env(sid) { return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: sid || SID }); }
function git(dir, args) { return cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, encoding: 'utf8' }); }
function write(dir, rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
function hookRaw(mode, dir, raw, sid) {
  const res = cp.spawnSync(process.execPath, [HOOK, mode], { input: raw, encoding: 'utf8', env: env(sid) });
  let json = null; try { json = JSON.parse(res.stdout); } catch (_) { /* none */ }
  return { code: res.status, stderr: res.stderr, json };
}
function hook(mode, dir, input, sid) { return hookRaw(mode, dir, JSON.stringify(Object.assign({ session_id: sid || SID, cwd: dir }, input)), sid); }
function cli(dir, args, sid) { const r = cp.spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: env(sid) }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
const isAsk = (r) => r.code === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'ask';
function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-rv-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'src/a.js', 'a\n');
  write(dir, 'src/auth/session.js', 'export const t = 30;\n');
  assert.strictEqual(cli(dir, ['init', '--check', 'test=node -e 0']).code, 0);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  hook('session-start', dir, { source: 'startup' });
  return dir;
}
function ledger(dir) { return fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8'); }
function task(dir) { return core.activeTask(dir, SID); }
const D = core.defaults().rules;
const cls = (c) => R.classifyCommand(c, D.bash_classes, D.protected_paths.never).cls;

test('#4 unparseable hook input is blocked, not let through', () => {
  const dir = project('badjson');
  const r = hookRaw('pre-tool-use', dir, '{not json');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /could not be read/);
  assert.strictEqual(hook('pre-tool-use', dir, { tool_input: { command: 'git push' } }).code, 2, 'missing tool_name');
});

test('#1 the PowerShell and Monitor tools go through the command gate', () => {
  const dir = project('pwsh');
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'PowerShell', tool_input: { command: 'git push origin main' } })));
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'PowerShell', tool_input: { command: 'Remove-Item build -Recurse -Force' } })));
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'PowerShell', tool_input: { command: 'claude -p hi' } }).code, 2);
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'Monitor', tool_input: { command: 'curl https://example.com' } })));
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' } }).code, 0);
});

test('#3 commands wrapped, nested or spelled differently are classified by what they do', () => {
  const expect = {
    vcs_remote: ['(cd pkg && npm publish)', '(git push)', 'if true; then git push; fi', 'git -C . push', 'git --no-pager push', '/usr/bin/git push', 'git.exe push', 'bash -c "git push"', 'eval "git push"', 'powershell -c "git push"', 'gh api -X DELETE repos/x', 'git frobnicate', 'terraform apply'],
    destructive: ['find . | xargs rm -rf', 'rm --recursive dir', 'git checkout .', 'git restore .', 'git stash drop', 'kubectl delete pod x', 'Remove-Item x -Recurse'],
    network: ['timeout 30 curl https://x', 'git pull', 'git clone https://x'],
    self_protect: ['npx claude -p hi', 'cmd /c claude -p x'],
    unknown: ['sed -Ei s/a/b/ src/x.ts', 'sed --in-place s/a/b/ x', 'sort -o out in', 'uniq a b', 'rm -f a.txt'],
    read: ['git status', 'gh api repos/x', 'sed -n 1p f', 'ls -la'],
  };
  for (const [want, list] of Object.entries(expect)) for (const c of list) assert.strictEqual(cls(c), want, c);
});

test('#9 heredoc bodies are data: a commit message naming protected files or rm -rf is just a commit', () => {
  const commit = 'git commit -m "$(cat <<\'EOF\'\nFix plugin/hooks/hooks.json handling\n\nrm -rf is never run here; git push either\nEOF\n)"';
  assert.strictEqual(cls(commit), 'vcs_local');
  assert.strictEqual(cls('cat <<EOF > notes.txt\ngit push\nEOF'), 'unknown');
});

test('#5 Engineering OS state can\'t be edited by the model; config edits ask', () => {
  const dir = project('state');
  for (const rel of ['.engos/tasks/TASK-001/profile.json', '.engos/sessions/x.json', '.engos/status.json', '.engos/statusline.js', '.engos/view/index.html']) {
    const r = hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) } });
    assert.strictEqual(r.code, 2, rel);
    assert.match(r.stderr, /can never be edited/);
  }
  const cfg = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.engos', 'config.yaml') } });
  assert.strictEqual(cfg.code, 2, 'config.yaml is protected: a plan first, then the user is asked');
  assert.match(cfg.stderr, /protected path/);
  assert.strictEqual(cls('echo x > .engos/tasks/TASK-001/profile.json'), 'self_protect');
});

test('#5 evidence from a check whose command changed during the task does not count', () => {
  const dir = project('checkcmd');
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  write(dir, 'src/a.js', 'a2\n');
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  const f = path.join(dir, '.engos', 'config.yaml');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('test: "node -e 0"', 'test: "true"'));
  cli(dir, ['check', 'test']);
  const c = cli(dir, ['task', 'close', task(dir).task_id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /command for check "test" changed during this task/);
});

test('#2 a command that fails is still observed', () => {
  const dir = project('failed');
  hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node scripts/x.js' } });
  write(dir, '.env', 'SECRET=1\n');
  const r = hook('post-tool-use-failure', dir, { tool_name: 'Bash', tool_input: { command: 'node scripts/x.js' }, error: 'Exit code 1' });
  assert.match(r.json.hookSpecificOutput.additionalContext, /changed protected files/);
  assert.strictEqual(task(dir).status, 'needs_human');
});

test('#6 switching branches re-baselines instead of reporting the other branch as a violation', () => {
  const dir = project('branch');
  const main = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '-b', 'other']);
  write(dir, 'src/auth/session.js', 'export const t = 99;\n');
  git(dir, ['commit', '-q', '-am', 'other']);
  git(dir, ['checkout', '-q', main]);
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } }); // opens a trivial task
  write(dir, 'src/a.js', 'a2\n');
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  git(dir, ['stash', '-q']);
  git(dir, ['checkout', '-q', 'other']);
  git(dir, ['stash', 'pop', '-q']);
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git checkout other' } });
  const t = task(dir);
  assert.notStrictEqual(t.status, 'needs_human');
  assert.strictEqual(t.effective.class, 'trivial_edit');
  assert.match(ledger(dir), /baseline\.moved/);
  assert.ok(t.observed.files_touched.includes('src/a.js'), 'earlier changes are kept');
});

test('#7 #8 an edit that keeps line counts still counts as a change, and clears the close confirmation', () => {
  const dir = project('hash');
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  write(dir, 'src/a.js', 'aaa\n');
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  const t = task(dir);
  t.close_acknowledged = { by: 'human', at: new Date().toISOString() };
  t.last_change_at = '2000-01-01T00:00:00.000Z';
  core.saveProfile(dir, t);
  write(dir, 'src/a.js', 'bbb\n'); // same line counts
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'node fmt.js' } });
  const t2 = task(dir);
  assert.notStrictEqual(t2.last_change_at, '2000-01-01T00:00:00.000Z');
  assert.strictEqual(t2.close_acknowledged, null);
});

test('#11 secrets in commands are redacted before they are stored', () => {
  const dir = project('redact');
  const cmd = 'curl -H "Authorization: Bearer abcdef1234567890xyz" https://api.example.com';
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } })));
  const files = fs.readdirSync(path.join(dir, '.engos', 'approvals')).map((f) => fs.readFileSync(path.join(dir, '.engos', 'approvals', f), 'utf8')).join('');
  assert.ok(!/abcdef1234567890xyz/.test(files), 'approval record');
  assert.ok(!/abcdef1234567890xyz/.test(ledger(dir)), 'ledger');
  assert.ok(!/abcdef1234567890xyz/.test(fs.readFileSync(path.join(dir, '.engos', 'status.json'), 'utf8')), 'status');
  hook('post-tool-use', dir, { tool_name: 'Bash', tool_input: { command: cmd } });
  assert.match(ledger(dir), /approval\.granted/, 'the hash still matches the original command');
  for (const [raw, secret] of [['mysql --password=hunter2 x', 'hunter2'], ['API_KEY=sk-abcdefghijklmnop1234 node x', 'sk-abc'], ['curl -u bob:pa55 https://x', 'pa55'], ['git push https://ghp_abcdefghijklmnopqrstuvwx1@github.com/x', 'ghp_']]) {
    assert.ok(!R.redact(raw).includes(secret), raw);
  }
});

test('#9 typed commands work from command_name/command_args too; a task with no session refuses decisions', () => {
  const dir = project('typed');
  const r = hook('prompt-expansion', dir, { command_name: 'engos:pause', command_args: '' });
  assert.match(r.json.systemMessage, /paused/);
  cli(dir, ['task', 'open', '--summary', 'x'], '');
  const t = core.listTasks(dir).pop();
  t.session_id = null; t.status = 'needs_human'; core.saveProfile(dir, t);
  const d = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + t.task_id + ' accept' }, 'some-other-session');
  assert.match(d.json.systemMessage, /isn't tied to a session/);
});

test('#12 #13 only a real "model unavailable" error marks a model, it expires, and stuck launches can be freed', () => {
  assert.ok(O.MODEL_UNAVAILABLE_RE.test('model fable is not available for your plan'));
  assert.ok(!O.MODEL_UNAVAILABLE_RE.test('Overloaded: please retry'));
  assert.ok(!O.MODEL_UNAVAILABLE_RE.test('Permission denied: access to file'));
  const dir = project('models');
  O.markUnavailable(dir, 'fable');
  assert.deepStrictEqual(O.loadUnavailable(dir), ['fable']);
  assert.match(cli(dir, ['models', 'reset']).stdout, /Cleared/);
  assert.deepStrictEqual(O.loadUnavailable(dir), []);
  cli(dir, ['task', 'open', '--summary', 'x']);
  const t = task(dir);
  t.agents = [{ id: 'A1', role: 'worker', type: 'engos:worker', step: 'S1', status: 'launched', launched_at: new Date().toISOString() }];
  core.saveProfile(dir, t);
  assert.strictEqual(O.runningWorkers(task(dir)).length, 1);
  assert.match(cli(dir, ['agents', 'reset']).stdout, /1 agent launch/);
  assert.strictEqual(O.runningWorkers(task(dir)).length, 0);
});

test('a docs-only trivial task closes without code checks; a whole-repo scope is refused', () => {
  const dir = project('docs');
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'README.md') } });
  write(dir, 'README.md', '# hi\n');
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'README.md') } });
  const c = cli(dir, ['task', 'close', task(dir).task_id]);
  assert.strictEqual(c.code, 0, c.stdout);
  assert.match(c.stdout, /docs only/);
  cli(dir, ['task', 'open', '--summary', 'y']);
  const r = cli(dir, ['plan', 'set', '--kind', 'feature', '--scope-write', '**']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /covers the whole repo/);
});

test('D25: a medium or higher finding needs the user to confirm the close, in any class', () => {
  const dir = project('severity');
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  write(dir, 'src/a.js', 'a2\n');
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  cli(dir, ['check', 'test']);
  const t = task(dir);
  t.reviews = [{ step: 'S2', verdict: 'pass', refs_ok: true, report_ok: true, max_severity: 3, at: new Date().toISOString() }];
  core.saveProfile(dir, t);
  const c = cli(dir, ['task', 'close', t.task_id]);
  assert.strictEqual(c.code, 1);
  assert.match(c.stdout, /medium severity or higher/);
  assert.strictEqual(core.loadProfile(dir, t.task_id).awaiting_close_ack, true);
});
