// Tools, Policies, Approvals, Audit (20 §12) — migration 0009.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companies, companyId } from "./companies.js";
import { agents } from "./agents.js";
import { tasks } from "./tasks.js";
import { users } from "./identity.js";

/** 12.1 tools [platform] — registry cache; source of truth is packages/tools. */
export const tools = pgTable(
  "tools",
  {
    id: id(),
    createdAt: createdAt(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    description: text("description").notNull(),
    riskClass: text("risk_class").notNull(),
    scopes: text("scopes").array().notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tools_name_version_uq").on(t.name, t.version),
    uniqueIndex("tools_name_enabled_uq").on(t.name).where(sql`${t.enabled}`),
    check("tools_risk_class_check", sql`${t.riskClass} IN ('R0','R1','R2','R3')`),
  ],
);

/** 12.4 policies — Founder-only categories are hard-coded in domain, never rows here (S6). */
export const policies = pgTable(
  "policies",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    effect: text("effect").notNull(),
    priority: integer("priority").notNull().default(100),
    rule: jsonb("rule").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("policies_company_name_uq").on(t.companyId, t.name),
    index("policies_company_kind_enabled_pidx")
      .on(t.companyId, t.kind)
      .where(sql`${t.enabled}`),
    check(
      "policies_kind_check",
      sql`${t.kind} IN ('tool','budget','escalation','standing_approval','memory_promotion','approval_routing')`,
    ),
    check("policies_effect_check", sql`${t.effect} IN ('allow','deny','require_approval')`),
  ],
);

/** 12.2 tool_permissions — agent/position/unit scoped grants. */
export const toolPermissions = pgTable(
  "tool_permissions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    toolName: text("tool_name").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    constraints: jsonb("constraints").notNull().default(sql`'{}'::jsonb`),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tool_permissions_active_uq")
      .on(t.companyId, t.toolName, t.subjectKind, t.subjectId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("tool_permissions_subject_idx").on(t.subjectKind, t.subjectId),
    check(
      "tool_permissions_subject_kind_check",
      sql`${t.subjectKind} IN ('agent','position','org_unit')`,
    ),
  ],
);

/** 12.5 approvals — structured Founder briefs. */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    number: integer("number").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    requestMd: text("request_md").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    chain: jsonb("chain").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("pending"),
    risk: text("risk").notNull(),
    costCents: bigint("cost_cents", { mode: "number" }),
    urgency: text("urgency").notNull().default("normal"),
    deadline: timestamp("deadline", { withTimezone: true }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    workflowId: text("workflow_id"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [
    uniqueIndex("approvals_company_number_uq").on(t.companyId, t.number),
    index("approvals_pending_pidx")
      .on(t.companyId, t.urgency)
      .where(sql`${t.status} = 'pending'`),
    index("approvals_requester_created_idx").on(
      t.requestedByAgentId,
      sql`${t.createdAt} DESC`,
    ),
    check(
      "approvals_kind_check",
      sql`${t.kind} IN ('tool_execution','budget_increase','hire','promotion','deployment','vendor','legal_financial','other')`,
    ),
    check(
      "approvals_status_check",
      sql`${t.status} IN ('pending','approved','rejected','needs_review','expired')`,
    ),
    check("approvals_risk_check", sql`${t.risk} IN ('low','medium','high','critical')`),
    check("approvals_urgency_check", sql`${t.urgency} IN ('low','normal','high','critical')`),
  ],
);

/** 12.3 tool_invocations — audit row for EVERY gateway decision (S3). */
export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    agentSessionId: uuid("agent_session_id"),
    toolName: text("tool_name").notNull(),
    riskClass: text("risk_class").notNull(),
    input: jsonb("input").notNull(),
    decision: text("decision").notNull(),
    decisionReason: text("decision_reason").notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    // FK to workspaces appended at the end of migration 0010.
    workspaceId: uuid("workspace_id"),
    resultSummary: text("result_summary"),
    error: text("error"),
    costCents: integer("cost_cents").notNull().default(0),
    durationMs: integer("duration_ms"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("tool_invocations_company_created_idx").on(t.companyId, sql`${t.createdAt} DESC`),
    index("tool_invocations_agent_created_idx").on(t.agentId, sql`${t.createdAt} DESC`),
    index("tool_invocations_awaiting_pidx")
      .on(t.companyId)
      .where(sql`${t.status} = 'awaiting_approval'`),
    index("tool_invocations_tool_created_idx").on(t.toolName, t.createdAt),
    check(
      "tool_invocations_risk_class_check",
      sql`${t.riskClass} IN ('R0','R1','R2','R3')`,
    ),
    check(
      "tool_invocations_decision_check",
      sql`${t.decision} IN ('allow','deny','require_approval')`,
    ),
    check(
      "tool_invocations_status_check",
      sql`${t.status} IN ('denied','awaiting_approval','dispatched','succeeded','failed')`,
    ),
  ],
);

/** 12.6 audit_log — append-only (S7); company_id nullable for platform actions. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    actorKind: text("actor_kind").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: uuid("target_id"),
    ip: inet("ip"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("audit_log_company_created_idx").on(t.companyId, sql`${t.createdAt} DESC`),
    index("audit_log_action_created_idx").on(t.action, sql`${t.createdAt} DESC`),
    check("audit_log_actor_kind_check", sql`${t.actorKind} IN ('user','agent','system')`),
  ],
);
