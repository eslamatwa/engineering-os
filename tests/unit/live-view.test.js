'use strict';
// Live view v0.1 additions: tokens and cost from transcripts, check history, health, projects, server endpoints.
// Run: node --test tests/unit/live-view.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'plugin', 'scripts', 'engos-hook.js');
const CLI = path.join(REPO, 'plugin', 'scripts', 'engos-cli.js');
const U = require(path.join(REPO, 'plugin', 'scripts', 'engos-usage.js'));
const core = require(path.join(REPO, 'plugin', 'scripts', 'engos-core.js'));
const SID = 'sess-lv';
const PRICES = core.defaults().policies.usage.prices;

function env(home) { return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: SID, ENGOS_HOME: home || '' }); }
function hook(mode, dir, input, home) { const r = cp.spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(Object.assign({ session_id: SID, cwd: dir }, input)), encoding: 'utf8', env: env(home) }); return r; }
function cli(dir, args, home) { return cp.spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: env(home) }); }
function git(dir, args) { cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'].concat(args), { cwd: dir, stdio: 'ignore' }); }
function line(id, model, at, u) { return JSON.stringify({ type: 'assistant', timestamp: at, message: { id, model, usage: u } }); }
const U1 = { input_tokens: 24, output_tokens: 2303, cache_read_input_tokens: 331469, cache_creation_input_tokens: 38988, cache_creation: { ephemeral_5m_input_tokens: 16499, ephemeral_1h_input_tokens: 22489 } };

test('cost from a transcript matches Claude Code\'s own figure; repeated lines of one message count once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lv-u-'));
  const f = path.join(dir, 't.jsonl');
  const at = new Date().toISOString();
  fs.writeFileSync(f, [line('m1', 'claude-sonnet-5-5', at, U1), line('m1', 'claude-sonnet-5-5', at, U1), '{"type":"user"}'].join('\n') + '\n');
  const u = U.agentUsage(f, PRICES);
  assert.strictEqual(u.by_model['claude-sonnet-5-5'].messages, 1);
  // Benchmark run P16: Claude Code reported $0.1874284 for exactly these tokens.
  assert.ok(Math.abs(u.cost_usd - 0.1874) < 0.0002, String(u.cost_usd));
});

test('lead usage is split by task window and read incrementally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lv-s-'));
  fs.mkdirSync(path.join(dir, '.engos', 'sessions'), { recursive: true });
  const f = path.join(dir, 't.jsonl');
  const t0 = Date.now();
  const tasks = [{ task_id: 'TASK-001', session_id: SID, opened_at: new Date(t0).toISOString(), closed_at: new Date(t0 + 10000).toISOString() }, { task_id: 'TASK-002', session_id: SID, opened_at: new Date(t0 + 20000).toISOString() }];
  const small = { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  fs.writeFileSync(f, line('a', 'claude-opus-5-5', new Date(t0 + 5000).toISOString(), small) + '\n' + line('b', 'claude-opus-5-5', new Date(t0 + 15000).toISOString(), small) + '\n');
  let u = U.sessionUsage(dir, SID, f, tasks, PRICES);
  assert.strictEqual(u.tasks['TASK-001'].by_model['claude-opus-5-5'].messages, 1);
  assert.ok(!u.tasks['TASK-002']);
  assert.strictEqual(u.session.by_model['claude-opus-5-5'].messages, 2, 'messages between tasks still count for the session');
  fs.appendFileSync(f, line('c', 'claude-opus-5-5', new Date(t0 + 25000).toISOString(), small) + '\n');
  u = U.sessionUsage(dir, SID, f, tasks, PRICES);
  assert.strictEqual(u.tasks['TASK-002'].by_model['claude-opus-5-5'].messages, 1);
  assert.strictEqual(u.session.by_model['claude-opus-5-5'].messages, 3);
});

function project(name, home) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lv-' + name + '-'));
  git(dir, ['init', '-q']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'b\n');
  cli(dir, ['init', '--check', 'test=node -e 0'], home);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('status carries agent cost, check history, flaky checks and health; the hook records the agent\'s cost', () => {
  const dir = project('status');
  const tr = path.join(dir, 'lead.jsonl');
  fs.writeFileSync(tr, '');
  hook('session-start', dir, { source: 'startup', transcript_path: tr });
  cli(dir, ['task', 'open', '--summary', 'x']);
  cli(dir, ['plan', 'set', '--kind', 'feature', '--scope-write', 'src/**', '--steps', 'S1:locate']);
  fs.appendFileSync(tr, line('L1', 'claude-opus-5-5', new Date().toISOString(), U1) + '\n');
  hook('pre-tool-use', dir, { tool_name: 'Agent', tool_input: { subagent_type: 'engos:scout', model: 'haiku', prompt: 'step_id: S1' } });
  hook('subagent-start', dir, { agent_id: 's1', agent_type: 'engos:scout' });
  const atr = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(atr, line('A1', 'claude-haiku-5-5', new Date().toISOString(), U1) + '\n');
  hook('subagent-stop', dir, { agent_id: 's1', agent_type: 'engos:scout', agent_transcript_path: atr, last_assistant_message: '```yaml\nschema: engos/report@1\nstatus: done\ninputs_read: []\noutputs_changed: []\nevidence: []\nlimitations: []\nnext_action: x\nhypothesis: "h"\n```' });
  cli(dir, ['check', 'test']);
  cli(dir, ['check', 'test']);
  const s = cli(dir, ['status']) && JSON.parse(fs.readFileSync(path.join(dir, '.engos', 'status.json'), 'utf8'));
  const t = s.tasks[0];
  assert.ok(t.agents[0].usage && t.agents[0].usage.cost_usd > 0, 'agent cost');
  assert.ok(t.usage.lead && t.usage.lead.cost_usd > 0, 'lead cost for the task');
  assert.ok(t.usage.total_cost_usd > t.usage.agents_cost_usd);
  assert.strictEqual(t.check_runs.length, 2);
  assert.deepStrictEqual(t.flaky_checks, []);
  assert.strictEqual(s.health.plugin_version, require(path.join(REPO, 'plugin', '.claude-plugin', 'plugin.json')).version);
  // a check that passed and failed on the same diff is flaky
  const p = core.activeTask(dir, SID);
  p.evidence.checks.push(Object.assign({}, p.evidence.checks[0], { passed: false, exit: 1, at: new Date().toISOString() }));
  core.saveProfile(dir, p);
  const s2 = require(path.join(REPO, 'plugin', 'scripts', 'engos-status.js')).buildStatus(dir);
  assert.deepStrictEqual(s2.tasks[0].flaky_checks, ['test']);
});

function get(url) {
  return new Promise((resolve) => { http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b })); }).on('error', () => resolve({ code: 0, body: '' })); });
}

test('server: diffs only for files the task changed (secrets redacted), task events, all projects', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lv-home-'));
  const dir = project('serve', home);
  hook('session-start', dir, { source: 'startup' }, home);
  hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'a.js') } }, home);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const KEY = "x";\nconst API_TOKEN = "supersecretvalue123";\n');
  hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'a.js') } }, home);
  const taskId = core.activeTask(dir, SID).task_id;
  const port = 45000 + Math.floor(Math.random() * 2000);
  const child = cp.spawn(process.execPath, [CLI, 'view', '--serve', '--port', String(port)], { cwd: dir, env: env(home) });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /Live view: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/.exec(out); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('no address: ' + out)), 10000);
  });
  try {
    const d = await get(base + 'diff.js?task=' + taskId + '&file=src%2Fa.js');
    assert.strictEqual(d.code, 200);
    assert.match(d.body, /^window\.__engosDiff\(/);
    assert.match(d.body, /\+const KEY/);
    assert.ok(!/supersecretvalue123/.test(d.body), 'secrets redacted in diffs');
    const other = await get(base + 'diff.js?task=' + taskId + '&file=src%2Fb.js');
    assert.match(other.body, /not one this task changed/);
    const traversal = await get(base + 'diff.js?task=' + taskId + '&file=..%2F..%2Fetc%2Fpasswd');
    assert.match(traversal.body, /not one this task changed/);
    assert.strictEqual((await get(base + 'diff.js?task=../x')).code, 400);
    const ev = await get(base + 'events.js?task=' + taskId);
    assert.match(ev.body, /"type":"task\.opened"/);
    const pr = await get(base + 'projects.js');
    assert.match(pr.body, /^window\.__engosProjects\(/);
    assert.ok(pr.body.includes(JSON.stringify(path.basename(dir))), 'this project is listed');
  } finally { child.kill(); }
});

test('throwaway folders are not added to the project list unless ENGOS_HOME is set', () => {
  const S = require(path.join(REPO, 'plugin', 'scripts', 'engos-status.js'));
  const saved = process.env.ENGOS_HOME;
  delete process.env.ENGOS_HOME;
  const fake = path.join(os.tmpdir(), 'engos-lv-not-a-project');
  const before = fs.existsSync(S.registryFile()) ? fs.readFileSync(S.registryFile(), 'utf8') : null;
  S.registerProject(fake);
  const after = fs.existsSync(S.registryFile()) ? fs.readFileSync(S.registryFile(), 'utf8') : null;
  if (saved !== undefined) process.env.ENGOS_HOME = saved;
  assert.strictEqual(after, before);
});

test('the page script parses and keeps every new control read-only', () => {
  const html = fs.readFileSync(path.join(REPO, 'plugin', 'view', 'index.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  for (const id of ['projects', 'replay', 'export', 'notify', 'lang', 'theme', 'pause']) assert.ok(html.includes("id=\"" + id + "\"") || html.includes('id="' + id + '"'), id);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|<form/i.test(js), 'the page sends nothing anywhere');
});

test('the project registry never lives in a folder named .engos (that name marks a project)', () => {
  const S = require(path.join(REPO, 'plugin', 'scripts', 'engos-status.js'));
  const saved = process.env.ENGOS_HOME;
  delete process.env.ENGOS_HOME;
  const file = S.registryFile();
  if (saved !== undefined) process.env.ENGOS_HOME = saved;
  assert.ok(!file.split(/[\/]/).includes('.engos'), file);
});
