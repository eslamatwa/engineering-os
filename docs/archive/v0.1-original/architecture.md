# Architecture

```text
Request / Repository / Claude Desktop
              │
       Context & Classifier
              │
     Policy Gate + Model Router
              │
      Hybrid Orchestrator ───── Shared Knowledge Workspace
              │                         │
       Dynamic Agent Plan              Ledger / Decisions
              │
       Controlled Execution
              │
     Evidence-based Validator
              │
     Result / Approval Request
```

## Components

**Context and classifier** creates a normalized task profile: project type, task class, complexity, risk, reversibility, constraints, and expected evidence.

**Policy gate** decides the permitted execution mode before work begins. It is deterministic and takes precedence over model recommendations.

**Model router** selects a capability tier for each step, records why, and can escalate after low confidence or failed validation.

**Hybrid orchestrator** uses structured rules for safety and lifecycle control, while a frontier model plans ambiguous or cross-cutting work. It creates only the roles required by the task.

**Shared knowledge workspace** is file-based, inspectable, and portable. It holds project facts, decisions, task state, and agent handoffs.

**Evidence-based validator** checks that outcomes match the requested scope and that completion claims are backed by reproducible evidence.

## Extensibility boundary

The orchestration and routing contracts do not expose provider-specific commands. Claude Code is the first runtime adapter. Claude Desktop connects through an MCP interface to the same knowledge and planning contracts. Future provider adapters implement the same execution and evidence interfaces.
