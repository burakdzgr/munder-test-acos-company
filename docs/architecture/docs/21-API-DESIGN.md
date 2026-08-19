# 21-API-DESIGN.md — API Architecture & Endpoint Catalog

Status: v1.0 — Implementation-ready

Defines every external and internal API surface of the control plane. Schemas live as Zod in
`packages/contracts` (single source; OpenAPI + typed SDK generated from it). Persistence contracts
in 20-DATABASE-DESIGN.md; event names in 10-EVENT-ARCHITECTURE.md; WS details shared with
22-REALTIME-ARCHITECTURE.md; internal auth invariants in 18-PERMISSIONS-AND-SECURITY.md.

---

## 1. Style decision recap (boundary → protocol)

Per _DECISIONS §1: REST (Fastify 5 + fastify-type-provider-zod, OpenAPI generated) for CRUD and
queries; WebSocket for realtime; Temporal signals and NATS strictly internal. No GraphQL, no tRPC.

| Boundary | Protocol | Why |
|---|---|---|
| Web SPA / CLI / external consumers → server (CRUD, queries, commands) | REST `/api/v1` + Zod + OpenAPI | Generated typed SDK; external-consumer friendly (ADR-002) |
| Web SPA → server (live events, presence, terminals) | WebSocket `/ws`, seq replay | Bidirectional subscribe/resume (ADR-008) |
| server / agent-worker → running workflows (verdicts, messages, cancel) | Temporal signals | Durable delivery into workflow state (_DECISIONS §8) |
| server → workers / projections (event fan-out) | NATS JetStream `co.<companyId>.<type>` | Durable consumers, replay, DLQ (ADR-006) |
| agent-worker → server (tool authorization + dispatch) | Internal HTTP `/internal/v1/tool-gateway` | Single audited chokepoint (invariant S3) |
| execution-worker → sandbox-manager (workspaces, exec, PTY) | Internal HTTP `/internal/v1/*` on sandbox-manager | Only Docker-socket owner (invariant S1) |
| sandbox-manager → UI (terminal frames) | NATS ephemeral → WS gateway | Never through REST or events table (_DECISIONS §9) |

Agents NEVER call the public REST API — agent actions execute through domain services inside
apps/server and workers. REST is the human/SDK surface.

---

## 2. Conventions

### 2.1 Base, content types, IDs
- Base path `/api/v1`. JSON only (`application/json`); errors `application/problem+json`.
- All IDs are UUIDv7 strings. Human numbers (`TASK-81`, `#12`) appear as `number` fields alongside
  ids, never as path params.
- Timestamps: RFC3339 UTC. Money: integer minor units + `currency` from company settings.
- Field names camelCase on the wire (mapped from snake_case columns by `packages/contracts`).

### 2.2 Authentication
- **Session cookie** `acos_session` (HttpOnly, SameSite=Lax) — set by `POST /auth/login`; or
- **PAT bearer**: `Authorization: Bearer acos_pat_<token>`. PAT scopes (stored in
  `personal_access_tokens.scopes`) use `<action>:<module>` grammar: `read:*`, `write:tasks`,
  `write:approvals`, `admin:providers` … Scope required per endpoint is listed in the catalog
  (`perm` column); session users pass scope checks implicitly and are checked against
  `platform_role` + company membership role instead.
- 401 = unauthenticated; 403 = authenticated but forbidden (includes tenant mismatch).

### 2.3 Company scoping
- Every company-scoped request carries `X-Company-Id: <uuid>`. The server validates it against
  `company_members` (role ≥ viewer) before any handler runs; the resolved `CompanyContext` is the
  ONLY way repositories accept queries (20-DATABASE-DESIGN.md §1.1).
- Platform-level routes (`/auth/*`, `/companies` list/create, `/providers`) ignore the header.
- Mismatch (resource exists but in another company) returns 404, never 403 — no existence leaks.

### 2.4 Pagination, filtering, sorting
- **Cursor pagination** everywhere: `?limit=50&cursor=<opaque>`. Cursor = base64url of
  `(sortKey, id)`; response envelope `{ items: [...], nextCursor: string|null }`. Max limit 200.
- Filters are documented query params per endpoint; repeated params = OR within a field
  (`status=REVIEW&status=QA`), distinct fields AND. Time ranges: `from`/`to` (RFC3339).
- Sorting: `?sort=-createdAt` (default per endpoint, `-` = desc). Only indexed sorts are exposed.

### 2.5 Error envelope (RFC7807 problem+json)
```json
{
  "type": "https://acos.dev/errors/task_transition_invalid",
  "title": "Invalid task transition",
  "status": 409,
  "code": "task_transition_invalid",
  "detail": "REVIEW -> DONE is not a legal transition; allowed: CHANGES_REQUESTED, QA",
  "instance": "/api/v1/tasks/0198a7…/transitions",
  "requestId": "0198a7f1-…",
  "errors": [{ "path": "to", "message": "…" }]
}
```
`errors[]` present only for `validation_failed` (Zod issues). **Code catalog** (stable, exhaustive
list maintained in `packages/contracts/src/errors.ts`): `validation_failed` 400,
`unauthenticated` 401, `forbidden` 403, `not_found` 404, `conflict` 409,
`task_transition_invalid` 409, `org_cycle_detected` 409, `dependency_cycle_detected` 409,
`idempotency_conflict` 409, `approval_required` 409, `state_precondition_failed` 412,
`payload_too_large` 413, `rate_limited` 429 (+`Retry-After`), `budget_exceeded` 402,
`provider_unavailable` 503, `internal` 500.

### 2.6 Idempotency
All mutating POSTs accept `Idempotency-Key: <uuid>` (required for `hire`, `transitions`,
`verdict`, `import`; recommended elsewhere). Server stores `(companyId, key, endpoint,
requestHash)` in `idempotency_keys` (20-DATABASE-DESIGN.md §2.7): replay with same hash → cached
response + `Idempotency-Replayed: true`; same key, different hash → 409 `idempotency_conflict`.
TTL 24h. PATCH/PUT/DELETE are naturally idempotent by design.

### 2.7 Rate limits
Token bucket per principal per route class, backed by the unlogged `rate_limits` table:
default 600 req/min (reads), 120 req/min (writes), 20 req/min (`memory/search`, `events` replay,
report queries). Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; 429 body
uses code `rate_limited`.

---

## 3. Endpoint catalog

Legend — **perm**: `F` = founder/admin member of company (session), `V` = viewer allowed,
`P:<scope>` = PAT scope, `A` = platform admin (`users.platform_role in (owner,admin)`).
**events**: emitted on success (10-EVENT-ARCHITECTURE.md). Request/response shapes name the
`packages/contracts` types; field lists are given where non-obvious. All list endpoints return the
`{items, nextCursor}` envelope.

### 3.1 Auth (platform)

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| POST `/auth/login` | `{email, password, totpCode?}` → `{user: User}` + session cookie | public | — (audit_log) |
| POST `/auth/logout` | — → 204, clears cookie | any | — (audit) |
| GET `/auth/me` | → `{user: User, companies: [{id, name, slug, role}]}` | any | — |
| POST `/auth/totp/setup` | — → `{otpauthUrl, secret}` (pending until verify) | session only | — (audit) |
| POST `/auth/totp/verify` | `{code}` → 204 (enables 2FA) | session only | — (audit) |
| GET `/auth/pats` | → list of `Pat {id, name, tokenPrefix, scopes, expiresAt, lastUsedAt}` | session only | — |
| POST `/auth/pats` | `{name, scopes, expiresAt?}` → `Pat & {token}` (token shown once) | session only | — (audit) |
| DELETE `/auth/pats/:id` | → 204 (revoke) | session only | — (audit) |

`User = {id, email, displayName, platformRole, totpEnabled, createdAt}`.

### 3.2 Companies (platform + scoped)

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/companies` | → list `Company` (membership-filtered) | any | — |
| POST `/companies` | `{name, slug, currency}` → `Company` (creator becomes founder member; default settings row created) | A | company.created, company.member.added |
| GET `/companies/current` | → `Company & {settings: CompanySettings}` (via X-Company-Id) | V | — |
| PATCH `/companies/current` | partial `{name, status}` → `Company` | F | company.archived (if status) |
| GET `/companies/current/settings` | → `CompanySettings` (all typed fields of company_settings) | V | — |
| PATCH `/companies/current/settings` | partial `CompanySettings` → same | F | company.settings.updated |

### 3.3 Organization

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/org/units` | filters `kind, parentId, includeArchived` → list `OrgUnit` | V | — |
| POST `/org/units` | `{parentId?, kind, name, slug}` → `OrgUnit` | F / P:write:org | org.unit.created |
| PATCH `/org/units/:id` | partial → `OrgUnit`; `{archived: true}` archives | F | org.unit.updated/archived |
| GET `/org/positions` · POST · PATCH `/:id` | `Position {title, seniorityTrack, defaultRole, description}` | V read / F write | position.created / position.updated |
| GET `/org/edges` | filters `kind, fromAgentId, toAgentId, toUnitId, active` → list `OrgEdge` | V | — |
| POST `/org/edges` | `{fromAgentId, toAgentId?\|toUnitId?, kind}` → `OrgEdge`; 409 `org_cycle_detected` on reports_to cycles | F / P:write:org | org.edge.created |
| DELETE `/org/edges/:id` | → 204 (sets endedAt — history preserved) | F | org.edge.ended |
| GET `/org/chart` | `?kinds=reports_to,member_of` → `{nodes: [{agentId\|unitId, label, kind, …}], edges: [...]}` computed graph for Cytoscape | V | — |
| GET `/org/escalation-chain/:agentId` | → `{chain: [AgentRef…]}` reports_to walk, Founder virtual node last | V | — |

### 3.4 Agents

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/agents` | filters `status, orgUnitId, positionId, seniority, q` → list `Agent` | V | — |
| POST `/agents` | `CreateAgent {name, positionId, orgUnitId, seniority, autonomyLevel, persona, avatarUrl?}` → `Agent` (status=draft, employeeNumber assigned) | F / P:write:agents | agent.created |
| GET `/agents/:id` | → `Agent & {modelBindings, activeSession?: AgentSessionSummary, skills: AgentSkillSummary[]}` | V | — |
| PATCH `/agents/:id` | partial (name, persona, avatar, autonomyLevel, positionId, orgUnitId, seniority) → `Agent` | F | agent.updated |
| POST `/agents/:id/hire` | `{reportsToAgentId?, memberOfUnitId?}` → `Agent` (draft→active; creates org_edges; Idempotency-Key required) | F | agent.hired, org.edge.created |
| POST `/agents/:id/pause` | `{reason?}` → `Agent` (cancels/parks sessions gracefully) | F | agent.paused |
| POST `/agents/:id/resume` | → `Agent` | F | agent.resumed |
| POST `/agents/:id/offboard` | `{reason}` → `Agent` (ends org_edges, reassigns open tasks to manager) | F | agent.offboarded, task.reassigned* |
| GET `/agents/:id/model-bindings` | → list `ModelBinding {purpose, providerId, model, params, priority}` | V | — |
| PUT `/agents/:id/model-bindings` | full replacement list → same (identity untouched — _BRIEF §2.4) | F / P:write:agents | agent.model.binding.changed |
| GET `/agents/:id/sessions` | filters `status, from, to` → list `AgentSession` | V | — |
| GET `/agent-sessions/:id` | → `AgentSession` (live monitor card data incl. currentActivity) | V | — |
| GET `/agent-sessions/:id/steps` | cursor by stepNo → list `AgentStep {stepNo, actionKind, action, observation, tokens, costCents, createdAt}` | V | — |
| GET `/agents/:id/performance` | `?from&to` → `PerformanceSnapshot[]` | V | — |

### 3.5 Skills

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/skills` · POST · PATCH `/:id` | `Skill {name, category, description}` | V read / F write | skill.created |
| GET `/skills/:id/agents` | → list `{agent: AgentRef, level, confidence, evidenceCount, lastUsedAt}` | V | — |
| GET `/agents/:id/skills` | → list `AgentSkill` | V | — |
| GET `/agent-skills/:id/evidence` | cursor → list `SkillEvidence {kind, weight, ref, note, createdAt}` | V | — |

Skill levels are never writable via API — recomputed from evidence only (_DECISIONS §11).

### 3.6 Projects

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/projects` | filters `status, q` → list `Project` | V | — |
| POST `/projects` | `{name, slug, objectiveMd, constraintsMd?}` → `Project` (status=proposed; greenfield flow starts CEO planning) | F / P:write:projects | project.created |
| GET `/projects/:id` | → `Project & {repository?, members, lead?: AgentRef}` | V | — |
| PATCH `/projects/:id` | partial + `{status}` (pause/archive/cancel only — other transitions are org-driven) | F | project.status.changed |
| POST `/projects/import` | `{name, slug, source: {kind: 'path'\|'url', value}, businessGoalMd, constraintsMd?}` → `Project` (status=intake; starts `projectIntakeWorkflow`; Idempotency-Key required) | F | project.imported |
| GET `/projects/:id/intake-report` | → `Artifact` (kind=intake_report) or 404 while intake runs | V | — |
| GET `/projects/:id/repository` | → `Repository {name, defaultBranch, barePath, languages, importedAt, originUrl}` | V | — |
| GET `/projects/:id/members` · POST · DELETE `/:agentId` | `{agentId, role}` | V read / F write | project.member.added/removed |
| GET `/projects/:id/environments` · PUT `/:name` | `Environment {name, baseUrl, config}` | V read / F write | environment.configured |
| GET `/projects/:id/deployments` | cursor → list `Deployment` | V | — |

### 3.7 Tasks

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/tasks` | board queries — filters `projectId, kind, status, ownerAgentId, orgUnitId, priority, risk, parentId, q, deadlineBefore`; sort `-createdAt\|priority\|deadline` → list `Task` | V | — |
| POST `/tasks` | `CreateTask {projectId?, parentId?, kind, title, objective, priority, successCriteria, risk, budgetCents?, deadline?, orgUnitId?}` → `Task` (Founder-created ⇒ creatorAgentId null, status=DRAFT) | F / P:write:tasks | task.created |
| GET `/tasks/:id` | → `Task & {owner?: AgentRef, dependencies, assignments, artifacts: ArtifactRef[], reviews: ReviewRef[], costCents}` | V | — |
| PATCH `/tasks/:id` | partial metadata (title, objective, priority, successCriteria, risk, budgetCents, deadline) → `Task` | F | task.updated |
| POST `/tasks/:id/transitions` | `{to: TaskStatus, reason?}` → `Task`; legality + role permission via domain state machine (_DECISIONS §7); 409 `task_transition_invalid`; APPROVAL states rejected here (Approval Engine only). Idempotency-Key required | F / P:write:tasks | task.status.changed |
| GET `/tasks/:id/dependencies` | → `{blockedBy: TaskRef[], blocks: TaskRef[]}` | V | — |
| POST `/tasks/:id/dependencies` | `{dependsOnTaskId}` → 201; 409 `dependency_cycle_detected` | F | task.dependency.added |
| DELETE `/tasks/:id/dependencies/:depId` | → 204 (resolves) | F | task.dependency.resolved |
| GET `/tasks/:id/tree` | → `{root: TaskNode}` recursive subtree (kind hierarchy, status rollup) | V | — |
| GET `/tasks/:id/assignments` | → history list `TaskAssignment` | V | — |
| POST `/tasks/:id/assignments` | `{agentId, role, reason?}` → `TaskAssignment` (Founder override of delegation engine; bumps reassignmentCount) | F | agent.task.assigned |
| GET `/tasks/:id/artifacts` · GET `/artifacts/:id` | → `Artifact` (contentMd inline or `uri`) | V | — |
| GET `/tasks/:id/reviews` · GET `/reviews/:id` | → `Review {kind, branch, author, reviewer, status, verdictMd, diffStat}` | V | — |

### 3.8 Communication

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/channels` | filters `kind, projectId, orgUnitId, memberAgentId, archived` → list `Channel & {lastMessageAt, unread}` | V | — |
| POST `/channels` | `{kind: 'dm'\|'team'\|'department'\|'project', name?, orgUnitId?, projectId?, memberAgentIds}` → `Channel` (task_thread/review/escalation channels are system-created only) | F | channel.created |
| GET `/channels/:id` | → `Channel & {members: [{agentId\|founder, joinedAt}]}` | V | — |
| GET `/channels/:id/messages` | cursor (reverse-chron) `?before=<cursor>` → list `Message` | V | — |
| POST `/channels/:id/messages` | `{body, kind?: 'text', refs?, replyToMessageId?}` → `Message` (sender = Founder ⇒ senderAgentId null; delivery signals/wakes recipient workflows — _DECISIONS §14) | F / P:write:messages | agent.message.sent |
| POST `/channels/:id/read` | `{at}` → 204 (Founder read marker) | F | — |
| GET `/messages/:id/thread` | → `{root: Message, replies: Message[]}` | V | — |

### 3.9 Memory

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| POST `/memory/search` | `MemorySearch {query, scopes?: [{scope, scopeRef?}], types?, status?, minImportance?, minConfidence?, from?, to?, topK?=20}` → `{items: [{memory: Memory, score, scoreParts: {cosine, importance, recency, confidence}}]}` — **hybrid**: pgvector cosine + trgm keyword + re-rank 0.55/0.2/0.15/0.1 (_DECISIONS §10) | V / P:read:memory | memory.retrieved (sampled) |
| GET `/memories` | Observatory list — filters `scope, scopeRef, type, status, agentId(createdBy), minImportance, minConfidence, from, to, q`; sort `-createdAt\|-importance` → list `Memory` | V | — |
| GET `/memories/:id` | detail + provenance → `Memory & {evidence: MemoryEvidence[], versions: MemoryVersion[], relations: [{kind, direction, memory: MemoryRef}], sourceEvent?: EventRef, usage: {retrievalCount, lastRetrievedAt}}` — the "why it exists" view (_BRIEF §3) | V | — |
| GET `/memory/graph` | `?scope&scopeRef&types&kinds(relations)&limit` → `{nodes: MemoryNodeRef[], edges: [{from, to, kind}]}` for Cytoscape | V | — |
| GET `/memory/promotions` | filter `status` → list `MemoryPromotion` | V | — |
| PATCH `/memories/:id` | Founder edit `{title?, content?, summary?, importance?, confidence?, reason}` → `Memory` (writes memory_versions, changedBy=founder) | F | memory.updated |
| POST `/memories/:id/archive` | `{reason}` → `Memory` (status=archived) | F | memory.archived |

Memory creation has NO public endpoint — memories are born only from the consolidation pipeline
(12-MEMORY-ARCHITECTURE.md); the Founder can edit/archive, never fabricate provenance.

### 3.10 Approvals

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/approvals` | inbox — filters `status(default pending), kind, urgency, risk` sort `-urgency,-createdAt` → list `Approval` | F / P:read:approvals | — |
| GET `/approvals/:id` | → `Approval & {requestedBy: AgentRef, chain, task?: TaskRef, toolInvocation?: ref}` | F | — |
| POST `/approvals/:id/verdict` | `{verdict: 'approve'\|'reject'\|'request_executive_review', note?}` → `Approval` — signals `approvalVerdict` into waiting workflow (`workflowId`); needs_review re-routes to endorsing executive. Idempotency-Key required | F / P:write:approvals | approval.approved / approval.rejected |

Approval creation is internal-only (agents via Approval Engine, 19-APPROVAL-ENGINE.md).

### 3.11 Events

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/events` | timeline — filters `types (prefix ok: 'task.*'), actorKind, actorId, taskId, projectId, agentId, from, to`; cursor keyed on `seq` → list `Event` (envelope incl. seq, payload) | V / P:read:events | — |
| GET `/events/replay` | `?afterSeq=<n>&limit=500` → `{items: Event[], nextSeq}` — deterministic per-company seq replay (WS resume fallback, 22-REALTIME-ARCHITECTURE.md) | V | — |
| GET `/events/:id` | → `Event` full envelope | V | — |

### 3.12 Reports & Dashboards

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/reports/executive` | list of executive-report artifacts (kind=executive_report) newest-first | F | — |
| GET `/reports/summary` | → `{tasks: {byStatus}, agents: {active, byActivity}, approvals: {pending}, spendTodayCents, budgetHealth, incidentsOpen}` — command-center header KPIs | V | — |
| GET `/reports/agents/utilization` | `?from&to` → per-agent `{agentId, sessions, activeMinutes, tasksCompleted, costCents}` | V | — |
| GET `/reports/projects/:id/status` | → project scorecard `{taskRollup, reviewStats, spendCents, deadlineRisk, recentDecisions}` | V | — |

### 3.13 Costs & Budgets

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/costs/rollups` | `?groupBy=day\|kind\|agent\|project\|orgUnit\|task&from&to` → `{rows: [{key, amountCents, quantity}]}` (from cost_rollup_daily) | V / P:read:costs | — |
| GET `/costs/entries` | filters `kind, agentId, taskId, projectId, from, to` cursor → list `CostEntry` | V | — |
| GET `/llm-calls` | filters `agentId, purpose, providerId, status, from, to` → list `LlmCall` | V | — |
| GET `/budgets` · POST · PATCH `/:id` | `Budget {scopeKind, scopeRef?, period, limitCents, kind}` | V read / F write | budget.created/updated |

### 3.14 Tools

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/tools` | registry cache → list `Tool {name, version, description, riskClass, scopes, inputSchema, enabled}` | V | — |
| GET `/tool-permissions` | filters `toolName, subjectKind, subjectId, active` → list `ToolPermission` | V | — |
| POST `/tool-permissions` | `{toolName, subjectKind, subjectId, constraints?, expiresAt?}` → `ToolPermission` | F / P:write:permissions | tool.permission.granted |
| DELETE `/tool-permissions/:id` | → 204 (revoke) | F | tool.permission.revoked |
| GET `/tool-invocations` | log — filters `agentId, taskId, toolName, decision, status, riskClass, from, to` → list `ToolInvocation` | V | — |

### 3.15 Terminal

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/terminal-sessions` | filters `status(default active), workspaceId, agentId` → list `TerminalSession & {workspace: {taskRef, isolationLevel}}` | V | — |
| GET `/terminal-sessions/:id` | → `TerminalSession & {attach: {wsTopic: "terminal:<id>", cols, rows}}` — client subscribes to that topic on `/ws` (§4) | V | — |
| DELETE `/terminal-sessions/:id` | → 204 (force close PTY via sandbox-manager) | F | workspace.terminal.closed |

Terminal history beyond the ring buffer: `GET /terminal-sessions/:id/log` streams the rolling file
(text/plain, Range supported), 7-day retention.

### 3.16 Settings & Providers

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/providers` · POST · PATCH `/:id` · DELETE `/:id` | `Provider {kind, name, baseUrl?, apiKey (write-only), enabled}`; GET never returns keys | A / P:admin:providers | provider.registered/updated |
| POST `/providers/:id/test` | → `{ok, latencyMs, model?}` live probe | A | — |
| GET `/model-profiles` · PUT | full list per purpose `ModelProfile {purpose, providerId, model, params, maxTokensPerCall, costCapCentsPerCall, priority}` | F | model_profile.updated |
| GET `/secrets` | names + metadata only, never values | F | — |
| PUT `/secrets/:name` | `{scope, projectId?, value}` → 204 (sealed-box encrypt server-side) | F | — (audit) |
| DELETE `/secrets/:name` | `?scope&projectId` → 204 | F | — (audit) |

### 3.17 Notifications

| Method & path | Request → Response | Perm | Events |
|---|---|---|---|
| GET `/notifications` | filter `unread=true` cursor → list `Notification` | F | — |
| POST `/notifications/:id/read` · POST `/notifications/read-all` | → 204 | F | notification.read |

---

## 4. WebSocket protocol (`/ws`) — normative spec

Expanded from _DECISIONS §16; shared with 22-REALTIME-ARCHITECTURE.md (that doc owns server
internals; this section owns the wire contract).

### 4.1 Connect & auth
- `GET /ws` upgrade; auth via the SAME session cookie (browsers) or `?pat=` query for CLI
  (PAT scope `read:events` minimum). Unauthenticated upgrade → close `4401`.
- First server frame: `{op: "hello", connectionId, heartbeatSec: 20, maxTopics: 32}`.

### 4.2 Client operations
```json
{ "op": "subscribe", "topics": ["events:<companyId>", "presence:<companyId>", "terminal:<sessionId>"] }
{ "op": "resume",    "topic": "events:<companyId>", "after_seq": 184223 }
{ "op": "unsubscribe", "topics": ["terminal:<sessionId>"] }
{ "op": "ping", "t": 1712345678 }
```
- Topic authorization: company topics require membership of that company; `terminal:` topics
  additionally require the session's company match. Unauthorized topic → `{op:"error",
  code:"forbidden_topic", topic}` (connection stays open).

### 4.3 Server frames
```json
{ "op": "sub_ok", "topic": "events:…", "current_seq": 184230 }
{ "topic": "events:<companyId>", "seq": 184231, "events": [ {Event envelope…} ] }
{ "topic": "presence:<companyId>", "seq": 991, "events": [ {"type":"office.avatar.moved", …} ] }
{ "topic": "terminal:<id>", "seq": 512, "frames": [ {"t": 1712, "data": "base64…"} ] }
{ "op": "gap", "topic": "terminal:<id>", "from_seq": 490, "to_seq": 505 }
{ "op": "pong", "t": 1712345678 }
```
- `seq` is per-topic monotonic: events topics use the company event `seq` (gap-free, from the
  events table); presence topics use an in-memory Office-Projector counter (resumable only within
  process lifetime — on `sub_ok` mismatch the client re-snapshots via
  `GET /reports/summary` + `GET /org/chart`); terminal topics use frame counters.

### 4.4 Resume semantics
- `resume` on `events:` replays from the events TABLE (`WHERE company_id=? AND seq>? ORDER BY seq
  LIMIT batches of 500`) then switches to live — the client sees no gap, ever.
- `resume` on `terminal:` replays only what the 64KB ring buffer holds; older → `gap` frame; full
  history via the log-file endpoint (§3.15).

### 4.5 Heartbeat & liveness
Client pings every 20s; server closes after 2 missed intervals (code `4408`). Server also sends
`pong` piggybacked liveness. TCP keepalive is not trusted.

### 4.6 Backpressure (binding)
- **Terminal frames are droppable**: if a connection's outbound buffer exceeds 1MB, terminal
  frames for that connection are dropped oldest-first per topic and a `gap` frame is sent. UI shows
  a "output trimmed" marker.
- **Domain events are NEVER dropped**: if buffering `events:` frames would exceed the limit, the
  server closes the connection with `4409 slow_consumer`; the client reconnects and `resume`s from
  its last seq — replay from the table guarantees losslessness. (Digital-twin invariant: office
  renders only real, complete event streams — _BRIEF §2.8.)

---

## 5. Internal APIs

Both internal surfaces authenticate with a **shared bearer token** (`INTERNAL_SERVICE_TOKEN`, 32+
random bytes from `.env`, rotated by redeploy; sent as `Authorization: Bearer`), bound to the
compose-internal network — mTLS deferred to Phase 3. [WRITER-DECISION] Shared token over mTLS for
MVP: single-host compose network, no cert lifecycle burden; the network boundary plus token meets
the threat model in 18-PERMISSIONS-AND-SECURITY.md.

### 5.1 sandbox-manager HTTP API (consumed by execution-worker & server only)

| Method & path | Request → Response |
|---|---|
| POST `/internal/v1/workspaces` | `{workspaceId, companyId, projectId, taskId?, isolationLevel, image, repo: {barePath, branch}, limits}` → `{containerId, volumePath, status: 'ready'}` (idempotent on workspaceId) |
| DELETE `/internal/v1/workspaces/:id` | `?discard=true` → 204 (destroys container + volume per retention) |
| GET `/internal/v1/workspaces/:id` | → `{status, containerId, resourceUsage: {cpu, memBytes, diskBytes}}` |
| POST `/internal/v1/workspaces/:id/exec` | `{cmd, args, cwd?, env?, timeoutMs, maxOutputBytes}` → `{exitCode, stdout, stderr, truncated, durationMs}` (non-PTY, for tool activities) |
| POST `/internal/v1/workspaces/:id/pty` | `{terminalSessionId, cmd, cols, rows}` → `{natsSubject: "term.<sessionId>.out", stdinSubject: "term.<sessionId>.in"}` — frames stream via NATS; server's WS gateway bridges to `terminal:` topics |
| POST `/internal/v1/pty/:terminalSessionId/resize` | `{cols, rows}` → 204 |
| DELETE `/internal/v1/pty/:terminalSessionId` | → 204 (SIGHUP + close) |
| GET `/internal/v1/health` | → `{ok, dockerOk, workspaces: n}` |

sandbox-manager holds NO domain state (invariant: control vs execution plane); workspace/terminal
rows in Postgres are written by the caller around these calls.

### 5.2 Tool Gateway internal endpoint (in apps/server, consumed by agent-worker)

| Method & path | Request → Response |
|---|---|
| POST `/internal/v1/tool-gateway/invoke` | `{invocationId (idempotency), companyId, agentId, taskId, agentSessionId, toolName, input}` → `202 {invocationId, decision: 'allow'\|'deny'\|'require_approval', approvalId?}` then result delivered to the workflow via activity completion; synchronous fast path returns `200 {invocationId, decision:'allow', result, costCents, durationMs}` for R0 tools |
| GET `/internal/v1/tool-gateway/invocations/:id` | → `ToolInvocation` (poll fallback) |

Pipeline per _DECISIONS §12: identity → `tool_permissions` grant + constraints → policy engine
(autonomy × risk × cost × budget) → audit row (`tool_invocations`) → dispatch (sandbox-manager /
egress proxy / integration adapter). There is NO other execution path (invariant S3).

---

## 6. SDK generation & contracts pipeline

1. `packages/contracts` — every request/response/query schema as Zod + the error-code catalog +
   shared domain types (mirroring `packages/domain` enums).
2. `apps/server` registers routes with `fastify-type-provider-zod`; `@fastify/swagger` emits
   **OpenAPI 3.1** at build (`pnpm --filter contracts gen:openapi` → `packages/contracts/openapi.json`,
   committed, drift-checked in CI).
3. Typed client generated from the same Zod source (not from OpenAPI round-trip):
   `packages/contracts/src/client/` exports `createAcosClient({baseUrl, auth})` — per-module
   namespaces (`client.tasks.transition(id, body)`), full inference, problem+json → typed
   `AcosApiError`. `apps/web` consumes ONLY this client + `packages/ui` (dependency rule,
   _DECISIONS §3). OpenAPI.json remains the artifact for third-party/non-TS consumers.

## 7. Versioning & deprecation policy

- `/api/v1` is stable from first release. **Additive** changes (new endpoints, new OPTIONAL fields,
  new enum values marked non-exhaustive in contracts) are non-breaking and ship freely.
- Breaking changes require `/api/v2` living alongside `/api/v1` for ≥2 minor releases. Deprecated
  endpoints emit `Deprecation: true` and `Sunset: <RFC3339>` headers + changelog entry; the SDK
  marks them `@deprecated`.
- Event schema versioning is separate (envelope `version`, _DECISIONS §9) — API and event versions
  never couple.
- WS protocol version negotiated in `hello` (`protocol: 1`); clients reject unknown majors.

## 8. Example request/response pairs

### 8.1 Hire agent
```
POST /api/v1/agents/0198f3a2-7c1e-7d4a-9b21-3f8e5d2a1c07/hire
X-Company-Id: 01989f00-1111-7aaa-bbbb-000000000001
Idempotency-Key: 5f3c9e10-aaaa-4bbb-8ccc-1234567890ab
```
```json
{ "reportsToAgentId": "0198e1b0-4d2f-7e3c-8a55-9c0d1e2f3a4b",
  "memberOfUnitId": "0198d0c0-2222-7ccc-9ddd-000000000031" }
```
Response `200`:
```json
{
  "id": "0198f3a2-7c1e-7d4a-9b21-3f8e5d2a1c07",
  "companyId": "01989f00-1111-7aaa-bbbb-000000000001",
  "employeeNumber": 14,
  "name": "Alex Demir",
  "status": "active",
  "positionId": "0198c0a0-3333-7eee-8fff-000000000007",
  "orgUnitId": "0198d0c0-2222-7ccc-9ddd-000000000031",
  "seniority": "senior",
  "autonomyLevel": 3,
  "persona": "Senior frontend engineer focused on React performance and DX.",
  "avatarUrl": "/avatars/alex.png",
  "employment": { "hiredAt": "2026-08-10T14:03:22Z" },
  "createdAt": "2026-08-09T10:11:12Z"
}
```
Emits `agent.hired` + `org.edge.created` (reports_to, member_of) — office renders the new avatar
from these events only.

### 8.2 Task transition
```
POST /api/v1/tasks/0198f4d5-1e2f-7a3b-8c4d-5e6f7a8b9c0d/transitions
X-Company-Id: 01989f00-1111-7aaa-bbbb-000000000001
Idempotency-Key: 7a1b2c3d-eeee-4fff-9000-abcdefabcdef
```
```json
{ "to": "CANCELLED", "reason": "Objective superseded by TASK-97." }
```
Response `200`:
```json
{
  "id": "0198f4d5-1e2f-7a3b-8c4d-5e6f7a8b9c0d",
  "number": 81,
  "kind": "task",
  "title": "Implement feature X import pipeline",
  "status": "CANCELLED",
  "priority": "P1",
  "risk": "medium",
  "ownerAgentId": "0198f3a2-7c1e-7d4a-9b21-3f8e5d2a1c07",
  "projectId": "0198e9aa-0f0f-7bbb-9ccc-00000000002a",
  "closedAt": "2026-08-10T14:20:05Z",
  "result": { "outcome": "cancelled", "reason": "Objective superseded by TASK-97." }
}
```
Illegal transition example — `409 application/problem+json`:
```json
{ "type": "https://acos.dev/errors/task_transition_invalid",
  "title": "Invalid task transition", "status": 409,
  "code": "task_transition_invalid",
  "detail": "REVIEW -> DONE is not a legal transition; allowed: CHANGES_REQUESTED, QA",
  "requestId": "0198f4d6-90ab-7cde-8f01-234567890abc" }
```

### 8.3 Memory search (hybrid)
```
POST /api/v1/memory/search
X-Company-Id: 01989f00-1111-7aaa-bbbb-000000000001
```
```json
{
  "query": "flaky vitest tests caused by shared postgres container",
  "scopes": [ { "scope": "project", "scopeRef": "0198e9aa-0f0f-7bbb-9ccc-00000000002a" },
              { "scope": "company" } ],
  "types": ["failure", "procedural"],
  "minConfidence": 0.5,
  "topK": 5
}
```
Response `200`:
```json
{
  "items": [
    {
      "memory": {
        "id": "0198fa10-aaaa-7bbb-8ccc-00000000ff01",
        "scope": "project",
        "scopeRef": "0198e9aa-0f0f-7bbb-9ccc-00000000002a",
        "type": "failure",
        "title": "Parallel integration tests deadlock on shared Postgres schema",
        "summary": "Vitest workers sharing one Testcontainers Postgres deadlock on migrations; use one container per worker or serial migration step.",
        "importance": 0.78,
        "confidence": 0.83,
        "status": "active",
        "retrievalCount": 12,
        "createdAt": "2026-07-30T09:15:00Z",
        "lastVerifiedAt": "2026-08-08T17:40:00Z"
      },
      "score": 0.812,
      "scoreParts": { "cosine": 0.87, "importance": 0.78, "recency": 0.71, "confidence": 0.83 }
    }
  ],
  "nextCursor": null
}
```
Weights per _DECISIONS §10: `score = 0.55·cosine + 0.2·importance + 0.15·recency + 0.1·confidence`.
