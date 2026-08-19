# ADR-020: Embeddings Strategy — Per-Row Model + Dimension, HNSW Indexes, Per-Company Config

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Semantic retrieval is a required memory capability: consolidation dedupes candidates by
similarity, and the Working-Set builder runs semantic top-k per scope with re-ranking
(_DECISIONS §10). Embeddings also serve Phase 2 asset-library search (_BRIEF §7). Forces:

- **Two very different providers must work.** Default online: OpenAI `text-embedding-3-small`
  (1536d). Offline profile: Ollama `nomic-embed-text` (768d) (_DECISIONS §1). Embeddings from
  different models are **not comparable** — mixed-model cosine similarity is meaningless, and
  dimensions differ, so the schema must track provenance per vector.
- **Per-company configuration.** Companies on one installation may differ (one privacy-sensitive
  company runs local models; another uses OpenAI); embedding choice follows company
  `model_profiles` via the ModelRouter `embed()` port (ADR-015).
- **Config can change.** A Founder may switch a company from offline to OpenAI later; existing
  vectors then mismatch the new query model. The design must degrade gracefully and allow
  re-embedding without downtime or data loss (memory *content* is the truth; vectors are derived).
- **Scale.** Large memory collections, but per-company and per-scope subsets are what's queried;
  pgvector HNSW comfortably serves this (ADR-003/007).

## Options considered

### Option A: Single fixed embedding model platform-wide

- **Description.** Hard-pick one model (e.g. `text-embedding-3-small`, 1536d); one vector column,
  one index; all companies use it.
- **Pros.** Simplest possible schema and query path; uniform similarity semantics; one index to
  tune.
- **Cons.** Makes the offline/Ollama profile impossible — a supported deployment mode
  (_DECISIONS §0 A3) — and forces privacy-sensitive companies to ship memory text to OpenAI.
  Any future model migration becomes a big-bang re-embed with no transitional state.
- **Rejected because** offline mode impossible; violates per-company privacy routing.

### Option B: No vectors — lexical search only (Postgres FTS/trigram)

- **Description.** Skip embeddings; retrieval via full-text search, trigram similarity, and
  structured filters.
- **Pros.** Zero external calls; no model dependency at all; FTS is cheap and well understood.
- **Cons.** The brief explicitly requires semantic retrieval where it helps (_BRIEF §3): memory
  consolidation's dedupe/similarity stage and "find memories about this kind of problem" fail on
  synonymy/paraphrase, which is the common case for LLM-authored memories. Lexical is a
  complement, not a substitute.
- **Rejected because** semantic retrieval is required; FTS remains a candidate *additional*
  signal (ADR-007 revisit trigger), not the strategy.

### Option C: Fixed model per installation (env-level choice)

- **Description.** One embedding model chosen at install time in `.env`; per-row bookkeeping
  avoided.
- **Pros.** Nearly as simple as Option A while allowing offline installs.
- **Cons.** Breaks per-company privacy routing on multi-company installations (all companies
  share the install-level choice); config changes still strand all existing vectors with no
  recorded provenance — you cannot even tell which model produced a stored vector, making safe
  migration impossible.
- **Rejected because** per-company configuration is canonical (_DECISIONS §1) and silent
  provenance loss makes evolution unsafe.

### Option D: Per-row model + dimension, HNSW per active dimension, per-company config (chosen)

- **Description.** Store `embedding_model` beside each vector; company profiles choose the
  model; indexes exist per active dimension configuration; queries filter to the query-model's
  rows.
- **Pros.** Offline and online coexist; switching models is an online, incremental migration;
  similarity is always computed within one model's space.
- **Cons.** Schema/query complexity (model predicate everywhere); transitional states where some
  rows aren't yet re-embedded; multiple indexes cost memory.

## Decision

Embeddings follow **per-row provenance with per-company configuration**, per _DECISIONS §1, §10:

- **Storage:** `memories.embedding vector` + `memories.embedding_model` (and the dimension
  implied by config) on every embedded row. Defaults: OpenAI `text-embedding-3-small` (1536d)
  online; Ollama `nomic-embed-text` (768d) offline. Vectors are derived data — content/summary
  columns are authoritative; any vector can be regenerated.
- **Configuration:** the company `model_profiles` purpose `embedding` selects provider+model; all
  embedding calls go through ModelRouter `embed()` (ADR-015) — call sites never know which model
  runs, and costs land in `llm_calls`/`cost_entries`.
- **Indexing:** one **HNSW index per active dimension config** (partial index
  `WHERE embedding_model = ...` per model in use), cosine distance opclass. Indexes are created
  when a company first activates a config and dropped when no rows remain.
- **Querying:** semantic retrieval embeds the query with the company's current embedding config
  and searches **only rows with the matching `embedding_model`**, always filtered by
  `company_id` + scope. Cross-model comparison is forbidden at the repository layer.
- **Model change = re-embed migration:** switching a company's embedding config enqueues a
  background Temporal workflow (`reembedMemoriesWorkflow`) that re-embeds rows in batches
  (rate-limited, budget-tracked). Until complete, retrieval over not-yet-migrated rows falls back
  to structured/recency signals of the ranking formula; the Observatory shows migration progress.
  Old-model rows are re-embedded in place, never deleted.

## Consequences

**Positive.**
- Both deployment profiles (online, fully offline) and per-company privacy routing work on one
  schema; a single installation can host an Ollama-only company beside an OpenAI company.
- Model evolution is routine: provenance per row makes re-embedding incremental, resumable
  (Temporal), and auditable — never a big-bang or a silent corruption of similarity semantics.
- Correctness guarantee: similarity scores are always intra-model, so ranking weights
  (_DECISIONS §10) stay meaningful.

**Negative / accepted tradeoffs.**
- Every vector query carries a model predicate and every write records provenance — modest,
  permanent complexity tax; centralized in the memory repository so call sites stay clean.
- During re-embed migrations, retrieval quality is temporarily degraded for unmigrated rows;
  accepted and surfaced in UI rather than hidden.
- Multiple HNSW indexes consume memory; bounded in practice (installations run 1–2 active
  configs).

**Revisit triggers.**
- Retrieval quality of the offline model measurably hurts agent performance (eval suite) →
  evaluate newer local embedding models; the per-row design makes adoption cheap.
- More than 3 active embedding configs per installation observed in practice → add config
  lifecycle management (forced consolidation to fewer models).
- pgvector limitations at corpus growth (see ADR-003/007 triggers) → any external ANN store must
  preserve the per-model partitioning invariant.

## References

- _BRIEF.md §3 (memory, hybrid storage), §7 (asset library, Phase 2)
- _DECISIONS.md §1 (embeddings row), §10 (retrieval/ranking), §17 (model profiles), §22 row 020
- ADR-003 (pgvector), ADR-007 (memory storage), ADR-015 (ModelRouter embed port)
