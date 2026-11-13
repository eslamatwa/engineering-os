# Security and governance

## Default posture

Start read-only. Widen permissions one step at a time only when necessary, policy-permitted, and attributable to a task. Use the least privilege required to produce evidence.

## Approval gates

Human approval is mandatory before production deployment, irreversible changes, destructive actions, security-sensitive changes, credential handling, or externally visible side effects.

## Data handling

- Keep secrets out of prompts, workspace files, and ledger records.
- Mark unsupported assumptions and request confirmation rather than treating them as facts.
- Preserve an audit trail for decisions that affect architecture, access, cost, or delivery risk.

## Validation independence

The validator must review stated scope and evidence rather than simply restating the implementer's conclusion. A failed validation returns a concrete gap, not a vague rejection.

## Production boundary

v0.1 plans and validates production changes but does not autonomously deploy or obtain privileged access.
