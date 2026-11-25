# Architecture

Engineering OS is a Claude Code plugin. It classifies each request from what the code actually touches, routes each step to the right model, blocks what policy forbids, and accepts nothing as done without recorded evidence.

Visual version: `docs/engos-architecture.html`. Decisions: `docs/decisions.md`.

## Two layers

| Layer | Where | Maintained by |
| --- | --- | --- |
| The plugin: skills, subagents, commands, hooks, `engos` CLI, default rules | Installed plugin | Plugin author |
| Project state: config, brief, state, tasks, approvals, ledger | `.engos/` in the user's repo | Hooks, the CLI and the user |

## Flow

```text
Request ─▶ Classify ─▶ Route ─▶ Plan ─▶ Execute ─▶ Verify ─▶ Close
  lead       code       code     lead    worker    code +     code
                                                   validator
        └──────── Gate (PreToolUse) and Observe (PostToolUse) on every write, Bash and Agent call ────────┘
```

1. **Request.** Nothing happens until something changes. Reading is free (`question`).
2. **Classify.** The class is the highest of what the lead declared, what the plan covers, and what hooks observe. It only goes up. See `config/rules.yaml`.
3. **Route.** A written rule table picks the tier per step and the validator tier by assurance. No model is asked how hard the task is.
4. **Plan.** The lead writes scope, acceptance criteria and, optionally, steps through the `engos` CLI. Each step gets an executor, a role card and a tier from the rules.
5. **Execute.** Without steps the lead does the work itself (cheapest). With worker steps, `engos step brief` prints the brief and the exact model; the gate checks the Agent call; the lead's own edits are then limited to small integration fixes (D47). One writer at a time; read-only agents may run in parallel.
6. **Verify.** `engos check <name>` records the real exit code. A failed check counts as an attempt: same tier, same tier with the failing output, one tier up, then the user decides (D20). A validator subagent reviews; its refs are checked to exist. Each subagent's report is compared with what the hooks observed it change.
7. **Close.** `engos task close` refuses unless the required evidence exists: checks after the last change, scope, residual risk, and for high_risk a passing validator review and the user's confirmation.

## Components

| Component | Implemented as | Level |
| --- | --- | --- |
| Gate | `PreToolUse` hooks on file writes, shell commands (Bash, PowerShell, Monitor), Agent and MCP calls | prevented |
| Observer | `PostToolUse` hooks and git diff | detected |
| Classifier and router | Code reading `config/rules.yaml` and the task profile | prevented |
| Lead | The main Claude Code session, guided by the session summary, refusals and briefs | advisory, bounded by the gate |
| Scout, worker, validator | Three subagent files; model checked per step, no nesting, one writer | prevented (tools, model check) |
| Roles | Short cards and the report format injected at subagent start | advisory |
| Reports | Checked at subagent stop: shape, files changed vs observed, refs and quotes exist | detected (sent back once, then flagged to the lead) |
| Escalation | Attempts counted from `engos check` results; handover to the user | prevented |
| Approvals | Claude Code's own Allow/Deny prompt; typed `/engos:` commands for decisions; recorded by hooks | prevented, human-decided |
| State | `.engos/`, changed only by the `engos` CLI and hooks | prevented for Edit/Write |
| Visibility | Status line, `/engos:view` (read-only live page), `/engos:status`, all from `.engos/status.json` | informational |

Levels: **prevented** means code stops it before it runs; **detected** means code finds it afterwards and stops the task; **advisory** means a skill or card asks for it.

## Models

| Tier | Model | Used for |
| --- | --- | --- |
| fast | Haiku | Search, extraction, log reading. Never edits code. |
| balanced | Sonnet | Features below high_risk, scoped fixes, tests, docs, routine validation |
| frontier | Opus | High-risk implementation, refactors, debugging, security review (features below high_risk use balanced, D56) |
| deep | Fable | Architecture, migrations. Always asks the user first (D32). |

Model availability is asked once per project (`models.available`). An unavailable model falls back one tier with a note; a call that fails because the account lacks a model marks it unavailable. Escalation never reaches Fable by itself.

## Boundaries

- Claude only, Claude Code only (D1, D2).
- Code inside a git repo only (D3, D11). Logs are analysed, not fetched from servers.
- Protects against mistakes and injected instructions, not a deliberately hostile model (D7).
- No production deploys, ever, in v0.1.

## Details

| Topic | File |
| --- | --- |
| Classification, routing, escalation rules | `config/rules.yaml` |
| Modes, hard gates, approvals, pause | `config/policies.yaml` |
| Subagents, roles, disputes | `config/agents.yaml` |
| Each hook and what it enforces | `docs/hooks.md` |
| Lifecycle, schemas, ledger, CLI | `docs/execution-contract.md` |
| Commands, skills, files | `docs/plugin-surface.md` |
| Threat model and limits | `docs/security-and-governance.md` |
