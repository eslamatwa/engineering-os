'use strict';
// Engineering OS — evidence and closing tasks (phase 4, D36).
// Checks count only when run through `engos check <name>`: this module runs the exact configured
// command and records the exit code itself. Command output is never stored (it may contain secrets);
// only its hash and line count are.

const cp = require('child_process');
const crypto = require('crypto');
const path = require('path');
const rules = require('./engos-rules.js');

// Checks that must pass before a task closes: `required_checks` in config, else every configured check.
function requiredChecks(config) {
  const checks = (config && config.checks) || {};
  const configured = Object.keys(checks).filter((k) => typeof checks[k] === 'string' && checks[k].trim());
  if (Array.isArray(config && config.required_checks)) return config.required_checks.filter((k) => configured.includes(k));
  return configured;
}

// Run one configured check. Output streams to the terminal so Claude sees it; the record keeps only facts.
function runCheck(root, config, name, opts) {
  const o = opts || {};
  const checks = (config && config.checks) || {};
  const command = checks[name];
  if (typeof command !== 'string' || !command.trim()) {
    const names = Object.keys(checks).filter((k) => typeof checks[k] === 'string' && checks[k].trim());
    return { error: 'no check named "' + name + '" in .engos/config.yaml' + (names.length ? '. Configured: ' + names.join(', ') : '. Add it under checks:') };
  }
  const started = Date.now();
  const res = cp.spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: (o.timeoutSec || 900) * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const timedOut = res.error && /ETIMEDOUT/.test(String(res.error.code || res.error.message));
  const exit = typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1);
  return {
    name,
    command,
    exit,
    passed: exit === 0,
    timed_out: !!timedOut,
    duration_ms: Date.now() - started,
    output_sha256: 'sha256:' + crypto.createHash('sha256').update(out).digest('hex'),
    output_lines: out ? out.split('\n').length : 0,
    output: out,
    at: new Date().toISOString(),
  };
}

// Latest run of each check recorded on the task.
function latestRuns(task) {
  const latest = {};
  for (const r of (task.evidence && task.evidence.checks) || []) {
    if (!latest[r.name] || Date.parse(r.at) >= Date.parse(latest[r.name].at)) latest[r.name] = r;
  }
  return latest;
}

// What closing this task needs, and what is still missing (docs/execution-contract.md, rules.class_requirements).
function evaluateClose(task, config, opts) {
  const o = opts || {};
  const cls = (task.effective && task.effective.class) || 'question';
  const missing = [];
  const met = [];
  const notYet = [];

  if (task.status === 'needs_human') missing.push('a decision from the user (' + (task.needs_human_reason || 'task is waiting') + ')');
  if (task.status === 'upgrade_pending') missing.push('the profile and plan this ' + cls + ' task still needs');

  const touched = ((task.observed && task.observed.files_touched) || []);
  const changed = touched.length > 0;

  // E-diff-shown: the close command prints the diff summary itself.
  if (cls !== 'question' && changed) met.push('E-diff-shown');

  // E-checks / E-checks-if-present: required checks passed after the last change.
  const R2 = require('./engos-rules.js');
  const notCounted = (((require('./engos-core.js').defaults().rules.budgets || {}).trivial_edit || {}).lines_not_counted) || [];
  const docsOnly = touched.length > 0 && touched.every((f) => R2.matchAny(f, notCounted));
  const required = cls === 'trivial_edit' && docsOnly ? [] : requiredChecks(config);
  const lastChange = task.last_change_at ? Date.parse(task.last_change_at) : 0;
  if (cls !== 'question' && changed) {
    if (!required.length) {
      if (cls === 'trivial_edit') met.push(docsOnly ? 'E-checks-if-present (docs only)' : 'E-checks-if-present (no checks configured)');
      else missing.push('checks: none are configured in .engos/config.yaml, so this ' + cls + ' task has nothing to prove it works. Ask the user to add them under checks:');
    } else {
      const latest = latestRuns(task);
      const atOpen = (o.baseline && o.baseline.checks) || null;
      for (const name of required) {
        const r = latest[name];
        const now = ((config && config.checks) || {})[name];
        if (atOpen && Object.prototype.hasOwnProperty.call(atOpen, name) && atOpen[name] !== now && !(task.approved_files || {})['.engos/config.yaml']) {
          missing.push('the command for check "' + name + '" changed during this task (was "' + atOpen[name] + '", now "' + now + '") without the user approving the config change; ask the user');
          continue;
        }
        if (r && r.command !== undefined && now !== undefined && r.command !== now) { missing.push('run `engos check ' + name + '` again: its command changed since it ran'); continue; }
        if (!r) missing.push('run `engos check ' + name + '`');
        else if (Date.parse(r.at) < lastChange) missing.push('run `engos check ' + name + '` again: it last ran before the latest change');
        else if (!r.passed) missing.push('`engos check ' + name + '` must pass (last exit code ' + r.exit + ')');
      }
      if (!missing.some((m) => m.includes('engos check'))) met.push('E-checks (' + required.join(', ') + ')');
    }
  }

  if (cls === 'standard' || cls === 'high_risk') {
    // E-scope: every changed file is inside the plan, except changes made before the task was upgraded.
    const scope = (task.planned && task.planned.scope && task.planned.scope.write) || [];
    const pre = new Set(task.pre_upgrade_files || []);
    const outside = touched.filter((f) => !pre.has(f) && !rules.matchAny(f, scope));
    if (outside.length) missing.push('changed files outside the plan scope: ' + outside.join(', ') + ' (widen the scope with engos scope amend, or undo them)');
    else met.push('E-scope');

    // E-residual-risk: written, even if "none".
    const risk = o.residualRisk || task.residual_risk;
    if (!risk || !String(risk).trim()) missing.push('residual risk: pass --residual-risk "..." (write "none" if there is none)');
    else met.push('E-residual-risk');
  }

  if (cls === 'high_risk') {
    // E-review-record: a validator verdict after the last change, with refs that code confirmed exist (phase 5).
    const reviews = (task.reviews || []).filter((r) => !lastChange || Date.parse(r.at) >= lastChange);
    const last = reviews[reviews.length - 1];
    if (!last) missing.push('E-review-record: an independent validator review after the last change. Add a step (engos step add --step "S9:verify"), run engos step brief S9 and start engos:validator');
    else if (last.verdict !== 'pass') missing.push('E-review-record: the latest validator verdict (' + last.step + ') is ' + (last.verdict || 'missing') + '. Fix the findings and review again, or open a dispute (engos dispute open)');
    else if (!last.refs_ok || !last.report_ok) missing.push('E-review-record: the latest validator report (' + last.step + ') had refs or fields code could not verify; review again');
    else met.push('E-review-record (' + last.step + ')');
    if (!task.close_acknowledged) missing.push('the user\'s confirmation: ask them to type /engos:decide ' + task.task_id + ' close');
  }

  // D25: a validator finding of medium severity or higher is the user's call, in any class.
  const severe = (task.reviews || []).filter((r) => (!lastChange || Date.parse(r.at) >= lastChange) && (r.max_severity || 0) >= 2);
  if (severe.length && cls !== 'high_risk' && !task.close_acknowledged) missing.push('the user\'s confirmation: a review (' + severe[severe.length - 1].step + ') reported a finding of medium severity or higher; show it and ask them to type /engos:decide ' + task.task_id + ' close');

  return { ok: missing.length === 0, cls, missing, met, notYet };
}

function diffStat(root, base) {
  try {
    return cp.execFileSync('git', ['-C', root, 'diff', base || '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '--stat'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return ''; }
}

module.exports = { requiredChecks, runCheck, latestRuns, evaluateClose, diffStat };
