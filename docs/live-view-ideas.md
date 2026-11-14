# Live view: ideas for the next version

Proposals for `/engos:view`, written for review (Fable and the owner) before anything is built. None of this is decided. Each idea says what it adds, where its data comes from, and what it risks.

## Where the view stands (v0.1)

An interactive, read-only page (`plugin/view/index.html`) that re-reads `.engos/view/status.js` every 2 seconds. It shows:
- The agent graph: you, the lead, each step or agent. Selecting a node shows its model, timing, files changed and stored report.
- Event list with filters, open and recent closed tasks, files by author, evidence, what's waiting for you.
- Served as a `file://` page, or by `engos view --serve` on 127.0.0.1 under a random path (the Desktop app's pane shows `file://` pages as static snapshots).

## Rules every idea must keep

1. **Read-only.** The page never approves, rejects or decides anything (D34, E2). Approvals happen only in the session that asked for them.
2. **Local.** No external resources, no network calls; data comes only from `.engos/`.
3. **No secrets.** Command output, prompts and environment values are never written to the status data.
4. **Cheap for the hooks.** The status picture is rebuilt once per hook run that wrote to the ledger; anything new must not slow the gate (D44, 30 ms).

## Proposals, most valuable first

| # | Idea | What it adds | Data source | Risk or cost | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | **Real cost and tokens per agent and per task** | The question users ask most: what did this cost, and which model spent it. Shows the Haiku/Sonnet/Opus split, which is the whole point of routing. | Claude Code's own transcripts: `transcript_path` and `agent_transcript_path` (verified in P7) carry per-message usage. Read after a subagent stops and at task close, not on every call. | Transcript format isn't a documented contract and could change; estimate prices from a table we ship. | Medium |
| 2 | **Timeline lanes (Gantt)** | One row per agent over time: who ran when, what overlapped, where the task waited for you. Makes slow or idle stretches obvious. | `launched_at` / `ended_at` and ledger times, already in the status data. | None. | Small |
| 3 | **Diff viewer per file** | Select a changed file to see its diff, so you can review without leaving the page. | `git diff <task base> -- <file>`, computed by the CLI or the server on request, not by hooks. | Diffs can contain secrets the user typed; show only on request and never store them. Needs the `--serve` mode (a `file://` page can't run git). | Medium |
| 4 | **Arabic and right-to-left** | The guide exists in Arabic; the view should too. Follows the browser language with a toggle. | Static strings in the page. | None. | Small |
| 5 | **Browser notification when something waits for you** | With the view on a second screen, you hear about an approval or a blocked task without watching the terminal. Information only; the notification opens the session, it doesn't approve. | `approvals` and `needs_human` in the status data. | Needs the user's permission in the browser; must not become an approval channel. | Small |
| 6 | **Replay a task** | A slider that rewinds a closed task event by event: class changes, refusals, attempts, checks. Good for review and for learning how the system behaves. | The ledger, filtered by task. | The ledger tail in the status data is limited; replay would read the task's events on demand (`--serve` mode). | Medium |
| 7 | **Task report export** | One click to save a Markdown or HTML summary of a closed task: request, class history, files, checks with exit codes, reviews, residual risk. Ready for a pull request description. | Status data for that task. | None; the file is saved locally by the browser. | Small |
| 8 | **Health strip** | Session mode, Claude Code version, gate latency of the last calls, warnings (unknown version, read-only reasons). Explains "why is it blocking everything". | Session files, and a latency sample the hook already measures. | Measuring latency in the hook must stay outside the 30 ms budget. | Small |
| 9 | **Check history** | Each check's runs over the task with duration and label (`passed`, `check_failed`, `env_error`), and a flag for flaky checks that pass and fail on the same code. | `evidence.checks` in the task profile. | None. | Small |
| 10 | **All projects at once** | A list of every project on the machine with an open task, its class and what waits for you. | Needs an index of projects; this is roadmap v0.2 (read-only MCP for the Desktop Chat tab, D39). | Larger change; out of scope for v0.1. | Large |

## Smaller polish

- Copy buttons next to each `/engos:decide …` line. They copy text only; the user still types or pastes it in the session. Worth checking with the owner that this doesn't blur the "decide only in the session" rule.
- Keyboard navigation between nodes (arrow keys) and a visible focus ring on SVG nodes.
- A light/dark toggle that overrides the system setting.
- Keep the event list's scroll position across refreshes.
- Show the routed tier next to the model that ran, and flag a mismatch.

## Questions for the review

1. Is real cost per agent (idea 1) worth reading transcripts, given their format isn't a published contract?
2. Should the diff viewer (idea 3) exist at all in a read-only page, or is the terminal the right place for diffs?
3. Is a browser notification (idea 5) a helpful nudge or a new channel someone could mistake for an approval?
4. Which three should ship first?
