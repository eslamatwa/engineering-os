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

test('D50: recommendations come only from the official marketplace, fit the project, and skip installed ones', () => {
  const Rec = require(path.join(REPO, 'plugin', 'scripts', 'engos-recommend.js'));
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'defaults', 'recommendations.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engos-p7-rec-'));
  cp.execFileSync('git', ['init', '-q'], { cwd: dir });
  cp.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15', stripe: '1' } }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default 1');
  const off = (name, d, n) => ({ name, description: d, installCount: n, marketplaceName: 'claude-plugins-official' });
  const cat = {
    available: [
      off('code-review', 'Automated code review', 400), off('security-guidance', 'Security review', 300),
      off('github', 'Official GitHub MCP server', 350), off('typescript-lsp', 'TypeScript language server', 200),
      off('frontend-design', 'Frontend design skill', 900), off('stripe', 'Stripe development plugin', 80),
      off('vercel', 'Vercel deployment integration', 250),
      { name: 'stripe-unofficial', description: 'x', marketplaceName: 'some-other-market' },
      { name: 'playwright', description: 'Browser MCP server', marketplaceName: 'anthropic-plugin-directory' }, // not the official marketplace
    ],
    installed: [{ id: 'security-guidance@claude-plugins-official' }],
  };
  const out = Rec.recommend(dir, cfg, cat, {});
  const names = [].concat(out.groups.skills, out.groups.mcp, out.groups.code).map((x) => x.name);
  for (const n of ['code-review', 'github', 'typescript-lsp', 'frontend-design', 'stripe', 'vercel']) assert.ok(names.includes(n), n + ' should be recommended');
  assert.ok(!names.includes('security-guidance'), 'installed plugins are not recommended again');
  assert.deepStrictEqual(out.already_installed, ['security-guidance']);
  assert.ok(!names.includes('playwright') && !names.includes('stripe-unofficial'), 'only the official marketplace');
  assert.deepStrictEqual(out.groups.mcp.map((x) => x.name), ['github']);
  const gh = out.groups.mcp[0];
  assert.strictEqual(gh.install_in_session, '/plugin install github@claude-plugins-official');
  assert.strictEqual(gh.install_in_terminal, 'claude plugin install github@claude-plugins-official');
  assert.match(gh.why, /GitHub/);
  assert.deepStrictEqual(out.groups.skills.map((x) => x.name).slice(0, 2), ['frontend-design', 'code-review']); // by install count
  assert.ok(Rec.recommend(dir, cfg, { error: 'no catalog' }, {}).error);
});

test('cost: one command sets profile and plan; the refusal names that one command', () => {
  const dir = project('oneshot');
  const run = (args) => cp.spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: env() });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, 'src', f + '.js'), '1\n');
  cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A'], { cwd: dir });
  cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x'], { cwd: dir });
  for (const f of ['a', 'b', 'c']) {
    const pre = hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', f + '.js') } });
    if (pre.code === 2) {
      assert.match(pre.stderr, /engos plan set --kind <bugfix\|feature/);
      assert.ok(!/profile set/.test(pre.stderr), 'one command, not two');
      break;
    }
    fs.writeFileSync(path.join(dir, 'src', f + '.js'), '2\n' + f.repeat(30) + '\n'.repeat(20));
    hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', f + '.js') } });
  }
  assert.notStrictEqual(run(['plan', 'set', '--scope-write', 'src/**']).status, 0, 'plan without a kind is refused when no profile exists');
  const r = run(['plan', 'set', '--kind', 'feature', '--scope-write', 'src/**']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Edits can continue/);
});

test('D51: lines in docs files do not count against the trivial budget; code lines do', () => {
  const core = require(path.join(REPO, 'plugin', 'scripts', 'engos-core.js'));
  const big = Array.from({ length: 120 }, (_, i) => 'line ' + i).join('\n') + '\n';
  for (const [rel, want] of [['docs/MODULES.md', 'trivial_edit'], ['README.md', 'trivial_edit'], ['src/big.js', 'standard']]) {
    const dir = project('d51-' + rel.replace(/\W/g, ''));
    cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });
    const file = path.join(dir, rel);
    assert.strictEqual(hook('pre-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: file } }).code, 0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, big);
    hook('post-tool-use', dir, { tool_name: 'Write', tool_input: { file_path: file } });
    assert.strictEqual(core.activeTask(dir, SID).effective.class, want, rel);
  }
});
