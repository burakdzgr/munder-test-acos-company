# AI AGENT COMPANY OS — Canonical Decision Core

**Status: BINDING.** Every architecture document and ADR must use exactly these names, technologies,
states, and models. If a writer needs something not decided here, they choose it, mark it
`[WRITER-DECISION]` inline, and keep it consistent with this file. Nothing here may be contradicted.

---

## 0. Global assumptions (professional assumptions made on behalf of the Founder)

- A1. Single-operator install initially: the Founder is the only human user in MVP; multi-human
  (co-founders, human employees) is Phase 3. Auth still designed multi-user from the start.
- A2. Self-hosted on Linux x86_64/arm64 with Docker; 8+ cores / 16+ GB RAM recommended baseline.
- A3. Internet access available for LLM APIs by default; fully-offline mode (Ollama-only) is a
  supported degraded profile, not the primary target.
- A4. Currency-agnostic budgets stored in minor units with a per-company currency setting (examples
  may use TRY/USD).
- A5. English is the canonical internal language of agents/docs; company-facing output language is a
  company setting.
- A6. MVP targets software-company use cases (engineering dept); marketing dept lands in Phase 2 but
  its domain model ships in MVP schema.
- A7. Social/ads integrations (Instagram Graph API etc.) are Phase 2; MVP integrations: git, GitHub
  (optional), filesystem, terminal, database inspector, web fetch/search.
- A8. Legal/financial actions are always Founder-approval-gated regardless of autonomy config.
- A9. No GPU assumed; media generation uses external APIs (Phase 2+).
- A10. Licensing/monetization of the platform itself: out of scope for architecture.
- A11. **(Founder decision 2026-08-13)** Single-user mode is the shipped default: there is NO login
  UI — the server transparently mints the Founder session on cookie-less `/api/v1` GETs
  (`AUTH_AUTOLOGIN`, default `true`). The auth substrate itself (sessions, CSRF, PATs, TOTP, audit,
  rate limits) stays fully in place and multi-user capable per A1; `AUTH_AUTOLOGIN=false` restores
  the classic login flow. Founder identity, S6 founder-only approvals and S7 audit attribution are
  unaffected — every request still runs as a real authenticated user with a real session row.

**Founder-clarification items (genuinely business-level, deferred, non-blocking):** target pricing
model for the platform; which social platforms matter first in Phase 2; whether multi-human org
membership should arrive earlier than Phase 3.

---

## 1. Canonical technology stack

| Concern | Choice | Notes |
|---|---|---|
| Language (all backend + frontend) | **TypeScript** (strict), Node.js 22 LTS | One language across domain/core/workers/UI; best LLM SDK ecosystem |
| Monorepo | **pnpm workspaces + Turborepo** | |
| Control-plane HTTP | **Fastify 5** + **Zod** schemas (fastify-type-provider-zod), OpenAPI generated | REST + WebSocket; no GraphQL, no tRPC (external consumers + generated SDK preferred) |
| Database | **PostgreSQL 16** + **pgvector** extension | The ONLY database. Source of truth for all domain state, events, memory, vectors |
| ORM/migrations | **Drizzle ORM + drizzle-kit** | SQL-first, typed, migration files in repo |
| Durable workflows | **Temporal** (self-hosted, docker compose; TypeScript SDK) | Agent runtime, consolidation, intake, pipelines |
| Event distribution | **Postgres transactional outbox** (append-only `events` table = source of truth) → outbox relay → **NATS JetStream** | JetStream gives durable consumers, replay, DLQ; single small binary |
| Cache/locks | Postgres (advisory locks, unlogged tables) | **No Redis in MVP** — deliberately minimal; revisit only under measured load |
| LLM provider abstraction | Own `ModelRouter` port; adapters implemented with **Vercel AI SDK v5** providers (Anthropic, OpenAI, OpenRouter, Ollama/vLLM via OpenAI-compat) | AI SDK is an implementation detail behind our port, replaceable |
| Agent framework | **NONE.** Agent loop is our own Temporal workflow | CrewAI/LangGraph/MetaGPT/OpenHands rejected as core (ADR-004) |
| Sandboxing | **Docker containers** managed by `sandbox-manager` (dockerode), git **worktrees** on per-project volumes, egress via allowlist HTTP proxy | gVisor optional hardening in Phase 3 |
| Frontend | **React 19 + Vite + TanStack Router + TanStack Query + Zustand + Tailwind CSS** | Desktop-like SPA |
| Virtual office renderer | **PixiJS v8** | Phaser rejected (game framework overhead); DOM/Canvas2D rejected (perf) |
| Graphs (org/memory/task) | **Cytoscape.js** (+ dagre/fcose layouts) | |
| Terminal UI | **xterm.js** | |
| Charts | **Recharts** | |
| Realtime transport | **WebSocket** (single gateway endpoint `/ws`) with per-company monotonic sequence + replay from event store | SSE rejected (needs bidirectional subscribe/ack) |
| AuthN | Cookie sessions (HttpOnly, SameSite=Lax), **Argon2id** password hashing, optional TOTP 2FA; PAT tokens for API/CLI | Self-hosted ⇒ no third-party IdP dependency; OIDC optional Phase 3 |
| AuthZ | RBAC (platform roles) + **policy engine** (our own, DB-backed rules) for agent action authorization | OPA rejected (heavy, wrong grain) |
| Secrets | App-level envelope encryption: libsodium sealed boxes, master key from env/OS keyring; secrets table | Vault optional Phase 3 |
| Observability | **pino** structured logs → stdout; **OpenTelemetry** traces/metrics; optional compose profile: otel-collector + Prometheus + Grafana + Loki + Tempo | In-app dashboards read domain data from Postgres |
| Testing | **Vitest** (unit/integration), **Testcontainers** (Postgres/NATS/Temporal), **Playwright** (E2E) | |
| Embeddings | Via ModelRouter: default OpenAI `text-embedding-3-small` (1536d); offline: Ollama `nomic-embed-text` (768d) — dimension stored per-memory-row; one HNSW index per active dimension config | |

Infra containers in `docker compose up`: `postgres`, `nats`, `temporal` (+ its own postgres schema),
`temporal-ui`, `server`, `web`, `agent-worker`, `execution-worker`, `sandbox-manager`,
(optional profile) observability stack.

## 2. Process topology (deployable units)

Modular monolith control plane + specialized workers. NOT microservices (ADR-002).

1. **`apps/server`** — control plane. Fastify modular monolith: all domain modules (org, agents,
   tasks, projects, memory, skills, comms, approvals, policies, costs, events), REST API, WebSocket
   gateway, outbox relay (leader-elected via advisory lock), Tool Gateway *authorization* side.
2. **`apps/web`** — React SPA.
3. **`workers/agent-worker`** — Temporal worker: `agentTaskWorkflow`, delegation workflows, memory
   consolidation workflows, intake workflow, experiment workflows. LLM-calling activities live here.
4. **`workers/execution-worker`** — Temporal worker for sandboxed activities: run commands, git ops,
   tests, builds, browser, media. Talks only to sandbox-manager; no direct Docker access.
5. **`services/sandbox-manager`** — the ONLY process with the Docker socket. Small Fastify service:
   create/destroy workspace containers, exec with PTY, stream output frames to NATS, enforce
   resource limits. Runs privileged; everything else runs unprivileged.

Control plane = 1,2 + Postgres/NATS/Temporal-server. Execution plane = 4,5 + workspace containers.
The agent-worker straddles: it is control-plane logic executing on Temporal (no sandbox access).

## 3. Monorepo layout (canonical)

```
agent-company-os/
├── apps/
│   ├── server/            # control-plane monolith (Fastify)
│   └── web/               # React SPA
├── workers/
│   ├── agent-worker/      # Temporal: agent loop, delegation, memory, intake
│   └── execution-worker/  # Temporal: sandboxed tool activities
├── services/
│   └── sandbox-manager/   # Docker-socket owner, PTY streaming
├── packages/
│   ├── domain/            # PURE domain: entities, value objects, state machines, policies (no IO)
│   ├── db/                # Drizzle schema + migrations + repositories
│   ├── events/            # event catalog: Zod schemas, types, versioning helpers
│   ├── contracts/         # API Zod schemas, OpenAPI gen, typed client SDK
│   ├── llm/               # ModelRouter port + provider adapters + prompt assembly
│   ├── tools/             # tool definitions (schemas, risk classes) shared by gateway & runtime
│   ├── config/            # env parsing (Zod), shared constants
│   └── ui/                # shared React components/design system
├── infrastructure/
│   ├── docker/            # Dockerfiles, compose files, egress-proxy config
│   └── grafana/           # optional observability provisioning
├── docs/                  # this architecture package
└── turbo.json, pnpm-workspace.yaml, .env.example
```

**Dependency rule (enforced by eslint boundaries + CI):**
`domain` depends on nothing internal. `db`, `events`, `tools`, `llm`, `contracts` may depend on
`domain`. Apps/workers/services depend on packages, never on each other. `web` depends only on
`contracts` + `ui`.

## 4. Identity & tenancy

- IDs: **UUIDv7** everywhere (time-ordered). Human-readable numbers where needed
  (`employee_number`, `TASK-81`) are per-company sequences stored alongside.
- Every tenant-owned table has `company_id NOT NULL` FK; all repository methods take a
  `CompanyContext`; a Drizzle wrapper refuses tenant-table queries without company filter.
  Postgres RLS policies added in Phase 3 (defense in depth), app-level enforcement from day one.
- Platform-level tables (users, sessions, model_providers) have no company_id.

## 5. Organization model (graph)

Tables: `companies`, `org_units` (self-referencing, `kind: department|team|office|division`),
`positions` (title, seniority_track, default_role), `agents`,
`org_edges (id, company_id, from_agent_id, to_agent_id, kind, strength, created_at, ended_at)`
with `kind ∈ {reports_to, manages, member_of(unit), leads(unit), mentors, collaborates_with}` —
unit-edges use `to_unit_id` instead of `to_agent_id` (both nullable, CHECK exactly one).
`reports_to` must form a forest per company (cycle check on write, recursive CTE).
Escalation chain = walk `reports_to` upward; Founder is a virtual node (the human), not an agent row.
Relationship strength (`collaborates_with`) is recomputed nightly from communication/review events.

## 6. Agent model

`agents`: id, company_id, employee_number, name, avatar_url, status
(`draft|active|paused|offboarded`), position_id, org_unit_id (primary team), seniority
(`junior|mid|senior|staff|lead|expert`), autonomy_level (0–5), employment JSONB (hired_at etc.),
persona (short professional bio used in prompts), created_at.
`agent_model_bindings`: agent_id, purpose (`primary|fast|embedding`), provider, model, params,
priority — identity NEVER references a model directly anywhere else.
`agent_sessions`: one row per Temporal agent-workflow execution (agent_id, task_id, workflow_id,
status, started_at, tokens, cost) — powers the Agent Monitor.
Runtime presence status (IDLE/THINKING/WORKING/WAITING/COMMUNICATING/REVIEWING/TESTING/LEARNING/
BLOCKED/ESCALATING/OFFLINE) is **derived state** published via events, persisted only in
`agent_sessions.current_activity` — not on the agents row.

## 7. Task engine

Hierarchy via `kind ∈ {goal, initiative, epic, task, subtask}` + `parent_id` on one `tasks` table.
`task_dependencies (task_id, depends_on_task_id, kind=blocks)` — DAG, cycle-checked.
Key columns: company_id, project_id, number (per-company seq), kind, title, objective, context JSONB,
creator_agent_id (nullable → Founder), owner_agent_id, org_unit_id, priority (P0–P3), status,
success_criteria (text[]), risk (`low|medium|high|critical`), budget_cents, deadline,
approval_policy_id, result JSONB, created_at.

**Task state machine (canonical):**
`DRAFT → BACKLOG → PLANNED → ASSIGNED → IN_PROGRESS → {WAITING, BLOCKED} → IN_PROGRESS
IN_PROGRESS → REVIEW → {CHANGES_REQUESTED → IN_PROGRESS, QA} → {QA_FAILED → IN_PROGRESS, APPROVAL|DONE}
APPROVAL → {DONE, REJECTED → IN_PROGRESS}` ; terminal: `DONE, FAILED, CANCELLED`.
Transition permissions: owner may move IN_PROGRESS→REVIEW; only a *different* agent with reviewer
capability may REVIEW→{CHANGES_REQUESTED,QA}; only manager-or-above may CANCELLED/FAILED/PLANNED→ASSIGNED;
APPROVAL transitions only via Approval Engine. All transitions emit `task.status.changed`.

**Delegation limits:** max delegation depth 5 (goal→subtask), max reassignments per task 3, then
forced manager intervention; per-task token/cost budget inherited pro-rata from parent.

**Manager self-assignment is legitimate** (Founder decision 2026-08-20, ADR-022): a manager may keep
a slice of the work it just decomposed instead of delegating every child. The Scheduler stays the
deterministic owner of assignment (INV-10) — the manager simply joins its own candidate pool under
the same scoring, and an explicit self-choice (`delegate_task.toAgentId = SELF_SENTINEL_UUID`) still
passes the reporting-line rule (07 §6 already permits self-assignment of one's own subtask) and the
capacity model. Self-taken work counts against the manager's OWN WIP cap, and a manager with no
active direct report is not its own candidate — an empty pool still means "staff the team first".

## 8. Agent runtime (the heart)

- One **Temporal workflow per active task assignment**: `agentTaskWorkflow(agentId, taskId)`.
  Long-lived agents are NOT one eternal workflow; idle agents have no running workflow (scales to
  100s of mostly-idle agents). "The employee" exists in Postgres; workflows are their working hours.
- Loop per step: build **Working Set** (activity: task context + retrieved memories + recent
  channel messages + role/persona + org context + tool list) → LLM call (activity, with model
  routing) → parse **AgentAction** (strict Zod union) → execute action (activity) → append step to
  `agent_steps` → check guards (budget, deadline, loop detector) → continue / wait / finish.
- **AgentAction union:** `use_tool`, `send_message`, `create_task`, `delegate_task`,
  `request_review`, `request_help`, `escalate`, `update_task_status`, `record_decision`,
  `complete_task`, `wait_for` (dependency/reply/timer), `abandon`.
- Signals into the workflow: `messageReceived`, `dependencyResolved`, `reviewVerdict`,
  `approvalVerdict`, `managerDirective`, `cancel`.
- Durability: activities idempotent (idempotency keys), `continueAsNew` after 50 steps or 5k events;
  heartbeats on long activities; Temporal retries with backoff; workflow survives every crash class
  listed in the brief.
- **Runaway protection:** per-step guard checks (a) task budget remaining, (b) wall-clock deadline,
  (c) step count vs cap, (d) loop detector — hash of (action type + normalized args) repeated ≥3 in
  last 6 steps → force `request_help` to manager; (e) message ping-pong detector — >8 alternating
  messages between same pair on same thread without a task-state change → manager notification;
  (f) delegation depth check. Company-level daily spend circuit breaker pauses non-critical agents.

## 9. Events

- Append-only `events` table: id (uuidv7), company_id, seq (per-company BIGINT, gap-free via
  per-company sequence row locked in tx), type, version, occurred_at, actor
  (`{kind: agent|founder|system, id}`), subject refs (task_id, project_id, agent_id nullable),
  correlation_id, causation_id, payload JSONB. Written **in the same transaction** as the state
  change (transactional outbox). Relay publishes to NATS JetStream subject
  `co.<company_id>.<type>` after commit; `published_at` marks completion.
- Naming: `domain.entity.action`, past tense, e.g. `task.status.changed`, `agent.hired`,
  `agent.message.sent`, `memory.created`, `approval.requested`, `workspace.terminal.output`
  (terminal frames go ONLY to NATS ephemeral subjects + rolling files, never the events table).
- Versioning: `version` int; schemas in `packages/events` as Zod; additive changes preferred;
  breaking change ⇒ new version, consumers declare handled versions.
- Consumers are idempotent (dedupe on event id); JetStream DLQ after max deliveries → `dead_events`
  table + alert. Event catalog (~70 events) is enumerated in doc 10; the list in the brief is the
  minimum set and all names there are canonical.

## 10. Memory architecture

- `memories`: id, company_id, scope (`company|project|agent`), scope_ref (project_id/agent_id),
  type (`semantic|episodic|procedural|decision|failure|experiment|relationship|artifact`),
  title, content (markdown), summary, entities JSONB, importance (0–1), confidence (0–1),
  status (`candidate|active|superseded|archived|rejected`), source_event_id, created_by_agent_id,
  last_verified_at, expires_at, retrieval_count, embedding vector, embedding_model, created_at.
- `memory_versions` (full history), `memory_evidence` (memory_id, kind
  (`event|artifact|review|metric|statement`), ref, weight),
  `memory_relations` (from, to, kind: `supports|contradicts|supersedes|derived_from|related_to`).
- **Consolidation:** every N significant events or task completion triggers
  `memoryConsolidationWorkflow` (Temporal): extract candidates (LLM) → score importance → detect
  scope → embed → similarity search (pgvector cosine, top-k within scope) → merge/dedupe or
  contradiction-flag (LLM compare) → persist with status. Candidates below importance threshold are
  discarded. Contradictions create `memory_relations(kind=contradicts)` + surface in Observatory.
- **Promotion:** promotion rules table; e.g. failure memory with ≥3 supporting evidence rows across
  ≥2 distinct tasks → propose project-scope copy (status=candidate, approved by owning lead agent);
  project→company requires ≥2 projects + manager-agent approval. Originals link via
  `derived_from`. A single event can never directly create company-scope memory.
- **Retrieval:** Working-Set builder queries: (1) structured (recent decisions/ADRs for project,
  procedures for role) via SQL, (2) semantic top-k per scope with recency+importance re-ranking
  (score = 0.55·cosine + 0.2·importance + 0.15·recency_decay + 0.1·confidence), capped token budget
  per scope (agent 1.5k, project 2.5k, company 1k tokens by default).

## 11. Skills & learning

`skills` (company-scoped taxonomy, name, category), `agent_skills` (agent_id, skill_id, level 1–5,
confidence, last_used_at, evidence_count), `skill_evidence` (agent_skill_id, kind
(`task_success|review_accepted|production_result|peer_eval|manager_eval|experiment|failure|
failure_resolved`), weight ∈ [-1,1], ref (task/review/event id), note, created_at).
Level recomputed by deterministic rule (not LLM): weighted evidence sum with time decay; level-up
also requires a manager-agent `promotion_review` artifact for senior+ levels. Career/seniority
changes are proposed by manager agents via `agent.promotion.recommended` → Founder approval only
for lead+ (configurable).

## 12. Tool Gateway & permissions

- Tools defined in `packages/tools`: name, description, Zod input/output schema, risk class
  (`R0 read` / `R1 reversible write` / `R2 costly or hard-to-reverse` / `R3 irreversible or
  external-world` ), scopes it touches (fs, git, network, db, money, publish), cost estimator.
- Execution path: agent-worker activity → **Tool Gateway service module** (in `apps/server`,
  invoked via internal HTTP): validates agent identity → permission grant (`tool_permissions`:
  agent/position/unit scoped grants with constraints JSONB e.g. path prefixes, repo list, spend cap)
  → policy engine (autonomy × risk × reversibility × cost × budget remaining) → decision
  `allow | deny | require_approval` → audit row (`tool_invocations`) → dispatch: R0/R1 fs/git/
  terminal tools route to sandbox-manager; network tools route through egress allowlist; money/
  publish tools route to integration adapters. Result + cost recorded.
- **Autonomy decision matrix (canonical):** allow if
  `risk ≤ maxRisk(autonomy_level)` AND `est_cost ≤ remaining budget` AND no policy rule denies AND
  (risk=R3 ⇒ always require_approval unless explicit standing policy grant).
  `maxRisk: L0→none (observe), L1→propose only, L2→R1, L3→R1(+R2 within own team scope),
  L4→R2 department-wide, L5→R2 company-wide + limited R3 within pre-approved budget lines`.
  Founder-only categories (payments, legal, credentials, destructive prod) are ALWAYS
  `require_approval` regardless of level (hard-coded platform policy, not tenant-editable).

## 13. Sandboxing & git

- Per-project bare repo at `/data/repos/<project_id>.git` (server-side origin). Sandbox-manager
  creates **workspace containers** per coding task: image `acos/workspace-node`, `acos/workspace-php`
  etc.; mounts a task-specific **git worktree volume** cloned from the bare repo, branch
  `task/<task-number>-<slug>`.
- Isolation levels: `analysis` (ro mount, no network), `coding` (rw worktree, egress proxy
  allowlist: package registries only), `testing` (same + service containers), `deploy` (Phase 3),
  `browser` (Phase 2, separate image), `media` (Phase 2). CPU/mem/pids/disk limits per level.
- Merge strategy: task branch → PR entity (`reviews` table) → independent reviewer agent →
  QA gate → merge by lead agent via fast-forward/squash into `main` in the bare repo; conflicts →
  rebase task in owner's workspace; file-level soft locks (`workspace_locks`) warn (not block)
  parallel tasks touching same paths.
- Import intake: Founder provides path/URL → copied into bare repo → `projectIntakeWorkflow` runs
  analysis containers (`analysis` level) producing the Intake Report artifact + routing tasks.

## 14. Communication

`channels` (kind: `dm|team|department|project|task_thread|review|escalation`),
`channel_members`, `messages` (channel_id, sender_agent_id nullable→Founder, kind
(`text|help_request|review_request|escalation|status|system`), body, refs JSONB, created_at).
Messages persist independently; delivering a message to an active agent = Temporal signal; to an
idle agent = starts/wakes a lightweight `agentInboxWorkflow` that decides (LLM, cheap model) whether
to act, queue, or ignore. Every message emits `agent.message.sent` (drives office animation).

## 15. Approvals

`approvals`: id, company_id, kind, title, request_md (structured brief fields), requested_by,
chain JSONB (executive endorsements), status (`pending|approved|rejected|needs_review|expired`),
risk, cost_cents, urgency, deadline, decided_by, decided_at, decision_note.
Approval Engine exposes generic workflow: requester → (optional) executive endorsement chain →
Founder inbox → verdict signals back into waiting workflows. UI = Approval Center.

## 16. Realtime protocol

WS endpoint `/ws`; client authenticates via session cookie; subscribes:
`{op:"subscribe", topics:["events:<companyId>", "terminal:<sessionId>", "presence:<companyId>"]}`.
Server streams `{topic, seq, events:[...]}`; client tracks last seq per topic; on reconnect sends
`{op:"resume", topic, after_seq}` → server replays from events table (events topic) or rolling
buffer (terminal). Presence/office positions are derived server-side (Office Projector module maps
domain events → office instructions: `office.avatar.moved`, `office.interaction.started`…) so the
renderer stays dumb. Terminal frames: NATS ephemeral + 64KB ring buffer + append to
`/data/terminals/<session_id>.log` (retention 7 days default).

## 17. LLM routing

`model_providers` (platform-level, encrypted keys), `model_profiles` (company-level: purpose →
provider+model+params+cost caps): purposes `reasoning`, `coding`, `fast`, `embedding`, `vision`.
Router resolves: task risk/type → required purpose → agent binding override → company profile →
fallback chain (on 429/5xx: next provider) with per-call token cap. Every call logged to
`llm_calls` (tokens, cost, latency, purpose, agent, task, cached).

## 18. Costs

`cost_entries`: company_id, kind (`llm|tool|compute|media|api`), ref, agent_id, task_id, project_id,
org_unit_id, amount_cents, quantity, occurred_at. Rollup materialized views per day×dimension.
`budgets`: scope (company/unit/project/task/agent), period, limit_cents, hard/soft. Hard breach →
circuit breaker event `budget.exceeded` → policy pauses affected agents.

## 19. State machines (canonical enumerations)

- **Agent:** draft → active ⇄ paused → offboarded.
- **Agent session (workflow run):** starting → running ⇄ waiting → {completed, failed, cancelled}.
- **Task:** see §7.
- **Project:** proposed → intake → active ⇄ paused → {completed, archived, cancelled}.
- **Approval:** pending → {approved, rejected, needs_review → pending, expired}.
- **Workspace:** provisioning → ready → in_use ⇄ idle → {merged, discarded, failed} → destroyed.
- **Experiment:** designed → baseline → running → analyzing → {adopted, rejected, inconclusive}.
- **Memory:** candidate → active → {superseded, archived, rejected}.

## 20. Security invariants (never violate)

S1. Only sandbox-manager touches the Docker socket. S2. Agents never receive raw secrets — tools
inject credentials server-side. S3. All tool executions pass the Gateway (no bypass path exists in
code). S4. Tenant isolation enforced at repository layer (+RLS Phase 3). S5. All external content
(repos, web pages, analytics) is untrusted: wrapped with provenance markers in prompts,
instruction-following from it is policy-flagged (prompt-injection defense), risky tool calls
triggered directly by external content require elevated review. S6. Founder-only action categories
are platform-hard-coded. S7. Full audit log (`audit_log` table) for auth, permission changes,
approvals, tool invocations R2+. S8. Workspace containers: no docker socket, no host mounts beyond
their volume, dropped capabilities, egress allowlist.

## 21. Naming conventions

snake_case DB, camelCase TS, PascalCase types/components, kebab-case files/packages, events
`domain.entity.action` (past tense), Temporal workflows `<thing>Workflow`, activities
`<verb><Thing>Activity`, NATS subjects `co.<companyId>.<eventType>`. Docs cross-reference by
filename (e.g. "see 12-MEMORY-ARCHITECTURE.md §4"). ADR references: ADR-001…ADR-020.

## 22. ADR index (canonical decisions + rejected alternatives)

| ADR | Decision | Rejected (why, one line) |
|---|---|---|
| 001 Repository strategy | pnpm+Turborepo monorepo, layout §3 | polyrepo (coordination cost), Nx (heavier) |
| 002 Core backend stack | TypeScript/Node22, Fastify modular monolith | Go (velocity, shared types), NestJS (ceremony), microservices (scale unjustified) |
| 003 Database | PostgreSQL16+pgvector only | Mongo (relational domain), separate vector DB (ops cost), Neo4j (edges fit relational at this scale) |
| 004 Agent orchestration | Own agent loop on Temporal; NO agent framework in core | CrewAI/MetaGPT (own the orchestration = source-of-truth violation), LangGraph (checkpointing weaker than Temporal, TS support secondary), OpenHands (coding-only scope) |
| 005 Durable workflows | Temporal self-hosted | custom Postgres state machine (reinvention, months of work), BullMQ (queues ≠ durable workflows), n8n (visual automation, wrong grain) |
| 006 Event bus | Outbox in Postgres + NATS JetStream | Kafka (ops weight), RabbitMQ (no replay), Redis Streams (adds Redis; weaker durability semantics), LISTEN/NOTIFY alone (no durable consumers) |
| 007 Memory storage | Postgres relational + pgvector hybrid, consolidation via Temporal | pure vector store (loses structure), graph DB (unjustified), Zep/Mem0 (source-of-truth violation) |
| 008 Realtime transport | WebSocket + seq replay | SSE (unidirectional), polling (latency), per-feature sockets (complexity) |
| 009 Coding sandbox | Docker containers via sandbox-manager, level matrix §13 | Firecracker/gVisor default (ops weight; optional Phase 3), host exec (unsafe), WebContainers (server-side unfit) |
| 010 Git workspace strategy | Server-side bare repo + per-task worktree volumes + PR-entity review flow | shared working dir (conflicts), full clone per task (disk/time), GitHub-only (must work offline/local) |
| 011 Frontend framework | React19+Vite+TanStack | Next.js (SSR pointless for self-hosted SPA), Svelte/Solid (ecosystem for Pixi/xterm/cytoscape integrations) |
| 012 Virtual office renderer | PixiJS v8 | Phaser (physics/scene overhead), raw canvas (too low-level), Three.js (3D unneeded) |
| 013 Authentication | Local sessions+Argon2id+TOTP, PATs | OIDC-required (self-host friction; optional later), JWT-stateless (revocation) |
| 014 Authorization | RBAC + custom DB-backed policy engine + autonomy matrix | OPA/Rego (heavy), Casbin (insufficient expressiveness for cost/budget context), pure ACL (no risk dimension) |
| 015 LLM provider abstraction | Own ModelRouter port; Vercel AI SDK adapters | LangChain (abstraction leakage), LiteLLM proxy (extra service; fine as optional gateway), direct SDKs only (N× integration work) |
| 016 Observability | pino+OTel, optional Grafana stack profile; domain metrics in Postgres | full ELK (weight), SaaS-only APM (self-hosted requirement) |
| 017 External integrations | Adapter pattern in integration module; MCP-compatible tool adapters where useful | n8n embed (extra platform), Zapier (cloud) |
| 018 Deployment | docker compose single server → multi-VM compose (workers scale-out) → K8s only if fleet demands | K8s-first (MVP overkill), systemd bare metal (isolation loss) |
| 019 ORM & migrations | Drizzle | Prisma (query engine binary, weaker SQL control), Knex (untyped) |
| 020 Embeddings strategy | Per-row model+dimension, HNSW indexes, config per company | single fixed model (offline mode impossible), no vectors (semantic retrieval required) |
| 021 Memory graph renderer | R3F/three.js 3D "galaxy" default, existing 2D cytoscape graph as the WebGL-unavailable fallback | cytoscape-only (the graph is the product's signature view), 3D-only (no fallback without WebGL) |
| 022 Manager self-assignment | A manager may keep a slice of its own decomposition: self-sentinel + manager in its own candidate pool under the same scoring; counts against its own WIP cap; Scheduler determinism (07 §5/§6) preserved; INV-14 NOT relaxed | prompt-only (unreachable: manager was never in the candidate pool), a separate `take_task` verb (duplicate capacity/permission/audit paths), no capacity accounting (invites work hoarding) |
| 023 Agent turn = live Claude Code CLI session | CLI process per turn in the workspace, PTY-attached; Tool Gateway exposed as MCP so the control plane sits ON TOP; identity BROKERED (no token in container, INV-2); company-scoped session cap. **Amends ADR-004 / INV-20 and narrows INV-3 for CLI agents**: the sandbox is the boundary, so CLI built-in fs/shell do NOT produce `tool_invocations` rows; org actions stay gateway-audited via MCP and audit/cost move to session level | mount the subscription token into the container (violates INV-2), run the CLI on the host with the worktree mounted (loses sandbox isolation S1/S8), restyle the step feed to look like a terminal (cosmetic, not the ask) |

## 23. MVP boundary (what is NOT built in MVP)

Phase 2: marketing org activation, social integrations, media pipeline, browser sandbox, experiment
engine UI, asset library, product-analytics ingestion. Phase 3: multi-human users/OIDC, RLS,
gVisor, distributed deployment, deploy-level sandbox, marketplace of tool adapters, cross-company
platform admin. MVP includes ALL schema for these where cheap (tables exist, features dark).
