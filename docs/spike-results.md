# Platform spike results

Throwaway tests of Claude Code behaviour that the design depends on. Nothing here is product code.

- **Claude Code:** 2.1.321 (bundled with the desktop app, not on PATH)
- **OS:** Windows 11, Git Bash present (hooks run through bash)
- **Node:** v24.19.0
- **Test files:** session scratchpad (`spike/hook.js`, `spike/settings/*.json`), not in the repo
- **Date:** 2026-11-13

## Round 1: no login needed

Hooks fire before the CLI checks login, so these ran without a model.

| # | Question | Result | Affects |
| --- | --- | --- | --- |
| R1 | Does exit code 2 block? | **Yes.** "UserPromptSubmit operation blocked by hook" with the stderr text. | Gate |
| R2 | Does a crashing hook (exit 1) block? | **No, fails open.** The prompt went through. | D7, gate |
| R3 | Does a missing runtime block? | **No, fails open.** `command not found`, prompt went through. | D26 |
| R4 | Does `"onFailure": "block"` fix R2? | **Yes.** "failed; blocking because onFailure is \"block\"". | D27 |
| R5 | Does `"onFailure": "block"` fix R3? | **Yes.** Same message. | D26, D27 |
| R6 | Is the permission mode in the hook input? | **Yes**, as `permission_mode`: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto` all reported. | D15 |
| R7 | Does `UserPromptExpansion` give the command and args? | **Yes**: `expansion_type: slash_command`, `command_name`, `command_args`, `command_source`. | D14 |
| R8 | Can a script fake a typed approval? | **Yes.** `claude -p "/approve-test APR-1234"` fired `UserPromptSubmit` and `UserPromptExpansion` with the same fields as a typed command, no origin field, even without a login. | D14, D7 |
| R9 | Fields in `UserPromptSubmit` | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`, `prompt`. No origin. | D14 |

### What this changes

- **D27 confirmed:** fail-closed hooks exist in 2.1.321. Every gate hook must set `"onFailure": "block"`. Without it, a crash or missing Node silently disables the gate.
- **D26 confirmed:** with `onFailure: block`, a user without Node gets a clear block, not silent bypass.
- **D15 confirmed:** the gate can read `permission_mode` and switch to the typed approval in `bypassPermissions` and `auto`.
- **D14 needs two extra checks (cheap):**
  1. The approval hook only accepts `/engos:approve` when `session_id` equals the session that created the request. A `claude -p` spawned from Bash gets a new session id. (Not yet tested: whether `claude -p --resume <id>` reuses the id.)
  2. The Bash denylist blocks running `claude` (already in D7). R8 shows this is required, not optional.

## Round 2: logged-in CLI, headless, Haiku

Run 2026-11-13 after the owner logged the bundled CLI in. Control run C0 (logging hook only, `acceptEdits`) created the file, so the denials below come from the hooks.

| # | Question | Result | Affects |
| --- | --- | --- | --- |
| P1 | PreToolUse exit 2 on Write blocks the write | **Yes.** File not created; the model got the stderr reason. | Gate |
| P2 | JSON `permissionDecision: deny` blocks | **Yes.** File not created; reason passed to the model. | Gate |
| P3 | Hook `ask` in headless | **Denied** in `acceptEdits`, `bypassPermissions` and `auto`. Nobody to answer, so it becomes a denial. | D15 |
| P4 | Hook deny in `bypassPermissions` | **Still blocks**, for exit 2 and for JSON deny. | Gate |
| P5 | Settings `allow: [Write]` vs hook `ask` (headless, default mode) | **Hook wins**: write denied. Interactive behaviour still to see in round 3. | D14 |
| P6 | Agent tool input | `tool_input` has `subagent_type`, `model` (as asked, e.g. `haiku`), `prompt`, `description`. Hook input also has `permission_mode` and `effort`. Main-thread calls have no `agent_id`. | D23, H5 |
| P6b | Calls made inside a subagent | PreToolUse and PostToolUse carry `agent_id` and `agent_type`. | H3 rule 6, H5 rule 1 |
| P7 | Real model and subagent fields | Agent `PostToolUse` response has **`resolvedModel: claude-haiku-5-5`**. `SubagentStart`: `agent_id`, `agent_type`. `SubagentStop`: `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks`. No model field in either. Agents launched async by default (`status: async_launched`). | D23, D33, ledger |
| P8 | Exit code of a failed Bash | `PostToolUseFailure` fires; `error` starts with `Exit code 3` followed by stderr. A command that ends in `; echo $?` exits 0 and goes to PostToolUse instead. | Evidence |
| P10 | Plugin agent names | Plugin subagents are called with `subagent_type: engos:worker` (and `engos:scout`, `engos:validator`); hooks see the same string in `agent_type`. | D23, H5 |
| P11 | SubagentStart injection | `additionalContext` from SubagentStart reaches the subagent: the role card and report template appear in its transcript, and it outranks a lead prompt asking for another format. | H10 |
| P12 | SubagentStop send-back | `decision: block` from SubagentStop makes the subagent continue; the next stop has `stop_hook_active: true`. Agent `PostToolUse` arrives after SubagentStop with `status: completed` when the lead waits for the agent. | H11 |
| P13 | Local pages in the Desktop browser pane | A `file://` page opens as a static snapshot: its scripts don't run, so it can't refresh. An `http://127.0.0.1` page runs normally and refreshes. | D33, E3 |
| P14 | Version without a process spawn | `AI_AGENT=claude-code_2-1-321_agent` is set in the Desktop app's Code tab. Terminal sessions: pending (the owner's next live test). | D42, D48 |
| P15 | Typed command fields | `UserPromptExpansion` for `/engos:decide TASK-001 accept` carries `prompt: "/engos:decide TASK-001 accept"`, `command_name: "engos:decide"`, `command_args: "TASK-001 accept"`, `expansion_type: slash_command`, `command_source: plugin` (2.1.321, headless). `/engos:pause` was recorded in the ledger. | D34, H2 |
| P16 | Cost from transcripts | Summing `message.usage` per assistant message (deduplicated by `message.id`) over the session transcript and `<session>/subagents/agent-*.jsonl`, at list prices with cache writes at 1.25x (5 min) and 2x (1 h) input, gave $0.1940 for a run Claude Code reported as $0.19392. | D53 |
| P9 | Does `claude -p --resume <id>` keep the id? | **Yes, same `session_id`.** `SessionStart` fires with `source: resume`. With `--fork-session` the id changes and `source: fork`. | D34 |

### What this changes

- **Gate design holds.** Deny works by exit code and by JSON, in every mode tested, including bypass.
- **D15 in headless is automatic:** an `ask` with nobody present is a denial. Interactive behaviour (does the prompt show in bypass?) is round 3.
- **Ledger can record the real model** from the Agent call's `resolvedModel`. `model_actual: unknown` is no longer needed when the PostToolUse fires.
- **Checks must be recorded per command.** If the model chains `; echo $?`, the failure is hidden. The gate should run configured checks only in their exact configured form, or the CLI should run them itself (`engos check test`). Proposed below.
- **D34 is not enough on its own.** A script can resume the lead's session and send `/engos:approve` with the same `session_id`. The `claude` block in Bash stops the direct path. Proposed extra check below.

### Proposals from round 2 (need the owner's yes)

1. **Approval after resume is void.** The approval hook refuses a typed approval if a `SessionStart` with `source: resume` or `fork` happened for that session after the request was created. A real user who restarts and resumes just gets asked again. Cost: one ledger lookup.
2. **Checks run through the CLI.** Configured checks run as `engos check <name>`, which runs the exact configured command and records the exit code itself. Evidence no longer depends on how the model typed the command.

## Round 3: with the owner, interactive (2026-11-13)

Throwaway Claude Code 2.1.321 sessions (Haiku) in `tests/.tmp/r3/` with a hook that returns `ask` for Write and `git push`, and a status line script.

| # | Question | Result | Affects |
| --- | --- | --- | --- |
| H1a | Hook `ask`, session started without a mode flag | The session's default mode was **auto** (Claude Code's new default, shown as a notice). The Allow/Deny prompt still appeared. | D46 |
| H1b | Hook `ask` vs a settings `allow: [Write]` rule | **Prompt appeared**; the hook wins over the allow rule. | D46 |
| H1c | Hook `ask` in `bypassPermissions` | **Prompt appeared.** | D46, supersedes D15 fallback |
| H1d | Does the prompt show the hook's reason text? | **No.** It shows the real action: file name and content for Write. | D16 → D46 |
| H1e | Does a `systemMessage` from the same hook show next to the prompt? | **No**, not before the prompt. | D46 |
| H1f | Allow → does the action run? | **Yes**, `a.txt` created with the expected content. | D46 |
| H2 | Status line from settings in the terminal | **Shown** at the bottom (owner confirmed). The script receives session id, model, workspace and effort as JSON. | D33 |
| H2b | Status line in the Desktop app's Code tab | Not tested yet. | D33 |
| H3 | Plugins with hooks on Claude Code on the web | Not tested yet. | D39 |

### What this changes

- D46 replaces typed approvals with the native prompt for actions and protected files.
- Context for an approval (outgoing commits, file list) can't go inside the prompt; it is recorded and shown in `/engos:status` and the live view.
