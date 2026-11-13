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
