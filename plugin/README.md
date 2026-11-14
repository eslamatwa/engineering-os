# Engineering OS (`engos`)

Engineering discipline for Claude Code, enforced by hooks rather than requested in a prompt. Engineering OS sits between Claude and its tools:

- **Gates every file edit, shell command (Bash, PowerShell), agent call and external MCP call.** Commands are unwrapped (subshells, nested shells and command wrappers) and classified; protected files and the task's planned scope are enforced.
- **Classifies each task by what the code touches** (`question` → `trivial_edit` → `standard` → `high_risk`); the class only goes up.
- **Asks you through Claude Code's own Allow/Deny prompt** for pushes, publishing, network calls, destructive commands, external MCP tools and the first edit of each protected file. Every approval is recorded.
- **Requires evidence before a task closes:** `engos check <name>` runs your own test, lint or build command and records the real exit code.
- **Routes work to the right model:** a read-only scout on Haiku for heavy reading, workers on Sonnet or Opus per step, a validator that never edits, and Fable only with your yes. Failing steps get three attempts, then come to you.
- **Shows you what is happening and what it costs:** a status line, `/engos:status`, and `/engos:view`, a read-only live page with the agent graph, a timeline, real tokens and cost per agent from Claude Code's transcripts, diffs, replay and a report export, in English or Arabic.
- **Recommends official skills and MCP servers** that fit your project, with install commands (`/engos:recommend`); it never installs anything itself.

It protects against honest mistakes and instructions injected through files, logs or web pages. It is not a sandbox and does not stop a model deliberately working around it.

## Requirements

Claude Code 2.1.321 or later, Node 18 or later (tested on 20 and 24 on Windows, macOS and Linux), and git.

## Install

```bash
claude plugin install engos --marketplace eslamatwa/engineering-os
```

## Start

In each project, run `/engos:init` once. It asks which Claude models your plan includes and which commands prove the code works, offers a status line and deny rules, and writes a small `.engos/` folder. Then keep working as usual.

| Command | What it does |
| --- | --- |
| `/engos:init` | Set up the project |
| `/engos:status` | What is happening now |
| `/engos:view` | Open the live view |
| `/engos:recommend` | Official skills and MCP servers that fit the project |
| `/engos:decide TASK-… <option>` | Answer a task that is waiting for you |
| `/engos:class TASK-… <class>` | Lower a task's class (safety rules stay) |
| `/engos:pause` · `/engos:resume` | Turn the workflow off or on for this session; approvals stay on |

## Privacy

Everything stays on your machine in `.engos/` and in a small local list of your projects. Nothing is sent anywhere. Commands are stored with secrets redacted, and check output is never stored, only its hash. The live view is read-only and, when served, listens only on 127.0.0.1 under a random path.

Documentation, decisions, test results and the cost benchmark: <https://github.com/eslamatwa/engineering-os>

License: MIT.
