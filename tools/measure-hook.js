#!/usr/bin/env node
'use strict';
// Measures wall time of the PreToolUse hook (node start + gate) — build plan phase 1 exit.
const cp = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const HOOK = path.resolve(__dirname, '..', 'plugin', 'scripts', 'engos-hook.js');
const CLI = path.resolve(__dirname, '..', 'plugin', 'scripts', 'engos-cli.js');
const N = Number(process.argv[2] || 40);
function p(arr, q) { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; }
function run(label, cwd, input) {
  const times = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    cp.spawnSync(process.execPath, [HOOK, 'pre-tool-use'], { input: JSON.stringify(input), env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '' }) });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  console.log(label.padEnd(34), 'p50', p(times, 0.5).toFixed(1) + 'ms', ' p95', p(times, 0.95).toFixed(1) + 'ms', ' max', Math.max(...times).toFixed(1) + 'ms');
}
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lat-plain-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-lat-proj-'));
cp.execFileSync('git', ['init', '-q'], { cwd: proj });
cp.execFileSync(process.execPath, [CLI, 'init'], { cwd: proj, stdio: 'ignore' });
cp.spawnSync(process.execPath, [HOOK, 'session-start'], { input: JSON.stringify({ session_id: 'lat', cwd: proj }), env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '' }) });
const baseline = [];
for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); cp.spawnSync(process.execPath, ['-e', '0']); baseline.push(Number(process.hrtime.bigint() - t) / 1e6); }
console.log('node -e 0 (startup only)'.padEnd(34), 'p50', p(baseline, 0.5).toFixed(1) + 'ms', ' p95', p(baseline, 0.95).toFixed(1) + 'ms');
run('no .engos (fast exit)', plain, { session_id: 'lat', cwd: plain, tool_name: 'Write' });
run('project, Write allowed', proj, { session_id: 'lat', cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, 'x') } });
run('project, Bash', proj, { session_id: 'lat', cwd: proj, tool_name: 'Bash', tool_input: { command: 'ls' } });
