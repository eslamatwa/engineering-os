# Build plan

Phases in order. Each phase ends with the acceptance scenarios it must pass (`tests/acceptance-scenarios.md`). Nothing ships until phase 7.

## Phase 0 · Finish the platform spike

Rounds 2 and 3 in `docs/spike-results.md`. Needs the CLI logged in and about 15 minutes with the owner.

**Exit:** every **pending** row in `docs/hooks.md` is verified or has a recorded workaround. Any result that breaks a decision gets a new D-number before phase 1.

## Phase 1 · Skeleton — done 2026-11-13 (see docs/phase-results.md)

- Plugin manifest, `engos-hook.js` entry with the `.engos/`-missing fast exit.
- `/engos:init`: templates, Node and git checks, model availability question, gitignore, optional deny rules and status line.
- `SessionStart` self-check and safe mode.
- `engos` CLI with `task open|status|close` and state file schemas.

**Exit:** B1, B9, F1; init on an empty folder and on an existing repo; hook latency measured on Windows.

## Phase 2 · Gate and fast path — done 2026-11-13 (see docs/phase-results.md)

- Path rules (`never`, protected, scope), modes, auto `trivial_edit`, budgets, class ratchet, sensitivity flags.
- Bash splitter and classifier, `self_protect`.
- Observer: git snapshot and diff after non-read commands.

**Exit:** A1–A8, B4 (Bash part), B7 (`never` part).

## Phase 3 · Approvals — done 2026-11-13 (see docs/phase-results.md)

- Requests from the real tool input; Claude Code's own prompt for actions and protected files (D46); grant recorded after the tool ran.
- Typed decisions, class lowering and pause with whole-line match, same-session and resume rules.

**Exit:** B2–B11 (including B4b).

## Phase 4 · Evidence and close — done 2026-11-13 (see docs/phase-results.md)

- `engos check <name>` runs the exact configured command and records the exit code (D36).
- Evidence kinds; `engos task close` rules; criteria amendments.

**Exit:** C6, C7, A1 close path.

## Phase 5 · Orchestration — done 2026-11-13 (see docs/phase-results.md)

- Three subagent files; role cards via SubagentStart; brief and report schemas; report check at SubagentStop.
- Router and validator tier; Agent gate (types, model, no nesting, one writer).
- Escalation, failure labels, handover, disputes.
- Fable ask and model fallback.

**Exit:** C1–C5, C8–C10, D1–D4.

## Phase 6 · Visibility — done 2026-11-13 (see docs/phase-results.md; Desktop status line still needs the owner)

- `status.json` written on every event; status line script; `/engos:status`.
- `/engos:view` page from the ledger, matching the approved mockup. Panels: agent graph, agent details, timeline, evidence, pending approvals, blocked tasks. Read-only: no approve controls.

**Exit:** E1, E2, E3.

## Phase 7 · Hardening and publish

- Run all scenarios on Windows, macOS and Linux.
- Gate p95 under 50 ms, or a recorded reason.
- `claude plugin validate --strict` clean.
- README with the threat model statement from `config/policies.yaml`.

**Exit:** all scenarios pass; owner sign-off; publish to a marketplace.
