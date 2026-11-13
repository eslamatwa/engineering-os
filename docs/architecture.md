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
4. **Plan.** The lead writes steps, scope and acceptance criteria through the `engos` CLI.
5. **Execute.** The lead does small work itself; a worker subagent does steps in `standard` and `high_risk`. One writer at a time.
6. **Verify.** Hooks record check results. A validator subagent judges scope and sufficiency when assurance needs it.
7. **Close.** `engos task close` refuses unless the required evidence is in the ledger.

## Components

| Component | Implemented as | Level |
| --- | --- | --- |
| Gate | `PreToolUse` hooks on writes, Bash, Agent, MCP | prevented |
| Observer | `PostToolUse` hooks and git diff | detected |
| Classifier and router | Code reading `config/rules.yaml` and the task profile | prevented |
| Lead | The main Claude Code session, guided by skills | advisory, bounded by the gate |
| Scout, worker, validator | Three subagent files, tier set per call | prevented (tools, model check) |
| Roles | Short cards injected at subagent start | advisory |
| Approvals | Native prompt or typed command, recorded by hooks | prevented, human-decided |
| State | `.engos/`, changed only by the `engos` CLI | prevented for Edit/Write |
| Visibility | Status line, `/engos:view`, `/engos:status` | informational |

Levels: **prevented** means code stops it before it runs; **detected** means code finds it afterwards and stops the task; **advisory** means a skill or card asks for it.

## Models

| Tier | Model | Used for |
| --- | --- | --- |
| fast | Haiku | Search, extraction, log reading. Never edits code. |
| balanced | Sonnet | Scoped fixes, tests, docs, routine validation |
| frontier | Opus | Features, debugging, security review |
| deep | Fable | Architecture, migrations. Always asks the user first (D32). |

Model availability is asked once per project. An unavailable model falls back one tier with a note.

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
