'use strict';
// Token and cost benchmark: the same requests with and without Engineering OS, in real Claude Code (headless).
// Usage: node tools/bench.js <work-dir> <claude-exe> [reps] [model]
// Writes <work-dir>/results.json. Costs real usage on the account running it.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const [workDir, claudeExe, repsArg, modelArg] = process.argv.slice(2);
if (!workDir || !claudeExe) { console.error('usage: node tools/bench.js <work-dir> <claude-exe> [reps] [model]'); process.exit(2); }
const REPS = Number(repsArg) || 2;
const MODEL = modelArg || 'sonnet';
const CLI = path.join(REPO, 'plugin', 'scripts', 'engos-cli.js');

const SUM = '// Sum of a list of numbers.\nfunction sum(list) {\n  let total = 0;\n  for (let i = 1; i < list.length; i++) total += list[i];\n  return total;\n}\nmodule.exports = { sum };\n';
const SUM_TEST = "const assert = require('assert');\nconst { sum } = require('../src/sum.js');\nassert.strictEqual(sum([1, 2, 3]), 6);\nassert.strictEqual(sum([]), 0);\nconsole.log('sum tests passed');\n";
const RUN_TESTS = "const fs = require('fs');\nconst path = require('path');\nfor (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js'))) require(path.join(__dirname, f));\n";

function write(dir, rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
function git(dir, args) { cp.execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid'].concat(args), { cwd: dir, stdio: 'ignore' }); }
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'defaults' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function sumProject(dir, extraFiles) {
  write(dir, 'package.json', JSON.stringify({ name: 'bench', version: '1.0.0', scripts: { test: 'node test/run.js' } }, null, 2) + '\n');
  write(dir, 'src/sum.js', SUM);
  write(dir, 'test/sum.test.js', SUM_TEST);
  write(dir, 'test/run.js', RUN_TESTS);
  write(dir, 'README.md', '# bench\n\nSmall math helpers.\n');
  if (extraFiles) extraFiles(dir);
}

const ONLY = (process.env.BENCH_TASKS || '').split(',').filter(Boolean);
const TASKS_ALL = [
  { id: 'big-docs', setup: (d) => copyDir(path.join(REPO, 'plugin'), d), prompt: 'Write docs/MODULES.md: for every .js file in scripts/ (skip vendor/), give its purpose in one or two sentences and list each exported function with a one-line description. Read the code so it is accurate.', ok: (d) => { try { const t = fs.readFileSync(path.join(d, 'docs/MODULES.md'), 'utf8'); return /engos-orchestrate/.test(t) && /engos-hook/.test(t); } catch (_) { return false; } } },
  { id: 'analyze', setup: (d) => copyDir(path.join(REPO, 'plugin'), d), prompt: 'Give me an overview of this project: the main modules, how they connect, and the three biggest risks you see. Don\'t change any files.', ok: () => true },
  { id: 'trivial', setup: (d) => sumProject(d, (x) => write(x, 'src/sum.js', SUM.replace('i = 1', 'i = 0'))), prompt: 'Change the comment at the top of src/sum.js to: // Adds up a list of numbers.', ok: (d) => /Adds up a list of numbers/.test(fs.readFileSync(path.join(d, 'src/sum.js'), 'utf8')) },
  { id: 'bugfix', setup: (d) => sumProject(d), prompt: 'npm test fails. Find and fix the bug, and make sure the tests pass.', ok: (d) => testsPass(d) },
  { id: 'feature', setup: (d) => sumProject(d, (x) => write(x, 'src/sum.js', SUM.replace('i = 1', 'i = 0'))), prompt: 'Add an average(list) function in src/average.js that returns 0 for an empty list, with tests in test/average.test.js (npm test runs every *.test.js in test/), and mention it in README.md. Make sure the tests pass.', ok: (d) => testsPass(d) && fs.existsSync(path.join(d, 'src/average.js')) },
];

// A real project: BENCH_SUITE=latchkey with LK_SRC (a checkout) and LK_NODE_MODULES (app/ui/node_modules from npm ci).
function copyProject(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'target'].includes(e.name)) continue;
    const s2 = path.join(src, e.name), d2 = path.join(dest, e.name);
    if (e.isDirectory()) copyProject(s2, d2); else fs.copyFileSync(s2, d2);
  }
}
function latchkey(d) {
  copyProject(process.env.LK_SRC, d);
  fs.cpSync(process.env.LK_NODE_MODULES, path.join(d, 'app', 'ui', 'node_modules'), { recursive: true });
}
const uiTests = (d) => cp.spawnSync('npm', ['--prefix', 'app/ui', 'test'], { cwd: d, shell: true, stdio: 'ignore' }).status === 0;
if (process.env.BENCH_SUITE === 'latchkey') {
  TASKS_ALL.length = 0;
  TASKS_ALL.push(
    { id: 'lk-analyze', setup: latchkey, check: 'test=npm --prefix app/ui test', prompt: 'Give me an overview of this project: the main modules (the Rust crates and the UI), how they connect, and the three biggest risks you see. Do not change any files.', ok: () => true },
    { id: 'lk-forget-host', setup: latchkey, check: 'test=npm --prefix app/ui test', prompt: 'In app/ui/src/lib/recent-hosts.ts add forgetHost(host) that removes a remembered host, matching case-insensitively, and add tests for recentHosts, rememberHost and forgetHost to app/ui/tests/ui.test.mjs using a fake localStorage. Run the UI tests (npm --prefix app/ui test) and make sure they pass.', ok: (d) => uiTests(d) && /forgetHost/.test(fs.readFileSync(path.join(d, 'app/ui/src/lib/recent-hosts.ts'), 'utf8')) && /forgetHost/.test(fs.readFileSync(path.join(d, 'app/ui/tests/ui.test.mjs'), 'utf8')) },
  );
}
const TASKS = ONLY.length ? TASKS_ALL.filter((t) => ONLY.includes(t.id)) : TASKS_ALL;

function testsPass(d) { return cp.spawnSync('npm', ['test'], { cwd: d, shell: true, stdio: 'ignore' }).status === 0; }

const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Agent', 'Bash(engos:*)', 'Bash(npm test)', 'Bash(npm --prefix app/ui test)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(cat:*)'];

function runOnce(task, withPlugin, rep) {
  const dir = path.join(workDir, task.id + '-' + (withPlugin ? 'engos' : 'plain') + '-' + rep);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  task.setup(dir);
  git(dir, ['init', '-q']);
  if (withPlugin) cp.spawnSync(process.execPath, [CLI, 'init', '--models', 'haiku,sonnet,opus', '--check', task.check || 'test=npm test'], { cwd: dir, stdio: 'ignore' });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'start']);
  const args = ['-p', task.prompt, '--model', MODEL, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--allowedTools'].concat(TOOLS);
  if (withPlugin) args.push('--plugin-dir', path.join(REPO, 'plugin'));
  const t0 = Date.now();
  const res = cp.spawnSync(claudeExe, args, { cwd: dir, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  let j = {};
  try { j = JSON.parse(res.stdout); } catch (_) { j = { parse_error: String(res.stdout || res.stderr).slice(0, 300) }; }
  const models = {};
  for (const [m, u] of Object.entries(j.modelUsage || {})) models[m] = { cost: u.costUSD, input: u.inputTokens, output: u.outputTokens, cache_read: u.cacheReadInputTokens, cache_write: u.cacheCreationInputTokens };
  const tokens = Object.values(models).reduce((a, u) => a + (u.input || 0) + (u.output || 0) + (u.cache_read || 0) + (u.cache_write || 0), 0);
  let ledger = null;
  try { ledger = fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type); } catch (_) { /* plain */ }
  return {
    task: task.id, plugin: withPlugin, rep,
    ok: !j.is_error && task.ok(dir),
    cost_usd: j.total_cost_usd || null,
    tokens_total: tokens,
    turns: j.num_turns || null,
    duration_s: Math.round((Date.now() - t0) / 1000),
    models,
    engos_events: ledger ? ledger.filter((t) => t !== 'session.started').length : null,
    agents_started: ledger ? ledger.filter((t) => t === 'step.started').length : null,
    denials: ledger ? ledger.filter((t) => t === 'gate.denied').length : null,
    error: j.parse_error || (j.is_error ? String(j.result || '').slice(0, 300) : null),
  };
}

const out = path.join(workDir, 'results.json');
const results = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const task of TASKS) {
    for (const withPlugin of [false, true]) {
      if (results.some((r) => r.task === task.id && r.plugin === withPlugin && r.rep === rep)) continue;
      const r = runOnce(task, withPlugin, rep);
      results.push(r);
      fs.writeFileSync(out, JSON.stringify(results, null, 2));
      console.log([r.task, r.plugin ? 'engos' : 'plain', 'rep ' + rep, r.ok ? 'ok' : 'FAILED', '$' + (r.cost_usd || 0).toFixed(4), r.tokens_total + ' tok', r.duration_s + 's'].join('  '));
    }
  }
}
console.log('done: ' + out);
