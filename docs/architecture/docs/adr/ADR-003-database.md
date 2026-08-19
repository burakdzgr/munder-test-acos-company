# ADR-003: Database — PostgreSQL 16 + pgvector as the Only Database

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The system's data is unusually diverse for one product: relational domain state (companies, agents,
tasks with a DAG of dependencies, approvals, budgets), an org **graph** with typed edges
(_DECISIONS §5), an append-only **event log** in the millions of rows (_BRIEF §10), **vector**
embeddings for semantic memory retrieval (_DECISIONS §10), cache/locks, and audit data. Forces:

- **Domain core owns everything** (_BRIEF §2.6). Every piece of state must live where the domain
  can transact over it — especially events, which must commit atomically with state changes
  (transactional outbox, ADR-006).
- **Local-first ops.** Every datastore added to the compose file is another thing the Founder must
  back up, monitor, and upgrade. The decision core is explicit: smallest coherent stack, no Redis,
  no Neo4j, no separate vector DB in MVP.
- **Scale is bounded.** Millions of events over time, large memory collections, thousands of tasks
  — comfortably inside single-node Postgres with sane indexes and partitioning headroom.
- **Consistency requirements.** Task state transitions, gap-free per-company event sequences
  (locked sequence rows), budget checks, and permission grants all need real transactions.

## Options considered

### Option A: MongoDB (document store) as primary

- **Description.** Store agents, tasks, memories, events as documents; use Atlas-style search or a
  bolt-on for vectors.
- **Pros.** Flexible schema during early iteration; JSONB-like payloads are natural documents.
- **Cons.** The domain is deeply relational: org edges with cycle checks (recursive CTEs), task
  dependency DAGs, per-company gap-free sequences, cross-entity transactional writes (state change
  + outbox event). Multi-document transactions exist in Mongo but are the awkward path, not the
  paved one. Referential integrity and the Drizzle/SQL-first approach (ADR-019) are lost.
- **Rejected because** the domain is relational at its core; JSONB columns already cover the
  document-shaped parts (payloads, context, employment).

### Option B: Postgres + dedicated vector database (Qdrant/Weaviate/Milvus)

- **Description.** Postgres for domain state; a separate vector DB for memory embeddings.
- **Pros.** Purpose-built ANN performance, richer vector-specific features (quantization, hybrid
  search built in), independent scaling of the retrieval path.
- **Cons.** Two datastores to run, back up, and keep consistent; memory rows and their embeddings
  split across systems, so consolidation (dedupe, contradiction linking, promotion) loses
  single-transaction semantics; tenant isolation must be re-implemented in the vector store. At
  our corpus size (large but not internet-scale; per-scope top-k over per-company subsets),
  pgvector HNSW is more than adequate.
- **Rejected because** the ops cost buys performance we do not need; pgvector keeps embeddings in
  the same row as memory metadata, filterable by company/scope/type in one SQL query.

### Option C: Postgres + Neo4j for the org/memory graphs

- **Description.** Property graph database for org edges, memory relations, relationship strength.
- **Pros.** Native graph traversals; Cypher is expressive for path queries.
- **Cons.** Our graph queries are shallow and bounded: escalation chain = walk `reports_to` upward
  through a forest of ≤100 nodes per company (one recursive CTE); memory relations are one-hop
  lookups. No query in the spec needs variable-length pattern matching at scale. A second
  transactional store again breaks atomicity with domain writes.
- **Rejected because** the edges fit relational tables at this scale; a graph DB is unjustified
  operational weight (explicitly excluded by the decision core).

### Option D: PostgreSQL 16 + pgvector, the only database (chosen)

- **Description.** One Postgres 16 instance holds all domain state, the events table, memories
  with `vector` columns, cache/locks (advisory locks, unlogged tables), and audit logs. Temporal's
  own persistence uses a separate schema in the same instance.
- **Pros.** One backup, one upgrade path, real transactions across every concern, SQL-first with
  Drizzle, RLS available for Phase 3 defense in depth.
- **Cons.** All eggs in one basket (mitigated: WAL archiving/pgBackRest guidance in ops docs);
  vector and OLTP workloads share resources; HNSW index builds compete with foreground traffic.

## Decision

**PostgreSQL 16 with the pgvector extension is the only database.** It is the source of truth for
all domain state, the append-only `events` table, memory records including embeddings, advisory
locks and unlogged cache tables (no Redis), and the audit log.

Bounding rules:

- The `events` table is append-only with per-company gap-free `seq` (sequence row locked in the
  writing transaction) — ADR-006 builds on this.
- Embedding vectors live on `memories.embedding` with `embedding_model` per row; one HNSW index
  per active dimension config (ADR-020). Vector search always filters by `company_id` and scope.
- Cache and coordination needs use Postgres primitives: advisory locks for leader election
  (outbox relay) and soft file locks; unlogged tables for ephemeral caches. Redis is introduced
  only via a future ADR under measured load.
- Temporal server persistence shares the Postgres instance under its own schemas/databases —
  operationally one container, logically separate.
- App-level tenant filtering is mandatory from day one (repository wrapper refuses tenant-table
  queries without `company_id`); Postgres RLS added in Phase 3.

## Consequences

**Positive.**
- Transactional outbox is trivial and correct: state change + event in one commit.
- One `pg_dump`/pgBackRest job backs up the entire company: org, tasks, memories, vectors, events.
- Semantic retrieval composes with relational filters in one query — scope, type, importance,
  confidence, recency re-ranking as SQL (_DECISIONS §10).

**Negative / accepted tradeoffs.**
- Single-instance Postgres is the system's availability bottleneck; accepted for a self-hosted
  single-server product. Read replicas are the first scaling lever if needed.
- Millions of events will eventually want partitioning (by company or month); we accept deferring
  declarative partitioning until row counts demand it (~50M+).
- pgvector HNSW recall/latency is below dedicated engines at very large corpus sizes; accepted
  within spec scale.

**Revisit triggers.**
- p95 memory-retrieval query >150ms with tuned HNSW at target corpus size → re-evaluate a
  dedicated vector store (Option B) for the retrieval path only.
- Events table >50M rows or write contention on the per-company sequence row → introduce
  partitioning / batch sequence allocation.
- A real multi-hop graph query requirement emerges (e.g. Phase 2 relationship analytics) that
  recursive CTEs cannot serve interactively.

## References

- _DECISIONS.md §1, §4 (tenancy), §5 (org graph), §9 (events), §10 (memory), §22 row 003
- _BRIEF.md §3 (memory), §10 (scale)
- ADR-006 (event bus), ADR-007 (memory storage), ADR-019 (ORM), ADR-020 (embeddings)
