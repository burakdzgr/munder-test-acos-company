// Memory + Decisions/Experiments/Incidents (20 §10–11) — migration 0007.
// The two HNSW partial expression indexes on memories (per embedding
// dimension, ADR-020) are hand-audited into the generated SQL.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { jsonb } from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { tasks } from "./tasks.js";

/** pgvector without typmod — dimension varies per model (ADR-020). */
const vector = customType<{ data: string }>({
  dataType() {
    return "vector";
  },
});

/** 10.1 memories */
export const memories = pgTable(
  "memories",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    scope: text("scope").notNull(),
    scopeRef: uuid("scope_ref"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary").notNull(),
    entities: jsonb("entities").notNull().default(sql`'{}'::jsonb`),
    importance: real("importance").notNull(),
    confidence: real("confidence").notNull(),
    status: text("status").notNull().default("candidate"),
    sourceEventId: uuid("source_event_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    retrievalCount: integer("retrieval_count").notNull().default(0),
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingDim: smallint("embedding_dim"),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memories_scope_window_idx").on(t.companyId, t.scope, t.scopeRef, t.status),
    index("memories_company_type_status_idx").on(t.companyId, t.type, t.status),
    index("memories_candidate_pidx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.status} = 'candidate'`),
    index("memories_entities_gin").using("gin", sql`${t.entities} jsonb_path_ops`),
    index("memories_title_trgm_gin").using("gin", sql`${t.title} gin_trgm_ops`),
    check("memories_scope_check", sql`${t.scope} IN ('company','project','agent')`),
    check("memories_scope_ref_check", sql`(${t.scope} = 'company') = (${t.scopeRef} IS NULL)`),
    check(
      "memories_type_check",
      sql`${t.type} IN ('semantic','episodic','procedural','decision','failure','experiment','relationship','artifact')`,
    ),
    check("memories_importance_check", sql`${t.importance} BETWEEN 0 AND 1`),
    check("memories_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
    check(
      "memories_status_check",
      sql`${t.status} IN ('candidate','active','superseded','archived','rejected')`,
    ),
  ],
);

/** 10.2 memory_versions */
export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary").notNull(),
    importance: real("importance").notNull(),
    confidence: real("confidence").notNull(),
    status: text("status").notNull(),
    changedBy: text("changed_by").notNull(),
    changedByRef: uuid("changed_by_ref"),
    changeReason: text("change_reason"),
  },
  (t) => [
    uniqueIndex("memory_versions_memory_version_uq").on(t.memoryId, t.version),
    check("memory_versions_changed_by_check", sql`${t.changedBy} IN ('system','agent','founder')`),
  ],
);

/** 10.3 memory_evidence */
export const memoryEvidence = pgTable(
  "memory_evidence",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    weight: real("weight").notNull().default(1.0),
  },
  (t) => [
    index("memory_evidence_memory_idx").on(t.memoryId),
    index("memory_evidence_company_ref_idx").on(t.companyId, t.ref),
    check(
      "memory_evidence_kind_check",
      sql`${t.kind} IN ('event','artifact','review','metric','statement','incident')`,
    ),
    check("memory_evidence_weight_check", sql`${t.weight} BETWEEN 0 AND 1`),
  ],
);

/** 10.4 memory_relations */
export const memoryRelations = pgTable(
  "memory_relations",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    fromMemoryId: uuid("from_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    toMemoryId: uuid("to_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("memory_relations_triple_uq").on(t.fromMemoryId, t.toMemoryId, t.kind),
    index("memory_relations_to_idx").on(t.toMemoryId),
    check(
      "memory_relations_kind_check",
      sql`${t.kind} IN ('supports','contradicts','supersedes','derived_from','related_to')`,
    ),
    check("memory_relations_created_by_check", sql`${t.createdBy} IN ('system','agent','founder')`),
    check("memory_relations_no_self_check", sql`${t.fromMemoryId} <> ${t.toMemoryId}`),
  ],
);

/** 10.5 memory_promotions */
export const memoryPromotions = pgTable(
  "memory_promotions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    sourceMemoryId: uuid("source_memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "restrict" }),
    targetScope: text("target_scope").notNull(),
    targetRef: uuid("target_ref"),
    targetMemoryId: uuid("target_memory_id").references(() => memories.id, {
      onDelete: "restrict",
    }),
    evidenceCount: integer("evidence_count").notNull().default(0),
    distinctTaskCount: integer("distinct_task_count").notNull().default(0),
    status: text("status").notNull().default("proposed"),
    approverAgentId: uuid("approver_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    // FK to policies appended at the end of migration 0009.
    rulePolicyId: uuid("rule_policy_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("memory_promotions_proposed_pidx")
      .on(t.companyId)
      .where(sql`${t.status} = 'proposed'`),
    check("memory_promotions_target_scope_check", sql`${t.targetScope} IN ('project','company')`),
    check(
      "memory_promotions_status_check",
      sql`${t.status} IN ('proposed','approved','rejected')`,
    ),
  ],
);

/**
 * 12 §4.5 memory_retrievals — UNLOGGED observability table (T45): one row per
 * Working-Set build with the returned id array; a per-minute batch aggregates
 * into memories.retrieval_count (12 §7.4) and sweeps rows older than 14 days.
 * UNLOGGED is hand-audited into the migration (drizzle has no flag for it);
 * crash-loss of ≤1 minute of usage counters is accepted.
 */
export const memoryRetrievals = pgTable(
  "memory_retrievals",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id"),
    taskId: uuid("task_id"),
    lane: text("lane").notNull().default("working_set"),
    queryRef: text("query_ref"),
    returnedIds: uuid("returned_ids").array().notNull().default(sql`'{}'::uuid[]`),
    scores: real("scores").array().notNull().default(sql`'{}'::real[]`),
    budgetTokensUsed: integer("budget_tokens_used").notNull().default(0),
    empty: boolean("empty").notNull().default(false),
    // §7.5 degradation flags: budget starvation ≥50%, semantic lane skipped,
    // latency above the 1.5s threshold
    truncated: boolean("truncated").notNull().default(false),
    semanticSkipped: boolean("semantic_skipped").notNull().default(false),
    slow: boolean("slow").notNull().default(false),
    durationMs: integer("duration_ms").notNull().default(0),
    counted: boolean("counted").notNull().default(false),
  },
  (t) => [
    index("memory_retrievals_uncounted_pidx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.counted} = false`),
    index("memory_retrievals_company_created_idx").on(t.companyId, t.createdAt),
  ],
);

/** 11.1 decisions */
export const decisions = pgTable(
  "decisions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("proposed"),
    contextMd: text("context_md").notNull(),
    decisionMd: text("decision_md").notNull(),
    consequencesMd: text("consequences_md"),
    decidedByAgentId: uuid("decided_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    supersedesDecisionId: uuid("supersedes_decision_id").references(
      (): AnyPgColumn => decisions.id,
      { onDelete: "restrict" },
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("decisions_company_number_uq").on(t.companyId, t.number),
    index("decisions_project_status_idx").on(t.projectId, t.status),
    check(
      "decisions_status_check",
      sql`${t.status} IN ('proposed','accepted','superseded','deprecated','rejected')`,
    ),
  ],
);

/** 11.2 experiments */
export const experiments = pgTable(
  "experiments",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    ownerAgentId: uuid("owner_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    hypothesisMd: text("hypothesis_md").notNull(),
    baselineMd: text("baseline_md"),
    variantMd: text("variant_md"),
    metricDefs: jsonb("metric_defs").notNull().default(sql`'[]'::jsonb`),
    sampleSize: integer("sample_size"),
    status: text("status").notNull().default("designed"),
    decisionMd: text("decision_md"),
    learningMemoryId: uuid("learning_memory_id").references(() => memories.id, {
      onDelete: "restrict",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("experiments_company_status_idx").on(t.companyId, t.status),
    check(
      "experiments_status_check",
      sql`${t.status} IN ('designed','baseline','running','analyzing','adopted','rejected','inconclusive')`,
    ),
  ],
);

/** 11.3 experiment_results */
export const experimentResults = pgTable(
  "experiment_results",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    arm: text("arm").notNull(),
    metricKey: text("metric_key").notNull(),
    value: numeric("value").notNull(),
    sample: integer("sample"),
    confidence: real("confidence"),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("experiment_results_series_idx").on(t.experimentId, t.metricKey, t.measuredAt),
    check("experiment_results_arm_check", sql`${t.arm} IN ('baseline','variant')`),
    check(
      "experiment_results_confidence_check",
      sql`${t.confidence} BETWEEN 0 AND 1`,
    ),
  ],
);

/** 11.4 incidents — postmortem columns here; learnings are failure memories. */
export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    number: integer("number").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    summaryMd: text("summary_md").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    detectedByAgentId: uuid("detected_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    mitigatedAt: timestamp("mitigated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    postmortemMd: text("postmortem_md"),
    postmortemStatus: text("postmortem_status").notNull().default("pending"),
  },
  (t) => [
    uniqueIndex("incidents_company_number_uq").on(t.companyId, t.number),
    index("incidents_live_pidx")
      .on(t.companyId, t.severity)
      .where(sql`${t.status} IN ('open','mitigated')`),
    check("incidents_severity_check", sql`${t.severity} IN ('sev1','sev2','sev3','sev4')`),
    check(
      "incidents_status_check",
      sql`${t.status} IN ('open','mitigated','resolved','closed')`,
    ),
    check(
      "incidents_postmortem_status_check",
      sql`${t.postmortemStatus} IN ('pending','drafted','reviewed','published')`,
    ),
  ],
);
