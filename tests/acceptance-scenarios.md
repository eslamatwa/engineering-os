# Acceptance scenarios

Each scenario has a fixed setup and an expected result that a test can check from the ledger, the task profile and the file system. "Gate" means the PreToolUse hooks; "class" means the effective class in the task profile.

Default setup unless stated: a git repo with `.engos/` from `/engos:init`, `checks.test` configured, default protected paths, permission mode `default`.

## A. Fast path and classification

### A1 · Trivial edit costs nothing extra
- **Given** a request to rename variable `tmp` to `buffer` in `utils/io.py`.
- **When** the lead edits the file directly.
- **Then** a `TASK-auto` opens as `trivial_edit`; no subagent is started; the test check runs and is recorded; the task closes with `E-diff-shown` and `E-checks-if-present`; no approval is requested.

### A2 · Budget exceeded raises the class
- **Given** a trivial task that has changed 2 files.
- **When** the lead edits a third file.
- **Then** the edit is denied; class becomes `standard`; state `upgrade_pending`; earlier changes stay and are marked `pre_upgrade`; writes resume only after a profile and plan exist.

### A3 · Misjudged change is caught by path
- **Given** a request "small tweak to the login timeout" and no sensitivity flag declared.
- **When** the lead calls Edit on `src/auth/session.ts`.
- **Then** the edit is denied before it happens; class `high_risk`; a scope approval request is written and shown with the file list.

### A4 · Sensitivity flag in any language raises the class
- **Given** the request "عدّل مدة انتهاء جلسة تسجيل الدخول" (Arabic).
- **When** the lead declares `sensitivity: [auth]`.
- **Then** class is `high_risk` before any edit; `floor_sources` includes `F-sensitivity`.

### A6 · Gitignored protected file changed by a script
- **Given** `.env` is gitignored and a `standard` task is open.
- **When** a Bash command runs `node scripts/setup.js`, which rewrites `.env`.
- **Then** git shows nothing, but the protected-path snapshot catches the change; the task goes to `needs_human` with the file named (D37).

### A7 · New, staged and renamed files all count
- **Given** a `trivial_edit` task.
- **When** a command creates an untracked file, stages one change and renames a file.
- **Then** all three appear in `observed`; the budget counts them; renaming counts as a change (D37).

### A8 · Unknown command in a high_risk task
- **Given** a `high_risk` task and `known_commands: ["npm run build"]`.
- **When** the worker runs `python migrate_helper.py`, then `npm run build`.
- **Then** the first needs an action approval; the second runs without one (D38).

### A5 · Write outside scope
- **Given** a `standard` task with `scope.write: ["src/session/**"]`.
- **When** a worker edits `src/billing/x.ts`.
- **Then** denied; the lead can widen scope at most twice with a reason, and never to a protected path.

## B. Gate and approvals

### B1 · Gate fails closed
- **Given** Node is not on PATH.
- **When** any Edit is attempted.
- **Then** the call is blocked with install instructions. (Mechanism verified in spike R5.)

### B2 · Push needs an approval with the exact action
- **Given** a task with 2 local commits.
- **When** the lead runs `git push origin fix/x`.
- **Then** the native prompt shows the exact command, branch and both commits; on allow, an approval record exists with `method: native_prompt`, is used once, and a second push in the same task asks again.

### B3 · Bypass mode falls back to the typed command
- **Given** permission mode `bypassPermissions`.
- **When** the lead runs `git push`.
- **Then** denied with an approval ID; only `/engos:approve APR-…` typed in the same session lets the retry through.

### B4 · A script can't approve
- **Given** a pending request APR-1.
- **When** a Bash call runs `claude -p "/engos:approve APR-1"`.
- **Then** the Bash call is denied (`self_protect`). And if the command reached the hook from a different session, the approval is refused (`session_id` mismatch).

### B4b · A resumed session can't approve
- **Given** a pending request APR-1 in session S.
- **When** `claude -p --resume S "/engos:approve APR-1"` runs (from any source).
- **Then** the approval is refused because a `SessionStart` with `source: resume` came after the request (D35); the user is asked again in the real session.

### B8 · Approvals expire and die with a new commit
- **Given** an approved push APR-2 at HEAD `4e1a9c0`.
- **When** the lead commits again before pushing, or waits more than one hour.
- **Then** the push is denied and a new request is shown; APR-2 is marked expired in the ledger (D17).

### B9 · Old Claude Code starts read-only
- **Given** a Claude Code version without hook `onFailure`.
- **Then** the session starts `read_only` and tells the user to update (D27).

### B5 · Headless can't approve
- **Given** `claude -p` with no human.
- **When** the work needs a push.
- **Then** denied; the task reports that a human approval is needed.

### B6 · Rejection isn't re-asked
- **Given** the user rejected a push.
- **When** the lead requests the identical push again in the same task.
- **Then** denied without asking; a push to a different branch may be asked.

### B7 · Pause keeps hard gates
- **Given** `/engos:pause` in this session.
- **When** the lead edits files freely and then runs `git push`.
- **Then** edits go through without tasks; the push still needs an approval; a write to `.engos/ledger.jsonl` is still denied.

## C. Execution and escalation

### C1 · Three attempts then the human
- **Given** a `standard` bugfix routed to `balanced` whose check keeps failing.
- **Then** attempts run Sonnet, Sonnet (with the failing output), Opus; then the task is `blocked` and a handover lists what was tried, options and the lead's recommendation. Fable is offered only as an option.

### C2 · Environment errors don't burn attempts
- **Given** a check fails with `command not found`.
- **Then** labelled `env_error`, attempt count unchanged; the second `env_error` in the step goes to the human.

### C3 · Fable needs a yes
- **Given** a migration task routed to `deep`.
- **Then** the Agent call is denied until the user answers; yes runs on Fable and is recorded; no runs on Opus and is recorded.

### C4 · Unavailable model falls back
- **Given** `models.available` lacks `fable` and the user said yes.
- **Then** the call fails, Fable is marked unavailable, the step runs on Opus with a note to the user.

### C5 · Workers can't spawn agents
- **When** a worker calls the Agent tool.
- **Then** denied.

### C6 · Lead can't close without evidence
- **When** the lead runs `engos task close` before checks ran after the last edit.
- **Then** refused with the missing evidence listed.

### C7 · A hand-typed test run isn't evidence
- **Given** `checks.test` is `npm test` and the test fails.
- **When** the model runs `npm test; echo $?` itself.
- **Then** no `E-checks` evidence is recorded; only `engos check test` counts, and it records exit code 1 (D36).

### C8 · Wrong model for a step is refused
- **Given** step S2 routed to `balanced`.
- **When** the lead calls the Agent tool with `model: opus`.
- **Then** denied with the expected tier; the ledger records the real model from `resolvedModel` when the right call runs (D23).

### C9 · One writer, approved agents only
- **Given** a worker is running S2.
- **When** the lead starts a second worker, or starts `general-purpose` during the task.
- **Then** both are denied; starting `Explore` is allowed (D24).

### C10 · Who settles a dispute
- **Given** a validator says AC-2 isn't covered and the worker disagrees.
- **Then** in `standard` the lead settles it once and it is recorded; a second dispute in the same task goes to the human; in `high_risk` the human settles it; a medium security finding goes to the human in any class (D25).

## D. Original scenarios, adapted to v0.1 scope

### D1 · New SaaS idea (no repo)
- **Given** an empty folder.
- **Then** `/engos:init` offers `git init` (D11). Declined: the project stays `read_only` and the result is a written proposal in chat. Accepted: architecture work writes only `docs/**` and `.engos/**`; unknowns become questions to the human first; assumptions are stored as `assumed`; any external action (repo creation, publish) needs approval.

### D2 · Existing project analysis
- **Then** class `standard`, mode `read_only`; a scout inventories; facts are stored only with a source that code confirms exists; assumptions are marked; the result proposes the next task, it doesn't start it.

### D3 · Linux troubleshooting (logs provided)
- **Given** logs pasted or saved as files. No commands run on servers (D3).
- **Then** a scout on the fast tier triages first; the uncertainty checks run (hypothesis, verbatim quotes, symptoms explained); evidence across more than one component moves one tier up; suggested diagnostic commands are listed for the human to run, and their output, when returned, is recorded with source `human`.

### D4 · Security audit
- **Then** mode `read_only` for the whole task; any Edit or Write is denied; findings carry file, lines, severity and remediation; every critical and high finding is re-checked by an evidence validator; medium and higher disputes go to the human; fixes open as new tasks.

## F. Setup

### F1 · Init creates the project files
- **Given** an existing git repo without `.engos/`.
- **When** the user runs `/engos:init`.
- **Then** `.engos/config.yaml`, `BRIEF.md` and `STATE.yaml` exist; `.gitignore` lists tasks, approvals, ledger and status; the user was asked which models they have and which check commands to use; deny rules and the status line were offered, not forced (D2, D26, D28, D32).

## E. Visibility

### E1 · The user can always see the agents
- **Given** a running `standard` task with a scout done and a worker running.
- **Then** the status line shows task, class, each agent with model and step, attempts and pending approvals; `/engos:view` shows the same in the graph; `/engos:status` prints it as text.

### E2 · The live view can't approve
- **Given** a pending approval.
- **Then** `/engos:view` lists it with the exact action, but has no control that approves or rejects; the request is still pending until answered in the session (D34, D39).

### E3 · Same behaviour on every Claude Code surface
- **Given** the same repo opened in the terminal and in the Desktop Code tab.
- **Then** A1, A3 and B2 give the same results in both; if the status line doesn't show in the Desktop, `/engos:view` opens in the browser pane instead (D39).

## Completion checks for any scenario

- The ledger explains every class change, denial, approval and attempt.
- No secrets in `.engos/`, briefs or reports.
- The final message separates verified results from residual risk and from approvals still needed.
