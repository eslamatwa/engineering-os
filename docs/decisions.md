# Design decisions — Claude Engineering OS v0.1

Agreed decisions only. Proposals waiting for the owner's answer are listed at the bottom.
Source review: `docs/reviews/fable-architecture-review.md`.

| ID | Decision | Date |
| --- | --- | --- |
| D1 | Claude only. No multi-provider adapters. | 2026-11-12 |
| D2 | Ships as a Claude Code plugin. Project state lives in `.engos/` inside the user's repo, separate from the plugin. | 2026-11-12 |
| D3 | v0.1 scope is code inside the repo. No commands on live servers; Linux troubleshooting means analysing logs and output the user provides. Ops waits for v0.2. | 2026-11-12 |
| D4 | Every human approval is recorded. Only the human can approve; the model can request, never grant. An approval covers one exact action, is single-use and expires. | 2026-11-12 |
| D5 | Routing is deterministic code, not a model call. Work goes to subagents on the routed model. Roles are prompt cards, not separate agents. | 2026-11-12 |
| D6 | Published for other people to use, and used on the owner's own projects. | 2026-11-12 |
| D7 | Threat model: prevent mistakes and accidental harm, including a model misled by injected instructions. A model deliberately working to bypass the rules is out of scope for v0.1. No OS sandbox. | 2026-11-13 |
| D8 | Four classes: `question`, `trivial_edit`, `standard`, `high_risk` (requirements per class below). Nobody picks the class up front: work starts as `question`, the first edit opens `trivial_edit`, and observed signals raise it. | 2026-11-13 |
| D9 | Default protected paths (list below). Projects can add paths in `.engos/config.yaml` but cannot remove anything from `never`. | 2026-11-13 |
| D10 | `trivial_edit` budget: max 2 files, 40 changed lines, 1 new file, 0 deleted files; Bash limited to read, configured checks and local git. Exceeding it raises the class to `standard`; changes already made stay and join the plan. Numbers are a first guess to tune on real repos. | 2026-11-13 |
| D11 | Edits in v0.1 require a git repo. Without git, `/engos:init` offers `git init`; if declined the project stays `read_only`. | 2026-11-13 |
| D12 | The class only goes up. Lowering needs a typed human command and is recorded. Hard gates (approval per external action, `never` paths, no production deploy) cannot be lowered. Writing outside the planned scope is blocked; the lead may widen scope at most twice per task with a written reason and only to unprotected paths. Changes present before the task opened don't count against it. | 2026-11-13 |

| D13 | No keyword (lexical) matching in code. The model reads the request in any language and declares sensitivity flags (`auth`, `payments`, `data_migration`, `deployment`, `secrets`, `other`) in its profile. Flags can only raise the class, never lower it. Missed flags are caught by protected paths and observed signals. | 2026-11-13 |

| D14 | Approval method by kind: single external action (push, publish, network, destructive) uses Claude Code's native permission prompt; scope approval for protected paths and decisions on blocked tasks or disputes use a typed `/engos:approve` command. | 2026-11-13 |
| D15 | Fallback: if the permission mode is bypass or auto, the gate denies and asks for the typed command instead of the native prompt. With no human present (headless, CI) anything needing approval is denied. | 2026-11-13 |
| D16 | An approval shows the exact action the code will run plus context: branch and outgoing commits for a push, file list and task reason for a scope approval, files to be removed for a delete. Never the model's paraphrase. | 2026-11-13 |
| D17 | Expiry: a single-action approval is single-use, valid 1 hour, and bound to the current HEAD (a new commit voids it). A scope approval lasts until the task closes, max 24 hours. | 2026-11-13 |
| D18 | No blanket approvals ("all pushes for this task") in v0.1. | 2026-11-13 |
| D19 | A rejection is recorded and reported to the model. The identical action (same hash) cannot be requested again in the same task; a changed action can. | 2026-11-13 |

| D20 | 3 attempts per step: routed tier; same tier with the exact failing output; one tier up. Then the task is `blocked` and the human gets a handover (what was tried, state, options, lead's recommendation). The deep tier (Fable) is never reached automatically; only the human can choose it. | 2026-11-13 |
| D21 | Failure type: code labels what it can (non-zero check exit = `check_failed`; missing command or dependency = `env_error`); the lead labels the rest from `check_failed`, `env_error`, `scope_violation`, `criterion_disputed`. Only `check_failed` counts as an attempt. Two `env_error`s in one step go to the human. | 2026-11-13 |
| D22 | "Uncertain" becomes objective checks for analysis and debugging: a hypothesis exists; quoted log lines exist verbatim (verified by code); the hypothesis explains all reported symptoms (validator judges). Evidence spanning more than one component goes one tier up directly. | 2026-11-13 |
| D23 | Three subagent files: `scout` (read-only, fast tier), `worker` (model set per call), `validator` (no Edit/Write). The gate checks the requested model matches the route. Effort is fixed per file. | 2026-11-13 |
| D24 | Workers and validators cannot spawn subagents. One writer at a time; parallel work is read-only only. During a task, of the built-in agents only `Explore` and `Plan` are allowed. | 2026-11-13 |
| D25 | The lead can never skip a failed check, change acceptance criteria without a recorded amendment, close a task itself (code closes it when evidence exists), approve, or lower a class. Worker/validator disputes: lead settles once per task in `standard` (recorded); human settles in `high_risk`; human settles any security finding of medium or higher in any class. | 2026-11-13 |

| D26 | Hook scripts: one dependency-free Node file, JSON in / JSON out. `/engos:init` checks Node is installed and explains how to install it if not. Prebuilt binaries can come in v0.2. | 2026-11-13 |
| D27 | Minimum Claude Code version is the first one with fail-closed hooks (`onFailure: block`; reported as v2.1.295, to verify). Older versions: the session starts `read_only` and asks the user to update. | 2026-11-13 |
| D28 | Committed from `.engos/`: `config.yaml`, `BRIEF.md`, `STATE.yaml`. Tasks, approvals and ledger stay local; `/engos:init` adds them to `.gitignore`. | 2026-11-13 |
| D29 | `/engos:pause` is typed by the human, recorded, and lasts for the current session only. It turns off classification, plans and validation; hard gates keep working (approval for external actions, `never` paths, no production deploy). | 2026-11-13 |
| D30 | Running the lead as a main-thread plugin agent is out of v0.1. | 2026-11-13 |
| D31 | Plugin name `engos` (commands `/engos:*`). Display name "Engineering OS", described as "for Claude Code"; no "Claude" in the name. | 2026-11-13 |
| D32 | Model availability: not every subscriber has every model. Availability is asked once (at init or first use) and stored in `.engos/config.yaml`; if a call fails because a model is unavailable, it is marked unavailable and falls back one tier with a note. Using the deep tier (Fable) always needs the user's yes for that task: the lead explains why the task needs it and asks; no means the frontier tier. Projects can mark other tiers "ask first" the same way. | 2026-11-13 |
| D33 | The user can always see what the agents are doing: a compact status line in the terminal, a live graph view (`/engos:view`, local auto-refreshing page built from the ledger) showing each agent, its model, role, step, status and how they connect, and `/engos:status` as text. Look and feel per the mockup in `docs/engos-live-view-mockup.html`. | 2026-11-13 |

| D34 | From spike R8: a script can fake a typed approval (`claude -p "/engos:approve …"` fires the same hooks with the same fields). So the approval hook accepts a command only when its `session_id` equals the session that created the request, and the Bash rule that blocks running `claude` is mandatory. Every gate hook sets `"onFailure": "block"` (spike R4/R5). | 2026-11-13 |
| D35 | From spike P9: `claude -p --resume <id>` keeps the session id. A typed approval or decision is void if a `SessionStart` with `source: resume` or `fork` happened for that session after the request was created. The user is simply asked again. | 2026-11-13 |
| D36 | From spike P8: configured checks run only as `engos check <name>`, which runs the exact configured command and records the exit code itself. Only these runs count as `E-checks` evidence. | 2026-11-13 |
| D37 | Change detection covers everything: `git status --porcelain=v2` (untracked, staged and unstaged, renames, deletions), plus a separate snapshot (size and modified time) of files matching protected and `never` paths, because those are often gitignored (`.env*`, approvals, ledger) and invisible to git. | 2026-11-13 |
| D38 | Unknown Bash commands stay allowed and observed in `question`, `trivial_edit` and `standard`, but need an action approval in `high_risk`. Each project can list known commands in `.engos/config.yaml` that never need one. | 2026-11-13 |
| D39 | v0.1 runs wherever Claude Code runs: terminal, the Desktop app's Code tab, IDE extensions, and a phone through Remote Control of a running session. Claude Code on the web to be verified. Not supported: Desktop Chat tab, claude.ai, mobile chat, Cowork. Monitoring all projects from Desktop Chat via a read-only MCP is roadmap v0.2; it can never approve. | 2026-11-13 |
| D40 | Amends D26: nothing for the user to install. The hook script vendors one pinned YAML parser, js-yaml 4.1.0 (MIT), verified against the npm registry checksum (`plugin/scripts/vendor/README.md`). Plugin defaults are compiled from `config/*.yaml` to JSON at build time; only the user's `.engos/` YAML is parsed at runtime. | 2026-11-13 |
| D41 | Plugin source lives in `plugin/` in this repo; the repo is under git. At publish time the repo root becomes the marketplace pointing to `./plugin`. Commits only when the owner asks. | 2026-11-13 |
| D42 | Minimum Claude Code version is the newest one tested, starting at 2.1.321, read at session start by running the binary in `CLAUDE_CODE_EXECPATH` with `--version`. Unknown version: warn, don't lock. Hooks never log environment variables (they include the user's email and account IDs). The session-start hook doesn't block on failure, so a broken install can't lock someone out of Claude Code; the PreToolUse gate does block (D34). | 2026-11-13 |
| D43 | License: MIT. `LICENSE` at the repo root and in `plugin/`, `"license": "MIT"` in `plugin.json`. Copyright line: "Engineering OS contributors" until the owner names a holder. Vendored js-yaml keeps its own MIT notice. | 2026-11-13 |
| D44 | Keep Node for v0.1. Latency target becomes: Engineering OS code adds at most 30 ms (p95) on top of Node start-up, measured by `tools/measure-hook.js`. Node's compile cache is enabled in the hook. Prebuilt binaries stay in roadmap v0.2. | 2026-11-13 |
| D45 | Task profiles are stored as `.engos/tasks/TASK-xxx/profile.json` (not YAML), with `baseline.json` beside it. They are local machine state read on every gated call and written only by hooks and the CLI; JSON keeps the gate fast. | 2026-11-13 |
| D46 | From spike round 3: a hook's `ask` shows Claude Code's own Allow/Deny prompt in every interactive mode (default, auto, bypass), even with a settings allow rule, and headless turns it into a denial. So: single external actions (push, publish, network, destructive, unknown commands in high_risk) use that prompt in every mode, and every execution asks again, which makes them single-use without hashes or expiry. Protected files use the same prompt the first time each file is edited in a task; the file then stays approved for that task (max 24 hours). Typed commands remain only for decisions on blocked or needs_human tasks (`/engos:decide`), lowering a class (`/engos:class`) and pause/resume; D34 and D35 apply to them. Supersedes the typed-approval parts of D14, the fallback in D15, the expiry rules in D17 for actions, and D19 for prompts (a "No" isn't visible to hooks, so the model may ask again; nothing runs without a click). Context such as outgoing commits is recorded with the request and shown in `/engos:status` and the live view, because the prompt itself only shows the action. | 2026-11-13 |
| D47 | Steps are optional in v0.1. A task without planned steps is done by the lead, which is cheapest. Once the plan has worker steps, the lead's own edits are integration fixes only: at most `budgets.lead_integration_edit.max_files` files, and the rest goes to workers (H3 rule 6). A step the lead plans in a trivial task still runs on a worker; `executor: lead` only means a trivial edit needs no step. Proposed in build phase 5; approved by the owner 2026-11-13. | 2026-11-13 |
| D48 | Refines D42: the Claude Code version is read first from `AI_AGENT`, which Claude Code sets for its child processes (`claude-code_2-1-321_agent`), with no process spawn; `CLAUDE_CODE_EXECPATH --version` stays as the fallback. Only these two variables are read, and neither is logged. Proposed in build phase 7; approved by the owner 2026-11-13. | 2026-11-13 |
| D49 | MCP tools are external actions (G-delivery): each call asks through Claude Code's own prompt, also when paused. Claude's own app tools pass without a prompt so the gate isn't noisy: `mcp__ccd_*`, the built-in browser, inline widgets, and reading the terminal (`config/policies.yaml` mcp). Running or opening a terminal through MCP always asks, because it would bypass the Bash gate; no list can allow it. A project can allow more tools or globs in `mcp_allowlist`. Approved by the owner 2026-11-13. | 2026-11-13 |
| D50 | Recommendations: `/engos:recommend` (and the end of `/engos:init`) shows the best-fitting skills and MCP servers for the project, grouped (skills and workflows, MCP servers, code intelligence), each with why it fits and the exact install commands. Only plugins from Anthropic's official marketplace (`claude-plugins-official`), read live from the user's Claude Code so nothing removed or unofficial is ever shown; matched by project signals in `config/recommendations.yaml`; sorted by install count; installed ones skipped. Engineering OS never installs: the user runs the commands (Bash can't run `claude` anyway, D34). Approved by the owner 2026-11-13. | 2026-11-13 |

### D8 class requirements

| Class | Record | Plan | Executor | Validation |
| --- | --- | --- | --- | --- |
| question | none | none | lead | none |
| trivial_edit | ledger line | none | lead | code: diff shown, checks if present |
| standard | full | required | worker | code first, then validator |
| high_risk | full | required | worker | as standard + stronger review, scope approval, human acknowledgement at close |

### D9 default protected paths

```yaml
high_risk: ["**/auth/**", "**/security/**", "**/migrations/**", "**/.env*", "**/*secret*",
            ".github/workflows/**", "**/terraform/**", "**/k8s/**", "**/Dockerfile*"]
standard:  ["package.json", "**/requirements*.txt", "**/*.lock"]
never:     [".engos/approvals/**", ".engos/ledger*", ".claude/settings*.json", "**/hooks/hooks.json"]
```

## D7 consequences

**Kept** (cheap, and they catch mistakes):
- The gate fails closed: a crashed, missing or timed-out hook blocks instead of allowing.
- Classification only ratchets up from what code observes (paths, diff size, command class).
- The gate, not the model, writes each approval request from the real tool input.
- Check results are recorded by hooks, not reported by the model.
- `/engos:init` offers permission deny rules for `.engos/` state files and settings.
- Bash denylist for obvious risky classes (`git push`, `rm -rf`, `curl`, running `claude`).

**Dropped from v0.1:**
- OS sandbox and a "strict" protection level.
- Hash-chained ledger, nested-session detection, confirmation codes.
- Moving approvals and ledger outside the repo. They stay in `.engos/` and are gitignored.

**README must say plainly:** the plugin prevents common mistakes and detects indirect changes after the fact. It is not a sandbox and does not stop a model that is deliberately trying to get around it.

**Residual risk:** an injected instruction can make the model try an unusual path (for example an indirect write through a script). The gate catches common patterns and post-command diff checks detect changes inside the repo; anything outside the repo is not observed.

## Pending

- With the owner at the machine: the status line in the Desktop app's Code tab (H2b), E3 (same results in terminal and Desktop), version detection in a terminal session (P14).
- With the owner: the MCP gate (D49) in a real Desktop session, and how much a hook on every host MCP call costs there.
- Owner decision: publishing (the repo is private; marketplace installs need it public or per-user access).
- Owner review of values marked `# default, tune` in `config/`; they are placeholders, not decisions.

Live view mockup approved by the owner on 2026-11-13.
