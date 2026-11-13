# Engineering OS for Claude Code

A Claude Code plugin that catches mistakes before they land. It classifies each request from what the code actually touches, routes every step to the right Claude model, blocks what policy forbids, asks you before anything leaves your machine, and accepts nothing as done without recorded evidence.

**Status:** build phases 1–6 (skeleton, gate, approvals, evidence, orchestration, visibility) done; phase 7 (hardening and publish) to go. Platform spike rounds 1–3 done (Desktop status line and web still to check). See `docs/build-plan.md` and `docs/phase-results.md`.

## Install

Needs Claude Code 2.1.321 or later, Node 18 or later (tested on 20 and 24), and git.

```bash
claude plugin install engos --marketplace eslamatwa/engineering-os
```

Or inside a Claude Code session: `/plugin marketplace add eslamatwa/engineering-os`, then `/plugin install engos@engineering-os`.

Then, in each project, run `/engos:init`. It asks which models your plan includes and which commands prove the code works, and offers deny rules and a status line. After that, `/engos:status` shows what is happening and `/engos:view` opens the live view.

## What it protects against

Engineering OS prevents common mistakes and detects indirect changes inside the repo after they happen. It is not a sandbox and does not stop a model that is deliberately trying to get around it.

## How it works, in short

- **Small work stays cheap.** Reading is free. A small edit opens a lightweight task automatically; the main session does it itself.
- **The class only goes up.** It is raised by what the code observes (protected paths, diff size, risky commands) and by sensitivity the model reads in your request, in any language.
- **Routing is written down.** Haiku for search and logs, Sonnet for scoped work, Opus for features and security, Fable for architecture, and only after you say yes.
- **You approve what leaves the repo.** Push, publish, network and destructive commands, and the first edit of each protected file, ask you through Claude Code's own Allow/Deny prompt. Every approval is recorded.
- **Evidence, not narration.** Checks run through `engos check`, which records the real exit code. A task closes only when the required evidence exists.
- **You can always see the agents.** Status line, a live graph (`/engos:view`) and `/engos:status`.

## Repository map

| Path | What |
| --- | --- |
| `docs/decisions.md` | Every agreed decision (D1–D48). Source of truth. |
| `docs/architecture.md` | Architecture in text; visual version in `docs/engos-architecture.html` |
| `config/rules.yaml` | Classes, protected paths, budgets, Bash classes, routing, escalation |
| `config/policies.yaml` | Threat model, modes, hard gates, approvals, pause, platform |
| `config/agents.yaml` | Lead limits, subagents, roles, disputes |
| `docs/hooks.md` | Each hook and what it enforces |
| `docs/execution-contract.md` | Lifecycle, task profile, brief, report, handover, approval record, ledger, CLI |
| `docs/plugin-surface.md` | Commands, skills, files the user sees |
| `docs/security-and-governance.md` | Threat model, enforcement levels, residual risks |
| `docs/engos-live-view-mockup.html` | Approved look of the live view |
| `templates/engos/` | Files `/engos:init` creates in a project |
| `tests/acceptance-scenarios.md` | Scenarios each build phase must pass |
| `docs/build-plan.md` | Build phases and exit criteria |
| `docs/phase-results.md` | Evidence for each finished build phase |
| `plugin/` | The plugin source (D41) |
| `tools/` | Build and measurement scripts |
| `docs/traceability.md` | Each decision and the scenario that checks it |
| `docs/roadmap.md` | Direction for v0.2 and later (not decisions) |
| `docs/engos-user-guide.html` | How to use Engineering OS, step by step |
| `docs/engos-user-guide-ar.html` | The same guide in Arabic |
| `docs/spike-results.md` | Platform behaviour verified so far |
| `docs/reviews/` | Design review by Fable |
| `docs/archive/v0.1-original/` | The first design package, kept for reference |
