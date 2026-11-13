'use strict';
// Engineering OS — plugin recommendations (D50).
// Reads signals from the project, matches config/recommendations.yaml, and keeps only plugins that are in
// Anthropic's official marketplace right now (from `claude plugin list --available --json`). Never installs:
// it returns the commands for the user to run.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

// What the project is made of. Cheap: git ls-files, package.json, a few names, the remote.
function signals(root) {
  const files = new Set();
  const ext = new Set();
  let list = [];
  try {
    list = cp.execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (_) {
    try { list = fs.readdirSync(root); } catch (_) { list = []; }
  }
  for (const f of list.slice(0, 200000)) {
    if (/(^|\/)(node_modules|vendor|dist|build)\//.test(f)) continue;
    files.add(f);
    const m = /(\.[A-Za-z0-9]+)$/.exec(f);
    if (m) ext.add(m[1].toLowerCase());
  }
  const deps = new Set();
  for (const f of list.filter((x) => /(^|\/)package\.json$/.test(x) && !/node_modules/.test(x)).slice(0, 20)) {
    const p = readJson(path.join(root, f)) || {};
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const d of Object.keys(p[k] || {})) deps.add(d);
  }
  for (const f of list.filter((x) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/.test(x)).slice(0, 10)) {
    try { for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/^\s*["']?([A-Za-z0-9_.-]+)/gm)) deps.add(m[1].toLowerCase()); } catch (_) { /* skip */ }
  }
  let remote = '';
  try { remote = cp.execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { /* none */ }
  return { files, ext, deps, remote };
}

function fileHit(sig, patterns) {
  const R = require('./engos-rules.js');
  return (patterns || []).some((p) => {
    if (!/[*?]/.test(p)) return sig.files.has(p) || [...sig.files].some((f) => f.endsWith('/' + p));
    const re = R.globToRegex(p);
    return [...sig.files].some((f) => re.test(f) || re.test(path.posix.basename(f)));
  });
}

function matches(when, sig) {
  if (when.always) return true;
  if (when.git_remote && sig.remote.toLowerCase().includes(String(when.git_remote).toLowerCase())) return true;
  if (when.files && fileHit(sig, when.files)) return true;
  if (when.ext && when.ext.some((e) => sig.ext.has(String(e).toLowerCase()))) return true;
  if (when.deps && when.deps.some((d) => sig.deps.has(d))) return true;
  return false;
}

// The official catalog and what is installed, from the user's own Claude Code.
function catalog(claudeExe) {
  const exe = claudeExe || process.env.CLAUDE_CODE_EXECPATH || 'claude';
  const res = cp.spawnSync(exe, ['plugin', 'list', '--available', '--json'], { encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024 * 1024, shell: !process.env.CLAUDE_CODE_EXECPATH && !claudeExe });
  if (res.status !== 0) return { error: 'could not read the plugin catalog from Claude Code (' + String(res.stderr || res.error || 'exit ' + res.status).split('\n')[0].slice(0, 160) + ')' };
  let j;
  try { j = JSON.parse(res.stdout); } catch (e) { return { error: 'the plugin catalog was not valid JSON' }; }
  return { available: j.available || [], installed: j.installed || [] };
}

function kindOf(p) {
  const d = String(p.description || '');
  if (/\bLSP\b|language server/i.test(d) || /-lsp$/.test(p.name)) return 'code intelligence';
  if (/\bMCP\b/i.test(d)) return 'MCP server';
  return 'skills';
}

// Returns { groups: { mcp: [...], skills: [...], code: [...] }, signals: {...} } or { error }.
function recommend(root, cfg, cat, opts) {
  const o = opts || {};
  if (cat.error) return { error: cat.error };
  const market = cfg.marketplace || 'claude-plugins-official';
  const official = new Map();
  for (const p of cat.available) if (p.marketplaceName === market) official.set(p.name, p);
  const installed = new Set((cat.installed || []).map((p) => String(p.id || p.pluginId || '').split('@')[0]));
  const sig = signals(root);
  const picked = new Map();
  for (const rule of cfg.rules || []) {
    if (!matches(rule.when || {}, sig)) continue;
    for (const name of rule.plugins || []) {
      if (picked.has(name)) continue;
      const p = official.get(name);
      if (!p) continue;                       // not in the official marketplace today: never recommended
      picked.set(name, {
        name,
        id: name + '@' + market,
        why: rule.why,
        description: String(p.description || '').slice(0, 220),
        installs: p.installCount || null,
        kind: kindOf(p),
        installed: installed.has(name),
        install_in_session: '/plugin install ' + name + '@' + market,
        install_in_terminal: 'claude plugin install ' + name + '@' + market,
      });
    }
  }
  const all = [...picked.values()].filter((x) => o.includeInstalled || !x.installed).sort((a, b) => (b.installs || 0) - (a.installs || 0));
  const limit = o.limit || cfg.limit_per_group || 5;
  return {
    marketplace: market,
    groups: {
      skills: all.filter((x) => x.kind === 'skills').slice(0, limit),
      mcp: all.filter((x) => x.kind === 'MCP server').slice(0, limit),
      code: all.filter((x) => x.kind === 'code intelligence').slice(0, limit),
    },
    already_installed: [...picked.values()].filter((x) => x.installed).map((x) => x.name),
    signals: { remote_host: (/(github\.com|gitlab|bitbucket)/i.exec(sig.remote) || [''])[0], extensions: [...sig.ext].slice(0, 30), dependencies: sig.deps.size },
  };
}

module.exports = { signals, matches, catalog, recommend, kindOf };
