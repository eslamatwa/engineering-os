# Engineering OS v0.1: independent review (Fable, 2026-11-14)

Review of the project as built at commit `e3e0476`, requested by the owner. Fable read the docs, the code and the tests, ran the 79 unit tests (all pass), and reproduced several findings against a scratch repo. Nothing in the repo was changed. Recorded as received; fixes are tracked separately.

## 1. Overall verdict

Not ready to publish as v0.1 with the current README. The architecture is sound and the code is clean, but the gate has several realistic fail-open paths that need no hostile model, and the README's absolute claims ("every edit and command", "the only thing that writes task state", "never deploys to production") are not true of the code.

**Biggest weakness:** the Bash gate is a first-word/prefix allowlist. Anything it does not recognise is `unknown`, which runs without a prompt in every class except high_risk. Combined with the PowerShell tool not being hooked and failed commands not being observed, the "prevented" level is much thinner than documented.

## 2. Correctness and security bugs (most severe first)

1. **The PowerShell tool is not gated.** `plugin/hooks/hooks.json:17,29` match `Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task|mcp__.*`, and `preToolUse` (`plugin/scripts/engos-hook.js:741-744`) has no branch for it.
   - Scenario: on Windows, `git push`, `Remove-Item -Recurse`, `claude -p …` or a write to `.engos/ledger.jsonl` through that tool gets no gate and no observation.
   - Fix: add `PowerShell` (and `Monitor`) to both matchers and route them through `gateBash`; deny unknown tool names in `preToolUse`.
2. **Failed Bash commands are never observed.** Spike P8 shows a non-zero exit fires `PostToolUseFailure`, but that hook only matches `Agent|Task`, and `engos task close` never re-observes.
   - Scenario: a script rewrites `.env` then exits 1, or `git merge` stops on conflicts. There is no violation, `last_change_at` does not move, and an earlier passing check still closes the task. If the next call is an Edit, the protected hit is absorbed without `needs_human`.
   - Fix: run the observer on Bash failure, and again inside `engos check` and `engos task close`.
3. **Command classifier gaps (reproduced).** `classifyPart` is at `engos-rules.js:175-201`.
   - Classified `read`, so allowed for scouts and read-only sessions and skipped by the observer: `sed -Ei … src/auth/x.ts`, `sed --in-place … .env`, `sort -o`, `uniq a b`.
   - Classified `unknown`, so no prompt outside high_risk: `(cd pkg && npm publish)`, `(git push)`, `if …; then git push; fi`, `git -C . push`, `git --no-pager push`, `/usr/bin/git push`, `git.exe push`, `bash -c "git push"`, `eval …`, `find … | xargs rm -rf`, `timeout 30 curl …`, `rm --recursive`, `gh api -X DELETE`, `git pull`, `git clone`, `terraform apply`, `kubectl delete`.
   - The `claude` block (D34 calls it mandatory) is first-word only: `npx claude -p "/engos:decide TASK-001 close"` and `cmd /c claude …` are `unknown`.
   - `git checkout .`, `git restore .` and `git stash drop` are `vcs_local`, so they discard work without asking.
   - Fix: strip `(`, `{`, `then`, `do`, `!` and wrappers (`xargs`, `timeout`, `npx`, `bash -c`, `eval`, `cmd /c`, `powershell -c`, recursing into the quoted string); match on the basename plus the subcommand after git's global options; treat `git`/`gh`/`npm` with an unrecognised subcommand as approval; fix the `sed` regex for combined flags.
4. **Unparseable hook input fails open (reproduced).** `readInput` returns `{}` on bad JSON (`engos-hook.js:18-25`), so `tool_name` is undefined, nothing matches and the hook exits 0.
   - Fix: in `pre-tool-use` mode, block on a parse failure or missing `tool_name`.
5. **`.engos/` state is editable by the model (reproduced).** `never` covers only approvals and the ledger (`config/rules.yaml:83-87`), and the observer ignores all of `.engos/`. Edit/Write to `.engos/config.yaml`, `.engos/tasks/TASK-001/profile.json` and `.engos/sessions/<id>.json` exit 0 with no prompt.
   - Scenario: an injected "add `mcp__*` to the allowlist", or an honest "fix the test command" that sets `checks.test: "true"`. One Write can also set `close_acknowledged`, `approved_files`, the class, or `paused`.
   - This contradicts `config/policies.yaml` ("hand-editing YAML is denied by the gate"), `docs/architecture.md` ("State … prevented for Edit/Write") and the README.
   - Fix: make `.engos/tasks/**`, `.engos/sessions/**` and `.engos/status.json` `never`; make `.engos/config.yaml` high_risk (prompt on each edit); record the check command hash and refuse evidence when it changed during the task.
6. **Branch switches and pulls create false violations (reproduced).** The observer diffs against the task-open HEAD and `vcs_local` is not exempt. `git checkout other`, where the branches differ in `src/auth/`, turned an open trivial task into high_risk and `needs_human`. The same applies to `git pull`, `merge`, `rebase` and `stash pop`.
   - Fix: re-baseline when HEAD moves through a VCS command, or attribute only working-tree changes.
7. **Stale evidence.** `last_change_at` only moves for Bash when the file list or line counts change. A second `sed -i`, a formatter or a codegen run that keeps the counts leaves an old passing check valid.
   - Fix: compare a content hash of the diff.
8. **Close confirmation outlives the diff.** `close_acknowledged` is never cleared. The user confirms, Claude edits more and re-runs the check and validator, and the task closes on a diff the user never confirmed.
   - Fix: clear it whenever `last_change_at` moves.
9. **Typed commands are unverified against the real event.** `promptExpansion` reads `input.prompt`, but spike R7 lists the `UserPromptExpansion` fields as `command_name`/`command_args`. The tests inject a synthetic `prompt`, and no live run of `/engos:decide`, `/engos:class` or `/engos:pause` is recorded.
   - If the field is absent, the hook silently returns while `plugin/commands/decide.md` tells Claude "the hook has already recorded it"; high_risk tasks could then never close.
   - Fix: build the line from `command_name` + `command_args`, and test it live.
10. **D35 gaps.** `/engos:pause` has no same-session or resume check, although the docs say D34/D35 apply to it. A task with `session_id: null` (opened by the CLI without the env var) accepts decisions from any session. `engos task rearm` is model-runnable and classed harmless.
11. **Secrets reach `.engos/`.** The full command is stored in approval records, in the ledger (500 chars), in the task summary and in `status.json`/`status.js`. MCP inputs are stored up to 400 chars. `curl -H "Authorization: Bearer …"` or an email body from a mail MCP ends up on disk and in the live view.
    - Fix: redact header, token and `KEY=` patterns, and store a hash plus the first words.
12. **Model permanently marked unavailable on any failure.** The regex in the Agent failure hook matches "model", "permission" or "access" in any Agent error and writes `.engos/sessions/models.json` with no expiry and no reset command. One overload or user interrupt silently downgrades all Opus steps to Sonnet.
13. **Stuck writer lock.** A launch is recorded in PreToolUse. If the user then denies the call or interrupts, it stays `launched` and `G-one-writer` blocks every worker for 2 hours; there is no clear command.
14. **Smaller items.**
    - Lowering a class ignores floors by rule name, so a later, different protected file never raises it again.
    - `--scope-write "**"` is accepted and avoids `F-protected-planned`.
    - `env_error` matches `ENOENT` or `Cannot find module` anywhere in failing output, so a broken import is not counted as an attempt.
    - Paused sessions do no observation at all.
    - Paths outside the repo are ungated, including `~/.claude/settings.json` and the plugin's own scripts.
    - Symlinks are not resolved.
    - There is no locking on `profile.json` or `nextTaskId` under concurrent hooks.
    - `ENGOS_TEST_THROW` ships in production code.
    - Likely but untested: choosing "don't ask again" writes `.claude/settings.local.json`, which the snapshot would flag as a `never` violation.
15. **Live view.** In good shape: `esc()` is used throughout, `<` is escaped in `status.js`, and the server checks the random path, Host and `Sec-Fetch-Site`. The remaining risk is the secret content in item 11.

## 3. Design problems

- **Granted is inferred from "PostToolUse fired".** A "No" is never recorded, and an approved command that exits non-zero stays `requested` and then `expired`. The README says "every answer is recorded".
- **D8 and the code disagree.** D8 says standard tasks get a worker and a validator. The code requires a validator only for high_risk and D47 makes steps optional. Escalation (D20) exists only when worker steps are planned; a step-less task has no attempt ceiling.
- **D25 is not enforced.** "Security finding of medium or higher goes to the human" depends on the lead passing `--security --severity`. `max_severity` is recorded and never used; a `pass` verdict with a critical finding closes.
- **Dispute outcomes do nothing at close.** After the human sides with the worker, close still demands a passing verdict.
- **G-prod has no code.** "Deploy to production: deny" is not implemented anywhere.
- **Sensitivity "in any language" is self-declared by the model**, so it is advisory.
- **Default protected globs miss common names.** `**/*secret*` does not match `secrets/db.yaml`; `payments/`, `billing/`, `infra/` and `.gitlab-ci.yml` are not covered.
- **Trivial tasks accumulate.** Nothing tells Claude to close them, and the Stop hook is not built. The third unrelated small edit in a session trips the budget, and open tasks pile up across sessions.
- **Attribution is by position.** Subagents are bound to the "oldest unbound launch of that type", and Bash changes to already-touched files are not attributed to the worker, which causes false report mismatches on retries.
- **Superseded decisions are still listed as live.** D14, D15, D17 and D19 sit in the table unmarked.

## 4. Usability and cost

- **Heredocs are split line by line.** A standard Claude Code commit (`git commit -m "$(cat <<'EOF' …)"`) whose message mentions `plugin/hooks/hooks.json` is denied as `self_protect` (reproduced). In a high_risk task every such commit prompts as "unknown command". A heredoc body containing `rm -rf` or `git push` prompts as destructive.
- **Closing a docs-only trivial edit requires every configured check.** Expect tasks to be left open.
- **`plugin/commands/decide.md` hints only `accept|stop`.** The real options include `close`, `retry`, `fable`, `no_fable`, `validator`, `worker`, `approve_amendment`.
- **MCP prompts on every call until allowlisted.** The fix is to edit `config.yaml`, which is itself ungated (item 5).
- **Report checks are strict on path spelling.** `./src/a.ts` versus `src/a.ts` costs a send-back turn.
- **Hook cost grows with history.** `listTasks` and `buildStatus` parse every task profile on each ledger write; the status rebuild will slow hooks after a few hundred tasks.
- **Refusal messages are good.** They carry ready-to-run commands, and the session summary is compact.
- **The install line needs checking** against the real CLI syntax, and the repo is still private.

## 5. Tests and evidence

- **Untested:** the PowerShell tool, malformed stdin, failed-Bash observation, subshells and wrappers, `sed -Ei`, branch switching, edits to `.engos/tasks` and `config.yaml`, concurrent hooks, the close acknowledgement after further edits, and `ask` inside a background subagent.
- **Tests that would pass with the feature broken:** all typed-command tests (synthetic `prompt` field); the MCP gate (unit only); model-unavailable, the Fable ask and three failed attempts (unit only, as `docs/phase-results.md` admits).
- **Benchmark:** two runs per side, with a baseline that ranged from $0.16 to $0.42. The README's −44% and −14% are presented without that caveat, and no planned worker-plus-validator task was measured.
- **`docs/hooks.md` says "verified fields (R7)" for H2**, but R7 did not verify `prompt`.

## 6. Docs

- The README explains the idea well. Overstated or wrong: "a gate on every edit and command"; "every answer is recorded"; "the only thing that writes task state"; "never deploys to production"; "three attempts … then it stops" (only with worker steps); "Version 0.1" (`plugin.json` says `0.1.0-phase7`).
- `docs/architecture.md` still says the MCP gate is "not built yet".
- `docs/hooks.md` drift: H3 steps 3 and 4 describe the old typed scope approval; the H2 regex is garbled; the latency target is 50 ms where D44 says 30 ms.
- `docs/execution-contract.md` lists ledger events `approval.rejected` and `approval.used`, which are never written.
- `config/policies.yaml` describes `default_mode: read_only` and state-file protection that the code does not implement.

## 7. Top 10 fixes before publishing

1. Hook the PowerShell (and Monitor) tool, and deny unknown tool names or unparseable input in `pre-tool-use`.
2. Observe on Bash failure, and re-observe inside `engos check` and `engos task close`.
3. Harden the classifier: subshells and keywords, wrappers, `git` global options, full paths, combined `sed` flags; make unrecognised `git`/`gh` subcommands ask.
4. Protect `.engos/tasks/**`, `sessions/**` and `status.json` as `never`, and `config.yaml` as prompt-on-edit; bind evidence to the check command hash.
5. Verify typed commands in a real session and build the line from `command_name`/`command_args`; apply D34/D35 to pause.
6. Re-baseline on HEAD moves so checkout, pull, merge and rebase stop raising false violations.
7. Clear `close_acknowledged` on any later change, and use a content hash for `last_change_at`.
8. Redact commands and MCP inputs before writing approvals, the ledger and the status files.
9. Stop splitting heredoc bodies; tighten the model-unavailable regex and add reset commands for it and for stuck launches.
10. Correct the README and docs to match the code, and tell Claude when to close trivial tasks.
