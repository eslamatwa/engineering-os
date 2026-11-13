# Decision to test traceability

Every decision in `docs/decisions.md` and how it is checked. Scenario IDs refer to `tests/acceptance-scenarios.md`. "Review" means it's checked by reading the release, not by a running test.

| Decision | Summary | Checked by |
| --- | --- | --- |
| D1 | Claude only | Review: no provider adapters in the release |
| D2 | Plugin + `.engos/` per repo | F1 |
| D3 | Repo scope; logs analysed, not fetched | D3 |
| D4 | Only humans approve | B2, B3, B4 |
| D5 | Routing in code; roles are cards | C1, C8 |
| D6 | Published for others | Review: phase 7 |
| D7 | Threat model; not a sandbox | Review: README statement; A6 shows detection limits |
| D8 | Four classes, start low | A1, A2 |
| D9 | Protected paths | A3, A6 |
| D10 | Trivial budget | A1, A2, A7 |
| D11 | Git required for edits | D1 |
| D12 | Class only goes up; scope limits | A5, B7 |
| D13 | Sensitivity flags in any language | A4 |
| D14 | Approval method by kind | B2, B3 |
| D15 | Fallback in bypass/auto; headless denies | B3, B5 |
| D16 | Approval shows the exact action | B2 |
| D17 | Expiry and HEAD binding | B2, B8 |
| D18 | No blanket approvals | B2 |
| D19 | Rejection memory | B6 |
| D20 | Three attempts, Fable only by human | C1 |
| D21 | Failure labels | C2 |
| D22 | Uncertainty as checks | D3 |
| D23 | Three subagent files; model checked | C8 |
| D24 | No nesting; one writer; built-ins | C5, C9 |
| D25 | Lead limits; disputes | C6, C10 |
| D26 | Node hooks; init checks Node | B1, F1 |
| D27 | Minimum version; read-only if older | B9 |
| D28 | What is committed | F1 |
| D29 | Pause keeps hard gates | B7 |
| D30 | No main-thread lead agent | Review |
| D31 | Name and display name | Review: `claude plugin validate --strict` |
| D32 | Model availability; ask before Fable | C3, C4 |
| D33 | Always visible | E1 |
| D34 | Same-session approvals; `claude` blocked | B4 |
| D35 | Approval void after resume or fork | B4b |
| D36 | Checks only through `engos check` | C7 |
| D37 | Full change detection incl. gitignored protected files | A6, A7 |
| D38 | Unknown commands need approval in high_risk | A8 |
| D39 | Runs wherever Claude Code runs; view is read-only | E2, E3 |

Every security decision (D4, D7, D9, D12, D14–D19, D24, D27, D29, D34–D38) has at least one running scenario, except D7, whose limits are stated rather than enforced.
