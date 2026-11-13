# Orchestration records

Store one task record per engineering request, plus plan and validation artifacts. Records are the durable coordination layer between sessions and agents.

Suggested layout:

```text
orchestration/
  TASK-001.yaml
  TASK-001-plan.md
  TASK-001-validation.md
  ledger.jsonl
```
