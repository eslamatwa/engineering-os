'use strict';
// Phase 7 tests: the MCP gate (H6, D49). Run: node --test tests/unit/phase7.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'plugin', 'scripts', 'engos-hook.js');
const CLI = path.join(REPO, 'plugin', 'scripts', 'engos-cli.js');
const SID = 'sess-p7';

function env() { return Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_EXECPATH: '', AI_AGENT: '', CLAUDE_CODE_SESSION_ID: SID }); }
function hook(mode, dir, input) {
  const res = cp.spawnSync(process.execPath, [HOOK, mode], { input: JSON.stringify(Object.assign({ session_id: SID, cwd: dir }, input)), encoding: 'utf8', env: env() });
  let json = null; try { json = JSON.parse(res.stdout); } catch (_) { /* none */ }
  return { code: res.status, stderr: res.stderr, json };
}
function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p7-' + name + '-'));
  cp.execFileSync('git', ['init', '-q'], { cwd: dir });
  const r = cp.spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8', env: env() });
  assert.strictEqual(r.status, 0, r.stderr);
  hook('session-start', dir, { source: 'startup' });
  return dir;
}
const isAsk = (r) => r.code === 0 && r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'ask';

test('H6: Claude\'s own app tools pass; other MCP tools ask every call; the terminal runner always asks', () => {
  const dir = project('mcp');
  for (const t of ['mcp__ccd_turn__update_plan', 'mcp__Claude_Browser__navigate', 'mcp__visualize__show_widget', 'mcp__terminal__read_terminal']) {
    const r = hook('pre-tool-use', dir, { tool_name: t, tool_input: {} });
    assert.strictEqual(r.code, 0, t);
    assert.ok(!isAsk(r), t + ' should pass without a prompt');
  }
  const send = hook('pre-tool-use', dir, { tool_name: 'mcp__slack__send_message', tool_input: { channel: 'x', text: 'hi' } });
  assert.ok(isAsk(send));
  assert.match(send.json.hookSpecificOutput.permissionDecisionReason, /external tool/);
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'mcp__terminal__run_in_terminal', tool_input: { command: 'ls' } })));

  // the call ran: the request is granted and recorded; the next identical call asks again
  hook('post-tool-use', dir, { tool_name: 'mcp__slack__send_message', tool_input: { channel: 'x', text: 'hi' }, tool_response: {} });
  const L = fs.readFileSync(path.join(dir, '.engos', 'ledger.jsonl'), 'utf8');
  assert.match(L, /"type":"approval.granted"/);
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'mcp__slack__send_message', tool_input: { channel: 'x', text: 'hi' } })));
});

test('H6: a project can allow read-only tools, but never the terminal runner; pause keeps the gate', () => {
  const dir = project('mcp-allow');
  const cfgFile = path.join(dir, '.engos', 'config.yaml');
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace('mcp_allowlist: []', 'mcp_allowlist: ["mcp__github__get_*", "mcp__terminal__*"]'));
  assert.ok(!isAsk(hook('pre-tool-use', dir, { tool_name: 'mcp__github__get_issue', tool_input: { n: 1 } })));
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'mcp__github__create_issue', tool_input: { t: 'x' } })));
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'mcp__terminal__run_in_terminal', tool_input: { command: 'ls' } })));
  hook('prompt-expansion', dir, { prompt: '/engos:pause' });
  assert.ok(isAsk(hook('pre-tool-use', dir, { tool_name: 'mcp__github__create_issue', tool_input: { t: 'y' } })));
});
