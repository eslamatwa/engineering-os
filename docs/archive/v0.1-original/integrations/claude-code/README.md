# Claude Code integration

Claude Code is the primary execution runtime. The eventual adapter should load `CLAUDE.md`, initialize or locate the workspace memory, invoke the classifier and router, and expose controlled commands for planning, execution, validation, and ledger updates.

Recommended initial commands:

- `intake` — create a normalized task record.
- `plan` — classify, apply policy, route models, and create a dynamic agent plan.
- `execute` — run an approved plan in its allowed mode.
- `validate` — collect and assess acceptance evidence.
- `status` — summarize project state, decisions, risks, and outstanding approvals.

The integration must never bypass the policy gate or represent a human approval as automated evidence.
