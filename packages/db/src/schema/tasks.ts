// Tasks & Work (20 §7) — migration 0004 (second half).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";
import { agents } from "./agents.js";
import { orgUnits } from "./org.js";
import { projects, repositories } from "./projects.js";

/** 7.1 tasks — single-table hierarchy goal→subtask. */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
    creatorAgentId: uuid("creator_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    orgUnitId: uuid("org_unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    priority: text("priority").notNull().default("P2"),
    status: text("status").notNull().default("DRAFT"),
    successCriteria: text("success_criteria").array().notNull().default(sql`'{}'::text[]`),
    risk: text("risk").notNull().default("low"),
    budgetCents: bigint("budget_cents", { mode: "number" }),
    spentCents: bigint("spent_cents", { mode: "number" }).notNull().default(0),
    deadline: timestamp("deadline", { withTimezone: true }),
    // FK to policies appended at the end of migration 0009.
    approvalPolicyId: uuid("approval_policy_id"),
    delegationDepth: smallint("delegation_depth").notNull().default(0),
    reassignmentCount: smallint("reassignment_count").notNull().default(0),
    result: jsonb("result"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * Founder panodan kaldırdı — SİLİNMEDİ.
     *
     * Görev satırı, olayları, adımları, artefaktları ve ondan doğan anılar
     * olduğu gibi durur (INV-11 append-only); değişen tek şey varsayılan
     * görünümde çıkıp çıkmadığı. Geri alınabilir: alan NULL'a döner.
     *
     * Durum makinesine yeni bir durum EKLENMEDİ (07 §5'teki 16 durum
     * sabittir); arşiv bir durum değil, görünüm niteliğidir.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tasks_company_number_uq").on(t.companyId, t.number),
    index("tasks_company_status_idx").on(t.companyId, t.status),
    index("tasks_company_project_status_idx").on(t.companyId, t.projectId, t.status),
    index("tasks_owner_open_pidx")
      .on(t.ownerAgentId)
      .where(
        sql`${t.status} IN ('ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','REVIEW','CHANGES_REQUESTED','QA','QA_FAILED','APPROVAL')`,
      ),
    index("tasks_parent_idx").on(t.parentId),
    index("tasks_company_archived_pidx")
      .on(t.companyId, t.closedAt)
      .where(sql`${t.archivedAt} IS NULL`),
    index("tasks_company_deadline_pidx")
      .on(t.companyId, t.deadline)
      .where(sql`${t.deadline} IS NOT NULL AND ${t.closedAt} IS NULL`),
    check("tasks_no_self_parent_check", sql`${t.parentId} <> ${t.id}`),
    check(
      "tasks_kind_check",
      sql`${t.kind} IN ('goal','initiative','epic','task','subtask')`,
    ),
    check("tasks_priority_check", sql`${t.priority} IN ('P0','P1','P2','P3')`),
    check(
      "tasks_status_check",
      sql`${t.status} IN ('DRAFT','BACKLOG','PLANNED','ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','REVIEW','CHANGES_REQUESTED','QA','QA_FAILED','APPROVAL','REJECTED','DONE','FAILED','CANCELLED')`,
    ),
    check("tasks_risk_check", sql`${t.risk} IN ('low','medium','high','critical')`),
    check("tasks_delegation_depth_check", sql`${t.delegationDepth} <= 5`),
    check("tasks_reassignment_count_check", sql`${t.reassignmentCount} <= 3`),
  ],
);

/** 7.2 task_dependencies — blocking DAG. */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    kind: text("kind").notNull().default("blocks"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("task_dependencies_pair_uq").on(t.taskId, t.dependsOnTaskId),
    index("task_dependencies_unresolved_pidx")
      .on(t.dependsOnTaskId)
      .where(sql`${t.resolvedAt} IS NULL`),
    check("task_dependencies_kind_check", sql`${t.kind} IN ('blocks')`),
    check("task_dependencies_no_self_check", sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  ],
);

/** 7.3 task_assignments — full assignment history. */
export const taskAssignments = pgTable(
  "task_assignments",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    role: text("role").notNull().default("owner"),
    assignedByAgentId: uuid("assigned_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    reason: text("reason"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("task_assignments_single_owner_uq")
      .on(t.taskId, t.role)
      .where(sql`${t.role} = 'owner' AND ${t.unassignedAt} IS NULL`),
    index("task_assignments_task_assigned_idx").on(t.taskId, t.assignedAt),
    index("task_assignments_agent_active_pidx")
      .on(t.agentId)
      .where(sql`${t.unassignedAt} IS NULL`),
    check(
      "task_assignments_role_check",
      sql`${t.role} IN ('owner','reviewer','qa','collaborator')`,
    ),
  ],
);

/** 7.4 artifacts — work products. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    contentMd: text("content_md"),
    uri: text("uri"),
    gitRef: text("git_ref"),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    index("artifacts_task_idx").on(t.taskId),
    index("artifacts_project_kind_idx").on(t.projectId, t.kind),
    index("artifacts_company_kind_created_idx").on(
      t.companyId,
      t.kind,
      sql`${t.createdAt} DESC`,
    ),
    check(
      "artifacts_kind_check",
      sql`${t.kind} IN ('code_diff','document','report','intake_report','executive_report','design','test_report','promotion_review','media','other')`,
    ),
    check(
      "artifacts_content_check",
      sql`${t.contentMd} IS NOT NULL OR ${t.uri} IS NOT NULL OR ${t.gitRef} IS NOT NULL`,
    ),
  ],
);

/** 7.5 reviews — the PR entity. */
export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    // FK to workspaces appended at the end of migration 0010.
    workspaceId: uuid("workspace_id"),
    branch: text("branch").notNull(),
    kind: text("kind").notNull().default("code"),
    authorAgentId: uuid("author_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("pending"),
    verdictMd: text("verdict_md"),
    diffStat: jsonb("diff_stat"),
    mergedCommit: text("merged_commit"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("reviews_task_idx").on(t.taskId),
    index("reviews_reviewer_inbox_pidx")
      .on(t.companyId, t.reviewerAgentId)
      .where(sql`${t.status} IN ('pending','in_review')`),
    index("reviews_project_created_idx").on(t.projectId, sql`${t.createdAt} DESC`),
    check(
      "reviews_kind_check",
      sql`${t.kind} IN ('code','architecture','qa','security')`,
    ),
    check(
      "reviews_status_check",
      sql`${t.status} IN ('pending','in_review','changes_requested','approved','merged','abandoned')`,
    ),
    check(
      "reviews_reviewer_not_author_check",
      sql`${t.reviewerAgentId} IS NULL OR ${t.reviewerAgentId} <> ${t.authorAgentId}`,
    ),
  ],
);
