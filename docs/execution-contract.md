# Execution contract

How a task moves from request to close, and the records each step leaves. Rules referenced here live in `config/` and `docs/decisions.md`.

## Task lifecycle

```text
idle ──(first edit, inside trivial budget)──────────────▶ trivial_edit (auto task)
idle ──(lead runs intake, or /engos:task)───▶ profiled ──▶ planned ──▶ active
trivial_edit ──(budget exceeded or floor hit)──▶ upgrade_pending ──(profile + plan)──▶ active
active ──(high_risk path needed)──▶ upgrade_pending ──(scope approval)──▶ active
active ──(violation detected after a command)──▶ needs_human
active ──▶ validating ──(evidence complete)──▶ complete
validating ──(3 attempts used | dispute for human)──▶ blocked | needs_human
any ──(external action)──▶ awaiting_approval ──▶ previous state
```

- `idle` is the `question` class: no record, reading is free.
- In `upgrade_pending`, every write is denied until the missing profile, plan or approval exists. Reading stays allowed.
- Only `engos` CLI commands change state. The gate denies hand edits to state files.

## Task profile

`.engos/tasks/TASK-012/profile.yaml`, written by the CLI.

```yaml
schema: engos/task-profile@1
task_id: TASK-012
session_id: "c41f…"
opened_at: 2026-11-13T10:00:00Z
opened_by: auto              # auto | lead | human
base:
  git_head: a1b2c3d
  dirty_at_open: [README.md] # not counted against the task (D12)

request:
  summary: "Fix session expiry not refreshing on activity"

declared:                    # by the lead. Untrusted, can only raise.
  kind: bugfix               # question|analysis|docs|tests|bugfix|feature|refactor|debugging|security_review|architecture|migration
  mutates: true
  sensitivity: [auth]        # D13, any language
  reversibility: easy        # easy | hard | irreversible
  expected_paths: ["src/session/**"]
  unknowns: ["root cause not located"]   # a list, not a confidence score

planned:
  scope:
    write: ["src/session/**", "tests/session/**"]
    read: ["src/**"]
  protected_overlap: []      # computed by code

observed:                    # hooks only
  files_touched: [src/session/refresh.ts]
  lines_added: 9
  lines_deleted: 3
  modules: [src/session]
  protected_hits: []
  commands: { read: 14, check: 2, unknown: 1 }
  tests_present: true
  attempts: { S2: 1 }
  violations: []

effective:                   # computed; never edited by hand
  class: high_risk
  assurance: high
  floor_sources: [F-sensitivity]
  mode: workspace_write
  roles: [triager, implementer, security_reviewer]
  steps:
    - { id: S1, kind: locate, role: triager, tier: fast, by: scout }
    - { id: S2, kind: implement, role: implementer, tier: frontier, by: worker }
    - { id: S3, kind: verify, role: security_reviewer, tier: frontier, by: validator }
  evidence_required: [E-scope, E-checks, E-residual-risk, E-review-record]
  human_override: null

history:
  - { at: "10:00:02Z", from: null, to: trivial_edit, trigger: auto_open }
  - { at: "10:00:05Z", from: trivial_edit, to: high_risk, trigger: F-sensitivity }
```

A non-empty `unknowns` list makes the router add a read-only exploration step before implementation.

## Brief: lead to subagent

Built by `engos step brief`; the lead fills the free-text parts.

```yaml
schema: engos/brief@1
task_id: TASK-012
step_id: S2
attempt: 1
role: implementer            # card injected by the SubagentStart hook
tier: frontier               # from the router; checked by the gate
objective: "Refresh session expiry on authenticated activity"
scope:
  write: ["src/session/**", "tests/session/**"]
  read: ["src/**"]
  non_goals: ["no change to token format"]
inputs:
  - { ref: "src/session/refresh.ts", why: "current refresh logic" }
  - { ref: ".engos/tasks/TASK-012/S1.report.yaml", why: "root cause location" }
acceptance:
  - { id: AC-1, check: "test -- tests/session", expect: pass }
  - { id: AC-2, statement: "expiry extends on activity", verified_by: validator }
prior_failure: null          # on retry: exact failing output and validator verdict
limits: { max_turns: 40 }
return: engos/report@1
```

## Report: subagent to lead

The subagent's last message. The SubagentStop hook checks the shape and stores it.

```yaml
schema: engos/report@1
task_id: TASK-012
step_id: S2
status: done                 # done | blocked | needs_reclass | disputes_criterion
inputs_read: [src/session/refresh.ts, src/session/store.ts]
outputs_changed: [src/session/refresh.ts, tests/session/refresh.test.ts]   # compared with observed
evidence:
  - { ac: AC-1, ledger_event: evt-0193 }   # references, not narration
limitations: ["did not test clock skew"]
assumptions: ["store.touch() is atomic"]
next_action: "validate AC-2"
```

Rules:
- An acceptance criterion counts as met only if its evidence points to a real ledger event.
- Claimed `outputs_changed` that differ from observed changes are reported to the lead and logged.

## Handover to the human

Generated from the ledger when a task is blocked or needs a decision. The lead adds the recommendation.

```yaml
schema: engos/handover@1
decision_id: DEC-004
task_id: TASK-012
reason: attempts_exhausted   # attempts_exhausted | dispute | violation | amendment | env_error_limit | secret_found
tried:
  - { step: S2, attempt: 1, tier: balanced, result: "AC-1 failed", ledger_event: evt-0193 }
  - { step: S2, attempt: 2, tier: balanced, result: "AC-1 failed", ledger_event: evt-0201 }
  - { step: S2, attempt: 3, tier: frontier, result: "AC-1 failed", ledger_event: evt-0214 }
state: { diff_files: 2, checks_passing: [lint], checks_failing: ["test:tests/session"] }
options:
  - { id: a, text: "one more attempt on Fable (needs your yes, D32)" }
  - { id: b, text: "amend AC-1: the test asserts the old behaviour" }
  - { id: c, text: "stop; keep the diff on the branch" }
lead_recommendation: { option: b, why: "the failing assertion encodes the bug" }
```

The human answers with `/engos:decide DEC-004 b`, captured like an approval (D34 rules apply).

## Approval record

`.engos/approvals/APR-9f2c41d7.yaml`, written only by hooks.

```yaml
approval_id: APR-9f2c41d7
kind: action                 # action | scope | decision
task_id: TASK-012
session_id: "c41f…"          # approvals are accepted only from this session (D34)
action: "git push origin fix/session-refresh"
context:
  branch: fix/session-refresh
  outgoing_commits: [4e1a9c0, 7b2d113]
action_hash: "sha256:9f2c41d7…"
bound_to: { git_head: 4e1a9c0 }
requested_at: 2026-11-13T10:06:00Z
decision: approved           # approved | rejected
decided_by: human            # set by the hook
method: native_prompt        # native_prompt | typed_command
decided_at: 2026-11-13T10:06:20Z
single_use: true
expires_at: 2026-11-13T11:06:00Z
used_at: null
```

## Ledger

`.engos/ledger.jsonl`, append-only, written by hooks and the CLI. Each line has an explicit actor. No hash chain in v0.1 (D7).

| Event | Written by | Key fields |
| --- | --- | --- |
| `task.opened` / `task.closed` | hook / CLI | `opened_by`, `class`, evidence checked at close |
| `profile.declared` | CLI | declared block |
| `class.changed` | hook | `from`, `to`, `rule_id`, `trigger` |
| `step.assigned` | CLI | `step`, `role`, `tier`, `rule_id` |
| `step.started` / `step.ended` | hook | `agent_id`, `model_requested`, `model_actual` (`unknown` until verified) |
| `gate.denied` | hook | `tool`, `rule_id`, input hash |
| `evidence.recorded` | hook | `ac`, `command`, `exit`, `output_sha256` |
| `validation.verdict` | hook | `verdict`, `findings` |
| `dispute.opened` / `dispute.resolved` | CLI | `resolved_by: lead\|human`, `reason` |
| `criteria.amended` / `scope.amended` | CLI | `before`, `after`, `by`, `reason` |
| `approval.requested/granted/rejected/used/expired` | hook | `approval_id`, `action_hash`, `method` |
| `model.asked` / `model.answered` | hook | `tier: deep`, `answer` (D32) |
| `responsibility.transferred` | CLI / hook | `from`, `to`, `reason`, `decision_id` |
| `engos.paused` / `engos.resumed` | hook | `by: human` |

The ledger records duration and tool-call counts. It does not record token cost: hooks don't receive usage data.

## Evidence standard

Evidence is a diff, a recorded check run, a cited file and line that code confirmed exists, or a human decision record. A model's description of what it did is never evidence on its own.

## engos CLI

The only writer of task state. Lives in the plugin's `bin/` and is on PATH for the Bash tool.

| Command | Does |
| --- | --- |
| `engos task open\|status\|close` | Open a task, show it, close it (refuses without required evidence) |
| `engos profile set` | Write the declared block |
| `engos plan set` | Write steps, scope and acceptance criteria |
| `engos step brief S2` | Print the brief for a step |
| `engos scope amend` | Widen scope (max 2 per task, unprotected paths only) |
| `engos criteria amend` | Change acceptance criteria with a reason |
| `engos facts add` | Add a verified fact (needs a source) or an assumption |
| `engos check <name>` | Run the exact configured check and record its exit code. The only way checks count as evidence (D36). |
