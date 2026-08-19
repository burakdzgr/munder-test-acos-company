# ADR-006: Event Bus — Postgres Transactional Outbox + NATS JetStream Distribution

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The system is event-driven by domain rule: all significant behavior emits persisted, versioned,
schema'd events, and the UI digital twin renders ONLY real events (_BRIEF §2.8). Events also feed
memory consolidation triggers, relationship-strength recomputation, cost rollups, and the global
company timeline with reconnect/replay (_BRIEF §8). Forces:

- **Atomicity.** An event must never exist without its state change or vice versa. Task status
  changes and their `task.status.changed` events must commit together.
- **Ordering & replay.** The frontend resumes streams via per-company monotonic sequence numbers
  (_DECISIONS §16); consumers need durable cursors, redelivery, and DLQ.
- **Volume.** Millions of events over time, but modest rates: tens/second peak at 5–30 active
  agents. Terminal output is the exception — high-frequency frames explicitly bypass the event
  store (_DECISIONS §9, §16).
- **Ops minimalism.** Single server, docker compose, one operator. Kafka-class infrastructure is
  out of proportion; the decision core mandates the smallest coherent stack.

## Options considered

### Option A: Apache Kafka (or Redpanda)

- **Description.** Distributed log as the event backbone; possibly event-sourcing from Kafka.
- **Pros.** Industry-standard durability, partitioned ordering, replay, huge ecosystem; Redpanda
  reduces the ops burden somewhat.
- **Cons.** Broker cluster semantics, partition management, and JVM (Kafka) tuning for a workload
  of tens of events/second is grotesque overprovisioning. If Kafka were the source of truth, we'd
  lose transactional atomicity with Postgres state; if not, it is only a distribution layer — a
  role a 20MB NATS binary fills.
- **Rejected because** operational weight is unjustified by orders of magnitude at spec scale.

### Option B: RabbitMQ

- **Description.** Mature AMQP broker for pub/sub and work queues.
- **Pros.** Solid delivery guarantees, flexible routing, well understood.
- **Cons.** Classic queues delete on consume — **no replay**: the resumable per-company stream and
  late-joining consumers (e.g. a rebuilt projection) need log semantics RabbitMQ (pre-Streams)
  does not provide; RabbitMQ Streams exists but then we are choosing a heavier Erlang broker for
  the same log semantics JetStream gives in one small Go binary.
- **Rejected because** no (or bolted-on) replay; heavier than NATS for our needs.

### Option C: Redis Streams

- **Description.** Redis as broker: streams with consumer groups.
- **Pros.** Simple, fast, consumer groups give cursors and pending-entry redelivery.
- **Cons.** Adds Redis to the stack, which the decision core deliberately excludes (cache/locks
  are Postgres). Durability is weaker by default (RDB/AOF tradeoffs, replication async); retention
  and DLQ patterns are DIY. Choosing it would add a datastore *and* deliver weaker semantics than
  JetStream.
- **Rejected because** it violates the no-Redis constraint while offering weaker durability
  semantics than the alternative.

### Option D: Postgres only — LISTEN/NOTIFY (+ polling)

- **Description.** No broker: outbox table + LISTEN/NOTIFY to wake consumers; each consumer keeps
  a cursor over `events`.
- **Pros.** Zero new infrastructure; truly minimal.
- **Cons.** NOTIFY is fire-and-forget (lost on disconnect, 8KB payload cap, no durable consumer
  state built in); every consumer must implement polling fallback, cursor management, redelivery,
  and DLQ by hand; terminal-frame fan-out (high-frequency ephemeral streams) has no good home.
  Honest at tiny scale, but pushes bespoke reliability code into every consumer.
- **Rejected because** no durable consumers/DLQ out of the box; the per-consumer machinery we'd
  write approximates a worse JetStream. It remains the conceptual fallback if NATS were ever
  removed.

### Option E: Postgres transactional outbox + NATS JetStream (chosen)

- **Description.** Append-only `events` table written in the same transaction as state changes;
  a relay publishes committed events to JetStream; consumers use durable JetStream subscriptions.
- **Pros.** Atomicity from Postgres; distribution, durable consumers, replay, and DLQ from a
  single small binary; ephemeral NATS subjects handle terminal frames outside the event store.
- **Cons.** One more infra container; at-least-once delivery requires idempotent consumers; relay
  is a component to build and monitor.

## Decision

**The Postgres `events` table is the event source of truth; NATS JetStream is distribution
only.** Precisely:

- Every significant state change writes its event row **in the same Postgres transaction**
  (_DECISIONS §9): uuidv7 id, per-company gap-free `seq`, type, version, actor, subject refs,
  correlation/causation ids, Zod-validated payload from `packages/events`.
- The **outbox relay** (in `apps/server`, leader-elected via Postgres advisory lock) publishes
  committed rows to JetStream subject `co.<company_id>.<type>` and stamps `published_at`.
  At-least-once; order per company preserved by seq.
- **Consumers** (workers, projections, WebSocket gateway fan-out) use durable JetStream consumers
  and are idempotent (dedupe on event id). After max deliveries, messages go to a DLQ →
  `dead_events` table + alert.
- **Replay** for UI resume reads from the `events` table by `(company_id, seq)` — never from
  JetStream; JetStream retention is a distribution window, not an archive.
- **Terminal frames** (`workspace.terminal.output`) go only to NATS ephemeral subjects + ring
  buffer + rolling files — never the events table (_DECISIONS §9, §16).
- No consumer may treat JetStream as authoritative; rebuilding any projection from the events
  table must always be possible.

## Consequences

**Positive.**
- Zero dual-write risk: the event exists iff the transaction committed.
- Durable consumers, redelivery, and DLQ are configuration, not code; NATS adds one small
  container to compose.
- The digital-twin guarantee holds structurally: the UI can only ever see committed domain events.

**Negative / accepted tradeoffs.**
- Relay adds latency (commit → publish, typically <100ms with LISTEN/NOTIFY wake-up on the relay);
  accepted — the UI tolerates sub-second event latency.
- At-least-once means every consumer must dedupe; enforced by a shared consumer helper in
  `packages/events`.
- Leader-elected relay is a single active publisher; throughput ceiling irrelevant at spec scale.
- Per-company gap-free seq serializes event writes per company (sequence row lock); acceptable at
  tens of events/second, a known hotspot beyond that.

**Revisit triggers.**
- Sustained event rate >500/s per company or relay lag >2s p95 → shard relay by company / batch
  publishing; re-examine seq allocation.
- A second installation-external consumer ecosystem emerges (webhooks at scale) → consider
  JetStream retention as a serving tier with snapshotting.
- NATS proves operationally problematic → fall back to Option D machinery (the outbox already
  makes this possible without data loss).

## References

- _BRIEF.md §2.8 (event-driven), §8 (timeline, live UI), §9 (reliability)
- _DECISIONS.md §9 (events), §16 (realtime protocol), §22 row 006
- ADR-003 (database), ADR-005 (Temporal consumers), ADR-008 (WebSocket replay)
