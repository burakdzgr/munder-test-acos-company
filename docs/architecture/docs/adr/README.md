# Architecture Decision Records — AI AGENT COMPANY OS

This directory contains the binding Architecture Decision Records (ADRs) for the platform. They
are written against the requirements in `_BRIEF.md` and the canonical decision core in
`_DECISIONS.md` (which wins on any naming/technology conflict). Cross-references use filenames
per the convention in `_DECISIONS.md` §21.

## Index

| ADR | Title | Status | Decision (one line) |
|---|---|---|---|
| [ADR-001](ADR-001-repository-strategy.md) | Repository strategy | Accepted | Single monorepo with pnpm workspaces + Turborepo; dependency rule enforced by eslint boundaries in CI |
| [ADR-002](ADR-002-core-backend-stack.md) | Core backend stack | Accepted | TypeScript/Node 22 everywhere; Fastify 5 modular monolith control plane with Zod-first contracts |
| [ADR-003](ADR-003-database.md) | Database | Accepted | PostgreSQL 16 + pgvector as the only database — domain state, events, memory, vectors, cache/locks |
| [ADR-004](ADR-004-agent-orchestration.md) | Agent orchestration | Accepted | Own agent loop as Temporal workflow `agentTaskWorkflow`; no third-party agent framework in core |
| [ADR-005](ADR-005-durable-workflows.md) | Durable workflows | Accepted | Self-hosted Temporal; workflows orchestrate, all IO in idempotent activities, Postgres stays source of truth |
| [ADR-006](ADR-006-event-bus.md) | Event bus | Accepted | Postgres transactional outbox as event source of truth; NATS JetStream for distribution only |
| [ADR-007](ADR-007-memory-storage.md) | Memory storage | Accepted | Postgres relational + pgvector hybrid; consolidation/promotion as Temporal workflows |
| [ADR-008](ADR-008-realtime-transport.md) | Realtime transport | Accepted | Single WebSocket gateway `/ws` with topic multiplexing and per-company sequence replay |
| [ADR-009](ADR-009-coding-sandbox.md) | Coding sandbox | Accepted | Docker workspace containers via sandbox-manager (sole Docker-socket owner) with isolation-level matrix |
| [ADR-010](ADR-010-git-workspace-strategy.md) | Git workspace strategy | Accepted | Server-side bare repo per project + per-task worktree volumes + domain-native PR-entity review flow |
| [ADR-011](ADR-011-frontend-framework.md) | Frontend framework | Accepted | React 19 + Vite SPA with TanStack Router/Query, Zustand, Tailwind; static-file deployment |
| [ADR-012](ADR-012-virtual-office-renderer.md) | Virtual office renderer | Accepted | PixiJS v8 as a dumb projection of server-derived office instructions; no fake animation |
| [ADR-013](ADR-013-authentication.md) | Authentication | Accepted | Local accounts, HttpOnly cookie sessions, Argon2id, optional TOTP, PATs; OIDC optional in Phase 3 |
| [ADR-014](ADR-014-authorization-model.md) | Authorization model | Accepted | Platform RBAC + own DB-backed policy engine + canonical autonomy×risk matrix in the Tool Gateway |
| [ADR-015](ADR-015-llm-provider-abstraction.md) | LLM provider abstraction | Accepted | Own ModelRouter port; Vercel AI SDK v5 strictly inside replaceable provider adapters |
| [ADR-016](ADR-016-observability.md) | Observability | Accepted | pino + OpenTelemetry instrumentation always on; optional Grafana-stack compose profile; domain metrics from Postgres |
| [ADR-017](ADR-017-external-integrations.md) | External integrations | Accepted | Adapter pattern in one integration module behind the Tool Gateway; MCP-compatible tool adapters with curated risk metadata |
| [ADR-018](ADR-018-deployment-architecture.md) | Deployment architecture | Accepted | Docker Compose single server → multi-VM compose worker scale-out → K8s only if fleet demands |
| [ADR-019](ADR-019-orm-and-migrations.md) | ORM & migrations | Accepted | Drizzle ORM + drizzle-kit; SQL-first typed repositories with tenant guard; plain SQL migrations in repo |
| [ADR-020](ADR-020-embeddings-strategy.md) | Embeddings strategy | Accepted | Per-row embedding model + dimension, HNSW index per active config, per-company embedding configuration |
| [ADR-021](ADR-021-memory-graph-renderer.md) | Memory graph renderer | Accepted | 3D R3F/three.js "galaxy" as the default memory graph; 2D cytoscape kept as the WebGL fallback |
| [ADR-022](ADR-022-manager-self-assignment.md) | Manager self-assignment | Accepted | A manager may keep a slice of its own decomposition; Scheduler still owns assignment (INV-10), self counts against the manager's own WIP cap |
| [ADR-023](ADR-023-agent-turn-as-cli-session.md) | Agent turn = live Claude Code CLI session | Accepted | CLI process per turn, PTY-attached; Tool Gateway exposed as MCP so the control plane sits on top; brokered identity (no token in container, INV-2); company-scoped session cap. Amends ADR-004/INV-20; CLI built-ins must not bypass the Gateway (INV-3) |

## ADR process

### When a new ADR is required

Write an ADR (next free number, `ADR-NNN-<kebab-title>.md`) whenever a decision is:

- **architecturally significant** — it constrains the structure, technology, data ownership,
  security invariants, or cross-cutting behavior of the system (new datastore, new deployable
  unit, new external dependency in the agent/tool path, change to the event or tenancy model);
- **expensive to reverse** — reversing it would touch multiple packages, require data migration,
  or change operator-facing deployment; or
- **a deliberate exception** — it violates a rule in `_DECISIONS.md` or an existing ADR (in
  which case it must supersede, never silently contradict).

Small, local, reversible choices do not get ADRs; mark them `[WRITER-DECISION]` in the relevant
design doc per `_DECISIONS.md` §0. A revisit trigger firing (each ADR lists measurable ones) does
not itself change anything — it obliges the team to re-evaluate and either record "trigger
reviewed, decision stands" in the ADR's history or write a superseding ADR.

### Statuses

- **Proposed** — under review; not yet binding; implementation must not depend on it.
- **Accepted** — binding for all implementation work.
- **Deprecated** — no longer recommended for new work, but not replaced by a specific ADR;
  existing usage may remain.
- **Superseded by ADR-NNN** — replaced; kept for history with a forward link.

Only Accepted ADRs bind implementation. Status changes are commits that edit the `Status:` line
and this index.

### Supersede rules

1. ADRs are **immutable once Accepted** except for: status-line changes, adding revisit-history
   notes, and fixing typos/links. Decisions are never edited in place.
2. To change a decision, write a **new ADR** that states the new decision, explains what changed
   since the original (which forces or triggers), and lists the migration consequences. Mark the
   old ADR `Superseded by ADR-NNN` with a link; the new ADR links back.
3. A superseding ADR must address every consequence and revisit trigger of the ADR it replaces —
   partial supersession (one aspect only) must say explicitly which parts of the old ADR remain
   in force.
4. Numbers are never reused. ADR-001 through ADR-020 form the founding set and match
   `_DECISIONS.md` §22; changes to any of them must also be reflected in `_DECISIONS.md` to keep
   the decision core canonical.
