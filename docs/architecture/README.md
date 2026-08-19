# AI AGENT COMPANY OS — Architecture Package

Implementation-ready architecture specification for a self-hosted operating system for autonomous
AI companies. Produced 2026-08-10. Intended consumer: Claude Code inside VS Code.

## How to use this package

1. **Start here:** `docs/35-CLAUDE-CODE-HANDOFF.md` — the implementation entry point (stack, repo
   structure, migration order, first 50 tasks in dependency order, invariants, milestone DoDs).
2. **Authority order on any conflict:** `_DECISIONS.md` (binding decision core) → the topic's
   domain document (`docs/NN-*.md`) → the relevant ADR (`docs/adr/`).
3. `_BRIEF.md` is the condensed product requirements the whole package satisfies.

## Contents

- `_BRIEF.md` — condensed, binding product requirements (from the Founder's 86-section spec)
- `_DECISIONS.md` — canonical decision core: stack, topology, data model, events, state machines,
  autonomy matrix, security invariants, ADR index
- `docs/00–35` — 36 architecture documents (domain, org engine, agent runtime, workflow engine,
  events, communication, memory, skills, projects, engineering, marketing, tool gateway, security,
  approvals, database, API, realtime, virtual office, frontend, observability, cost, infrastructure,
  repository, MVP plan, Phase 2/3, testing, failure modes, threat model, handoff)
- `docs/adr/` — 20 Architecture Decision Records + index/process README

## Headline decisions

TypeScript/Node 22 monorepo (pnpm + Turborepo) · Fastify modular-monolith control plane ·
PostgreSQL 16 + pgvector as the only database · Temporal for durable agent execution ·
Postgres transactional outbox → NATS JetStream event backbone · own agent loop (no agent
framework in the core) · Docker sandbox via a dedicated sandbox-manager + git worktrees ·
React 19 + PixiJS 8 digital-twin command center · WebSocket realtime with seq replay ·
`docker compose up` local-first, single-server production first.
