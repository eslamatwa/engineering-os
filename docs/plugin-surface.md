# Plugin surface

Everything a user installs and sees. Plugin name `engos`, display name "Engineering OS", for Claude Code (D31).

## Layout

```text
plugin/
├── .claude-plugin/plugin.json, icon.png
├── agents/
│   ├── scout.md       # read-only, fast tier (haiku)
│   ├── worker.md      # model set per call by the router, checked by the gate
│   └── validator.md   # no Edit / Write
├── commands/          # init, status, view, decide, class, pause, resume
├── hooks/hooks.json   # see docs/hooks.md
├── bin/engos, engos.cmd   # the CLI, on PATH for the Bash tool
├── scripts/
│   ├── engos-hook.js        # every hook event
│   ├── engos-cli.js         # the engos CLI, the only writer of task state
│   ├── engos-core.js        # paths, config, tasks, ledger, ratchet
│   ├── engos-rules.js       # globs, Bash classes, class recompute
│   ├── engos-observe.js     # git and protected-file observer
│   ├── engos-approvals.js   # approval records
│   ├── engos-evidence.js    # engos check and close rules
│   ├── engos-orchestrate.js # steps, routing, Agent gate, reports, escalation, disputes
│   ├── engos-status.js      # status.json and the live view data
│   ├── engos-statusline.js  # the status line (copied to .engos/statusline.js)
│   └── vendor/js-yaml.min.js
├── view/index.html    # the live view page
├── templates/         # BRIEF.md, STATE.yaml
└── defaults/          # rules.json, policies.json, agents.json, compiled from config/*.yaml (D40)
```

There are no skills in v0.1. A `CLAUDE.md` at the plugin root is not loaded as context, so the lead is guided by the `SessionStart` summary, by every refusal (which says exactly what to run next), by `engos step brief`, and by the role cards injected into subagents.

## Commands

| Command | Typed by | Does |
| --- | --- | --- |
| `/engos:init` | human | Creates `.engos/`, checks Node and git, asks which models the user has, offers deny rules and the status line for the project, adds gitignore entries |
| `/engos:decide TASK-xxx <option>` | human | Answers a task that is waiting: `accept`/`stop` (violation), `close` (high_risk close), `approve_amendment`/`reject_amendment`, `retry`/`fable`/`stop` (step blocked after 3 attempts), `validator`/`worker` (dispute), `fable`/`no_fable` (use Fable for a deep step) |
| `/engos:class TASK-xxx <class>` | human | Lowers a class (hard gates stay) |
| `/engos:pause` / `/engos:resume` | human | Turns ceremony off for this session; hard gates stay |
| `/engos:status` | anyone | Runs `engos status`: the status line, each open task with steps, agents, checks and reviews, what is waiting for the user, recent events |
| `/engos:view` | anyone | Opens the live graph page: `engos view --open` (file page), or `engos view --serve` (read-only server on 127.0.0.1:4317) where the browser shows local files as static snapshots |

Approvals have no command: Claude Code's own Allow/Deny prompt asks the user (D46).

## Where it runs (D39)

Wherever Claude Code runs: terminal, the Desktop app's Code tab, VS Code and JetBrains extensions, and a phone through Remote Control of a running session. Claude Code on the web is still to verify. It does not run in the Desktop Chat tab, claude.ai, mobile chat or Cowork, because those have no hooks.

One install at user scope serves every project. Each repo has its own `.engos/`, and each session gates its own repo.

## Visibility (D33)

- **Status line:** one line under the prompt. Reads `.engos/status.json`. Offered per project by `/engos:init --status-line` because a plugin can't install it itself; written to `.claude/settings.local.json` and pointing at `.engos/statusline.js`. Shows task, class, lead model, each agent with model, step and attempts, queued steps, failing checks and pending approvals. Verified in the terminal (H2); the Desktop Code tab is still to check (H2b).
- **Live graph:** `/engos:view` opens `.engos/view/index.html`, which re-reads `.engos/view/status.js` every 2 seconds; the hooks rewrite that file on each ledger event. The Desktop app's browser pane shows `file://` pages as static snapshots (P13), so there the lead starts `engos view --serve`: a local read-only server (127.0.0.1 only, GET only, two files, stops after 8 hours). Look per `docs/engos-live-view-mockup.html`. Panels in v0.1: agent graph, agent details, event timeline, evidence (checks and their exit codes), pending approvals, blocked tasks with what they need.
- **The page is read-only.** It has no approve buttons. Approvals only count when typed or clicked in the session that asked for them (D34, D35). It loads nothing external and sends nothing.
- **Text:** `/engos:status` prints the same picture in chat.

## Asking before Fable (D32)

When a step routes to the deep tier, the gate denies the Agent call until the user has answered for this task. The lead explains why the task needs Fable and asks; the user types `/engos:decide TASK-xxx fable` or `no_fable` in the same session. Yes: recorded, step runs on Fable. No: recorded, step runs on Opus. If `fable` isn't in `models.available`, nobody is asked: the step runs on Opus with a note. Projects can add other tiers to `ask_first` (not enforced yet for tiers other than deep).

## What `/engos:init` writes

| File | Committed |
| --- | --- |
| `.engos/config.yaml` | yes |
| `.engos/BRIEF.md` | yes |
| `.engos/STATE.yaml` | yes |
| `.gitignore` entries for tasks, approvals, ledger, status, sessions, view, statusline.js | yes |
| `.claude/settings.json` deny rules (only if the user agrees) | user's choice |
| `.claude/settings.local.json` status line and `.engos/statusline.js` (only if the user agrees) | no, machine-specific |

Created later, all local: `.engos/tasks/`, `.engos/approvals/`, `.engos/ledger.jsonl`, `.engos/sessions/`, `.engos/status.json`, `.engos/view/` (first `/engos:view`).

Templates: `templates/engos/`.
