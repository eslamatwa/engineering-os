# Plugin surface

Everything a user installs and sees. Plugin name `engos`, display name "Engineering OS", for Claude Code (D31).

## Layout

```text
engos/
├── .claude-plugin/plugin.json
├── skills/
│   ├── intake/        # request -> declared profile (kind, sensitivity, unknowns)
│   ├── plan/          # steps, scope, acceptance criteria
│   ├── run/           # orchestration loop: route, brief, execute, verify, escalate
│   ├── validate/      # how to judge evidence; what counts as a pass
│   ├── status/        # explain current state to the user
│   └── roles/         # short role cards injected into subagents
├── agents/
│   ├── scout.md       # read-only, fast tier
│   ├── worker.md      # tier set per call
│   └── validator.md   # no Edit / Write
├── commands/          # see below
├── hooks/hooks.json   # see docs/hooks.md
├── bin/engos          # the only writer of task state
├── scripts/engos-hook.js
├── view/              # template for the live graph page
└── defaults/
    ├── rules.yaml     # = config/rules.yaml in this repo
    ├── policies.yaml  # = config/policies.yaml
    └── agents.yaml    # = config/agents.yaml
```

A `CLAUDE.md` at the plugin root is not loaded as context, so lead guidance lives in skills and in the `SessionStart` summary.

## Commands

| Command | Typed by | Does |
| --- | --- | --- |
| `/engos:init` | human | Creates `.engos/`, checks Node and git, asks which models the user has, offers deny rules and the status line for the project, adds gitignore entries |
| `/engos:decide TASK-xxx accept|stop` | human | Answers a task that is waiting for a decision |
| `/engos:class TASK-xxx <class>` | human | Lowers a class (hard gates stay) |
| `/engos:pause` / `/engos:resume` | human | Turns ceremony off for this session; hard gates stay |
| `/engos:status` | anyone | Prints mode, open tasks and pending approvals |
| `/engos:view` | anyone | Opens the live graph page (phase 6) |

Approvals have no command: Claude Code's own Allow/Deny prompt asks the user (D46).

## Where it runs (D39)

Wherever Claude Code runs: terminal, the Desktop app's Code tab, VS Code and JetBrains extensions, and a phone through Remote Control of a running session. Claude Code on the web is still to verify. It does not run in the Desktop Chat tab, claude.ai, mobile chat or Cowork, because those have no hooks.

One install at user scope serves every project. Each repo has its own `.engos/`, and each session gates its own repo.

## Visibility (D33)

- **Status line:** one line under the prompt. Reads `.engos/status.json`. Offered per project by `/engos:init` because a plugin can't install it itself. Whether it shows in the Desktop Code tab as well as the terminal is checked in spike round 3.
- **Live graph:** `/engos:view` opens a local page rebuilt from the ledger on each event. In the Desktop app it opens in the browser pane. Look per `docs/engos-live-view-mockup.html`. Panels in v0.1: agent graph, agent details, event timeline, evidence (checks and their exit codes), pending approvals, blocked tasks with what they need.
- **The page is read-only.** It has no approve buttons. Approvals only count when typed or clicked in the session that asked for them (D34, D35).
- **Text:** `/engos:status` prints the same picture in chat.

## Asking before Fable (D32)

When a step routes to the deep tier, the gate denies the Agent call until the user has answered for this task. The lead explains why the task needs Fable and asks. Yes: recorded, step runs on Fable. No: recorded, step runs on Opus. Projects can add other tiers to `ask_first`.

## What `/engos:init` writes

| File | Committed |
| --- | --- |
| `.engos/config.yaml` | yes |
| `.engos/BRIEF.md` | yes |
| `.engos/STATE.yaml` | yes |
| `.gitignore` entries for tasks, approvals, ledger, status | yes |
| `.claude/settings.json` deny rules and status line (only if the user agrees) | user's choice |

Templates: `templates/engos/`.
