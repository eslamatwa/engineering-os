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
