# 28 — Repository Structure

Status: v1.0 — Implementation-ready

Canonical monorepo: **pnpm workspaces + Turborepo** (ADR-001). Layout below is binding
(`_DECISIONS.md` §3); this document specifies each package's responsibility, public surface,
allowed dependencies and their enforcement, test placement, TypeScript project-reference strategy,
the build pipeline, `.env.example`, and the compose service list.

## 1. Canonical layout

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
├── docs/                  # this architecture package (+ docs/adr/)
├── turbo.json
├── pnpm-workspace.yaml
├── .env.example
├── eslint.config.mjs      # flat config incl. eslint-plugin-boundaries
├── tsconfig.base.json     # shared compiler options + path aliases
└── package.json           # root scripts only (turbo run …)
```

Workspace package names use the `@acos/` scope: `@acos/domain`, `@acos/db`, `@acos/events`,
`@acos/contracts`, `@acos/llm`, `@acos/tools`, `@acos/config`, `@acos/ui`, `@acos/server`,
`@acos/web`, `@acos/agent-worker`, `@acos/execution-worker`, `@acos/sandbox-manager`.
[WRITER-DECISION: `@acos` npm scope for all workspace packages.]

## 2. Package responsibilities & public API surfaces

Every package exposes ONLY what its `package.json` `exports` map lists; deep imports are blocked by
`eslint-plugin-import/no-internal-modules`. [WRITER-DECISION: exports-map + no-internal-modules as
the deep-import enforcement mechanism.]

### packages/domain — `@acos/domain`
Pure TypeScript: zero runtime dependencies, no IO, no framework imports. Contains entity types and
factories (`Agent`, `Task`, `Project`, `Memory`, `Approval`, `OrgEdge`, …), value objects
(`Money`, `RiskClass`, `AutonomyLevel`, `Seniority`, UUIDv7 helpers), the canonical state machines
from `_DECISIONS.md` §19 as data + guard functions (`taskTransitions`, `canTransition(task, from,
to, actorRole)`), delegation limits, the autonomy decision matrix (`maxRisk(level)`), escalation
resolution-order rules, and memory scoring/promotion rules as pure functions.
Public surface: `@acos/domain` (all of the above), `@acos/domain/state-machines`,
`@acos/domain/policies`. Depends on: **nothing internal**.

### packages/db — `@acos/db`
Drizzle schema for every table in 20-DATABASE-DESIGN.md, drizzle-kit migrations
(`packages/db/migrations/*.sql`, committed), repository classes (one per aggregate:
`TaskRepository`, `AgentRepository`, `MemoryRepository`, …), the `CompanyContext`-enforcing
Drizzle wrapper (refuses tenant-table queries without a company filter, `_DECISIONS.md` §4),
transactional-outbox helper `withOutbox(tx, event)`, advisory-lock helpers.
Public surface: `@acos/db` (repositories, `createDb`, `CompanyContext`), `@acos/db/schema` (for
drizzle-kit and tests only). Depends on: `domain`, `events`, `config`.

### packages/events — `@acos/events`
The event catalog (~180 events, 10-EVENT-ARCHITECTURE.md): one Zod schema per event type+version,
`EventEnvelope` type (id, company_id, seq, type, version, occurred_at, actor, subject refs,
correlation_id, causation_id, payload), `defineEvent()` helper, versioning utilities
(`isHandledVersion`), NATS subject builders (`subjectFor(companyId, type)`).
Public surface: `@acos/events`. Depends on: `domain`.

### packages/contracts — `@acos/contracts`
REST request/response Zod schemas per resource (21-API-DESIGN.md), WebSocket protocol message
schemas (`subscribe`, `resume`, frame envelopes), OpenAPI document generation
(fastify-type-provider-zod compatible), and the generated typed client SDK
(`@acos/contracts/client`) used by web and external consumers.
Public surface: `@acos/contracts`, `@acos/contracts/client`. Depends on: `domain`, `events`
(re-exports event payload types for the WS stream).

### packages/llm — `@acos/llm`
The `ModelRouter` port (interface + resolution logic: purpose → binding → company profile →
fallback chain, `_DECISIONS.md` §17), provider adapters built on Vercel AI SDK v5 (Anthropic,
OpenAI, OpenRouter, Ollama/vLLM via OpenAI-compat), prompt assembly (Working-Set → messages, with
provenance markers for untrusted content per S5), token counting, `llm_calls` logging hook,
embedding client (per-model dimension aware).
Public surface: `@acos/llm`. Depends on: `domain`, `config`. (DB writes for `llm_calls` happen via
a logging callback injected by the app — `llm` itself stays repository-free.)

### packages/tools — `@acos/tools`
Tool definitions shared by the gateway and the runtime: for each tool a name, description, Zod
input/output schema, risk class (R0–R3), touched scopes (`fs|git|network|db|money|publish`), cost
estimator function, and required isolation level. MVP toolset: `fs.read`, `fs.write`, `fs.search`,
`git.commit`, `git.branch`, `git.diff`, `git.merge`, `terminal.run`, `db.inspect`, `web.fetch`,
`web.search`, `task.query`, `memory.search` (A7). No execution code here — definitions only.
Public surface: `@acos/tools`. Depends on: `domain`.

### packages/config — `@acos/config`
Zod-parsed environment (`loadConfig(processEnv)` returning a typed, validated config object; fails
fast with actionable messages), shared constants (queue names, NATS subject prefixes, Temporal task
queue names `agent-tasks`, `execution`, `memory`, `intake`, default budgets/limits).
Public surface: `@acos/config`. Depends on: nothing internal.

### packages/ui — `@acos/ui`
Design system: Tailwind preset, primitive components (Button, Card, Dialog, DataTable, StatusPill),
domain widgets reused across views (AgentAvatar, RiskBadge, MoneyText, EventRow). No data fetching.
Public surface: `@acos/ui`. Depends on: nothing internal (types via `contracts` are allowed for
prop typing).

### apps/server — `@acos/server`
Fastify 5 modular monolith: one module directory per domain area
(`src/modules/{companies,org,agents,tasks,projects,memory,skills,comms,approvals,policies,costs,
events,tool-gateway,realtime,office-projector,auth}`), each with routes + service + wiring to
`@acos/db` repositories; outbox relay (leader-elected); WS gateway; internal HTTP for the Tool
Gateway. Depends on: all packages except `ui`.

### apps/web — `@acos/web`
React 19 SPA (Vite, TanStack Router/Query, Zustand, Tailwind, PixiJS, Cytoscape.js, xterm.js,
Recharts). Depends on: **`contracts` + `ui` only** (dependency rule) — all server knowledge arrives
through the generated client and WS schemas.

### workers/agent-worker — `@acos/agent-worker`
Temporal worker (task queues `agent-tasks`, `memory`, `intake`): `agentTaskWorkflow`, `agentInboxWorkflow`,
`delegationWorkflow`, `memoryConsolidationWorkflow`, `projectIntakeWorkflow`,
`experimentWorkflow` (Phase 2); activities: Working-Set building, LLM calls, Tool-Gateway
invocation, message delivery. Depends on: `domain`, `db`, `events`, `llm`, `tools`, `config`.

### workers/execution-worker — `@acos/execution-worker`
Temporal worker (task queue `execution`): sandboxed activities `runCommandActivity`,
`gitOperationActivity`, `runTestsActivity`, `buildActivity` (+ Phase 2 browser/media). Talks only
to sandbox-manager over HTTP. Depends on: `domain`, `tools`, `config`, `contracts` (sandbox-manager
client types). No `db` — the execution plane holds zero domain state (02-SYSTEM-CONTEXT.md §3).

### services/sandbox-manager — `@acos/sandbox-manager`
Small Fastify service; the only Docker-socket owner (S1). dockerode container lifecycle, worktree
volume provisioning from bare repos, PTY exec, NATS frame publishing, resource-limit enforcement
per isolation level. Depends on: `config`, `contracts` (its own API schemas live there), `tools`
(isolation-level definitions). No `db`.

## 3. The dependency rule and its enforcement

Canonical rule (`_DECISIONS.md` §3):

- `domain` depends on nothing internal.
- `db`, `events`, `tools`, `llm`, `contracts` may depend on `domain` (plus the narrow extras listed
  per-package above).
- Apps/workers/services depend on packages, **never on each other**.
- `web` depends only on `contracts` + `ui`.

Enforcement — three independent nets, all CI-blocking:

1. **eslint-plugin-boundaries** (root `eslint.config.mjs`). Element types are declared per
   directory: `{ type: "domain", pattern: "packages/domain" }`, `{ type: "lib", pattern:
   "packages/*" }`, `{ type: "app", pattern: ["apps/*", "workers/*", "services/*"] }`. Rules:
   `domain → []`; `lib → [domain, lib-whitelist per package via "importKind" allow-list]`;
   `app → [lib, domain]`; explicit deny `app → app`; `web` gets its own element type with allow
   `[contracts, ui]` only. Violations fail `turbo run lint`.
2. **pnpm workspace manifests.** A package can only import what its `package.json` declares
   (`"@acos/domain": "workspace:*"`); undeclared cross-imports fail resolution at build time.
   Reviewers reject dependency additions that violate the rule; a CI script
   (`scripts/check-deps.ts`) diffs declared deps against the allow-matrix and fails on drift.
   [WRITER-DECISION: `scripts/check-deps.ts` as a third net.]
3. **TypeScript project references** (§5): a package without a reference cannot typecheck against
   another package's types.

## 4. Tests: where they live

- **Unit tests:** colocated `src/**/*.test.ts` next to the code under test (Vitest). Pure-domain
  tests (`packages/domain`) require no infrastructure and run in milliseconds.
- **Integration tests:** `<package>/test/integration/**/*.test.ts` using **Testcontainers**
  (Postgres+pgvector, NATS, Temporal dev server). Primary homes: `packages/db` (repositories,
  tenancy wrapper, outbox), `apps/server` (route+module tests via `fastify.inject`),
  `workers/agent-worker` (Temporal `TestWorkflowEnvironment` replay/determinism tests).
- **E2E:** `apps/web/e2e/**/*.spec.ts` with Playwright against a compose-launched stack; the MVP
  demo script (29-MVP-PLAN.md §3) is encoded here as `e2e/mvp-demo.spec.ts`.
- Full strategy: 32-TESTING-STRATEGY.md.

## 5. Naming conventions & tsconfig strategy

Naming (binding, `_DECISIONS.md` §21): snake_case DB identifiers; camelCase TS values; PascalCase
types/components; kebab-case file and package names; events `domain.entity.action` past tense;
Temporal workflows `<thing>Workflow`, activities `<verb><Thing>Activity`; NATS subjects
`co.<companyId>.<eventType>`; branches `task/<task-number>-<slug>`.

TypeScript: **project references** throughout. `tsconfig.base.json` holds strict options
(`"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`,
`"module": "NodeNext"`, `"verbatimModuleSyntax": true`). Each package has `tsconfig.json`
(`"composite": true`, `references` listing exactly its allowed dependencies — making the dependency
rule structurally enforced) and emits declarations to `dist/`. Apps/workers build with `tsc -b`
for types plus their bundler (Vite for web; `tsup` for node targets [WRITER-DECISION: tsup as node
bundler]). A root `tsconfig.json` references all packages so `tsc -b` at root = full typecheck.

## 6. Build pipeline (turbo.json)

```jsonc
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test":      { "dependsOn": ["^build"] },
    "test:integration": { "dependsOn": ["^build"], "cache": false },
    "db:generate": { "cache": false },   // drizzle-kit generate (packages/db)
    "db:migrate":  { "cache": false },
    "dev":       { "persistent": true, "cache": false }
  }
}
```

Root scripts: `pnpm build|lint|test|typecheck` → `turbo run <task>`. CI order:
`lint → typecheck → test → test:integration → build → docker build`. Remote caching optional
(self-hosted turbo cache), not required.

## 7. .env.example (canonical variable names)

```bash
# --- Core ---
NODE_ENV=production
APP_BASE_URL=http://localhost:3000        # server (REST + /ws); prod: https://os.example.com
WEB_PORT=5173
SERVER_PORT=3000
DATA_DIR=/data                            # repos, terminals, volumes root
LOG_LEVEL=info
SEED_DEMO=true                            # auto-seed Acme on first boot (false in prod)

# --- Postgres (source of truth) ---
DATABASE_URL=postgres://acos:acos@postgres:5432/acos

# --- NATS JetStream ---
NATS_URL=nats://nats:4222

# --- Temporal ---
TEMPORAL_ADDRESS=temporal:7233
TEMPORAL_NAMESPACE=acos

# --- Security ---
MASTER_KEY=                               # 32-byte base64; envelope encryption (libsodium)
SESSION_SECRET=                           # cookie signing
ARGON2_MEMORY_KIB=65536

# --- LLM providers (any subset; ModelRouter uses what's configured) ---
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_BASE_URL=http://host.docker.internal:11434
VLLM_BASE_URL=

# --- Embeddings ---
EMBEDDINGS_PROVIDER=openai                # openai | ollama
EMBEDDINGS_MODEL=text-embedding-3-small   # nomic-embed-text for offline profile

# --- Sandbox / execution plane ---
SANDBOX_MANAGER_URL=http://sandbox-manager:3010
MAX_WORKSPACES=8
DOCKER_SOCK=/var/run/docker.sock          # mounted ONLY into sandbox-manager
EGRESS_PROXY_URL=http://egress-proxy:3128

# --- Internal auth (server <-> workers/services) ---
INTERNAL_API_TOKEN=                       # shared bearer for internal HTTP (Tool Gateway, sandbox-manager)

# --- Observability (optional profile) ---
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
GRAFANA_ADMIN_PASSWORD=

# --- Budgets / safety defaults ---
DEFAULT_COMPANY_DAILY_BUDGET_CENTS=5000

# --- Backups ---
BACKUP_S3_URL=                            # optional rclone target
```

[WRITER-DECISION: `INTERNAL_API_TOKEN` shared-bearer for internal HTTP in MVP; mTLS optional
Phase 3.] `packages/config` parses all of these with Zod; unknown/missing required vars abort boot
with a named error.

## 8. docker compose services

`infrastructure/docker/docker-compose.yml` (details in 27-INFRASTRUCTURE.md):

| Service | Image/build | Notes |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg16` | volume `pgdata`; single DB `acos` + separate `temporal` schema/db |
| `nats` | `nats:2.10` (`-js`) | JetStream enabled, volume `natsdata` |
| `temporal` | `temporalio/auto-setup` | uses postgres; namespace `acos` |
| `temporal-ui` | `temporalio/ui` | dev/ops convenience |
| `server` | build `apps/server` | ports 3000; depends on postgres/nats/temporal |
| `web` | build `apps/web` (nginx) | serves SPA, proxies `/api` + `/ws` to server |
| `agent-worker` | build `workers/agent-worker` | scale-out target |
| `execution-worker` | build `workers/execution-worker` | scale-out target |
| `sandbox-manager` | build `services/sandbox-manager` | mounts `DOCKER_SOCK` + `${DATA_DIR}`; the only privileged service |
| `egress-proxy` | build `infrastructure/docker/egress-proxy` | allowlist HTTP proxy for workspace networks |
| *profile `observability`* | otel-collector, prometheus, grafana, loki, tempo | optional (`--profile observability`) |

Workspace containers (`acos/workspace-node`, `acos/workspace-php`, …) are NOT compose services;
sandbox-manager creates them dynamically on the dedicated `acos-workspaces` Docker network whose
only route out is `egress-proxy`.
