# Execution contract

## Task record

```yaml
task_id: unique-id
objective: concise desired outcome
execution_mode: read_only | workspace_write | approved_delivery
classification: feature | bugfix | architecture | security_audit | incident_triage
owner: role
inputs: []
plan: []
evidence_required: []
approval_required: false
status: planned | active | blocked | validating | complete
```

## Lifecycle

1. **Intake** — capture request and constraints.
2. **Classify** — produce task profile and risk rating.
3. **Authorize** — apply policy and determine allowed mode.
4. **Plan** — select workflow, roles, model tier, acceptance evidence, and escalation triggers.
5. **Execute** — agents work only within their declared scope.
6. **Record** — persist material facts, decisions, and handoffs.
7. **Validate** — independently compare evidence with the acceptance criteria.
8. **Close or escalate** — close with evidence, or identify the exact approval/decision required.

## Evidence standard

Evidence may include a diff, test command and result, reproducible observation, design review record, or an explicit human approval. Narrative alone is insufficient for claims of completion.

## Usage ledger

Record task ID, role, model tier, execution duration, tool calls when available, outcome, and escalation reason. The v0.1 ledger reports available usage data only; it does not invent costs.
