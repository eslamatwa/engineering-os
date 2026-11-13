# Claude Engineering OS — MVP v0.1

Design package for a Claude-first, adaptive multi-agent engineering environment.

## Purpose

The MVP accepts a project or engineering task, classifies the context, selects a workflow, plans a right-sized team, routes work to an appropriate Claude model, records shared knowledge, and validates evidence before a result is accepted.

This package is a design deliverable: Markdown and YAML contracts that can be turned into an executable implementation without redesigning the operating model.

## Decisions fixed for v0.1

| Area | Decision |
| --- | --- |
| Primary runtime | Claude Code |
| Secondary interface | Claude Desktop through MCP |
| Orchestration | Hybrid: deterministic policy gates plus model-led planning |
| Knowledge backend | Versioned Markdown and JSON files |
| Model routing | Dynamic, task-aware contract |
| Production safety | Approval gates; no autonomous production deployment or root access |
| Provider strategy | Claude-first; adapters enable future multi-provider support |

## Package map

```text
claude-engineering-os-mvp-v0.1-design/
├── README.md
├── CLAUDE.md
├── config/
│   ├── agents.yaml
│   ├── policies.yaml
│   └── routing.yaml
├── docs/
│   ├── architecture.md
│   ├── execution-contract.md
│   └── security-and-governance.md
├── integrations/
│   ├── claude-code/README.md
│   └── claude-desktop/README.md
├── workspace/
│   ├── PROJECT_BRIEF.md
│   ├── PROJECT_STATE.md
│   ├── orchestration/README.md
│   └── agents/README.md
└── tests/
    └── acceptance-scenarios.md
```

## From design to an executable MVP

1. Implement the classifier and router against the schemas in `config/`.
2. Treat `workspace/` as the shared, reviewable project memory.
3. Implement the orchestration lifecycle in `docs/execution-contract.md`.
4. Add Claude Code commands and the Desktop MCP surface described in `integrations/`.
5. Validate the first implementation with `tests/acceptance-scenarios.md`.

## Operating principle

Prefer the smallest capable model and team. Escalate only when complexity, uncertainty, risk, or failed evidence warrants it. Every material conclusion must be traceable to repository state, command output, tests, or an explicit human decision.
