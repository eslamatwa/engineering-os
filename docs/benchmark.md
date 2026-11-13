# Token and cost benchmark

The same requests in real Claude Code (2.1.321, headless, Sonnet as the main model), with and without Engineering OS. Each task ran twice per side in a fresh repo. Run with `node tools/bench.js <work-dir> <claude-exe> 2 sonnet` (`BENCH_TASKS=a,b` to pick tasks). Costs are Claude Code's own `total_cost_usd` (list prices); tokens include cache reads and writes. Every run finished its task correctly.

## Result after the cost changes (round 3, 2026-11-14)

| Task | Without | With Engineering OS | Difference | Time without → with |
| --- | --- | --- | --- | --- |
| Document every module of a 2,500-line project (big, reading-heavy) | $0.629 | **$0.374** | **−41%** | 80s → 138s |
| Read and analyse an existing project | $0.347 | **$0.267** | **−23%** | 38s → 190s |
| Small feature across 3 files | $0.097 | $0.115 | +19% | 16s → 26s |
| Bug fix with a failing test | $0.100 | $0.101 | +2% | 18s → 21s |
| Trivial edit (one comment) | $0.089 | $0.092 | +3% | 10s → 11s |

Big and reading-heavy work is now clearly cheaper; small edits cost 2–3% more; a small multi-file feature still costs more because of the plan step. Reading through a Haiku scout is slower in wall-clock time, by about 1.7× for the documentation task and up to 5× for the analysis.

Where the saving comes from, per run (big documentation task with Engineering OS): Sonnet $0.27 for 333k tokens plus Haiku $0.12 for 241k tokens, against Sonnet $0.64 for 611k tokens without it. Haiku read the files; Sonnet worked from its summary.

## How we got there

| Round | Change | All tasks, total | Notes |
| --- | --- | --- | --- |
| 1 | Phase 6 build | **+13%** (4 small tasks) | The 3-file feature +32%: two refusals, then `profile set` and `plan set`, 5 extra turns. No agents used. |
| 2 | One command (`engos plan set --kind … --scope-write …`); shorter session summary; empty brief template skipped; "use a scout for heavy reading" hint | **+2%** (5 tasks incl. the big one) | Feature +19% with no refusals (Claude planned first). Big task +8%: Claude still read everything itself, and writing a long doc raised the task to standard. |
| 3 | Concrete rule in the session summary: before reading more than 5 files, start one `engos:scout` (Haiku) with the file list and what to extract; read a file yourself only to edit it | big task **−41%**, analysis **−23%** | Haiku did the reading in both. The gate stopped the scout once when it tried a command that isn't read-only; it carried on. |

Baselines without Engineering OS were reused between rounds (same prompts, same model). Two runs per side is a small sample: the analysis baseline alone ranged from $0.16 to $0.42.

## Still open

- A long documentation file pushes a task over the trivial line budget (40 lines) and makes it `standard`, which costs a plan step for a docs-only change. Not counting lines in docs files is a possible owner decision.
- Not measured: a large code change with planned worker steps (Sonnet) and a validator.
