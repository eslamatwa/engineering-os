# Token and cost benchmark

The same requests in real Claude Code (2.1.321, headless, Sonnet as the main model), with and without Engineering OS. Each task ran twice per side in a fresh repo. Run with `node tools/bench.js <work-dir> <claude-exe> 2 sonnet`. Costs are Claude Code's own `total_cost_usd` (list prices); tokens include cache reads and writes.

Run: 2026-11-13, 16 sessions, $1.09 in total. All 16 finished their task correctly.

| Task | Without | With Engineering OS | Difference | Tokens without → with | Turns | Time |
| --- | --- | --- | --- | --- | --- | --- |
| Read and analyse an existing project (the plugin's own 2,500 lines) | $0.227 | $0.254 | +12% | 260k → 325k | 7 → 8 | 33s → 37s |
| Trivial edit (one comment) | $0.089 | $0.092 | +3% | 136k → 137k | 3 → 3 | 10s → 12s |
| Bug fix with a failing test | $0.100 | $0.106 | +7% | 185k → 209k | 5 → 5.5 | 18s → 22s |
| Small feature across 3 files | $0.097 | $0.127 | +32% | 160k → 282k | 3.5 → 9 | 16s → 28s |
| **All four** | **$0.512** | **$0.580** | **+13%** | | | |

## What the numbers say

- **Small work costs almost nothing extra** (+3% to +7%): the session summary and a few ledger writes.
- **The feature cost the most** (+32%). It touched 3 files, so the task was raised from trivial to standard; the gate refused the edit twice until Claude ran `engos profile set` and `engos plan set`. That round trip is 5 extra turns.
- **No agents were used in any run.** Steps are optional (D47), and for tasks this small Claude did the work itself, so the cheaper-model routing that should save money on large tasks never came into play. This benchmark measures the overhead of the gate and the evidence rules, not the savings from routing.
- **Analysis** (+12%) is mostly the session summary being re-read on every turn.

## Not measured yet

A large task where the lead plans worker and scout steps, so reading goes to Haiku and scoped work to Sonnet. That is where Engineering OS is expected to save, and it needs a bigger, more expensive run.

## Ways to lower the overhead

1. One command for profile and plan (`engos plan set --kind feature --scope-write …`), so an upgraded task costs one refusal and one command instead of two of each.
2. A shorter session summary.
3. When a task is raised, put the exact ready-to-run command in the refusal, so Claude doesn't need a separate turn to look anything up. This is already done; (1) makes it a single line.
