---
description: Show what Engineering OS is doing now (tasks, agents, checks, what is waiting for you)
---

Run `engos status` with the Bash tool and show the user the result in a few short lines: the session mode, each open task with its class, its steps and agents (model and state), the latest checks, and anything waiting for them (approvals to allow in the session prompt, or a `/engos:decide` they need to type). If `engos status` fails, run `engos doctor` and explain what it says. Don't change anything.
