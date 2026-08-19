# ADR-002: Core Backend Stack — TypeScript/Node 22, Fastify Modular Monolith

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The control plane must own the entire domain: companies, agents, org graph, tasks, memory, skills,
communication, approvals, policies, costs, events (_BRIEF §2.6). It exposes REST + WebSocket to the
SPA, runs the outbox relay, and hosts the Tool Gateway authorization side (_DECISIONS §2). Forces:

- **LLM-centric system.** The heart of the product is prompt assembly, structured output parsing
  (Zod unions for `AgentAction`), and provider SDKs — the TypeScript ecosystem (Vercel AI SDK,
  Anthropic/OpenAI SDKs, Temporal TS SDK) is the strongest here.
- **Shared types end to end.** Event schemas, tool schemas, API contracts, and domain state
  machines must be identical in server, workers, and the React frontend. Any second language
  splits this and reintroduces drift.
- **Scale is modest.** 1–10 companies, 5–30 concurrently active agents, thousands of tasks
  (_BRIEF §10). The workload is IO-bound (LLM calls, DB, NATS) — a single Node process with
  workers handles it comfortably. Heavy compute lives in sandboxes, not the control plane.
- **Solo-operator ops.** Self-hosted via docker compose; the fewer deployable units and the simpler
  the runtime, the better.
- **Velocity.** The system is implemented by Claude Code; a single idiomatic language with strict
  typing maximizes generation quality and cross-cutting refactor safety.

## Options considered

### Option A: Go services

- **Description.** Go for the control plane and workers; TypeScript only for the frontend.
- **Pros.** Excellent runtime efficiency and deployment story (static binaries); strong
  concurrency primitives; smaller memory footprint.
- **Cons.** Splits the codebase into two languages: every event schema, tool definition, and API
  contract must be duplicated or code-generated across the Go/TS boundary. The LLM tooling
  ecosystem (AI SDK, streaming structured outputs) is materially weaker. Temporal's Go SDK is
  first-class, but that does not offset losing shared Zod schemas with the frontend.
- **Rejected because** velocity and shared types outweigh runtime efficiency at this scale; the
  control plane is IO-bound, so Go's performance edge buys little.

### Option B: NestJS

- **Description.** TypeScript, but with NestJS's DI container, decorators, module system.
- **Pros.** Opinionated structure; large ecosystem; enforced modularity out of the box.
- **Cons.** Heavy ceremony (decorators, providers, module metadata) for a system whose modularity
  we already enforce via package boundaries and eslint (ADR-001); an extra abstraction layer over
  Fastify that complicates Zod-first schema generation; runtime DI adds indirection Claude Code
  does not need.
- **Rejected because** it duplicates structure we get from the monorepo dependency rule, at the
  price of ceremony; Fastify + plugins gives the same modularity with less machinery.

### Option C: Microservices (per-domain services)

- **Description.** Separate services for org, tasks, memory, comms, approvals, each with its own
  API and possibly database schema.
- **Pros.** Independent scaling and failure isolation per domain; enforced boundaries by network.
- **Cons.** At 5–30 concurrent agents there is nothing to scale independently; every domain
  operation (task transition → event → policy check → cost entry) becomes a distributed
  transaction; the transactional outbox (ADR-006) depends on state change + event sharing one
  Postgres transaction — microservices break exactly that guarantee. Operationally hostile to
  `docker compose up`.
- **Rejected because** scale does not justify it and it would destroy the single-transaction
  event-consistency model.

### Option D: TypeScript/Node 22, Fastify 5 modular monolith (chosen)

- **Description.** One `apps/server` process: Fastify 5 with Zod type provider, domain modules as
  internal packages/plugins, REST + WS, outbox relay (leader-elected), Tool Gateway authz. Workers
  are separate processes but share the same language and packages.
- **Pros.** One language everywhere; fastest honest path to the MVP; Zod-first contracts with
  generated OpenAPI; modularity enforced at compile time, not network time.
- **Cons.** Single runtime shares a failure domain; CPU-heavy work must be kept out (it is — LLM
  calls are external, execution is sandboxed); Node memory ceilings require attention for large
  event replays (mitigated by pagination and streaming).

## Decision

The backend is **TypeScript (strict) on Node.js 22 LTS**. The control plane is a **Fastify 5
modular monolith** (`apps/server`) using **Zod schemas via fastify-type-provider-zod**, with
OpenAPI generated from the same schemas and a typed client SDK in `packages/contracts`. REST +
WebSocket only — no GraphQL, no tRPC (external consumers and a generated SDK are preferred).

Bounding rules:

- Domain modules (org, agents, tasks, projects, memory, skills, comms, approvals, policies, costs,
  events) live as Fastify plugins wired to pure logic in `packages/domain`; the monolith is
  modular by package boundary (ADR-001), not by network boundary.
- The server process additionally runs: the WebSocket gateway (ADR-008), the outbox relay
  (leader-elected via Postgres advisory lock, ADR-006), and Tool Gateway authorization
  (_DECISIONS §12). It never touches Docker or sandboxes.
- Temporal workers (`workers/*`) and `services/sandbox-manager` are separate Node processes
  sharing the same packages — process topology per _DECISIONS §2 is fixed; no further service
  extraction without a new ADR.
- All request/response and event payloads validate through Zod at the boundary; `any` is banned by
  lint config.

## Consequences

**Positive.**
- One mental model, one toolchain, one debugger; contract changes are compiler-verified across
  server, workers, and SPA.
- Fastify's plugin encapsulation maps cleanly onto domain modules; Zod-first gives runtime
  validation and static types from one source.
- `docker compose up` runs three Node processes plus infra — operable by one person.

**Negative / accepted tradeoffs.**
- A crash in one domain module can take down the whole control plane; mitigated by process
  supervision (compose restart policies) and by the fact that durable work lives in Temporal, not
  in server memory (ADR-005).
- Node is weaker for CPU-bound work; accepted because none is planned in the control plane.
- Fastify 5 + Zod type-provider version coupling must be tracked.

**Revisit triggers.**
- Control-plane p95 latency for API reads exceeds 200ms at target scale due to event-loop
  saturation — consider extracting the WS gateway or relay into their own processes first.
- Sustained >100 concurrently active agents across companies (beyond spec) — re-evaluate topology.
- A domain module needs an incompatible release cadence or team ownership (Phase 3+).

## References

- _DECISIONS.md §1 (stack table), §2 (process topology), §22 row 002
- _BRIEF.md §9 (operations), §10 (scale)
- ADR-001 (monorepo), ADR-005 (Temporal), ADR-006 (outbox), ADR-008 (realtime), ADR-019 (Drizzle)
