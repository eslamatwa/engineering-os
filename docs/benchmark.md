# Token and cost benchmark

The same requests in real Claude Code (2.1.321, headless, Sonnet as the main model), with and without Engineering OS. Each task ran twice per side in a fresh repo. Run with `node tools/bench.js <work-dir> <claude-exe> 2 sonnet` (`BENCH_TASKS=a,b` to pick tasks). Costs are Claude Code's own `total_cost_usd` (list prices); tokens include cache reads and writes. Every run finished its task correctly.

## Result now (round 4, 2026-11-14)

| Task | Project | Without | With Engineering OS | Difference |
| --- | --- | --- | --- | --- |
| Document every module (big, reading-heavy) | Engineering OS plugin, 2,500 lines | $0.629 | **$0.352** | **−44%** |
| Read and analyse the project | latchkey (Rust + Svelte, 193 files) | $0.225 | **$0.193** | **−14%** |
| Add `forgetHost` plus tests, run the project's own tests | latchkey | $0.129 | $0.143 | +10% |
| Small feature across 3 files | small test repo | $0.097 | $0.115 | +19% |
| Bug fix with a failing test | small test repo | $0.100 | $0.101 | +2% |
| Trivial edit (one comment) | small test repo | $0.089 | $0.092 | +3% |

- **Big reading jobs:** a Haiku scout reads, Sonnet works from its summary (per run: Sonnet $0.25 + Haiku $0.11, against Sonnet $0.63 alone). About 1.5× slower in wall-clock time.
- **Ordinary questions:** Sonnet searches first and reads only the files that matter, with no scout; cheaper and as fast as plain Claude Code.
- **Code changes** cost a little more: when a change grows past the trivial budget the task becomes `standard` and needs one `engos plan set` (one refusal, one command). That is the price of the classification, scope and evidence rules.

latchkey's Rust tests could not run on this machine: Windows Application Control blocks unsigned build scripts, so the code task used the UI's Node tests (`npm --prefix app/ui test`).

## How we got there

| Round | Change | All tasks, total | Notes |
| --- | --- | --- | --- |
| 1 | Phase 6 build | **+13%** (4 small tasks) | The 3-file feature +32%: two refusals, then `profile set` and `plan set`, 5 extra turns. No agents used. |
| 2 | One command (`engos plan set --kind … --scope-write …`); shorter session summary; empty brief template skipped; "use a scout for heavy reading" hint | **+2%** (5 tasks incl. the big one) | Feature +19% with no refusals (Claude planned first). Big task +8%: Claude still read everything itself, and writing a long doc raised the task to standard. |
| 3 | Concrete rule in the session summary: before reading more than 5 files, start one `engos:scout` (Haiku) with the file list and what to extract; read a file yourself only to edit it | big task **−41%**, analysis **−23%** | Haiku did the reading in both. The gate stopped the scout once when it tried a command that isn't read-only; it carried on. |
| 3b | Same build, on a real project (latchkey) | analysis **+57%**, code task +10% | The scout read the whole project on Haiku (1.7M tokens) where Sonnet alone read selectively (260k). A scout saves only when the alternative is reading everything. |
| 4 | Scout told to be selective (search first, about 15 files); scouts only for jobs that need most of a codebase read; ordinary questions: search and read the key files yourself | big task **−44%**, latchkey analysis **−14%** | Analysis used no scout and no refusals; the big task used the scout. |

Baselines without Engineering OS were reused between rounds (same prompts, same model, same project). Two runs per side is a small sample: the analysis baseline alone ranged from $0.16 to $0.42.

## Still open

- Fixed by D51 (2026-11-14): lines in docs files no longer count against the trivial budget, so a long docs file no longer forces a plan step.
- Not measured: a large code change with planned worker steps (Sonnet) and a validator.
