<p align="center"><img src="plugin/.claude-plugin/icon.png" width="96" alt="Engineering OS icon"></p>

# Engineering OS for Claude Code

**Engineering discipline for Claude Code, enforced by code rather than requested in a prompt.**

Claude Code is fast and capable. Left alone, it will also edit a sensitive file because the change looked small, push without asking, say "tests pass" without running them, follow an instruction it found in a README or a log, and spend your most expensive model reading files a cheaper one could read. Engineering OS is a Claude Code plugin that sits between Claude and its tools and stops those things before they happen. Small work stays as fast as before.

[![tests](https://github.com/eslamatwa/engineering-os/actions/workflows/tests.yml/badge.svg)](https://github.com/eslamatwa/engineering-os/actions/workflows/tests.yml)
&nbsp;MIT · Claude Code 2.1.321+ · Windows, macOS, Linux

---

## The idea

Rules written in a prompt are requests: the model can skip them, forget them or be talked out of them. Claude Code hooks run as code on every tool call, so a rule enforced there holds. Engineering OS puts a small, fast gate on every edit, command and agent call, and gives Claude a workflow to follow when the gate says no:

1. **Classify by what the code touches**, not by how hard the request sounds. A change to `auth/` is high risk even when the request says "quick fix".
2. **Ask you only for what matters:** things that leave your machine, destroy data, or touch files you marked as protected.
3. **Prove it works:** a task closes only when your own check commands passed after the last change.
4. **Use the right model for each step:** Haiku reads, Sonnet does scoped work, Opus handles hard features, Fable only with your yes.
5. **Keep a record:** every class change, refusal, approval, check and agent run goes into a local ledger you can read.

## What you get

| | |
| --- | --- |
| **A gate on edits, commands, agents and MCP tools** | Every file edit, shell command (Bash, PowerShell), agent call and external MCP call passes the gate. Commands are split, unwrapped (subshells, `bash -c`, `eval`, `npx`, `xargs`) and classified: read, check, local git, install, network, push, destructive. A command it doesn't recognise runs and is watched, and asks in high-risk tasks. Edits are checked against protected paths and the planned scope. Adds about 10–20 ms on top of Node start-up. |
| **Risk classes that only go up** | `question` → `trivial_edit` → `standard` → `high_risk`, raised by what is observed: protected paths, diff size, new packages, sensitive topics (auth, payments, secrets, migrations, deployment) in any language. Only you can lower one, by typing a command. |
| **Your approval, in Claude Code's own prompt** | `git push`, publishing, network calls, destructive commands, external MCP tools, and the first edit of each protected file show Claude Code's Allow/Deny prompt, in every permission mode. The model can't click it, and every approval is recorded (a "No" just leaves the request unanswered, and it expires after an hour). |
| **Evidence before done** | `engos check <name>` runs your exact test, lint or build command and records the real exit code. A task won't close without passing checks after the last change, changes inside the plan, a written residual risk, and for high-risk work an independent review and your confirmation. |
| **Agents that stay in their lane** | Three subagents: a read-only **scout** on Haiku, a **worker** that implements one planned step, and a **validator** that reviews and never edits. The gate checks each agent call uses the right model, allows one writer at a time, and blocks agents from starting agents. Reports are compared with what the hooks actually saw change. |
| **Escalation with a ceiling** | When a task uses worker steps, a failing step gets three attempts: the routed model, the same model with the exact failure, one tier up. Then it stops and hands you a summary with options. Missing tools don't burn attempts, and neither does a disputed acceptance criterion. |
| **You can see the agents, and what they cost** | A status line under the prompt, `/engos:status` in chat, and `/engos:view`: an interactive live page with the agent graph, a timeline per agent, real tokens and cost per agent and per model (read from Claude Code's own transcripts), each file's diff, replay of a task, check history, a report you can export, all your projects, and anything waiting for you. In English or Arabic. Read-only by design. |
| **Recommendations that fit your project** | `/engos:recommend` reads your stack and lists the official skills and MCP servers from Anthropic's marketplace that match it, with the install commands. It never installs anything itself. |

## Does it cost more?

Measured in real Claude Code against plain Claude Code, same prompts, same model (details in [`docs/benchmark.md`](docs/benchmark.md)):

| Task | Without | With Engineering OS | |
| --- | --- | --- | --- |
| Document every module of a 2,500-line project | $0.63 | **$0.35** | **−44%** |
| Analyse a real 193-file Rust + Svelte project | $0.23 | **$0.19** | **−14%** |
| Add a function and its tests in that project | $0.13 | $0.14 | +10% |
| Trivial edit / bug fix | $0.09 / $0.10 | $0.09 / $0.10 | +2–3% |

Heavy reading goes to a Haiku scout and ordinary questions search before reading, so reading-heavy work gets cheaper. Code changes cost a little more for the plan and the evidence. Reading through a scout is slower in wall-clock time. Each figure is the mean of two runs per side, and single runs vary (one baseline ranged from $0.16 to $0.42), so read them as direction, not precision.

## Install

You need Claude Code 2.1.321 or later, Node 18 or later, and git.

```bash
claude plugin install engos --marketplace eslamatwa/engineering-os
```

Or inside Claude Code: `/plugin marketplace add eslamatwa/engineering-os`, then `/plugin install engos@engineering-os`.

## Quick start

In each project, once:

```text
/engos:init
```

It asks which Claude models your plan includes and which commands prove the code works, offers a status line and deny rules, writes a small `.engos/` folder, and shows the official skills and MCP servers that fit the project. Then keep working as usual:

```text
You:     Fix the session timeout bug in src/auth/session.ts
Claude:  (src/auth/ is protected, so this is a high_risk task; it plans the change)
         Claude Code asks: allow editing src/auth/session.ts?   [Yes] [No]
Claude:  (edits, runs `engos check test`: passed, exit 0; a validator reviews: pass)
         Ready to close TASK-004. Please confirm with /engos:decide TASK-004 close
You:     /engos:decide TASK-004 close
```

A one-line typo fix asks nothing. A `git push` always asks.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/engos:init` | you | Set up the current project |
| `/engos:status` | anyone | What is happening now, as text |
| `/engos:view` | anyone | Open the live view |
| `/engos:recommend` | anyone | Official skills and MCP servers that fit the project, with install commands |
| `/engos:decide TASK-… <option>` | you | Answer a task waiting for you: accept or stop, retry or Fable after 3 failed attempts, settle a dispute, confirm a high-risk close |
| `/engos:class TASK-… <class>` | you | Lower a task's class (built-in safety rules stay) |
| `/engos:pause` · `/engos:resume` | you | Turn the workflow off for this session; approvals for protected files, push, network and destructive commands stay on |

Claude uses the `engos` CLI itself (`plan set`, `step brief`, `check`, `task close` and others). Task state is written only by the hooks and that CLI; Claude can't edit it directly, and changing `.engos/config.yaml` asks you. Commands and tool inputs are stored with secrets (tokens, passwords, keys) redacted.

## What it is not

Engineering OS prevents common mistakes and detects indirect changes inside the repo after they happen. **It is not a sandbox** and does not stop a model that is deliberately trying to get around it. It doesn't see what a script does outside the repo. It doesn't detect deployments as such: pushes, publishing and infrastructure commands (terraform, kubectl, helm, cloud CLIs) ask you instead.

It runs wherever Claude Code runs with hooks: the terminal, the Desktop app's Code tab, VS Code and JetBrains, and your phone through Remote Control. It doesn't run in the Desktop Chat tab, claude.ai or Cowork.

## Configure a project

`.engos/config.yaml` is committed with your code:

```yaml
models:
  available: [haiku, sonnet, opus]      # add fable if your plan has it
checks:                                 # only these count as proof
  test: "npm test"
  lint: "npm run lint"
protected_paths:
  high_risk: ["src/billing/**"]         # added to the built-in list (auth, secrets, migrations, CI, infra…)
known_commands: ["npm run build"]       # never ask, even in high-risk tasks
mcp_allowlist: ["mcp__github__get_*"]   # read-only MCP tools that shouldn't ask
```

Tasks, approvals, the ledger and the live view stay local and are gitignored.

## Documentation

| For | Read |
| --- | --- |
| Using it | [User guide](docs/engos-user-guide.html) · [الدليل بالعربية](docs/engos-user-guide-ar.html) |
| How it is built | [Architecture page](docs/engos-architecture.html) · [`docs/architecture.md`](docs/architecture.md) · [`docs/hooks.md`](docs/hooks.md) · [`docs/execution-contract.md`](docs/execution-contract.md) |
| Why it is built this way | [`docs/decisions.md`](docs/decisions.md) (D1–D53) · [`docs/security-and-governance.md`](docs/security-and-governance.md) |
| What was verified | [`docs/phase-results.md`](docs/phase-results.md) · [`docs/benchmark.md`](docs/benchmark.md) · [`docs/spike-results.md`](docs/spike-results.md) · [`tests/acceptance-scenarios.md`](tests/acceptance-scenarios.md) |
| What's next | [`docs/roadmap.md`](docs/roadmap.md) · [`docs/live-view-ideas.md`](docs/live-view-ideas.md) |

## Repository layout

| Path | What |
| --- | --- |
| `plugin/` | The plugin: hooks, the `engos` CLI, three subagents, commands, the live view |
| `config/` | The rules in readable YAML, compiled into `plugin/defaults/` by `tools/build-defaults.js` |
| `docs/` | Design, decisions, evidence, guides |
| `tests/unit/` | 100 tests; CI runs them on Windows, macOS and Linux with Node 20 and 24 |
| `tools/` | Build, latency measurement, benchmark, icon |

## Status

Version 0.1.0. Build phases 1–6 are complete; phase 7 (hardening and publishing) is in progress, including the fixes from an independent review ([`docs/reviews/fable-project-review.md`](docs/reviews/fable-project-review.md)). Still to verify by hand: the status line in the Desktop app, and Claude Code on the web.

## License

MIT. See [LICENSE](LICENSE). Bundles js-yaml 4.1.0 (MIT).
