// Workforce + org graph (20 §4.3–4.7) — migration 0003.
// agent_steps is a partitioned parent: drizzle-kit's CREATE TABLE for it is
// hand-audited into `PARTITION BY RANGE (created_at)` + monthly partitions.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, idColumn } from "./common.js";
import { companyId } from "./companies.js";
import { modelProviders } from "./identity.js";
import { orgUnits, positions } from "./org.js";

/** 4.3 agents — identity decoupled from model (sacred invariant). */
export const agents = pgTable(
  "agents",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    employeeNumber: integer("employee_number").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("draft"),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    orgUnitId: uuid("org_unit_id")
      .notNull()
      .references(() => orgUnits.id, { onDelete: "restrict" }),
    seniority: text("seniority").notNull().default("junior"),
    autonomyLevel: smallint("autonomy_level").notNull().default(2),
    persona: text("persona").notNull(),
    employment: jsonb("employment").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("agents_company_employee_number_uq").on(t.companyId, t.employeeNumber),
    uniqueIndex("agents_company_name_active_uq")
      .on(t.companyId, sql`lower(${t.name})`)
      .where(sql`${t.status} <> 'offboarded'`),
    index("agents_company_status_idx").on(t.companyId, t.status),
    index("agents_company_org_unit_idx").on(t.companyId, t.orgUnitId),
    check(
      "agents_status_check",
      sql`${t.status} IN ('draft','active','paused','offboarded')`,
    ),
    check(
      "agents_seniority_check",
      sql`${t.seniority} IN ('junior','mid','senior','staff','lead','expert')`,
    ),
    check("agents_autonomy_level_check", sql`${t.autonomyLevel} BETWEEN 0 AND 5`),
  ],
);

/** 4.4 agent_model_bindings — the ONLY agent↔model linkage. */
export const agentModelBindings = pgTable(
  "agent_model_bindings",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    model: text("model").notNull(),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    priority: smallint("priority").notNull().default(0),
  },
  (t) => [
    uniqueIndex("agent_model_bindings_agent_purpose_priority_uq").on(
      t.agentId,
      t.purpose,
      t.priority,
    ),
    check(
      "agent_model_bindings_purpose_check",
      sql`${t.purpose} IN ('primary','default','coding','planning','review','fast','embedding')`,
    ),
  ],
);

/** 4.5 agent_sessions — one row per Temporal agentTaskWorkflow execution. */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    // FK to tasks is appended in migration 0004 (tasks lands there).
    taskId: uuid("task_id"),
    workflowId: text("workflow_id").notNull(),
    runId: text("run_id").notNull(),
    status: text("status").notNull().default("starting"),
    currentActivity: text("current_activity").notNull().default("IDLE"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    stepsCount: integer("steps_count").notNull().default(0),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costCents: bigint("cost_cents", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("agent_sessions_workflow_run_uq").on(t.workflowId, t.runId),
    index("agent_sessions_live_pidx")
      .on(t.companyId, t.agentId)
      .where(sql`${t.status} IN ('starting','running','waiting')`),
    index("agent_sessions_agent_started_idx").on(t.agentId, sql`${t.startedAt} DESC`),
    check(
      "agent_sessions_status_check",
      sql`${t.status} IN ('starting','running','waiting','completed','failed','cancelled')`,
    ),
    check(
      "agent_sessions_activity_check",
      sql`${t.currentActivity} IN ('IDLE','THINKING','WORKING','WAITING','COMMUNICATING','REVIEWING','TESTING','LEARNING','BLOCKED','ESCALATING','OFFLINE')`,
    ),
  ],
);

/** 4.6 agent_steps — PARTITIONED (monthly, RANGE on created_at); PK (id, created_at). */
export const agentSteps = pgTable(
  "agent_steps",
  {
    id: idColumn(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentSessionId: uuid("agent_session_id").notNull(), // soft ref (partition pruning)
    agentId: uuid("agent_id").notNull(),
    taskId: uuid("task_id"),
    stepNo: integer("step_no").notNull(),
    actionKind: text("action_kind").notNull(),
    action: jsonb("action").notNull(),
    observation: jsonb("observation"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("agent_steps_session_step_idx").on(t.agentSessionId, t.stepNo),
    index("agent_steps_company_created_idx").on(t.companyId, t.createdAt),
    index("agent_steps_task_created_idx").on(t.taskId, t.createdAt),
    check(
      "agent_steps_action_kind_check",
      sql`${t.actionKind} IN ('use_tool','send_message','create_task','delegate_task','request_review','request_help','escalate','update_task_status','record_decision','complete_task','wait_for','abandon')`,
    ),
  ],
);

/** 4.7 org_edges — typed organization graph. */
export const orgEdges = pgTable(
  "org_edges",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    fromAgentId: uuid("from_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    toAgentId: uuid("to_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    toUnitId: uuid("to_unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    strength: real("strength"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("org_edges_reports_to_single_manager_uq")
      .on(t.fromAgentId)
      .where(sql`${t.kind} = 'reports_to' AND ${t.endedAt} IS NULL`),
    uniqueIndex("org_edges_agent_edge_active_uq")
      .on(t.fromAgentId, t.toAgentId, t.kind)
      .where(sql`${t.endedAt} IS NULL`),
    uniqueIndex("org_edges_unit_edge_active_uq")
      .on(t.fromAgentId, t.toUnitId, t.kind)
      .where(sql`${t.endedAt} IS NULL`),
    index("org_edges_company_kind_idx").on(t.companyId, t.kind),
    index("org_edges_to_agent_idx").on(t.toAgentId),
    index("org_edges_to_unit_idx").on(t.toUnitId),
    check(
      "org_edges_kind_check",
      sql`${t.kind} IN ('reports_to','manages','member_of','leads','mentors','collaborates_with')`,
    ),
    check(
      "org_edges_exactly_one_target_check",
      sql`(${t.toAgentId} IS NULL) <> (${t.toUnitId} IS NULL)`,
    ),
    check(
      "org_edges_unit_kind_target_check",
      sql`(${t.kind} IN ('member_of','leads')) = (${t.toUnitId} IS NOT NULL)`,
    ),
    check("org_edges_strength_check", sql`${t.strength} BETWEEN 0 AND 1`),
  ],
);
