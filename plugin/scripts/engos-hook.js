#!/usr/bin/env node
'use strict';
// Engineering OS hook entry. Usage: node engos-hook.js <session-start|pre-tool-use>
// Phase 1: session self-check (H1) and the read-only part of the write gate (H3).
// Exit codes: 0 = allow / no opinion; 2 = block (stderr is the reason Claude sees).

// D44: reuse compiled code between runs (Node 22.1+); harmless no-op on older Node.
try { require('node:module').enableCompileCache(); } catch (_) { /* not available */ }

const fs = require('fs');

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function projectStart(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

function block(reason) {
  process.stderr.write('Engineering OS: ' + reason);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// H1 · SessionStart. Never blocks (D42); a failure becomes read-only mode.
// ---------------------------------------------------------------------------
function sessionStart(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return; // not an Engineering OS project: stay silent

  const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
  const check = core.selfCheck(root);
  const session = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    source: input.source || 'startup',
    mode: check.mode,
    reasons: check.hard,
    warnings: check.warn,
    claude_code_version: check.claude_code_version,
  };
  core.saveSession(root, sessionId, session);
  core.ledger(root, {
    type: 'session.started',
    actor: { kind: 'hook' },
    session_id: sessionId,
    source: session.source,
    mode: session.mode,
    claude_code_version: session.claude_code_version,
  });

  const lines = [];
  lines.push('Engineering OS is active in this project (.engos/).');
  lines.push('Session mode: ' + session.mode + '.');
  if (check.hard.length) lines.push('Read-only because: ' + check.hard.join(' '));
  if (check.warn.length) lines.push('Warnings: ' + check.warn.join(' '));

  const brief = briefExcerpt(core, root);
  if (brief) lines.push('Project brief (excerpt):\n' + brief);

  const open = core.listTasks(root).filter((t) => t.status !== 'closed');
  if (open.length) {
    lines.push('Open tasks: ' + open.map((t) => t.task_id + ' (' + ((t.effective && t.effective.class) || 'unclassified') + '): ' + ((t.request && t.request.summary) || '')).join('; '));
  }

  const out = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n').slice(0, 9500) },
  };
  if (check.hard.length) {
    out.systemMessage = 'Engineering OS: this session is read-only. ' + check.hard.join(' ');
  } else if (check.warn.length) {
    out.systemMessage = 'Engineering OS: ' + check.warn.join(' ');
  }
  process.stdout.write(JSON.stringify(out));
}

function briefExcerpt(core, root) {
  try {
    const text = fs.readFileSync(core.engosPath(root, 'BRIEF.md'), 'utf8').trim();
    return text.length > 3000 ? text.slice(0, 3000) + '\n…' : text;
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// H3 (phase 1 part) · PreToolUse. Blocks writes while the session is read-only.
// If SessionStart didn't run for this session (plugin installed or project
// initialised mid-session), run the self-check now and cache it.
// ---------------------------------------------------------------------------
function preToolUse(core, input) {
  const root = core.findProjectRoot(projectStart(input));
  if (!root) return;

  const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
  let session = core.loadSession(root, sessionId);
  if (!session) {
    const check = core.selfCheck(root);
    session = {
      session_id: sessionId,
      started_at: new Date().toISOString(),
      source: 'lazy_check',
      mode: check.mode,
      reasons: check.hard,
      warnings: check.warn,
      claude_code_version: check.claude_code_version,
    };
    core.saveSession(root, sessionId, session);
    core.ledger(root, { type: 'session.started', actor: { kind: 'hook' }, session_id: sessionId, source: 'lazy_check', mode: session.mode });
  }

  if (session.mode === 'read_only' && WRITE_TOOLS.has(input.tool_name)) {
    core.ledger(root, {
      type: 'gate.denied',
      actor: { kind: 'hook' },
      session_id: sessionId,
      tool: input.tool_name,
      rule_id: 'G-read-only-session',
      agent_id: input.agent_id || null,
    });
    block('this session is read-only, so edits are blocked. ' + (session.reasons || []).join(' '));
  }
}

// ---------------------------------------------------------------------------
function main() {
  const mode = process.argv[2];
  const input = readInput();
  let core;
  try {
    core = require('./engos-core.js');
  } catch (e) {
    if (mode === 'pre-tool-use') block('the plugin files are damaged (' + e.message + '). Reinstall Engineering OS.');
    return;
  }

  try {
    if (process.env.ENGOS_TEST_THROW === mode) throw new Error('test-induced failure');
    if (mode === 'session-start') return sessionStart(core, input);
    if (mode === 'pre-tool-use') return preToolUse(core, input);
  } catch (e) {
    if (mode === 'pre-tool-use') block('internal gate error, so the call is blocked to stay safe: ' + e.message);
    // session-start: never block (D42). Tell the user instead.
    process.stdout.write(JSON.stringify({ systemMessage: 'Engineering OS: session check failed (' + e.message + '). Edits will be checked again on the first change.' }));
  }
}

main();
