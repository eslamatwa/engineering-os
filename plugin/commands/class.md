---
description: Lower a task's class, e.g. /engos:class TASK-012 standard (approvals for protected files and push still apply)
argument-hint: TASK-ID question|trivial_edit|standard
---

The user asked to lower an Engineering OS task's class: $ARGUMENTS

The Engineering OS hook has already applied it (or refused it with a message the user can see). Don't change task state yourself. Run `engos task status` with the Bash tool and tell the user the task's class and state in one line.
