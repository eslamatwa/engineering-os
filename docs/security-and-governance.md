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
| advisory | A skill or role card asks for it | Plan quality, role behaviour |

Gate hooks fail closed: a crash, timeout or missing Node blocks the call (`onFailure: block`, verified in spike R4 and R5).

## Approvals

- Only a human approves (D4). The gate writes the request from the real tool input and shows the exact action plus context (D16).
- Single external actions use the native permission prompt; scope approvals and decisions use a typed command (D14).
- In `bypassPermissions` or `auto` mode the native prompt isn't trusted and the typed command is required (D15). Headless sessions can't approve.
- Single-action approvals are single-use, last one hour and die with a new commit. Scope approvals last until the task closes, at most 24 hours (D17).
- No blanket approvals (D18). A rejected action can't be asked again unchanged in the same task (D19).
- Typed approvals are accepted only from the session that created the request, and Bash may never run `claude` (D34). Spike R8 showed a script can otherwise fake a typed command.

## Data handling

- Secrets, tokens, private keys and raw credentials never go into `.engos/`, the ledger, briefs or reports. A secret found in a diff or state file sends the task to the human.
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
| The user turns the plugin off | Their choice | `/engos:pause` keeps hard gates on; uninstall is outside our control |
