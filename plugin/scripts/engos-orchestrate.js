'use strict';
// Engineering OS — orchestration (build phase 5).
// Steps and routing (D5, D20, D23), the Agent gate (H5, D24, D32), subagent role cards (H10),
// report checks (H11, D22), escalation (D20, D21) and disputes (D25).
// Every launch is one entry in task.agents; the live view (phase 6) reads the same list.

const fs = require('fs');
const path = require('path');

const TIERS = ['fast', 'balanced', 'frontier', 'deep'];
const ENGOS_TYPES = { 'engos:scout': 'scout', 'engos:worker': 'worker', 'engos:validator': 'validator' };
const RUNNING_TTL_MS = 2 * 60 * 60 * 1000;        // a launch with no stop event after 2h no longer counts as running
const ASSURANCE_RANK = { light: 0, normal: 1, high: 2 };
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const REPORT_FIELDS = ['status', 'inputs_read', 'outputs_changed', 'evidence', 'limitations', 'next_action'];
const REPORT_STATUSES = ['done', 'blocked', 'needs_reclass', 'disputes_criterion'];
const UNCERTAINTY_ROLES = ['triager', 'analyst', 'incident_lead'];

function asList(v) { return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]; }
function roleOfType(type) { return ENGOS_TYPES[type] || null; }

// Model names as the Agent tool takes them (haiku, sonnet, opus, fable); full ids are reduced to the family.
function modelAlias(m) {
  const s = String(m || '').toLowerCase();
  for (const f of ['haiku', 'sonnet', 'opus', 'fable']) if (s.includes(f)) return f;
  return s;
}

function upTier(t) {
  if (t === 'deep') return 'deep';
  const i = TIERS.indexOf(t);
  return i < 0 ? 'frontier' : TIERS[Math.min(i + 1, 2)]; // never automatically to deep (D20)
}

function readOnlyTask(task, D) {
  const kinds = (D.rules.task_modes && D.rules.task_modes.read_only_kinds) || [];
  return kinds.includes((task.declared || {}).kind);
}

// ---------------------------------------------------------------------------
// Assurance and routing
// ---------------------------------------------------------------------------
function assurance(task, rules) {
  let best = 'light';
  const cls = (task.effective && task.effective.class) || 'question';
  const kind = (task.declared || {}).kind;
  for (const r of rules.assurance_rules || []) {
    const w = r.when || {};
    if (Object.keys(w).some((k) => k.startsWith('observed.'))) continue; // not observed in v0.1
    if (w.class && w.class !== cls) continue;
    if (w['declared.kind'] && !asList(w['declared.kind']).includes(kind)) continue;
    if (ASSURANCE_RANK[r.assurance] > ASSURANCE_RANK[best]) best = r.assurance;
  }
  return best;
}

function stepKind(kind, D) {
  return (D.agents.step_kinds || {})[kind] || { by: 'worker', role: 'implementer' };
}

// Tier for a step from config/rules.yaml (first match wins). Returns { tier, by, rule }.
function routeStep(task, step, D) {
  const rules = D.rules;
  const by = step.by || stepKind(step.kind, D).by;
  if (by === 'scout') return { tier: 'fast', by, rule: 'agents.scout' };
  if (by === 'validator') {
    const a = assurance(task, rules);
    const vr = (rules.validator_tier_rules || []).find((r) => r.assurance === a) || {};
    return { tier: vr.tier || 'balanced', by, rule: 'validator_tier_rules:' + a };
  }
  const cls = (task.effective && task.effective.class) || 'question';
  const kind = (task.declared || {}).kind;
  const list = rules.step_tier_rules || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.default) return { tier: r.default, by, rule: 'step_tier_rules[' + i + ']' };
    if (r.step && !asList(r.step).includes(step.kind)) continue;
    if (r.kind && !asList(r.kind).includes(kind)) continue;
    if (r.class && r.class !== cls) continue;
    // executor: lead means a trivial edit needs no step at all. A step the lead planned anyway runs on a worker.
    if (r.executor === 'lead') continue;
    return { tier: r.tier, by, rule: 'step_tier_rules[' + i + ']' };
  }
  return { tier: 'frontier', by, rule: 'fallback' };
}

// Build planned steps from "S1:locate,S2:implement" (optionally S2:implement:worker).
function planSteps(task, specs, D) {
  return specs.map((s) => {
    const [id, kind = 'implement', by] = String(s).split(':').map((x) => x.trim());
    if (!/^S\d+$/.test(id)) throw new Error('step ids look like S1, S2 (got "' + id + '")');
    if (!(D.agents.step_kinds || {})[kind]) throw new Error('unknown step kind "' + kind + '" in ' + id + '. Use one of: ' + Object.keys(D.agents.step_kinds || {}).join(', ') + ' (e.g. S1:implement)');
    const k = stepKind(kind, D);
    const step = { id, kind, by: by || k.by, role: k.role };
    const r = routeStep(task, step, D);
    step.by = r.by;
    step.tier = r.tier;
    step.rule_id = r.rule;
    return step;
  });
}

function rolesFor(task, D) {
  const rr = D.agents.role_rules || {};
  const kind = (task.declared || {}).kind;
  const roles = new Set(asList(rr[kind]));
  for (const add of rr.add_when || []) {
    const w = add.when || {};
    let ok = true;
    if (w.class && w.class !== task.effective.class) ok = false;
    if (w.sensitivity && !asList(w.sensitivity).some((f) => asList((task.declared || {}).sensitivity).includes(f))) ok = false;
    if (w.cross_system && !task.cross_system) ok = false;
    if (ok) roles.add(add.role);
  }
  return Array.from(roles);
}

// ---------------------------------------------------------------------------
// Models and availability (D32)
// ---------------------------------------------------------------------------
function unavailableFile(root) { return path.join(root, '.engos', 'sessions', 'models.json'); }
function loadUnavailable(root) {
  try { return JSON.parse(fs.readFileSync(unavailableFile(root), 'utf8')).unavailable || []; } catch (_) { return []; }
}
function markUnavailable(root, model) {
  const list = Array.from(new Set(loadUnavailable(root).concat([model])));
  fs.mkdirSync(path.dirname(unavailableFile(root)), { recursive: true });
  fs.writeFileSync(unavailableFile(root), JSON.stringify({ unavailable: list, updated_at: new Date().toISOString() }, null, 2));
  return list;
}

// models = { available: [...], unavailable: [...] }
function modelFor(tier, D, models) {
  const t0 = (D.rules.tiers || {});
  const map = t0.map || {};
  const fb = t0.fallback || {};
  const avail = asList(models && models.available).map(modelAlias);
  const gone = asList(models && models.unavailable).map(modelAlias);
  const notes = [];
  let t = tier;
  for (let i = 0; i < 4; i++) {
    const m = map[t];
    if ((!avail.length || avail.includes(m)) && !gone.includes(m)) return { tier: t, model: m, notes };
    if (!fb[t]) break;
    notes.push(m + ' is not available on this account, so the ' + t + ' tier falls back to ' + fb[t]);
    t = fb[t];
  }
  return { tier: t, model: map[t], notes };
}

// ---------------------------------------------------------------------------
// Launches and attempts
// ---------------------------------------------------------------------------
function agentsOf(task) { task.agents = task.agents || []; return task.agents; }
function stepState(task, id) {
  task.step_state = task.step_state || {};
  if (!task.step_state[id]) task.step_state[id] = { status: 'pending' };
  return task.step_state[id];
}
function launchesFor(task, stepId) { return agentsOf(task).filter((a) => a.step === stepId); }
function failuresFor(task, stepId) { return launchesFor(task, stepId).filter((a) => a.result === 'check_failed').length; }
function isRunning(a, now) {
  return (a.status === 'launched' || a.status === 'running') && (now || Date.now()) - Date.parse(a.launched_at) < RUNNING_TTL_MS;
}
function runningWorkers(task, now) { return agentsOf(task).filter((a) => a.role === 'worker' && isRunning(a, now)); }
function attemptsPerStep(D) { return (D.rules.escalation && D.rules.escalation.attempts_per_step) || 3; }

// What the next launch of this step must use. { tier, model, attempt, notes } | { ask } | { blocked } | { lead }
function expectedFor(task, step, D, models) {
  if (step.by === 'lead') return { lead: true };
  const st = stepState(task, step.id);
  const failures = step.by === 'worker' ? failuresFor(task, step.id) : 0;
  const allowed = st.allowed_attempts || attemptsPerStep(D);
  if (step.by === 'worker' && failures >= allowed) return { blocked: true, failures };
  const fresh = routeStep(task, step, D);           // the class may have risen since the plan was set
  let tier = (fresh.by === step.by && fresh.tier) || step.tier || 'frontier';
  if (st.override_tier) tier = st.override_tier;
  else if (step.by !== 'scout') {
    if (task.cross_system) tier = upTier(tier);                 // D22: evidence across components
    if (step.by === 'worker' && failures >= 2) tier = upTier(tier); // D20: attempt 3 is one tier up
  }
  if (tier === 'deep') {
    const probe = modelFor('deep', D, models);
    if (probe.tier !== 'deep') return Object.assign(probe, { attempt: failures + 1 });   // not on this account: no point asking
    if (task.deep_answer === 'no') tier = 'frontier';
    else if (task.deep_answer !== 'yes') return { ask: true, attempt: failures + 1 };
  }
  return Object.assign(modelFor(tier, D, models), { attempt: failures + 1 });
}

function stepIdFrom(prompt) {
  const m = /\bstep_id\s*:\s*["']?(S\d+)\b/i.exec(String(prompt || ''));
  return m ? m[1].toUpperCase() : null;
}

// H5 · decide an Agent call made by the lead during a task.
function agentDecision(task, ti, D, models, now) {
  const type = ti.subagent_type || 'general-purpose';
  const role = roleOfType(type);
  const builtIns = D.agents.built_in_agents_allowed_in_task || ['Explore', 'Plan'];
  if (!role) {
    if (builtIns.includes(type)) return { allow: true, type, role: 'builtin', tier: null, model: ti.model ? modelAlias(ti.model) : null };
    return { deny: 'G-agent-type', reason: 'the "' + type + '" agent isn\'t allowed during a task (D24). Use engos:scout to read and search, engos:worker for a planned step, engos:validator to review, or the built-in Explore and Plan.' };
  }
  const steps = (task.planned && task.planned.steps) || [];
  const stepId = stepIdFrom(ti.prompt);
  const step = stepId ? steps.find((s) => s.id === stepId) : null;
  const asked = ti.model ? modelAlias(ti.model) : null;

  if (role === 'scout' && !step) { // unplanned reading is fine, always on the fast tier
    const m = modelFor('fast', D, models);
    if (asked && asked !== m.model) return { deny: 'G-model', reason: 'engos:scout runs on the fast tier, so the model must be "' + m.model + '" (or leave model out), not "' + asked + '" (D23).' };
    return { allow: true, type, role, step: null, tier: m.tier, model: m.model, notes: m.notes };
  }
  if (stepId && !step) return { deny: 'G-agent-step', reason: 'the brief names step ' + stepId + ', which isn\'t in ' + task.task_id + '\'s plan' + (steps.length ? ' (steps: ' + steps.map((s) => s.id).join(', ') + ')' : '') + '. Add it with `engos step add --step "' + stepId + ':<kind>"`.' };
  if (!step) {
    return { deny: 'G-agent-step', reason: 'engos:' + role + ' runs one planned step and needs its brief. ' + (steps.length ? 'Run `engos step brief <id>` (steps: ' + steps.map((s) => s.id + ' ' + s.kind).join(', ') + ') and pass the printed brief as the prompt.' : 'Add a step first: `engos step add --step "S1:' + (role === 'validator' ? 'verify' : 'implement') + '"`, then `engos step brief S1`.') };
  }
  if (step.by !== role) {
    return { deny: 'G-agent-step', reason: 'step ' + step.id + ' (' + step.kind + ') is done by ' + (step.by === 'lead' ? 'the lead itself, since it is a trivial edit' : 'engos:' + step.by) + ', not ' + type + '.' };
  }
  if (role === 'worker') {
    const busy = runningWorkers(task, now);
    if (busy.length) return { deny: 'G-one-writer', reason: 'a worker is already running step ' + busy[0].step + ' (' + busy[0].id + '). Only one writer at a time (D24); wait for its report. Read-only agents (scout, validator, Explore) can run in parallel.' };
  }
  const exp = expectedFor(task, step, D, models);
  if (exp.blocked) return { deny: 'G-attempts', reason: 'step ' + step.id + ' has used its ' + exp.failures + ' attempts. ' + task.task_id + ' waits for the user\'s decision (/engos:decide ' + task.task_id + ' retry|fable|stop).' };
  if (exp.ask) return { askDeep: true, step };
  if (!asked) return { deny: 'G-model', reason: 'set model: "' + exp.model + '" on this Agent call. Step ' + step.id + ' is routed to the ' + exp.tier + ' tier (attempt ' + exp.attempt + ')' + (exp.notes.length ? '; ' + exp.notes.join('; ') : '') + '.' };
  if (asked !== exp.model) return { deny: 'G-model', reason: 'step ' + step.id + ' is routed to the ' + exp.tier + ' tier for attempt ' + exp.attempt + ', so the model must be "' + exp.model + '", not "' + asked + '" (D23).' + (exp.notes.length ? ' Note: ' + exp.notes.join('; ') + '.' : '') };
  return { allow: true, type, role, step, tier: exp.tier, model: exp.model, attempt: exp.attempt, notes: exp.notes };
}

function recordLaunch(task, dec, extra) {
  const list = agentsOf(task);
  const a = Object.assign({
    id: 'A' + (list.length + 1),
    type: dec.type,
    role: dec.role,
    role_card: dec.step ? dec.step.role : (dec.role === 'scout' ? 'analyst' : null),
    step: dec.step ? dec.step.id : null,
    tier: dec.tier || null,
    model_requested: dec.model || null,
    model_actual: null,
    attempt: dec.attempt || null,
    status: 'launched',
    launched_at: new Date().toISOString(),
    agent_id: null,
    files: [],
  }, extra || {});
  list.push(a);
  if (dec.step) {
    const st = stepState(task, dec.step.id);
    st.status = 'running';
    if (dec.role === 'worker') task.current_step = dec.step.id;
  }
  return a;
}

function findByAgentId(task, agentId) { return agentsOf(task).find((a) => a.agent_id && a.agent_id === agentId) || null; }

// SubagentStart: bind the oldest unbound launch of that type to the real agent_id.
function bindStart(task, agentId, agentType) {
  const a = agentsOf(task).find((x) => !x.agent_id && x.type === agentType && x.status === 'launched');
  if (!a) return null;
  a.agent_id = agentId;
  a.status = 'running';
  a.started_at = new Date().toISOString();
  return a;
}

// ---------------------------------------------------------------------------
// Role cards (H10). Each under ~1,500 characters.
// ---------------------------------------------------------------------------
const CARD_EXTRA = {
  implementer: 'Change only files inside the write scope. Run checks only with `engos check <name>`; never retype the test command. If a criterion looks wrong, say so with status disputes_criterion instead of working around it.',
  triager: 'Cite exact files, lines and log lines. Put your best explanation in `hypothesis`, every quoted log line in `quotes` (file and exact text; code checks they exist verbatim), and the components involved in `components`.',
  analyst: 'Be selective: search first, open only files that answer the brief, stop when you can answer. Separate verified facts (each with a file:line source) from assumptions. Put your explanation in `hypothesis` when you give one; list `components` you looked at.',
  architect: 'Compare at least two options with trade-offs; state what would change the choice. Unknowns become questions for the human, not guesses.',
  critic: 'Find the weakest assumption in the proposal and how to test it. Give verdict pass only if nothing blocking remains.',
  security_reviewer: 'Each finding needs a ref (path:line), severity (info, low, medium, high, critical) and remediation. Don\'t fix anything.',
  evidence_validator: 'Re-check each claim against files and recorded check runs. Each finding needs a ref (path:line) that exists. Give verdict pass only if every acceptance criterion is covered.',
  incident_lead: 'Connect findings across components; propose the next diagnostic step. Commands for servers are suggestions for the human to run, never run them.',
};

function roleCard(role, D) {
  const r = (D.agents.roles || {})[role] || {};
  return ('Role: ' + role + '. You ' + (r.does || 'do the step in your brief') + '. ' + (CARD_EXTRA[role] || '')).slice(0, 1500);
}

function reportTemplate(role, step) {
  const lines = [
    '```yaml',
    'schema: engos/report@1',
    'task_id: <from the brief>',
    'step_id: ' + (step || '<from the brief>'),
    'status: done            # done | blocked | needs_reclass | disputes_criterion',
    'inputs_read: [path, ...]',
    'outputs_changed: []     # every file you changed; code compares this with what it observed',
    'evidence: []            # e.g. { ac: AC-1, check: test } for checks you ran with engos check',
    'limitations: []',
    'next_action: "..."',
  ];
  if (role === 'validator') lines.push('verdict: pass           # pass | fail', 'findings: []            # { ref: "path:line", severity: low, text: "..." }');
  if (role === 'scout' || role === 'triager' || role === 'analyst') lines.push('hypothesis: ""          # analysis and debugging steps', 'quotes: []              # { file: logs/app.log, text: "exact line" }', 'components: []');
  lines.push('```');
  return lines.join('\n');
}

function startContext(task, a, D) {
  const step = a.step ? ((task.planned && task.planned.steps) || []).find((s) => s.id === a.step) : null;
  const parts = ['Engineering OS: you are ' + a.type + (step ? ', running step ' + step.id + ' (' + step.kind + ') of ' + task.task_id : ' for ' + task.task_id) + '.'];
  if (a.role_card) parts.push(roleCard(a.role_card, D));
  if (a.role === 'worker') parts.push('Write scope: ' + (((task.planned || {}).scope || {}).write || []).join(', ') + '. Edits outside it are refused.');
  if (a.role === 'scout' || a.role === 'validator') parts.push('You don\'t edit files. Bash is limited to read commands' + (a.role === 'validator' ? ' and `engos check <name>`' : '') + '.');
  parts.push('You can\'t start other agents. Your last message must be a report in this exact shape:\n' + reportTemplate(a.role === 'validator' ? 'validator' : (a.role_card || a.role), a.step));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Reports (H11)
// ---------------------------------------------------------------------------
function parseReport(text, yaml) {
  const s = String(text || '');
  const blocks = [];
  const re = /```(?:ya?ml)?\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(s))) blocks.push(m[1]);
  if (!blocks.length && /schema\s*:\s*engos\/report@1/.test(s)) blocks.push(s.slice(s.search(/schema\s*:/)));
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!/engos\/report@1/.test(blocks[i])) continue;
    try {
      const doc = yaml.load(blocks[i]);
      if (doc && typeof doc === 'object') return { report: doc };
    } catch (e) { return { error: 'the report block is not valid YAML (' + String(e.message).split('\n')[0] + ')' }; }
  }
  return { error: 'no engos/report@1 YAML block found in your last message' };
}

function refExists(root, ref) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(String(ref || '').trim());
  const file = m ? m[1] : String(ref || '').trim();
  if (!file) return false;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return false; }
  if (!m) return true;
  const lines = text.split('\n').length;
  return Number(m[2]) >= 1 && Number(m[3] || m[2]) <= lines;
}

function quoteExists(root, q) {
  if (!q || !q.file || !q.text) return false;
  const abs = path.resolve(root, String(q.file));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try { return fs.readFileSync(abs, 'utf8').includes(String(q.text).trim()); } catch (_) { return false; }
}

function sameSet(a, b) {
  const x = new Set(a); const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

// Check a subagent's report. Returns { report, problems[], facts{} }.
function checkReport(root, task, a, text, yaml) {
  const out = { report: null, problems: [], facts: {} };
  const p = parseReport(text, yaml);
  if (p.error) { out.problems.push(p.error); return out; }
  const r = p.report;
  out.report = r;
  for (const f of REPORT_FIELDS) if (r[f] === undefined) out.problems.push('missing field `' + f + '`');
  if (r.status !== undefined && !REPORT_STATUSES.includes(r.status)) out.problems.push('status must be one of ' + REPORT_STATUSES.join(', '));
  for (const f of ['inputs_read', 'outputs_changed', 'evidence', 'limitations']) if (r[f] !== undefined && !Array.isArray(r[f])) out.problems.push('`' + f + '` must be a list');

  const claimed = asList(r.outputs_changed).map((x) => String(x).replace(/\\/g, '/'));
  if (Array.isArray(r.outputs_changed) && !sameSet(claimed, a.files || [])) {
    out.problems.push('outputs_changed lists [' + claimed.join(', ') + '] but Engineering OS observed [' + (a.files || []).join(', ') + ']. Report exactly the files you changed');
    out.facts.mismatch = { claimed, observed: a.files || [] };
  }
  if (a.role === 'validator') {
    if (!['pass', 'fail'].includes(r.verdict)) out.problems.push('a validator report needs verdict: pass or fail');
    const bad = asList(r.findings).filter((f) => !f || !refExists(root, f.ref));
    if (bad.length) out.problems.push('these finding refs don\'t exist (use path:line inside the repo): ' + bad.map((f) => (f && f.ref) || '?').join(', '));
    out.facts.refs_ok = !bad.length;
    out.facts.max_severity = asList(r.findings).reduce((m, f) => Math.max(m, SEVERITY_RANK[String((f && f.severity) || 'info').toLowerCase()] || 0), 0);
  }
  if (a.step && UNCERTAINTY_ROLES.includes(a.role_card)) { // D22: planned analysis and debugging steps only
    if (!r.hypothesis || !String(r.hypothesis).trim()) out.problems.push('U-hypothesis: state a hypothesis (or "none found" with what you ruled out)');
    const missingQuotes = asList(r.quotes).filter((q) => !quoteExists(root, q));
    if (missingQuotes.length) out.problems.push('U-quotes: these quoted lines aren\'t in the files verbatim: ' + missingQuotes.map((q) => JSON.stringify((q && q.text) || '')).join(', '));
    out.facts.components = asList(r.components).map(String);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escalation (D20, D21)
// ---------------------------------------------------------------------------
const ENV_ERROR_RE = /command not found|is not recognized as (an internal|the name)|cannot find module|no such file or directory|ENOENT|missing script|not installed|ModuleNotFoundError|No module named/i;

function labelCheck(exit, output) {
  if (exit === 0) return 'passed';
  if (exit === 127 || exit === 9009 || ENV_ERROR_RE.test(String(output || '').slice(-20000))) return 'env_error';
  return 'check_failed';
}

// Apply a check result to the step the current worker is on. Returns { label, step, blocked, envLimit, failures }.
function applyCheck(task, label, D) {
  const stepId = task.current_step;
  if (!stepId) return { label };
  const launches = launchesFor(task, stepId).filter((a) => a.role === 'worker');
  const last = launches[launches.length - 1];
  if (!last) return { label };
  const st = stepState(task, stepId);
  const res = { label, step: stepId };
  if (label === 'passed') { last.result = 'passed'; st.status = 'done'; return res; }
  if (label === 'env_error') {
    st.env_errors = (st.env_errors || 0) + 1;
    last.env_errors = (last.env_errors || 0) + 1;
    if (st.env_errors >= ((D.rules.escalation && D.rules.escalation.env_error_limit_per_step) || 2)) res.envLimit = true;
    return res;
  }
  if (last.result === 'criterion_disputed') { res.label = 'criterion_disputed'; res.failures = failuresFor(task, stepId); return res; } // D21: not an attempt
  if (!last.result || last.result === 'passed') last.result = 'check_failed';
  res.failures = failuresFor(task, stepId);
  const allowed = st.allowed_attempts || attemptsPerStep(D);
  if (res.failures >= allowed) { st.status = 'blocked'; res.blocked = true; }
  return res;
}

function handover(task, reason, latestRuns, D, models) {
  const tried = agentsOf(task).filter((a) => a.step === task.current_step && a.role === 'worker').map((a) => ({ step: a.step, attempt: a.attempt, tier: a.tier, model: a.model_actual || a.model_requested, result: a.result || 'unknown' }));
  const passing = []; const failing = [];
  for (const n of Object.keys(latestRuns)) (latestRuns[n].passed ? passing : failing).push(n);
  const deepOk = modelFor('deep', D, models).tier === 'deep';
  const options = [{ id: 'retry', text: 'one more attempt on the frontier tier' }];
  if (deepOk && reason === 'attempts_exhausted') options.push({ id: 'fable', text: 'one more attempt on Fable (deep tier); typing this is your yes (D32)' });
  options.push({ id: 'stop', text: 'stop; keep the changes for review' });
  return {
    schema: 'engos/handover@1',
    task_id: task.task_id,
    reason,
    tried,
    state: { diff_files: ((task.observed || {}).files_touched || []).length, checks_passing: passing, checks_failing: failing },
    options,
    lead_recommendation: 'the lead adds this when telling the user',
    created_at: new Date().toISOString(),
  };
}

// The user's answer to a blocked step: retry on frontier, or once on Fable.
function applyRetry(task, option) {
  const stepId = task.current_step;
  if (!stepId) return;
  const st = stepState(task, stepId);
  st.allowed_attempts = failuresFor(task, stepId) + 1;
  st.override_tier = option === 'fable' ? 'deep' : 'frontier';
  st.env_errors = 0;
  st.status = 'pending';
  if (option === 'fable') task.deep_answer = 'yes';
}

// ---------------------------------------------------------------------------
// Disputes (D25)
// ---------------------------------------------------------------------------
// Who settles: 'lead' or 'human'.
function disputeSettler(task, opts, D) {
  const disputes = (D.agents && D.agents.disputes) || {};
  const sev = SEVERITY_RANK[String(opts.severity || '').toLowerCase()] || 0;
  if (opts.security && sev >= SEVERITY_RANK.medium) return { by: 'human', why: 'a security finding of medium or higher is settled by the user in any class' };
  if (task.effective.class === 'high_risk') return { by: 'human', why: 'judgement disputes in high_risk tasks are settled by the user' };
  const limit = (disputes.judgement_standard && disputes.judgement_standard.limit_per_task) || 1;
  const settled = asList(task.disputes).filter((d) => d.resolved_by === 'lead').length;
  if (settled >= limit) return { by: 'human', why: 'the lead already settled ' + settled + ' dispute in this task; the next goes to the user' };
  return { by: 'lead', why: 'standard task: the lead settles once, recorded' };
}

module.exports = {
  TIERS, ENGOS_TYPES, SEVERITY_RANK, modelAlias, upTier, readOnlyTask, roleOfType,
  assurance, stepKind, routeStep, planSteps, rolesFor,
  loadUnavailable, markUnavailable, modelFor,
  agentsOf, stepState, launchesFor, failuresFor, isRunning, runningWorkers, expectedFor, stepIdFrom,
  agentDecision, recordLaunch, findByAgentId, bindStart,
  roleCard, reportTemplate, startContext,
  parseReport, refExists, quoteExists, checkReport,
  labelCheck, applyCheck, handover, applyRetry, disputeSettler,
};
