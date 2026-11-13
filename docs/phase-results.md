# Build phase results

Evidence for each build phase in `docs/build-plan.md`. A phase is done only when its exit scenarios pass here.

## Phase 1 · Skeleton (2026-11-13)

**Status:** done, with one open owner decision (latency target, below).

### What was built

| File | What |
| --- | --- |
| `plugin/.claude-plugin/plugin.json` | Manifest, name `engos`, version `0.1.0-phase1` |
| `plugin/hooks/hooks.json` | `SessionStart` (never blocks, D42) and `PreToolUse` on Edit, Write, MultiEdit, NotebookEdit, Bash, Agent, Task with `onFailure: block` |
| `plugin/scripts/engos-hook.js` | Hook entry: session self-check (H1) and the read-only part of the write gate (H3) |
| `plugin/scripts/engos-core.js` | Shared core: project root, config load and validation, self-check, session cache, ledger, tasks |
| `plugin/scripts/engos-cli.js` | `engos init`, `doctor`, `task open/status/close`, `version` |
| `plugin/bin/engos`, `plugin/bin/engos.cmd` | Launchers for Git Bash, macOS, Linux and Windows cmd |
| `plugin/scripts/vendor/` | js-yaml 4.1.0 with provenance (D40) |
| `plugin/commands/init.md`, `status.md` | `/engos:init`, `/engos:status` |
| `plugin/defaults/*.json` | Built from `config/*.yaml` by `tools/build-defaults.js` |
| `tests/unit/phase1.test.js` | 12 unit tests |
| `tools/measure-hook.js` | Latency measurement |

Not in phase 1 by design: protected paths, budgets, classification, Bash classes (phase 2); approvals (phase 3); evidence at close (phase 4: `engos task close` closes without checks for now and says so in the record).

### Exit scenarios

| Scenario | How | Result |
| --- | --- | --- |
| B1 · Gate fails closed without Node | Real Claude Code 2.1.321 with `--plugin-dir`, PATH without Node, Haiku asked to Write | **Pass.** "blocking because onFailure is block … node: command not found"; file not created |
| B9 · Old Claude Code is read-only | Unit test with version 2.1.100 → `read_only`; 2.1.321 → `normal`; unknown → warning only | **Pass** (unit). Real old binary not tested. |
| F1 · Init creates project files | Unit test plus real run: config, BRIEF, STATE, `.gitignore` lines, optional deny rules, idempotent, never overwrites | **Pass** |
| Init on an empty folder | `engos init` without git: files created, says the project stays read-only; session-start confirms | **Pass** (unit) |
| Init on an existing repo | Real temp repo, then a real session | **Pass** |
| Hook latency on Windows | `tools/measure-hook.js`, 40 runs | Measured, see below |

### End-to-end runs in real Claude Code (2.1.321, Haiku, `--plugin-dir`)

| # | What | Result |
| --- | --- | --- |
| E2E-1 | Healthy project, Write | Allowed; `session.started` in the ledger with mode `normal` and version 2.1.321. Works with a space in the plugin path. |
| E2E-2 | `engos version` from the Bash tool | Works: plugin `bin/` is on PATH. First attempt failed because Git Bash handed Node a `/d/...` path; fixed with a launcher that resolves its own Windows path. |
| E2E-3 | Deny rule protects `.engos/sessions/` | Write refused: "File is in a directory that is denied by your permission settings." Claude Code reported that `Write(...)` deny rules are never matched, so init now writes `Edit(...)` rules only. |
| E2E-4 | Broken `.engos/config.yaml` | Write blocked with the YAML error and how to fix it. |
| E2E-5 | No Node on PATH | Blocked (B1 above). |

### Latency (Windows 11, Node 24.19.0, 40 runs, process spawn to exit)

| Case | p50 | p95 |
| --- | --- | --- |
| `node -e 0` (Node start-up only) | 109 ms | 125 ms |
| No `.engos/` (fast exit) | 125 ms | 149 ms |
| Project, Write allowed | 118 ms | 134 ms |
| Project, Bash | 114 ms | 132 ms |

Engineering OS code adds about 5–25 ms; Node start-up on Windows is about 110 ms by itself. The build-plan target of p95 under 50 ms can't be met with Node on Windows. Claude Code also starts each hook through Git Bash, which this measurement doesn't include.

**Decided (D44):** keep Node for v0.1; target is "Engineering OS adds at most 30 ms (p95) on top of Node start-up". After enabling Node's compile cache: Node alone p50 111 / p95 132 ms; Write allowed p50 120 / p95 136 ms; Bash p50 119 / p95 137 ms. Overhead about 5–10 ms, inside the target.

**License (D43):** MIT, at the repo root and in `plugin/`. `claude plugin validate --profile directory` now passes; remaining warnings are a missing icon and author details (phase 7).

### Findings that changed the build

- Deny rules must use `Edit(...)`; `Write(...)` rules are ignored (E2E-3).
- The `bin/` launcher must resolve its own path for Windows (E2E-2).
- Hooks see many environment variables, including the user's email and account IDs. The hook never logs the environment (D42); a unit test checks the ledger has no email.
- `claude plugin validate` passes. The plugin directory would refuse a submission without a license, and warns about a missing icon. Both are phase 7 items; the license is the owner's choice.

## Phase 2 · Gate and fast path (2026-11-13)

**Status:** done. Approvals are not built yet, so everything that needs one is blocked with a message saying so; phase 3 turns those into requests.

### What was built

| File | What |
| --- | --- |
| `plugin/scripts/engos-rules.js` | Globs (gitignore-style, case-insensitive on Windows and macOS), Bash splitter (quotes, `&&`, `\|\|`, `;`, `\|`, `$( )`, backticks), command classifier, policy lookup, class ratchet |
| `plugin/scripts/engos-observe.js` | Baseline at task open; `git status --porcelain=v2` + `git diff <base> --numstat`; size/mtime snapshot of protected and `never` files including gitignored ones; ledger size check (D37) |
| `plugin/scripts/engos-hook.js` | Write gate (H3), Bash gate (H4), observer on PostToolUse (H7/H9) |
| `plugin/scripts/engos-core.js` | Tasks: open with baseline, active task per session, ratchet with history and ledger events |
| `plugin/scripts/engos-cli.js` | `profile set`, `plan set`, `scope amend`; `task status <ID>` shows files, scope and what is still needed |
| `config/rules.yaml` | Bash classes rewritten in machine-readable form; `engos` class added |
| `tests/unit/phase2.test.js` | 18 tests |

### Exit scenarios (unit, in temporary git repos)

| Scenario | Result |
| --- | --- |
| A1 small edit opens a trivial task by itself | Pass |
| A2 third file raises to standard; plan unlocks it; earlier changes stay. Also 60 changed lines raise after the edit | Pass |
| A3 protected path blocked before the edit; task high_risk; still blocked after a plan until scope approval (phase 3) | Pass |
| A4 Arabic request + `--sensitivity auth` makes the task high_risk before any edit | Pass |
| A5 write outside scope blocked; amendments max 2; never to a protected path | Pass |
| A6 a script rewriting gitignored `.env` is caught; task waits for a human; edits blocked | Pass |
| A7 untracked, staged and renamed files all counted | Pass (first run failed because the test staged an unchanged file; test fixed) |
| A8 unknown command in high_risk needs approval; `known_commands` entry runs | Pass |
| B4 (Bash part) `claude` blocked, also inside `$( )` and with a full path | Pass |
| B7 (`never` part) ledger, approvals and Claude settings can't be edited, including via `>>` | Pass |
| Extra: ledger tampering by a script detected through the recorded ledger size | Pass |
| Extra: package install makes a task standard; reads never open tasks; push, network and destructive need approval; read-only session runs reads only; pre-existing changes not counted | Pass |

All unit tests: 30 of 30 pass (`node --test tests/unit/phase1.test.js tests/unit/phase2.test.js`).

### End-to-end in real Claude Code (2.1.321, Haiku, `--plugin-dir`, bypassPermissions)

| # | What | Result |
| --- | --- | --- |
| P2-E1 | Rename a variable (A1) | Done; TASK-001 opened automatically as `trivial_edit` |
| P2-E2 | Edit `src/auth/session.ts` (A3) | Blocked; the model reported the exact reason and what is needed; file unchanged |
| P2-E3 | `node scripts/setup.js` rewrites gitignored `.env` (A6) | The PostToolUse message reached the model word for word; the model stopped and told the user; task `needs_human`. This verifies that `decision: block` from PostToolUse is delivered to Claude. |
| P2-E4 | `claude --version` from Bash (B4) | Blocked |
| P2-E5 | `git push origin main` | Blocked with "needs your approval" |

### Latency (Windows, 30 runs)

| Case | p50 | p95 |
| --- | --- | --- |
| Node start-up only | 111 ms | 139 ms |
| Gate, Write in an open task | 128 ms | 149 ms |
| Gate, Bash classification | 123 ms | 159 ms |
| Observer after Write (2 git calls) | 306 ms | 337 ms |
| Observer after Bash (4 git calls incl. protected snapshot) | 441 ms | 494 ms |

Gate overhead over Node start-up (p95): Write 10 ms, Bash 21 ms, inside the D44 target. The observer only runs inside a task and after the call has finished; each git call costs about 100 ms on Windows. Optimising it is a phase 7 item.

### Deferred on purpose

- Requests and approvals for protected scope, push, network, destructive and high_risk unknown commands: phase 3. Until then they are blocked.
- Typed `/engos:class` to lower a class, and resolving `needs_human`: phase 3 (they must come from the human).
- Lead integration budget in standard tasks (H3 rule 6) and the Agent gate: phase 5, when workers exist.

## Phase 3 · Approvals (2026-11-13)

**Status:** done. Design changed during the phase by D46, after spike round 3 showed Claude Code's own Allow/Deny prompt works in every interactive mode.

### What was built

| File | What |
| --- | --- |
| `plugin/scripts/engos-approvals.js` | Requests from the real tool input, a unique ID per request, grant on PostToolUse, 1-hour request expiry, per-file approvals (24 hours), fingerprints of every record, context (branch, outgoing commits, commit actually pushed) |
| `plugin/scripts/engos-hook.js` | `ask` for push, network, destructive, high_risk unknown commands and the first edit of each protected file; grants recorded after the tool ran; approved commands may change protected files; `/engos:decide`, `/engos:class`, `/engos:pause`, `/engos:resume` captured from UserPromptExpansion with the D34/D35 checks; pause keeps hard gates; refusals now include commands ready to run; repeated session warnings shown at most once a week |
| `plugin/scripts/engos-observe.js` | Approval records written by hooks are recognised by fingerprint; anything else is a violation |
| `plugin/scripts/engos-rules.js` | A class the human lowered ignores the floors that held it up |
| `plugin/scripts/engos-cli.js` | `task rearm`; `task status` lists pending approvals with their commits and approved protected files |
| `plugin/commands/` | `decide.md`, `class.md`, `pause.md`, `resume.md` |
| `config/rules.yaml` | `cd`, `pushd`, `popd`, `export` count as safe (found in the live test) |
| `config/policies.yaml` | Approvals section rewritten for D46 |
| `tests/unit/phase3.test.js` | 13 tests |

### Exit scenarios (unit)

| Scenario | Result |
| --- | --- |
| B2 push asks, records branch and outgoing commits, approved only after it ran, asks again next time, first record kept | Pass |
| B4 typed decision from another session refused (D34); `claude` blocked | Pass |
| B4b decision after a resume refused; accepted after `engos task rearm` (D35) | Pass |
| B6 protected file asks once per file per task; another protected file asks; ordinary files never ask; asks again after 24 hours | Pass |
| B7 pause: no tasks or budgets; push and protected files still ask; never paths and `claude` still blocked; new session unpaused | Pass |
| B8 unanswered request expires and can't be granted later | Pass |
| B10 forged approval record caught by fingerprint | Pass |
| B11 approved `rm -rf migrations` recorded as changed under approval, not a violation | Pass |
| `/engos:decide` accept and stop, invalid options, whole-line match only; `/engos:class` lowers and can't raise | Pass |

All unit tests: 43 of 43 (`node --test tests/unit/phase1.test.js tests/unit/phase2.test.js tests/unit/phase3.test.js`).

Bugs found and fixed during the phase:
- The observer flagged the hooks' own approval records as tampering (unit test B2). Fixed with fingerprints.
- Two requests for the same action shared an ID, so a new request overwrote the approved record. Fixed with a unique ID per request.
- A class the human lowered rose again at once, because the floors list was only saved when the class rose. Fixed.

### Live test with the owner (interactive Claude Code 2.1.321, Haiku, auto mode, `--plugin-dir`)

Request: "Change the timeout in src/auth/session.ts from 30 to 60", then "Commit this change and push it", then `/engos:status`.

| Step | What happened |
| --- | --- |
| First edit | Blocked: protected path, high_risk task, needs profile and plan. |
| Claude's first try to fix it | `cd ... && engos profile set --help` was refused because `cd` counted as an unknown command while the task waited for its plan. **Bug, fixed live:** `cd` and similar are safe, and refusals now carry ready-to-run commands. |
| After the fix | Claude ran `engos profile set` and `engos plan set` by itself. |
| Edit again | **Allow/Deny prompt appeared; owner clicked Yes.** Record `APR-a912cf5d`: kind file, approved, human. |
| Commit and push | Commit ran without asking. **The push asked; owner clicked Yes.** Record `APR-afc3aa21`: kind action, vcs_remote, approved, human. The branch reached the local remote. |
| `/engos:status` | Mode normal, TASK-001 open, high_risk. |

Ledger order: refused (protected) → refused (requirements) → profile → plan → file request → file granted → push request → push granted.

Finding: when commit and push run in one command, the outgoing commits don't exist yet when the request is written. The record now also stores the commit actually pushed, after the push.

Also seen: the session-start hook couldn't read the Claude Code version in a session started from the terminal, while `engos doctor` run from Claude's Bash could. The warning is now shown at most once a week; finding a reliable version source is left for phase 7.

## Phase 4 · Evidence and close (2026-11-13)

**Status:** done. The validator's review record (E-review-record) for high_risk tasks arrives with the validator in phase 5; until then it is listed at close as "not enforced yet".

### What was built

| File | What |
| --- | --- |
| `plugin/scripts/engos-evidence.js` | Runs the exact configured check, records exit code, duration, output hash and line count (never the output itself); required checks (`required_checks` in config, else all configured); close rules per class |
| `plugin/scripts/engos-cli.js` | `engos check <name>`; `task close` with evidence, diff summary and `--residual-risk`; `plan set --acceptance`; `criteria amend`; status shows check results and whether they ran before the latest change |
| `plugin/scripts/engos-hook.js` | Records the time of the last change; marks files changed before a trivial task was upgraded (D10); `/engos:decide TASK close` confirms a high_risk close; `approve_amendment` / `reject_amendment`; logs the full command that opened a task |
| `config/rules.yaml` | `jq`, `sed` (without `-i`), `nl`, `column` and checksum tools count as reads |
| `tests/unit/phase4.test.js` | 9 tests |

### Close rules as built

| Class | Needs |
| --- | --- |
| question | nothing |
| trivial_edit | diff shown; required checks passed after the last change, or "no checks configured" noted |
| standard | as trivial, but checks are mandatory; every changed file inside the plan scope (files changed before the upgrade count as in scope); residual risk written (`none` allowed) |
| high_risk | as standard, plus the user's `/engos:decide TASK close` from the task's session; validator review in phase 5 |

Any class: a task waiting for a decision or still missing its profile and plan can't close.

### Exit scenarios (unit)

| Scenario | Result |
| --- | --- |
| A1 close path: diff shown, check recorded, task closed with evidence in the ledger | Pass |
| C6 close refused before the check; refused again when a change came after the check; closes after a fresh check | Pass |
| C7 running the check command by hand records no evidence | Pass |
| Failing check recorded with the real exit code (3); close refused; output not stored | Pass |
| Unknown check name lists the configured ones; trivial task with no checks closes and says so | Pass |
| Standard: residual risk required; pre-upgrade files count as in scope | Pass |
| High_risk: close needs the user's confirmation; another session's confirmation refused | Pass |
| Criteria amendments: recorded in standard; user decides in high_risk; rejected leaves criteria unchanged | Pass |
| A task waiting for a decision can't close | Pass |

All unit tests: 52 of 52.

### End-to-end in real Claude Code (2.1.321, Haiku, headless)

| # | Request | Result |
| --- | --- | --- |
| P4-E1 | Rename, then "run its check and close it" | Claude edited, ran `engos check test` (passed), closed TASK-001 with "Evidence: E-diff-shown; E-checks (test)". Ledger: opened → evidence(0) → closed. |
| P4-E2 | A rename that breaks the test, then close | Check recorded FAILED (exit 1); close refused with the exact reason; Claude did not work around it and asked the user to choose between fixing the test and accepting the failure. |

Finding: in P4-E2 a task opened on a command the truncated summary showed as read-only. The full command is now logged when a command opens a task, and more read-only tools are recognised.

## Phase 5 · Orchestration (2026-11-13)

Built: `plugin/agents/` (scout, worker, validator), `plugin/scripts/engos-orchestrate.js` (router, Agent gate, role cards, report checks, escalation, disputes), new hook events (SubagentStart, SubagentStop, PostToolUseFailure on Agent, PostToolUse on Agent), CLI `step add|list|brief`, `dispute open|settle`, `facts add`, check labelling and handover, E-review-record at high_risk close.

### Unit tests (tests/unit/phase5.test.js, 15)

| Scenario | Result |
| --- | --- |
| Router: executor, role and tier per step from config | Pass |
| C5 · a subagent can't start agents | Pass |
| C8 · wrong model refused with the expected tier; real model recorded from resolvedModel | Pass |
| C9 · one writer at a time; general-purpose denied; Explore and scouts allowed in parallel | Pass |
| H10/H11 · role card at start; mismatched report sent back once, then the lead is told | Pass |
| Scout and validator can't edit; scout Bash read-only | Pass |
| C1 · attempts on sonnet, sonnet (with prior_failure), opus; then blocked with handover; retry is the user's | Pass |
| C2 · env_error doesn't count; the second goes to the user | Pass |
| C3 · deep step needs the user's yes from the same session; yes → fable, no → opus; recorded | Pass |
| C4 · fable not on the account → opus with a note; a failed call marks the model unavailable | Pass |
| C10 · lead settles one dispute in standard; the next, high_risk and medium security findings go to the user | Pass |
| E-review-record · validator refs must exist; a pass lets high_risk close | Pass |
| D47 · lead edits at most 2 files once worker steps are planned | Pass |
| D2/D4 · analysis and security_review tasks are read-only; facts need a real source | Pass |
| D3 · triage needs a hypothesis and verbatim quotes; two components raise later tiers | Pass |

All unit tests: 67 of 67.

### End-to-end in real Claude Code (2.1.321, headless, narrow tool allowlist)

| # | Request | Result |
| --- | --- | --- |
| P5-E1 | Sonnet lead: fix a failing test using steps S1:implement and S2:verify | Lead ran `engos plan set --steps`, `engos step brief S1`, started `engos:worker` on sonnet (balanced tier). The worker got the role card, fixed the bug, ran `engos check test` and returned a valid report on the first try. The validator (sonnet) reviewed with a real ref and verdict pass. The lead ran the check and closed TASK-001. Ledger: step.assigned → started → ended, agent.model `claude-sonnet-5-5`, validation.verdict pass, task.closed. |
| P5-E2 | Haiku lead asks a scout for "one plain sentence, no YAML" | The role card outranked the prompt; SubagentStop sent the report back once (`step.report_rejected`), the scout fixed it and stopped with `stop_hook_active: true`. |

Finding from P5-E2: an unplanned scout was asked for a hypothesis while only listing files. Uncertainty checks (D22) now apply to planned analysis and debugging steps only.

Not run end to end (unit-tested only): Fable ask with a real Fable call, a real model-unavailable failure, three real failed attempts. D1 (no repo) is covered by init (phase 1); unknowns-as-questions is guidance, not code.

## Phase 6 · Visibility (2026-11-13)

Built: `plugin/scripts/engos-status.js` (one status picture, rebuilt at the end of any hook or CLI run that wrote to the ledger), `plugin/scripts/engos-statusline.js` (standalone, copied to `.engos/statusline.js` at session start), `plugin/view/index.html` (live view per the approved mockup, read-only, no external resources), CLI `engos status`, `engos view [--open|--serve]`, `engos init --status-line` (writes `.claude/settings.local.json`), commands `/engos:view` and a fuller `/engos:status`.

### Unit tests (tests/unit/phase6.test.js, 4)

| Scenario | Result |
| --- | --- |
| status.json rebuilt by hooks after ledger events; no command output or environment values in it | Pass |
| E1 · status line shows task, class, lead model, each agent with model and step, attempts, queued steps, approvals; `engos status` prints the same; idle line | Pass |
| E1/E2 · live view data matches; later events refresh it; the page has no approve/decide controls, sends nothing, loads nothing external; the approval stays pending | Pass |
| The status line never fails loudly (broken or missing status.json) | Pass |

All unit tests: 71 of 71. Gate overhead over Node start-up (p95): Write 13.4 ms, Bash 5.7 ms (D44 target 30 ms).

### Live view in the Desktop browser pane

Demo project with a scout done, a worker on attempt 2, a failed check and a pending push. Served with `engos view --serve`; checked at desktop and phone width (no horizontal scroll). Ending the worker from a hook updated the page within one refresh, without reloading. Finding (P13): the pane shows `file://` pages as static snapshots, so `/engos:view` uses the local server there.

Still for the owner: the status line in the Desktop app's Code tab (H2b) and E3 (same results in terminal and Desktop).

## Phase 7 · Hardening and publish (in progress, 2026-11-13)

Done so far:
- CI (`.github/workflows/tests.yml`): unit tests, compiled defaults in sync, and hook latency on Windows, macOS and Linux with Node 20 and 24. Run 43475573409: all 6 jobs pass, 71 of 71 tests each.
- `claude plugin validate --strict`: clean except the missing `author` (waiting for the owner). Icon added (`plugin/.claude-plugin/icon.png`, drawn by `tools/make-icon.js`). Marketplace at `.claude-plugin/marketplace.json` (source `./plugin`); README has the install line and the threat model statement.
- Version detection (D48): `AI_AGENT` first, no process spawn. 72 of 72 tests locally.

### Latency in CI (p95, 30 runs)

| Runner | Node start-up | Gate overhead: Write / Bash | Observer after Bash |
| --- | --- | --- | --- |
| ubuntu · Node 20 | 29 ms | 7.9 / 2.9 ms | 51 ms |
| ubuntu · Node 24 | 26 ms | 5.0 / 1.2 ms | 45 ms |
| macos · Node 20 | 51 ms | 13.2 / 12.3 ms | 113 ms |
| macos · Node 24 | 79 ms | 16.5 / **37.3** ms | 119 ms |
| windows · Node 20 | 61 ms | 25.2 / 17.0 ms | 231 ms |
| windows · Node 24 | 62 ms | 27.2 / 14.8 ms | 225 ms |

11 of 12 gate figures are within the D44 target (30 ms). The macOS Node 24 Bash figure is one 30-run sample on a shared runner whose Node start-up itself varied by 30 ms; re-check before publishing. The observer is slowest on Windows because each git process start costs about 50 ms there; it runs after the tool, not before it.

Still open: owner's author name, the Desktop status line and E3 (need the owner at the machine), Claude Code on the web, publishing.

### Phase 7 additions: MCP gate and interactive live view

- **MCP gate (H6, D49):** `tests/unit/phase7.test.js` (2 tests). Claude's own app tools pass without a prompt; other MCP tools ask on every call, also when paused; the terminal runner always asks even if a project allows `mcp__terminal__*`; a granted call is recorded. Real Desktop run pending.
- **Interactive live view:** select any node or step for details (model asked and actual, timing, files changed, the stored report with findings and limitations), event filters and expandable events, files with who changed them, open and last 8 closed tasks, pause updates. Checked in the browser pane at desktop and phone width (no horizontal scroll). Still read-only: the test checks there is no approve, allow, deny or decide control.

All unit tests: 74 of 74.

### Phase 7 additions: recommendations and benchmark

- **Recommendations (D50):** `engos recommend` and `/engos:recommend`, also offered at the end of `/engos:init`. Tested with a fake catalog (official marketplace only, fits the project, installed ones skipped, exact install commands) and live on this repo (GitHub MCP, TypeScript language server, code-review, security-guidance). 75 of 75 unit tests.
- **Benchmark:** see `docs/benchmark.md`. With Engineering OS the four tasks cost 13% more in total (+3% trivial, +7% bug fix, +12% analysis, +32% a 3-file feature). No agents were used, so routing savings were not measured.

### Phase 7 additions: cost

- One command opens a standard task (`engos plan set --kind … --scope-write …`); the refusal names that one command; shorter session summary; the empty brief template is no longer injected; the session summary tells the lead to send heavy reading to an `engos:scout` on Haiku.
- Benchmark round 3 (`docs/benchmark.md`): big reading-heavy task −41% and project analysis −23% against plain Claude Code; small edits +2–3%; a small 3-file feature +19%. Reading through a scout is slower in wall-clock time.
- 76 of 76 unit tests.
