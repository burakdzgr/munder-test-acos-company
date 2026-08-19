# ADR-019: ORM and Migrations — Drizzle ORM + drizzle-kit

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Postgres is the only database and the source of truth for everything (ADR-003); the schema is
large (~40+ tables across org, tasks, memory, skills, comms, approvals, events, costs, security)
and SQL-heavy. Forces:

- **SQL is load-bearing.** The design leans on Postgres specifics: recursive CTEs (org forest
  cycle checks, escalation chains), pgvector operators and HNSW indexes, partial/expression
  indexes, advisory locks, `FOR UPDATE` on sequence rows for gap-free event seq, JSONB payloads,
  materialized views for cost rollups, CHECK constraints on org edges (_DECISIONS §5, §9, §18).
  The data layer must expose SQL, not hide it.
- **Type safety end to end.** TS-strict codebase (ADR-002): schema types must flow into
  repositories and up to contracts without hand-written duplication.
- **Tenancy enforcement hook.** The repository layer must refuse tenant-table queries lacking a
  `company_id` filter via a wrapper (_DECISIONS §4) — the data layer needs to be wrappable and
  inspectable, not a black box.
- **Migrations in repo, run anywhere.** Self-hosters upgrade by pulling and restarting
  (ADR-018); migrations must be plain, reviewable SQL files applied automatically and
  deterministically, offline.

## Options considered

### Option A: Prisma

- **Description.** Schema-first ORM with its own DSL, generated client, and (historically) a
  Rust query engine; Prisma Migrate for migrations.
- **Pros.** Best-in-class DX for standard CRUD; mature migrations; huge community; recent
  versions move toward a pure-TS client, easing old deployment pains.
- **Cons.** Weaker SQL control is the disqualifier: pgvector columns/operators, recursive CTEs,
  advisory locks, and `SELECT ... FOR UPDATE` land in `$queryRaw` — outside the typed model, so
  the queries that matter most are the least safe. The proprietary schema DSL adds a second
  source of truth beside SQL; the query-engine binary (still the default in current LTS
  deployments) complicates our multi-arch self-hosted images. Its abstraction optimizes for the
  80% CRUD we could write easily anyway.
- **Rejected because** the query engine binary and weaker SQL control put our hardest queries
  outside the safety the ORM exists to provide.

### Option B: Knex (query builder) or raw SQL + hand types

- **Description.** Untyped query builder (Knex) or plain `pg` with hand-maintained TypeScript
  types; migrations via Knex or a runner like node-pg-migrate.
- **Pros.** Total SQL control; zero abstraction risk; minimal dependencies.
- **Cons.** Untyped: column renames and type changes become silent runtime failures across a
  40-table schema — precisely the drift class the strict-TS decision exists to kill. Hand-written
  row types rot; the tenancy wrapper loses schema metadata (which tables are tenant-owned) unless
  we rebuild a schema registry ourselves — at which point we've written a worse Drizzle.
- **Rejected because** no static typing between schema and queries; unacceptable maintenance
  hazard at this schema size.

### Option C: Drizzle ORM + drizzle-kit (chosen)

- **Description.** Schema defined in TypeScript (`packages/db`), inferring row/insert types;
  SQL-like typed query builder that stays 1:1 with SQL; drizzle-kit generates plain `.sql`
  migration files committed to the repo.
- **Pros.** SQL-first philosophy matches our design; full type inference with zero codegen step;
  the `sql` template escape hatch keeps raw fragments (vector ops, CTEs) *inside* typed queries;
  migrations are reviewable SQL; no runtime binary — plain TS on `pg`.
- **Cons.** Younger than Prisma; drizzle-kit diffing has rough edges (renames detected as
  drop+create, custom types need manual migration edits); fewer batteries (no built-in
  soft-delete/middleware conventions — we own repository patterns).

## Decision

The data layer is **Drizzle ORM with drizzle-kit migrations**, all in `packages/db`:

- **Schema in TS** (`packages/db/schema/*`): one file per domain area; snake_case DB naming
  (_DECISIONS §21); pgvector columns via Drizzle's custom-type support; CHECK constraints and
  partial indexes declared in schema or migration SQL.
- **Migrations:** drizzle-kit generates plain SQL files committed to the repo; generated SQL is
  reviewed like code (rename/custom-type cases hand-edited); applied automatically and
  idempotently by `apps/server` on startup via Drizzle's migrator under a Postgres advisory lock
  (safe with restarting containers, ADR-018). No down-migrations — recovery is restore-from-
  backup, documented in ops runbooks.
- **Repositories, not scattered queries:** all DB access goes through repository modules in
  `packages/db` that accept a `CompanyContext`; the **tenant-guard wrapper** (built on Drizzle's
  schema metadata marking tenant-owned tables) rejects tenant-table queries without a
  `company_id` predicate at runtime and in tests (_DECISIONS §4). Apps/workers never import `pg`
  or build ad-hoc SQL outside repositories (lint-enforced).
- Raw SQL via the typed `sql` template is expected and encouraged for CTEs, vector search, and
  locking reads — kept inside repositories with integration tests (Vitest + Testcontainers).
- Transactions are explicit repository-level primitives; the outbox write (event + state change,
  ADR-006) is a shared transactional helper so atomicity is impossible to skip.

## Consequences

**Positive.**
- Schema changes propagate as compile errors through repositories, services, and contracts —
  the 40-table schema stays refactorable.
- Our hardest queries (vector retrieval with re-ranking, recursive org walks, gap-free seq
  allocation) remain first-class, typed, and testable rather than stringly `$queryRaw` islands.
- Plain-SQL migrations make self-hosted upgrades transparent and auditable; no vendor DSL or
  binary in the deployment path.

**Negative / accepted tradeoffs.**
- We adopt drizzle-kit's diffing quirks: renames and custom-type changes require manual
  migration editing; mitigated by mandatory review of generated SQL and Testcontainers migration
  tests (fresh DB + upgrade-from-previous in CI).
- Fewer conventions out of the box means our repository patterns (soft deletes, audit stamping,
  tenant guard) are ours to build and enforce — accepted, since the tenant guard had to be
  bespoke anyway.
- Drizzle's API surface still evolves; version pinning and an upgrade cadence owned by CI.

**Revisit triggers.**
- A Drizzle limitation forces >20% of repository queries into raw `sql` fragments → reassess
  (the escape hatch should be the exception, not the norm).
- drizzle-kit migration generation causes a production-affecting fault despite review → switch
  migration authoring to hand-written SQL with drizzle-kit as verification only.
- Project abandonment/stagnation of Drizzle → migration path is tractable (schema is TS + plain
  SQL migrations), evaluate successors then.

## References

- _DECISIONS.md §1 (ORM row), §4 (tenancy), §5, §9, §18 (SQL-heavy features), §21 (naming),
  §22 row 019
- _BRIEF.md §2.11 (tenant isolation)
- ADR-003 (database), ADR-006 (outbox transaction), ADR-018 (migrations on deploy)
