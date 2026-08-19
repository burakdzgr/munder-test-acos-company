// Workspaces & Terminals + Costs & Budgets (20 §13–14) — migration 0010.
// cost_entries is a partitioned parent (monthly RANGE on occurred_at) and the
// cost_rollup_daily materialized view is appended — both hand-audited.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, idColumn } from "./common.js";
import { companyId } from "./companies.js";
import { agents } from "./agents.js";
import { modelProviders } from "./identity.js";
import { projects, repositories } from "./projects.js";
import { tasks } from "./tasks.js";

/** 14.1 workspaces */
export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "restrict",
    }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    isolationLevel: text("isolation_level").notNull(),
    image: text("image").notNull(),
    containerId: text("container_id"),
    branch: text("branch"),
    volumePath: text("volume_path"),
    status: text("status").notNull().default("provisioning"),
    limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
  },
  (t) => [
    index("workspaces_live_pidx")
      .on(t.companyId, t.status)
      .where(sql`${t.status} NOT IN ('destroyed')`),
    uniqueIndex("workspaces_task_level_live_uq")
      .on(t.taskId, t.isolationLevel)
      .where(sql`${t.status} NOT IN ('merged','discarded','failed','destroyed')`),
    index("workspaces_project_idx").on(t.projectId),
    check(
      "workspaces_isolation_level_check",
      sql`${t.isolationLevel} IN ('analysis','coding','testing','deploy','browser','media')`,
    ),
    check(
      "workspaces_status_check",
      sql`${t.status} IN ('provisioning','ready','in_use','idle','merged','discarded','failed','destroyed')`,
    ),
  ],
);

/** 14.2 workspace_locks — soft locks: warn, don't block. */
export const workspaceLocks = pgTable(
  "workspace_locks",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    pathPrefix: text("path_prefix").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    index("workspace_locks_overlap_pidx")
      .on(t.repositoryId, t.pathPrefix)
      .where(sql`${t.releasedAt} IS NULL`),
  ],
);

/** 14.3 terminal_sessions */
export const terminalSessions = pgTable(
  "terminal_sessions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    cols: smallint("cols").notNull().default(120),
    rows: smallint("rows").notNull().default(32),
    logPath: text("log_path").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("terminal_sessions_active_pidx")
      .on(t.companyId)
      .where(sql`${t.status} = 'active'`),
    check("terminal_sessions_status_check", sql`${t.status} IN ('active','closed')`),
  ],
);

/** 13.1 budgets */
export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    scopeKind: text("scope_kind").notNull(),
    scopeRef: uuid("scope_ref"),
    period: text("period").notNull(),
    limitCents: bigint("limit_cents", { mode: "number" }).notNull(),
    kind: text("kind").notNull().default("soft"),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("budgets_scope_period_uq").on(
      t.companyId,
      t.scopeKind,
      sql`coalesce(${t.scopeRef}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.period,
    ),
    check(
      "budgets_scope_kind_check",
      sql`${t.scopeKind} IN ('company','org_unit','project','task','agent')`,
    ),
    check(
      "budgets_scope_ref_check",
      sql`(${t.scopeKind} = 'company') = (${t.scopeRef} IS NULL)`,
    ),
    check("budgets_period_check", sql`${t.period} IN ('daily','weekly','monthly','total')`),
    check("budgets_limit_check", sql`${t.limitCents} > 0`),
    check("budgets_kind_check", sql`${t.kind} IN ('hard','soft')`),
  ],
);

/** 13.2 cost_entries — PARTITIONED; PK (id, occurred_at). */
export const costEntries = pgTable(
  "cost_entries",
  {
    id: idColumn(),
    companyId: companyId(),
    createdAt: createdAt(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    agentId: uuid("agent_id"),
    taskId: uuid("task_id"),
    projectId: uuid("project_id"),
    orgUnitId: uuid("org_unit_id"),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    quantity: numeric("quantity"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index("cost_entries_company_occurred_idx").on(t.companyId, t.occurredAt),
    index("cost_entries_task_occurred_idx").on(t.taskId, t.occurredAt),
    index("cost_entries_agent_occurred_idx").on(t.agentId, t.occurredAt),
    index("cost_entries_project_occurred_idx").on(t.projectId, t.occurredAt),
    check("cost_entries_kind_check", sql`${t.kind} IN ('llm','tool','compute','media','api')`),
    // 26 §1.1: the ledger is append-only and corrections are COMPENSATING
    // entries (negative amount, `ref` at the corrected entry) — never updates.
    // A `>= 0` check made the documented correction path impossible, so it was
    // dropped in 0015. `kind` stays constrained; the sign does not.
  ],
);

/** 13.3 llm_calls — every model call; not partitioned in MVP. */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    agentSessionId: uuid("agent_session_id"),
    purpose: text("purpose").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCached: integer("tokens_cached").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    error: text("error"),
    fallbackRank: smallint("fallback_rank").notNull().default(0),
    correlationId: uuid("correlation_id"),
    // LIVE-CONSOLE TASK 7: working-set bölüm token dağılımı (migration 0025)
    contextTelemetry: jsonb("context_telemetry"),
  },
  (t) => [
    index("llm_calls_company_created_idx").on(t.companyId, sql`${t.createdAt} DESC`),
    index("llm_calls_agent_created_idx").on(t.agentId, sql`${t.createdAt} DESC`),
    index("llm_calls_provider_unhealthy_pidx")
      .on(t.providerId, t.createdAt)
      .where(sql`${t.status} <> 'ok'`),
    check(
      "llm_calls_purpose_check",
      sql`${t.purpose} IN ('reasoning','coding','fast','embedding','vision')`,
    ),
    check(
      "llm_calls_status_check",
      sql`${t.status} IN ('ok','error','timeout','rate_limited')`,
    ),
  ],
);
