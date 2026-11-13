# Roadmap

Direction only. Nothing here is a decision. Each version gets its own design round and D-numbers when we reach it, the same way v0.1 did.

| Version | Focus | Notes |
| --- | --- | --- |
| **v0.1** | Repository engineering | Current design (D1–D49). Code inside a git repo, every Claude Code surface. |
| v0.2 | Linux, Docker, infrastructure | Commands on real machines need a new risk model: read-only probes, changes, production. Also: read-only monitoring MCP for the Desktop Chat tab with a project index and project selector (D39). Prebuilt hook binaries instead of Node (D26). |
| v0.3 | Databases, networking, MCP integrations | External systems as first-class steps with their own approvals. |
| v0.4 | Desktop execution bridge, advanced dashboard | Only after the approval model has been proven in use. Cost and token views if the platform exposes usage data. |

Ideas parked from reviews, to reconsider later:
- OS sandbox as an optional strict mode (dropped from v0.1 by D7).
- Hash-chained ledger and tamper-proof approvals (dropped by D7).
- Running the lead as a main-thread plugin agent (D30).
- Blanket approvals per task (D18), if per-action approvals prove too tiring.
- Automatic secret scanning of diffs and state files (described in the first design, not built in v0.1).
- Lead skills (intake, plan, run, validate) if the session summary, refusals and briefs prove not to be enough.
