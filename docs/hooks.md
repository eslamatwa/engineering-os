# Hooks specification

Every rule that the design calls "prevented" or "detected" lives in one of these hooks. Rules that live only in skills or role cards are advisory.

Status column: **verified** = confirmed in `docs/spike-results.md`; **pending** = waiting for a spike round; **assumed** = from documentation, not yet tested.

## Common rules

- One Node entry file, no dependencies, JSON on stdin and JSON or exit code out (D26).
- First line of every handler: if the repo has no `.engos/`, exit 0 at once. A plugin installed at user scope runs in every repo.
- Gate hooks set `"onFailure": "block"` (D34). Without it a crash or a missing Node lets the call through (spike R2, R3). **verified**
- Block with exit 2 and a reason on stderr, or with JSON `permissionDecision: deny`. Both are **verified** (R1, P1, P2), including in `bypassPermissions` (P4).
- Use narrow matchers. `Read`, `Grep` and `Glob` are not hooked.
- Target latency: the gate adds at most 30 ms (p95) on top of Node start-up (D44); measured in CI on Windows, macOS and Linux.
- Corrupt `.engos/` config puts the session in safe mode: `read_only` plus a message to the user.

## Hook table

| # | Event | Matcher | Role | onFailure | Status |
| --- | --- | --- | --- | --- | --- |
| H1 | `SessionStart` | `startup\|resume\|compact\|clear` | Self-check, then inject a short state summary | default: never blocks (D42) | built and tested, phase 1 |
| H2 | `UserPromptExpansion` | `/engos:*` commands | Capture decisions, class changes, pause | block | fields verified live (P15): `prompt`, `command_name`, `command_args` |
| H3 | `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | Gate for file writes | block | built and tested, phase 2 |
| H4 | `PreToolUse` | `Bash\|PowerShell\|Monitor` | Gate for commands | block | built and tested, phase 2 (approvals: phase 3) |
| H5 | `PreToolUse` | `Agent\|Task` | Gate for subagents and models | block | built and tested, phase 5 (P10) |
| H6 | `PreToolUse` | `mcp__.*` | External tools ask through Claude Code's prompt every call; Claude's own app tools and the project's `mcp_allowlist` pass; the terminal runner always asks (D49). PostToolUse records the grant and observes changes like a command. | block | built and tested, phase 7; real Desktop run pending |
| H7 | `PostToolUse` | `Bash` | Observe changes; record check results | default | built and tested, phase 2; message delivery verified (P2-E3) |
| H8 | `PostToolUseFailure` | `Bash\|PowerShell\|Monitor\|Agent\|Task` | A failed command is observed like a successful one (D52). A failed Agent call frees its launch; a real "model unavailable" error marks the model for 24 hours (D32). | default | built and tested |
| H9 | `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | Update observed counts | default | built and tested, phase 2 |
| H10 | `SubagentStart` | all | Inject role card and step contract; ledger `step.started` | default | built and tested, phase 5; injection verified (P11) |
| H11 | `SubagentStop` | all | Read report, compare with observed changes; ledger `step.ended`. A bad report is sent back once (`decision: block`). A worker reporting `disputes_criterion` makes that attempt not count (D21) and tells the lead to open a dispute or amend the criteria. | default | built and tested, phase 5; send-back verified (P12) |
| H12 | `Stop` | all | Remind about open tasks. No enforcement. | default | not built (optional) |
| — | Status line | — | Reads `.engos/status.json`, rebuilt once per hook or CLI run that wrote to the ledger | — | built and tested, phase 6; terminal verified (H2), Desktop pending (H2b) |

Observer hooks (H7, H8, H9, H11) don't block. If they fail, the evidence they would have recorded is missing, so `engos task close` refuses later. The system still fails closed, just at close time.

## H1 · SessionStart

1. Check: Claude Code version supports `onFailure`; Node present; `.engos/config.yaml` parses; git repo present (D11).
2. Any failure: write `mode: read_only` for the session and tell the user what to fix.
3. Inject a summary of `BRIEF.md`, `STATE.yaml` and open tasks, under 10,000 characters.
4. On `resume` and `compact`, re-inject the active task's profile and step states, because the lead's memory of them may be gone.
5. Reset any `/engos:pause` from a previous session (D29).

## H2 · UserPromptExpansion

Typed human commands (D46): `/engos:decide TASK-xxx accept|stop`, `/engos:class TASK-xxx <lower class>`, `/engos:pause`, `/engos:resume`. Approvals are not typed any more; they use Claude Code's own prompt (H3, H4).

1. Read the line from `prompt` (or `/` + `command_name` + `command_args`) and match it whole, for example `^/engos:decide\s+(TASK-\d+)\s+([a-z_]+)$`. Text that merely contains a command is ignored.
2. A task command must come from the session that owns the task (D34). A fresh `claude -p` gets a new session ID (spike R8), but `--resume <id>` keeps it (P9), so also refuse if this session started with `source: resume` or `fork` after the decision was requested (D35). `engos task rearm TASK-xxx` re-requests the decision after a legitimate resume.
3. Apply the command and write a ledger event with `actor: human`. The result is shown to the user as a `systemMessage`; the command's own prompt tells Claude to read `engos task status`.

Known limit: the hook can't tell a typed command from one sent by another session or a scheduled task (R8, R9). The same-session and resume rules and the `claude` block in H4 cover the realistic paths under D7.

## H3 · PreToolUse on file writes

In order, first denial wins:

1. Path matches `never`: deny (G-never).
2. Session mode is `read_only`: deny with "open a task" guidance.
3. No open task: check `trivial_edit` budget for this call. Inside: open `TASK-auto`, allow, ledger line. Outside: deny and ask for a profile and plan.
4. Path matches `high_risk` protected and the file isn't approved for this task yet: ask through Claude Code's own prompt (D46, G-protected).
5. Path outside the plan's `scope.write`: deny (D12).
6. Main thread (no `agent_id`) editing in `standard` or `high_risk` when the plan has worker steps: count against the lead integration budget; deny when spent (D47). Scout and validator edits are always denied; `analysis` and `security_review` tasks are read-only.
7. Recompute the effective class with this path. Raised: deny and move the task to `upgrade_pending`.

## H4 · PreToolUse on Bash

1. Split the command on `&&`, `;`, `|`, `$( )` and backticks. Classify each part with `bash_classes` in `config/rules.yaml`.
2. `self_protect` anywhere, including running `claude`: deny (G-self, D34).
3. `vcs_remote`, `network` or `destructive`, or `unknown` in a high_risk task: write a request in `.engos/approvals/` with context (branch, outgoing commits) and return `ask`, so Claude Code's own Allow/Deny prompt shows the exact command. This works in every interactive mode, including auto and bypass (spike round 3). PostToolUse marks the request approved when the command ran; a "No" fires nothing and the request expires after an hour. Headless sessions turn `ask` into a denial (P3). (D46)
4. Apply `bash_policy` for the task's class. In `high_risk`, an `unknown` command needs an action approval unless it is in the project's `known_commands` (D38).
5. For non-read commands, save a git snapshot reference for H7.

## H5 · PreToolUse on Agent / Task

1. Caller is a subagent (`agent_id` present): deny. Workers and validators can't spawn agents (D24).
2. `subagent_type` not in `engos:scout`, `engos:worker`, `engos:validator`, `Explore`, `Plan`: deny during a task.
3. `model` parameter differs from the router's tier for this step: deny with the expected tier. Worker and validator calls must name their step (`step_id:` line from `engos step brief`).
4. Route is `deep` and the user hasn't said yes for this task: deny and tell the lead to ask (D32).
5. Another writer is active: deny a second worker (D24).

## H7 / H8 · Observing Bash

- After a non-read command, compare `git status --porcelain=v2 --untracked-files=all` and `git diff HEAD --numstat` with the task-open snapshot: untracked, staged, unstaged, renamed and deleted files all count (D37).
- Also compare the size and modified time of every file matching protected and `never` paths. These are often gitignored (`.env*`, approvals, ledger), so git alone would miss them (D37).
- A change to a protected or `never` path that H3 didn't see (written by a script): task goes to `needs_human` with the details (detected level).
- Checks: only `engos check <name>` counts (D36). The CLI runs the exact configured command and writes `evidence.recorded` with exit code and output hash itself. H7 and H8 just note that the call happened. Reason: in P8 the model appended `; echo $?`, which turned a failing check into exit 0.

## H10 / H11 · Subagents

- H10 injects the role card and the step contract as additional context at subagent start.
- H11 reads the last message as an `engos/report@1`, compares `outputs_changed` with the observed changes for that `agent_id`, and records `step.ended`. A mismatch is reported to the lead in plain text and logged.
- The real model is in the Agent call's PostToolUse response as `resolvedModel` (**verified**, P7). SubagentStart and SubagentStop have no model field, so H7 records it from the Agent PostToolUse. Agents start async by default (P7).

## What is not hooked

- `Read`, `Grep`, `Glob`: reading is free in v0.1.
- Anything Bash does outside the repo: not observed (D7 residual risk).
