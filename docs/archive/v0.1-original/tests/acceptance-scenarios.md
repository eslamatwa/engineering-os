# Acceptance scenarios

## 1. New SaaS idea

Input: a new SaaS concept with no repository.

Expected: classifier selects an architecture/feature workflow, records assumptions, creates a proportional plan, and requests approval before any external action.

## 2. Existing project analysis

Input: an existing repository.

Expected: system reads project context, records verified facts separately from assumptions, and proposes a scoped workflow.

## 3. Linux troubleshooting

Input: logs and a failure report.

Expected: fast triage is used first; uncertain or cross-system findings escalate; commands and observations are captured as evidence.

## 4. Security audit

Input: a codebase requiring security review.

Expected: security workflow is selected, privileged or destructive operations are not attempted, findings include evidence and remediation priority, and completion is independently validated.

## Completion checks

- Correct workflow and execution mode chosen.
- Agent plan contains explicit roles and evidence requirements.
- Shared knowledge contains no secrets.
- Escalations follow the routing contract.
- Final result distinguishes verified outcome from residual risk and required approvals.
