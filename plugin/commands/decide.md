---
description: Decide on a task that is waiting for you, e.g. /engos:decide TASK-004 accept (or stop)
argument-hint: TASK-ID accept|stop
---

The user typed a decision for an Engineering OS task: $ARGUMENTS

The Engineering OS hook has already recorded it (or refused it with a message the user can see). Don't run any command that changes task state. Run `engos task status` with the Bash tool and tell the user in one or two lines what the task's state is now. If the decision was `accept`, continue the task; if it was `stop`, don't continue it.
