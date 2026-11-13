#!/usr/bin/env node
'use strict';
// Measures wall time of the hooks (Node start + Engineering OS code). D44 target: our code adds <= 30 ms p95
// to the gate (pre-tool-use). The observer (post-tool-use) runs git and is reported separately.
const cp = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const HOOK = path.resolve(__dirname, '..', 'plugin', 'scripts', 'engos-hook.js');
const CLI = path.resolve(__dirname, '..', 'plugin', 'scripts', 'engos-cli.js');
const N = Number(process.argv[2] || 30);
const ENV = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', CLAUDE_CODE_SESSION_ID: 'lat' });
function p(arr, q) { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; }
function time(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }
function hook(mode, input) { return cp.spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(Object.assign({ session_id: 'lat' }, input)), env: ENV }); }
function run(label, fn) {
  const t = []; for (let i = 0; i < N; i++) t.push(time(fn));
  console.log(label.padEnd(38), 'p50', p(t, 0.5).toFixed(1).padStart(6) + 'ms', ' p95', p(t, 0.95).toFixed(1).padStart(6) + 'ms');
  return t;
}
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lat-plain-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lat-proj-'));
cp.execFileSync('git', ['init', '-q'], { cwd: proj });
for (let i = 0; i < 50; i++) { fs.mkdirSync(path.join(proj, 'src', 'm' + (i % 5)), { recursive: true }); fs.writeFileSync(path.join(proj, 'src', 'm' + (i % 5), 'f' + i + '.js'), 'x\n'); }
cp.execFileSync(process.execPath, [CLI, 'init'], { cwd: proj, stdio: 'ignore' });
cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A'], { cwd: proj });
cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i'], { cwd: proj });
hook('session-start', { cwd: proj });
const target = path.join(proj, 'src', 'm0', 'f0.js');
hook('pre-tool-use', { cwd: proj, tool_name: 'Write', tool_input: { file_path: target } }); // opens the trivial task
fs.writeFileSync(target, 'y\n');
console.log('Windows, ' + N + ' runs each, process spawn to exit');
const base = run('node -e 0 (Node start-up only)', () => cp.spawnSync(process.execPath, ['-e', '0']));
run('gate: no .engos (fast exit)', () => hook('pre-tool-use', { cwd: plain, tool_name: 'Write' }));
const w = run('gate: Write in open trivial task', () => hook('pre-tool-use', { cwd: proj, tool_name: 'Write', tool_input: { file_path: target } }));
const b = run('gate: Bash classify (npm run build)', () => hook('pre-tool-use', { cwd: proj, tool_name: 'Bash', tool_input: { command: 'npm run build' } }));
run('observer: after Write (git status+diff)', () => hook('post-tool-use', { cwd: proj, tool_name: 'Write', tool_input: { file_path: target } }));
run('observer: after Bash (+ protected snapshot)', () => hook('post-tool-use', { cwd: proj, tool_name: 'Bash', tool_input: { command: 'node x.js' } }));
const over = (arr) => (p(arr, 0.95) - p(base, 0.95)).toFixed(1);
console.log('gate overhead over Node start-up (p95): Write ' + over(w) + ' ms, Bash ' + over(b) + ' ms  (D44 target <= 30 ms)');
