# ADR-007: Memory Storage — Postgres Relational + pgvector Hybrid, Consolidation via Temporal

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Memory is a core subsystem, not a feature (_BRIEF §3). Requirements that shape storage:

- **Three isolated scopes** (company, project, agent) with strict tenant isolation; eight memory
  types (semantic, episodic, procedural, decision, failure, experiment, relationship, artifact).
- **Rich structure per record:** source, evidence rows, scope, confidence, importance,
  version history, expiration, entities, typed relations (supports/contradicts/supersedes/
  derived_from/related_to) — this is relational data, not just text+vector.
- **Consolidation pipeline** (raw event → extraction → scoring → scope detection → dedupe →
  contradiction detection → persist) is a multi-step, LLM-heavy, failure-prone process that must be
  durable.
- **Promotion rules** with evidence thresholds (≥3 evidence rows across ≥2 tasks, lead approval…)
  require joins across memories, evidence, tasks, and approvals.
- **Retrieval** is hybrid: structured SQL (recent decisions, role procedures) plus semantic top-k
  with re-ranking `0.55·cosine + 0.2·importance + 0.15·recency + 0.1·confidence` under per-scope
  token budgets (_DECISIONS §10).
- **Memory Observatory** UI needs graph/timeline/list/search over real stored memories with full
  provenance — arbitrary filtered queries, not just nearest-neighbor.

## Options considered

### Option A: Pure vector store (Qdrant/Chroma/Weaviate) as the memory system

- **Description.** Memories as embedded documents with metadata payloads in a vector database;
  retrieval purely by similarity + metadata filters.
- **Pros.** Excellent ANN performance; simple ingestion; metadata filtering covers basic scoping.
- **Cons.** Loses the structure that defines this subsystem: evidence tables, typed relations,
  version history, promotion joins, contradiction links, and Observatory queries are relational
  workloads a vector store serves poorly or not at all. Cross-store consistency with tasks/events
  breaks single-transaction consolidation.
- **Rejected because** our memory is structured knowledge with provenance, not a similarity index;
  vectors are one retrieval signal among four in the ranking formula.

### Option B: Graph database (Neo4j) for memory relations

- **Description.** Memories and entities as a knowledge graph; relations as first-class edges.
- **Pros.** Natural fit for `memory_relations` and entity linking; expressive traversals.
- **Cons.** Our relation queries are one-hop (show contradictions, walk `derived_from` lineage) at
  bounded scale — plain foreign-key tables and recursive CTEs suffice. Adds a datastore the
  decision core excludes (ADR-003), splits transactions, and duplicates tenant isolation work.
- **Rejected because** unjustified at this scale; same reasoning as ADR-003 Option C.

### Option C: Hosted/embedded memory frameworks (Zep, Mem0)

- **Description.** Purpose-built agent-memory services: automatic extraction, summarization,
  temporal knowledge graphs (Zep), or memory layers with scoring (Mem0).
- **Pros.** They genuinely implement much of our pipeline (extraction, dedupe, relevance) and
  encode hard-won lessons; adopting one would shortcut months of consolidation tuning.
- **Cons.** They own the memory store and schema — a direct source-of-truth violation
  (_BRIEF §2.6): our scopes, promotion rules, evidence model, and confidence semantics would be
  bent to their model, and the Observatory would render their database, not ours. Multi-tenant
  isolation, budget-capped retrieval, and deterministic promotion rules are ours to enforce and
  audit.
- **Rejected because** memory is the product's core IP and must live in the domain schema;
  frameworks may inspire the pipeline but cannot hold the data.

### Option D: Postgres + pgvector hybrid, consolidation as Temporal workflows (chosen)

- **Description.** Full relational schema (`memories`, `memory_versions`, `memory_evidence`,
  `memory_relations`, promotion rules) in Postgres; `embedding vector` column with per-row model;
  `memoryConsolidationWorkflow` on Temporal orchestrates the pipeline.
- **Pros.** One store, real transactions, SQL for every Observatory view, vectors co-located with
  metadata for single-query filtered retrieval; durable, retryable consolidation.
- **Cons.** We build the entire pipeline ourselves; pgvector tuning is on us; LLM-based extraction
  quality is our ongoing responsibility.

## Decision

Memory storage is **PostgreSQL relational tables + pgvector**, exactly per _DECISIONS §10, with
consolidation and promotion running as **Temporal workflows**:

- Schema: `memories` (scope, scope_ref, type, content, summary, entities, importance, confidence,
  status lifecycle candidate→active→{superseded, archived, rejected}, source_event_id, embedding,
  embedding_model, …), `memory_versions`, `memory_evidence`, `memory_relations`.
- `memoryConsolidationWorkflow` triggers every N significant events or on task completion; each
  pipeline stage (LLM extraction, importance scoring, scope detection, embedding, pgvector
  similarity search, LLM merge/contradiction compare, persist) is an idempotent activity.
- Promotion is rule-driven (promotion rules table), never a single event → company scope; originals
  link via `derived_from`; approvals by owning lead/manager agents per _DECISIONS §10.
- Retrieval is implemented in the Working-Set builder activity: structured SQL queries + per-scope
  semantic top-k (cosine, filtered by company_id and scope) with the canonical re-ranking formula
  and per-scope token budgets (agent 1.5k, project 2.5k, company 1k).
- No external memory service ever holds memory state; any future extraction library runs inside
  activities as a stateless adapter.

## Consequences

**Positive.**
- Observatory provenance ("why does this memory exist") is a join, not an integration: evidence,
  source event, versions, and relations are foreign keys.
- Consolidation survives crashes mid-pipeline and retries LLM steps independently (ADR-005).
- Overlearning prevention is enforceable in SQL: promotion thresholds are queries over evidence,
  auditable and deterministic.

**Negative / accepted tradeoffs.**
- Extraction/scoring quality is entirely ours to tune; expect iterative prompt and threshold work
  post-MVP. Mitigated by the `candidate` status gate — bad candidates are discarded, not stored
  as active.
- pgvector shares resources with OLTP (see ADR-003 tradeoffs); HNSW index maintenance on large
  memory churn needs monitoring.
- Storing full version history and evidence grows storage faster than a naive design; accepted —
  provenance is a requirement, and expiration/archival states bound growth.

**Revisit triggers.**
- Retrieval precision measurably poor (agents repeatedly miss known-relevant memories in evals) →
  revisit ranking weights, add hybrid lexical search (Postgres FTS) before any new store.
- Memory corpus >5M active rows per installation or retrieval p95 >150ms → evaluate dedicated
  vector store for the ANN path only (metadata stays in Postgres).
- A mature open-source memory engine appears that can run **on our schema** — evaluate as a
  pipeline adapter.

## References

- _BRIEF.md §3 (memory subsystem), §2.6 (ownership)
- _DECISIONS.md §10 (memory architecture), §22 row 007
- ADR-003 (database), ADR-005 (Temporal), ADR-020 (embeddings strategy)
