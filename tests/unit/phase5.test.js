'use strict';
// Phase 5 tests: routing, the Agent gate (H5), role cards (H10), report checks (H11), escalation (D20, D21),
// the Fable ask (D32), disputes (D25), read-only tasks, facts and uncertainty checks (D22).
// Run: node --test tests/unit/phase5.test.js
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
const O = require(path.join(REPO, 'plugin', 'scripts', 'engos-orchestrate.js'));

const SID = 'sess-p5';

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
function project(name, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p5-' + name + '-'));
  git(dir, ['init', '-q']);
  write(dir, 'src/a.ts', 'a\n');
  write(dir, 'src/b.ts', 'b\n');
  write(dir, 'src/c.ts', 'c\n');
  write(dir, 'logs/app.log', 'ok start\nERROR db timeout after 30s\nERROR cache miss storm\n');
  const args = ['init', '--models', o.models || 'haiku,sonnet,opus'];
  for (const c of o.checks || ['test=node -e 0']) args.push('--check', c);
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
function task(dir) { return core.activeTask(dir, SID); }
function planned(dir, kind, steps, extra) {
  cli(dir, ['task', 'open', '--summary', 'p5 ' + kind]);
  cli(dir, ['profile', 'set', '--kind', kind].concat(extra || []));
  const r = cli(dir, ['plan', 'set', '--scope-write', 'src/**', '--steps', steps]);
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const t = task(dir);
  if (t.effective.class !== 'high_risk') { t.effective.class = 'standard'; core.saveProfile(dir, t); }
  return task(dir);
}
function agentCall(dir, type, model, prompt, extra) {
  return hook('pre-tool-use', dir, Object.assign({ tool_name: 'Agent', tool_input: { subagent_type: type, model, prompt: prompt || '', description: 'x' } }, extra || {}));
}
// Simulate a whole worker launch: gate, start, its edit, Agent post, stop with a report.
function runWorker(dir, step, model, opts) {
  const o = opts || {};
  const g = agentCall(dir, 'engos:worker', model, 'step_id: ' + step);
  assert.strictEqual(g.code, 0, g.stderr);
  const aid = 'agent-' + Math.random().toString(16).slice(2, 8);
  const st = hook('subagent-start', dir, { agent_id: aid, agent_type: 'engos:worker' });
  hook('post-tool-use', dir, { tool_name: 'Agent', tool_input: { subagent_type: 'engos:worker', model }, tool_response: { resolvedModel: 'claude-' + model + '-5-5', status: 'async_launched' } });
  if (o.file) {
    const pre = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, o.file) }, agent_id: aid, agent_type: 'engos:worker' });
    assert.strictEqual(pre.code, 0, pre.stderr);
    write(dir, o.file, String(Math.random()) + '\n');
    hook('post-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, o.file) }, agent_id: aid, agent_type: 'engos:worker' });
  }
  const report = o.report || ('```yaml\nschema: engos/report@1\nstep_id: ' + step + '\nstatus: done\ninputs_read: []\noutputs_changed: [' + (o.file || '') + ']\nevidence: []\nlimitations: []\nnext_action: check\n```');
  const stop = hook('subagent-stop', dir, { agent_id: aid, agent_type: 'engos:worker', last_assistant_message: report, stop_hook_active: false });
  return { aid, start: st, stop };
}

// ---------------------------------------------------------------------------

test('router: steps get executor, role and tier from config', () => {
  const dir = project('route');
  const t = planned(dir, 'bugfix', 'S1:locate,S2:implement,S3:verify');
  const s = Object.fromEntries(t.planned.steps.map((x) => [x.id, x]));
  assert.deepStrictEqual([s.S1.by, s.S1.tier, s.S1.role], ['scout', 'fast', 'triager']);
  assert.deepStrictEqual([s.S2.by, s.S2.tier, s.S2.role], ['worker', 'balanced', 'implementer']);
  assert.strictEqual(s.S3.by, 'validator');
  assert.ok(t.effective.roles.includes('triager') && t.effective.roles.includes('implementer'));
  const brief = cli(dir, ['step', 'brief', 'S2']);
  assert.strictEqual(brief.code, 0, brief.stderr);
  assert.match(brief.stdout, /subagent_type: engos:worker/);
  assert.match(brief.stdout, /model: sonnet/);
  assert.match(brief.stdout, /step_id: S2/);
  assert.match(brief.stdout, /engos check test/);
});

test('C5: a subagent can\'t start agents', () => {
  const dir = project('c5');
  planned(dir, 'bugfix', 'S2:implement');
  const r = agentCall(dir, 'engos:scout', 'haiku', '', { agent_id: 'a1', agent_type: 'engos:worker' });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /can't start other agents/);
});

test('C8: wrong model for a step is refused; the real model is recorded from resolvedModel', () => {
  const dir = project('c8');
  planned(dir, 'bugfix', 'S2:implement');
  let r = agentCall(dir, 'engos:worker', 'opus', 'step_id: S2');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /routed to the balanced tier .* must be "sonnet", not "opus"/);
  r = agentCall(dir, 'engos:worker', undefined, 'step_id: S2');
  assert.match(r.stderr, /set model: "sonnet"/);
  r = agentCall(dir, 'engos:worker', 'sonnet', 'no step here');
  assert.match(r.stderr, /needs its brief/);
  const w = runWorker(dir, 'S2', 'sonnet', { file: 'src/a.ts' });
  assert.strictEqual(w.stop.code, 0);
  const a = task(dir).agents[0];
  assert.strictEqual(a.model_actual, 'claude-sonnet-5-5');
  assert.ok(ledger(dir).some((e) => e.type === 'gate.denied' && e.rule_id === 'G-model'));
});

test('C9: one writer at a time, approved agents only, Explore allowed', () => {
  const dir = project('c9');
  planned(dir, 'bugfix', 'S2:implement,S3:implement');
  assert.strictEqual(agentCall(dir, 'engos:worker', 'sonnet', 'step_id: S2').code, 0);
  hook('subagent-start', dir, { agent_id: 'w1', agent_type: 'engos:worker' });
  let r = agentCall(dir, 'engos:worker', 'sonnet', 'step_id: S3');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /Only one writer at a time/);
  r = agentCall(dir, 'general-purpose', 'opus', 'do it');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /isn't allowed during a task/);
  assert.strictEqual(agentCall(dir, 'Explore', undefined, 'find x').code, 0);
  assert.strictEqual(agentCall(dir, 'engos:scout', undefined, 'read logs').code, 0); // read-only in parallel
  // after the worker stops, the next writer may start
  hook('subagent-stop', dir, { agent_id: 'w1', agent_type: 'engos:worker', last_assistant_message: '```yaml\nschema: engos/report@1\nstatus: done\ninputs_read: []\noutputs_changed: []\nevidence: []\nlimitations: []\nnext_action: x\n```' });
  assert.strictEqual(agentCall(dir, 'engos:worker', 'sonnet', 'step_id: S3').code, 0);
});

test('H10/H11: role card at start; a wrong report is sent back once, then the lead is told', () => {
  const dir = project('h11');
  planned(dir, 'bugfix', 'S2:implement');
  const bad = '```yaml\nschema: engos/report@1\nstatus: done\ninputs_read: []\noutputs_changed: []\nevidence: []\nlimitations: []\nnext_action: x\n```';
  const w = runWorker(dir, 'S2', 'sonnet', { file: 'src/a.ts', report: bad });
  const ctx = w.start.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Role: implementer/);
  assert.match(ctx, /engos\/report@1/);
  assert.match(ctx, /Write scope: src\/\*\*/);
  assert.strictEqual(w.stop.json.decision, 'block');
  assert.match(w.stop.json.reason, /outputs_changed lists \[\] but Engineering OS observed \[src\/a.ts\]/);
  const again = hook('subagent-stop', dir, { agent_id: w.aid, agent_type: 'engos:worker', last_assistant_message: bad, stop_hook_active: true });
  assert.notStrictEqual(again.json && again.json.decision, 'block');
  assert.match(again.json.systemMessage, /report had 1 problem/);
  assert.strictEqual(task(dir).notices.length, 1);
  // the lead hears about it on its next tool call
  write(dir, 'src/b.ts', 'b2\n');
  hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/b.ts') } });
  const post = hook('post-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/b.ts') } });
  assert.match(post.json.reason, /Treat its claims as unverified/);
});

test('scout and validator can\'t edit; scout Bash is read-only', () => {
  const dir = project('ro-agents');
  planned(dir, 'bugfix', 'S2:implement');
  let r = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') }, agent_id: 'v1', agent_type: 'engos:validator' });
  assert.strictEqual(r.code, 2);
  r = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'npm run build' }, agent_id: 's1', agent_type: 'engos:scout' });
  assert.strictEqual(r.code, 2);
  r = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'grep -rn x src' }, agent_id: 's1', agent_type: 'engos:scout' });
  assert.strictEqual(r.code, 0);
});

test('C1: three attempts (sonnet, sonnet, opus), then blocked with a handover; retry and stop are the user\'s', () => {
  const dir = project('c1', { checks: ['test=node -e "process.exit(1)"'] });
  const t = planned(dir, 'bugfix', 'S2:implement');
  const models = [];
  for (let i = 0; i < 3; i++) {
    const brief = cli(dir, ['step', 'brief', 'S2']);
    const m = /model: (\w+)/.exec(brief.stdout)[1];
    models.push(m);
    if (i === 1) assert.match(brief.stdout, /prior_failure:/);
    runWorker(dir, 'S2', m, { file: 'src/a.ts' });
    const chk = cli(dir, ['check', 'test']);
    assert.strictEqual(chk.code, 1);
    if (i < 2) assert.match(chk.stdout, new RegExp('Attempt ' + (i + 1) + ' of 3'));
    else assert.match(chk.stdout, /is blocked and goes to the user \(attempts_exhausted\)/);
  }
  assert.deepStrictEqual(models, ['sonnet', 'sonnet', 'opus']);
  const p = core.loadProfile(dir, t.task_id);
  assert.strictEqual(p.status, 'needs_human');
  assert.deepStrictEqual(p.decision_options, ['retry', 'stop']); // no fable on this account
  const h = JSON.parse(fs.readFileSync(path.join(dir, '.engos', 'tasks', t.task_id, 'handover.json'), 'utf8'));
  assert.strictEqual(h.tried.length, 3);
  assert.deepStrictEqual(h.state.checks_failing, ['test']);
  assert.strictEqual(agentCall(dir, 'engos:worker', 'opus', 'step_id: S2').code, 2);
  const d = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + t.task_id + ' retry' });
  assert.match(d.json.systemMessage, /one more attempt on the frontier tier/);
  assert.match(cli(dir, ['step', 'brief', 'S2']).stdout, /model: opus/);
  assert.ok(ledger(dir).some((e) => e.type === 'responsibility.transferred' && e.to === 'human'));
});

test('C2: environment errors don\'t burn attempts; the second goes to the user', () => {
  const dir = project('c2', { checks: ['test=definitely-not-a-command-xyz'] });
  const t = planned(dir, 'bugfix', 'S2:implement');
  runWorker(dir, 'S2', 'sonnet', { file: 'src/a.ts' });
  let chk = cli(dir, ['check', 'test']);
  assert.match(chk.stdout, /Labelled env_error/);
  assert.strictEqual(O.failuresFor(core.loadProfile(dir, t.task_id), 'S2'), 0);
  chk = cli(dir, ['check', 'test']);
  assert.match(chk.stdout, /env_error_limit/);
  assert.strictEqual(core.loadProfile(dir, t.task_id).status, 'needs_human');
});

test('C3: a deep step needs the user\'s yes; yes runs on fable, no on opus, both recorded', () => {
  const dir = project('c3', { models: 'haiku,sonnet,opus,fable' });
  const t = planned(dir, 'migration', 'S1:plan_migration');
  let r = agentCall(dir, 'engos:worker', 'fable', 'step_id: S1');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /Fable needs the user's yes/);
  assert.match(cli(dir, ['step', 'brief', 'S1']).stdout, /engos:decide .* fable/);
  const forged = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + t.task_id + ' fable' }, 'other-session');
  assert.match(forged.json.systemMessage, /another session/);
  const yes = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + t.task_id + ' fable' });
  assert.match(yes.json.systemMessage, /Fable approved/);
  assert.strictEqual(agentCall(dir, 'engos:worker', 'opus', 'step_id: S1').code, 2);
  assert.strictEqual(agentCall(dir, 'engos:worker', 'fable', 'step_id: S1').code, 0);
  const L = ledger(dir);
  assert.ok(L.some((e) => e.type === 'model.asked' && e.tier === 'deep'));
  assert.ok(L.some((e) => e.type === 'model.answered' && e.answer === 'yes' && e.actor.kind === 'human'));

  const dir2 = project('c3no', { models: 'haiku,sonnet,opus,fable' });
  const t2 = planned(dir2, 'migration', 'S1:plan_migration');
  agentCall(dir2, 'engos:worker', 'fable', 'step_id: S1');
  hook('prompt-expansion', dir2, { prompt: '/engos:decide ' + t2.task_id + ' no_fable' });
  assert.strictEqual(agentCall(dir2, 'engos:worker', 'fable', 'step_id: S1').code, 2);
  assert.strictEqual(agentCall(dir2, 'engos:worker', 'opus', 'step_id: S1').code, 0);
});

test('C4: a model the account lacks falls back with a note; a failed call marks it unavailable', () => {
  const dir = project('c4');
  planned(dir, 'migration', 'S1:plan_migration');
  const brief = cli(dir, ['step', 'brief', 'S1']);
  assert.match(brief.stdout, /model: opus/);
  assert.match(brief.stdout, /fable is not available/);
  const r = agentCall(dir, 'engos:worker', 'opus', 'step_id: S1');
  assert.strictEqual(r.code, 0);
  assert.match(r.json.systemMessage, /fable is not available/);

  const dir2 = project('c4b', { models: 'haiku,sonnet,opus,fable' });
  const t2 = planned(dir2, 'migration', 'S1:plan_migration');
  agentCall(dir2, 'engos:worker', 'fable', 'step_id: S1');
  hook('prompt-expansion', dir2, { prompt: '/engos:decide ' + t2.task_id + ' fable' });
  assert.strictEqual(agentCall(dir2, 'engos:worker', 'fable', 'step_id: S1').code, 0);
  const f = hook('post-tool-use-failure', dir2, { tool_name: 'Agent', tool_input: { subagent_type: 'engos:worker', model: 'fable' }, error: 'model fable is not available for your plan' });
  assert.match(f.json.hookSpecificOutput.additionalContext, /marked unavailable/);
  assert.match(cli(dir2, ['step', 'brief', 'S1']).stdout, /model: opus/);
});

test('C10: lead settles one dispute in standard; the next, high_risk and medium security findings go to the user', () => {
  const dir = project('c10');
  const t = planned(dir, 'feature', 'S2:implement,S3:verify');
  let r = cli(dir, ['dispute', 'open', '--about', 'AC-2', '--reason', 'validator says not covered']);
  assert.match(r.stdout, /the lead settles once/);
  r = cli(dir, ['dispute', 'settle', 'DSP-1', '--side', 'worker', '--reason', 'covered by test x']);
  assert.strictEqual(r.code, 0, r.stderr);
  r = cli(dir, ['dispute', 'open', '--about', 'AC-3', '--reason', 'again']);
  assert.match(r.stdout, /goes to the user/);
  assert.strictEqual(core.loadProfile(dir, t.task_id).status, 'needs_human');
  r = cli(dir, ['dispute', 'settle', 'DSP-2', '--side', 'worker', '--reason', 'x']);
  assert.notStrictEqual(r.code, 0);
  const d = hook('prompt-expansion', dir, { prompt: '/engos:decide ' + t.task_id + ' validator' });
  assert.match(d.json.systemMessage, /in favour of the validator/);
  assert.ok(ledger(dir).some((e) => e.type === 'dispute.resolved' && e.resolved_by === 'human'));

  const p = { effective: { class: 'standard' }, disputes: [] };
  assert.strictEqual(O.disputeSettler(p, { security: true, severity: 'medium' }, core.defaults()).by, 'human');
  assert.strictEqual(O.disputeSettler(p, { security: true, severity: 'low' }, core.defaults()).by, 'lead');
  assert.strictEqual(O.disputeSettler({ effective: { class: 'high_risk' } }, {}, core.defaults()).by, 'human');
});

test('E-review-record: a validator verdict with real refs lets a high_risk task close', () => {
  const dir = project('review');
  const t = planned(dir, 'bugfix', 'S2:implement,S3:verify', ['--sensitivity', 'payments']);
  assert.strictEqual(task(dir).effective.class, 'high_risk');
  const brief = cli(dir, ['step', 'brief', 'S3']);
  assert.match(brief.stdout, /engos:validator/);
  assert.match(brief.stdout, /model: opus/); // high assurance
  assert.strictEqual(agentCall(dir, 'engos:validator', 'opus', 'step_id: S3').code, 0);
  hook('subagent-start', dir, { agent_id: 'v1', agent_type: 'engos:validator' });
  const badRef = '```yaml\nschema: engos/report@1\nstatus: done\ninputs_read: []\noutputs_changed: []\nevidence: []\nlimitations: []\nnext_action: x\nverdict: pass\nfindings: [{ ref: "src/nope.ts:3", severity: low, text: x }]\n```';
  const s1 = hook('subagent-stop', dir, { agent_id: 'v1', agent_type: 'engos:validator', last_assistant_message: badRef });
  assert.match(s1.json.reason, /finding refs don't exist/);
  const good = badRef.replace('src/nope.ts:3', 'src/a.ts:1');
  hook('subagent-stop', dir, { agent_id: 'v1', agent_type: 'engos:validator', last_assistant_message: good, stop_hook_active: true });
  const p = core.loadProfile(dir, t.task_id);
  assert.strictEqual(p.reviews[0].verdict, 'pass');
  assert.strictEqual(p.reviews[0].refs_ok, true);
  const E = require(path.join(REPO, 'plugin', 'scripts', 'engos-evidence.js'));
  const ev = E.evaluateClose(p, { checks: {} }, { residualRisk: 'none' });
  assert.ok(ev.met.some((m) => m.startsWith('E-review-record')), JSON.stringify(ev));
});

test('D47: with worker steps planned, the lead edits at most 2 files itself', () => {
  const dir = project('d47');
  planned(dir, 'feature', 'S2:implement');
  for (const f of ['src/a.ts', 'src/b.ts']) {
    assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, f) } }).code, 0);
    write(dir, f, 'x\n');
    hook('post-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, f) } });
  }
  const r = hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/c.ts') } });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /engos step brief S2/);
  // a worker may edit it
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/c.ts') }, agent_id: 'w', agent_type: 'engos:worker' }).code, 0);
});

test('D2/D4: analysis and security_review tasks are read-only; facts need a real source', () => {
  const dir = project('d4');
  cli(dir, ['task', 'open', '--summary', 'audit']);
  cli(dir, ['profile', 'set', '--kind', 'security_review']);
  let r = hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.ts') } });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /read-only/);
  r = hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'npm run fix' } });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Bash', tool_input: { command: 'git log -5' } }).code, 0);
  assert.notStrictEqual(cli(dir, ['facts', 'add', '--fact', 'x', '--source', 'src/missing.ts:4']).code, 0);
  assert.strictEqual(cli(dir, ['facts', 'add', '--fact', 'a is set', '--source', 'src/a.ts:1']).code, 0);
  assert.strictEqual(cli(dir, ['facts', 'add', '--assumption', 'prod uses the same config']).code, 0);
  const facts = task(dir).facts;
  assert.deepStrictEqual(facts.map((f) => f.kind), ['verified', 'assumed']);
});

test('D3: triage reports need a hypothesis and verbatim quotes; two components raise later tiers', () => {
  const dir = project('d3');
  const t = planned(dir, 'debugging', 'S1:triage,S2:implement');
  assert.strictEqual(agentCall(dir, 'engos:scout', 'haiku', 'step_id: S1').code, 0);
  hook('subagent-start', dir, { agent_id: 's1', agent_type: 'engos:scout' });
  const rep = (q) => '```yaml\nschema: engos/report@1\nstatus: done\ninputs_read: [logs/app.log]\noutputs_changed: []\nevidence: []\nlimitations: []\nnext_action: fix\nhypothesis: "db pool exhausted"\nquotes: [{ file: logs/app.log, text: "' + q + '" }]\ncomponents: [db, cache]\n```';
  const s = hook('subagent-stop', dir, { agent_id: 's1', agent_type: 'engos:scout', last_assistant_message: rep('ERROR db timeout after 99s') });
  assert.match(s.json.reason, /U-quotes/);
  hook('subagent-stop', dir, { agent_id: 's1', agent_type: 'engos:scout', last_assistant_message: rep('ERROR db timeout after 30s'), stop_hook_active: true });
  const p = core.loadProfile(dir, t.task_id);
  assert.strictEqual(p.cross_system, true);
  assert.match(cli(dir, ['step', 'brief', 'S2']).stdout, /model: opus/); // debugging → frontier already; stays frontier (never auto deep)
  assert.strictEqual(O.upTier('balanced'), 'frontier');
  assert.strictEqual(O.upTier('frontier'), 'frontier');
});
