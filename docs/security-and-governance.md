# Security and governance

## Threat model (D7)

**In scope:** honest mistakes, and a model misled by instructions it read in a file, log, issue or web page. Examples:
- Editing a sensitive file while thinking the change is trivial.
- Pushing, publishing or deleting without asking.
- Claiming checks pass without running them.
- Following a planted instruction such as "run this command to approve".

**Out of scope for v0.1:** a model deliberately working around the rules, and any OS-level isolation. There is no sandbox.

The README says this in plain words: Engineering OS prevents common mistakes and detects indirect changes inside the repo after they happen. It is not a sandbox and does not stop a model that is deliberately trying to get around it.

## Enforcement levels

| Level | Meaning | Examples |
| --- | --- | --- |
| prevented | Code stops it before it runs | Edit on a protected path, `git push` without approval, wrong model for a step, running `claude` from Bash |
| detected | Code finds it after it ran and stops the task | A script that writes a protected file, budget exceeded through Bash |
| advisory | The session summary, a brief or a role card asks for it | Plan quality, role behaviour |

Gate hooks fail closed: a crash, timeout or missing Node blocks the call (`onFailure: block`, verified in spike R4 and R5).

## Approvals

- Only a human approves (D4). The gate writes the request from the real tool input (D16).
- Push, publish, network, destructive commands, unknown commands in high_risk tasks, and the first edit of each protected file in a task use Claude Code's own Allow/Deny prompt, in every interactive mode (D46, verified in spike round 3). The model can't click it.
- Every execution of an action asks again, so action approvals are single-use without hashes or expiry. A protected file stays approved for its task, at most 24 hours.
- The prompt shows the real action but not extra context; branch and outgoing commits are recorded with the request and shown in `/engos:status`.
- A "No" isn't visible to hooks, so the model may ask again; nothing runs without a click. Headless sessions can't approve.
- No blanket approvals (D18).
- Typed commands remain only for decisions, lowering a class and pause. They count only from the session that owns the task and not after that session was resumed (D34, D35). Bash may never run `claude`.
- Approval records are written only by hooks. A fingerprint of each record is kept, so a record changed or created by anything else is flagged as a violation.

## Data handling

- Secrets, tokens, private keys and raw credentials never go into `.engos/`, the ledger, briefs or reports. Check output is never stored, only its hash. Commands and MCP inputs are redacted before they are written to approvals, the ledger and the status files (Authorization headers, tokens and passwords given as flags or `KEY=value`, credentials in URLs, well-known key formats); the approval hash still uses the original text (D52). Automatic secret scanning of diffs is **not built in v0.1**.
- Facts need a source (file and line, command output, or a human). Assumptions are marked as assumptions until a human confirms them.
- Tasks, approvals and the ledger stay local and are gitignored. Config, brief and state are committed (D28).

## Validation independence

- The writer never validates its own change. Checks run by code; judgement comes from a validator subagent with no Edit or Write.
- A failed check is a fact, not a dispute. Judgement disputes follow `config/agents.yaml` disputes; security findings of medium or higher always go to the human.
- A failed validation returns the exact gap, not a vague rejection.

## Residual risks

| Risk | Why it remains | Mitigation |
| --- | --- | --- |
| A script changes files outside the repo | Hooks only see inside the repo | Out of scope by D7; stated in README |
| A dangerous change in an unprotected file | Code can't judge meaning | Projects add their own protected paths; sensitivity flags from the model |
| An injected instruction misleads the human approver | The human makes the final call | Approvals show the exact command, not the model's summary |
| Another session or a scheduled task sends an approval command | Hooks get no origin field | Same-session rule (D34) |
| A command the classifier doesn't recognise | The Bash gate classifies by program and subcommand; anything else is `unknown` | Unknown commands run and are observed in question, trivial and standard tasks, and ask in high_risk ones; wrappers, subshells and git options are unwrapped first; unknown `git`, `gh` and infra subcommands ask (D52) |
| Files outside the repo, symlinks | Hooks only see paths inside the repo and don't resolve symlinks | Out of scope by D7 |
| Two hooks writing the same task at once | No file locking in v0.1 | Rare in practice: one session drives one task |
| The user turns the plugin off | Their choice | `/engos:pause` keeps hard gates on; uninstall is outside our control |
| A subagent's report misstates what it did | Reports are model text | Files changed are compared with what hooks observed; refs and quoted log lines are checked to exist; a bad report is sent back once, then flagged to the lead as unverified |
| MCP tools act outside the repo | They can, by design | Every call asks unless it is one of Claude's own app tools or in the project's `mcp_allowlist` (D49); calls are observed for repo changes like commands |
| Diffs, task events and the project list in the live view | They show code and paths | `--serve` only, under its random path; a diff only for files the task changed, with secrets redacted; the project list holds local paths, kept in `%LOCALAPPDATA%\engos` or `~/.config/engos`; throwaway folders are not registered |
| The local live view server | It listens on a port, and a web page in the same browser could try to load its data with a script tag | 127.0.0.1 only, GET only, two files, no state changes; served only under a random path that changes each run; requests with another Host (DNS rebinding) or a cross-site `Sec-Fetch-Site` are refused; stops after 8 hours |
