# ADR-005: Durable Workflows — Self-Hosted Temporal

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Durable execution is a non-negotiable domain rule: agent work must survive app restart, host
restart, worker crash, LLM timeout, and network outage (_BRIEF §2.9). Beyond the agent loop
(ADR-004), the system runs many long-lived, multi-step, failure-prone processes: memory
consolidation pipelines, project intake analysis, delegation cascades, experiment workflows, and
Phase 2 media pipelines. Forces:

- **Long-running with external waits.** An agent task can span hours or days, waiting on reviews,
  approvals, dependencies, or replies — the runtime must park cheaply and wake on signals.
- **Retry semantics per step.** LLM calls fail transiently (429/5xx/timeouts); tool executions
  fail; each needs independent retry policies, heartbeats, and idempotency, not whole-process
  restarts.
- **Self-hosted.** Must run inside `docker compose up` on a single server (_BRIEF §9); no managed
  cloud dependency.
- **TypeScript SDK** required (ADR-002).
- **Scale.** 5–30 concurrently active agents → tens of concurrent workflows, hundreds of
  activities/minute at peak. Temporal at this scale is comfortably served by a single-binary
  deployment backed by Postgres.

## Options considered

### Option A: Custom Postgres-backed state machine

- **Description.** Hand-rolled durable execution: a `jobs`/`steps` table, worker polling,
  SELECT FOR UPDATE SKIP LOCKED, our own retry/timeout/signal bookkeeping.
- **Pros.** Zero new infrastructure (Postgres only); total control; no determinism constraints.
- **Cons.** This is reinventing a durable-execution engine: timers, signal queues, heartbeats,
  versioned code deployment mid-flight, replayable history, child workflows, cancellation
  semantics. Each is subtle; together they are months of work and a long tail of correctness bugs
  in exactly the layer the product's reliability promise rests on.
- **Rejected because** it trades a well-understood infra dependency for months of undifferentiated,
  high-risk engineering — the opposite of "boring reliable infra".

### Option B: BullMQ (Redis-backed job queues)

- **Description.** Job queues with retries, delays, and flows (parent/child jobs) on Redis.
- **Pros.** Simple mental model; good TS support; mature.
- **Cons.** Queues are not durable workflows: no long-lived orchestration state, no signals into a
  running execution, no deterministic replay, no wait-conditions spanning days. Multi-step
  processes become chained jobs with hand-managed state in Postgres — a worse version of Option A.
  Also reintroduces Redis, which the decision core deliberately excludes.
- **Rejected because** the abstraction grain is wrong (jobs ≠ workflows) and it violates the
  no-Redis constraint.

### Option C: n8n (embedded workflow automation)

- **Description.** Self-hostable visual automation platform with an execution engine.
- **Pros.** Self-hosted; visual debugging; many integration nodes.
- **Cons.** Built for human-designed automation flows, not programmatic, code-defined,
  signal-driven agent loops at the granularity of one workflow per task assignment. Workflow
  definitions would live in n8n's store (source-of-truth violation); no comparable determinism,
  typed activities, or TS-native workflow code.
- **Rejected because** wrong grain and wrong ownership model — it is a product, not an execution
  substrate.

### Option D: Temporal, self-hosted (chosen)

- **Description.** Temporal server (auto-setup image) in the compose stack, persistence in our
  Postgres instance (own schemas), TypeScript SDK, Temporal UI container for operators.
- **Pros.** Purpose-built durable execution: event-sourced histories, deterministic replay,
  per-activity retry policies, heartbeats, signals, timers, `continueAsNew`, child workflows;
  first-class TS SDK; battle-tested at far larger scales; UI gives free operational visibility
  into every agent's execution.
- **Cons.** Heaviest infra component in the stack (server + workers + UI); determinism rules
  constrain workflow code; SDK/server version compatibility must be managed; learning curve.

## Decision

**Temporal, self-hosted via docker compose**, is the only durable-execution engine. Persistence
uses the shared Postgres 16 instance under Temporal-owned schemas; `temporal-ui` ships in the
default compose profile.

What runs as **workflows** (long-lived, signal-driven, survives everything):
- `agentTaskWorkflow` — one per active task assignment (ADR-004), plus lightweight
  `agentInboxWorkflow` for messages to idle agents (_DECISIONS §14).
- Delegation workflows (decompose → assign → monitor cascades).
- `memoryConsolidationWorkflow` (_DECISIONS §10) — extraction → scoring → dedupe → persist.
- `projectIntakeWorkflow` (_DECISIONS §13) — analysis containers → Intake Report → routing tasks.
- Experiment workflows (Phase 2), media pipelines (Phase 2).

What runs as **activities** (all IO, individually retried, idempotent via idempotency keys):
- Every LLM call (via ModelRouter), Working-Set building (DB reads), tool executions routed through
  the Tool Gateway, sandbox commands via sandbox-manager, git operations, embedding calls, DB
  writes/event emission.

Bounding rules:
- Workflows contain **no IO** and no nondeterminism; all effects live in activities.
- `continueAsNew` after 50 steps or 5k history events (_DECISIONS §8) caps history growth.
- Long activities heartbeat; retries use exponential backoff with per-activity policies; verdicts
  and messages enter only as signals.
- Temporal is an execution substrate, not a store: domain truth stays in Postgres (`tasks`,
  `agent_steps`, `agent_sessions`); workflow state is always reconstructible from/reconciled with
  Postgres. Nothing reads Temporal histories as an API.

## Consequences

**Positive.**
- The brief's crash matrix is satisfied by construction: any process can die at any point and
  execution resumes from history on another worker.
- Retry/timeout/heartbeat policy becomes declarative configuration per activity instead of
  bespoke code.
- Temporal UI provides deep per-agent execution debugging on day one.

**Negative / accepted tradeoffs.**
- Temporal server is the largest single infra dependency (~memory footprint and moving parts);
  accepted as the price of not writing our own engine. Auto-setup single-container mode keeps
  compose simple at MVP scale.
- Determinism discipline (no Date.now, no random, versioned workflow code changes) is a real tax
  on contributors; mitigated with lint rules and SDK helpers.
- Workflow code deployments require Temporal versioning/patching practices for in-flight runs.

**Revisit triggers.**
- Temporal server resource use exceeds ~25% of the single-server baseline (8 cores/16GB) at spec
  scale — investigate tuning before considering alternatives.
- Temporal licensing/OSS posture changes materially.
- If a future "durable functions on Postgres" engine reaches maturity with TS support, evaluate
  only if Temporal ops burden is demonstrably hurting self-host adoption.

## References

- _BRIEF.md §2.9 (durable execution), §9 (reliability), §11 (MVP proof)
- _DECISIONS.md §1, §2, §8, §10, §13, §22 row 005
- ADR-002 (stack), ADR-003 (shared Postgres), ADR-004 (agent loop), ADR-006 (events)
