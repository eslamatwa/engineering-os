---
description: Answer a task that is waiting for you, e.g. /engos:decide TASK-004 accept
argument-hint: TASK-ID accept|stop|close|retry|fable|no_fable|validator|worker|approve_amendment|reject_amendment
---

The user typed a decision for an Engineering OS task: $ARGUMENTS

The options depend on what the task is waiting for:
- `accept` or `stop`: a command changed protected files without approval.
- `close`: confirm closing a high_risk task, or one whose review reported a finding of medium severity or higher.
- `retry` or `fable`: a step failed its checks three times (fable only if the plan includes it).
- `fable` or `no_fable`: use Fable for a step routed to the deep tier.
- `validator` or `worker`: settle a dispute.
- `approve_amendment` or `reject_amendment`: a change to the acceptance criteria in a high_risk task.

The Engineering OS hook has already recorded the decision, or refused it with a message the user can see. Don't run any command that changes task state because of this message. Run `engos task status` with the Bash tool and tell the user in one or two lines what the task's state is now, then continue or stop as the decision says. If the task still shows as waiting, the decision wasn't accepted: say so and repeat the hook's message.
