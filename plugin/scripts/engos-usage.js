'use strict';
// Engineering OS — tokens and cost from Claude Code's own transcripts (live view idea 1).
// Hooks receive transcript_path (the session) and agent_transcript_path (a subagent). Each assistant message
// carries usage; one message can span several lines, so lines are deduplicated by message id.
// Reads are incremental: a cache keeps the byte offset, so each call only parses what was appended.
// Prices are list prices per million tokens (config/policies.yaml usage.prices); cost is an estimate.

const fs = require('fs');
const path = require('path');

function family(model) {
  const s = String(model || '').toLowerCase();
  for (const f of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) if (s.includes(f)) return f === 'mythos' ? 'fable' : f;
  return 'other';
}

function emptyTotals() { return { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, messages: 0 }; }

function addUsage(t, u) {
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : 0;
  const w1 = cc.ephemeral_1h_input_tokens != null ? cc.ephemeral_1h_input_tokens : (u.cache_creation_input_tokens || 0) - w5;
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cache_read += u.cache_read_input_tokens || 0;
  t.cache_write_5m += w5;
  t.cache_write_1h += Math.max(0, w1);
  t.messages += 1;
}

// Parse a transcript from byte `offset`. Returns { entries: [{ id, at, model, usage }], offset }.
function readTranscript(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = offset && offset <= size ? offset : 0;
    if (size === from) return { entries: [], offset: size };
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    const usable = lastNl < 0 ? '' : text.slice(0, lastNl + 1); // leave a partial last line for next time
    const byId = new Map();
    for (const line of usable.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let j; try { j = JSON.parse(line); } catch (_) { continue; }
      const m = j.message;
      if (j.type !== 'assistant' || !m || !m.usage) continue;
      byId.set(m.id || j.uuid, { id: m.id || j.uuid, at: j.timestamp, model: m.model, usage: m.usage });
    }
    return { entries: Array.from(byId.values()), offset: from + Buffer.byteLength(usable, 'utf8') };
  } catch (_) {
    return { entries: [], offset: offset || 0 };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

function cost(totalsByModel, prices) {
  let sum = 0;
  for (const [model, t] of Object.entries(totalsByModel)) {
    const p = (prices || {})[family(model)];
    if (!p) continue;
    sum += (t.input * p.input + t.output * p.output + t.cache_read * p.cache_read + t.cache_write_5m * p.input * (p.write_5m_x || 1.25) + t.cache_write_1h * p.input * (p.write_1h_x || 2)) / 1e6;
  }
  return Math.round(sum * 10000) / 10000;
}

function tokensOf(totalsByModel) {
  let n = 0;
  for (const t of Object.values(totalsByModel)) n += t.input + t.output + t.cache_read + t.cache_write_5m + t.cache_write_1h;
  return n;
}

// Whole-file usage for a subagent transcript (read once, at SubagentStop).
function agentUsage(file, prices) {
  const r = readTranscript(file, 0);
  const by = {};
  for (const e of r.entries) addUsage(by[e.model] = by[e.model] || emptyTotals(), e.usage);
  return { by_model: by, tokens: tokensOf(by), cost_usd: cost(by, prices) };
}

// Session (lead) usage, split by task: a message counts for the task whose window (opened → closed) holds it.
// Cached in .engos/sessions/usage-<session>.json so each rebuild parses only new lines.
function sessionUsage(root, sessionId, transcriptPath, tasks, prices) {
  if (!transcriptPath) return null;
  const file = path.join(root, '.engos', 'sessions', 'usage-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
  let cache = { transcript: transcriptPath, offset: 0, tasks: {}, session: {} };
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.transcript === transcriptPath) cache = c; } catch (_) { /* new */ }
  const r = readTranscript(transcriptPath, cache.offset);
  if (r.entries.length || r.offset !== cache.offset) {
    const windows = (tasks || []).filter((t) => t.session_id === sessionId || !t.session_id).map((t) => ({ id: t.task_id, from: Date.parse(t.opened_at), to: t.closed_at ? Date.parse(t.closed_at) : Infinity }));
    for (const e of r.entries) {
      addUsage(cache.session[e.model] = cache.session[e.model] || emptyTotals(), e.usage);
      const at = Date.parse(e.at);
      const w = windows.find((x) => at >= x.from && at <= x.to);
      if (w) { cache.tasks[w.id] = cache.tasks[w.id] || {}; addUsage(cache.tasks[w.id][e.model] = cache.tasks[w.id][e.model] || emptyTotals(), e.usage); }
    }
    cache.offset = r.offset;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch (_) { /* best effort */ }
  }
  const out = { session: { by_model: cache.session, tokens: tokensOf(cache.session), cost_usd: cost(cache.session, prices) }, tasks: {} };
  for (const [id, by] of Object.entries(cache.tasks)) out.tasks[id] = { by_model: by, tokens: tokensOf(by), cost_usd: cost(by, prices) };
  return out;
}

module.exports = { family, readTranscript, agentUsage, sessionUsage, cost, tokensOf, emptyTotals, addUsage };
