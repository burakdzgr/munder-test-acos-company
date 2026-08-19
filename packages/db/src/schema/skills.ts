// Skills & Performance (20 §5) — migration 0008.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";
import { agents } from "./agents.js";

/** 5.1 skills — company-scoped taxonomy. */
export const skills = pgTable(
  "skills",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("skills_company_name_uq").on(t.companyId, t.name)],
);

/** 5.2 agent_skills — level recomputed deterministically, never LLM-set. */
export const agentSkills = pgTable(
  "agent_skills",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "restrict" }),
    level: smallint("level").notNull().default(1),
    confidence: real("confidence").notNull().default(0.3),
    evidenceCount: integer("evidence_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    levelUpdatedAt: timestamp("level_updated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agent_skills_agent_skill_uq").on(t.agentId, t.skillId),
    index("agent_skills_who_can_idx").on(t.companyId, t.skillId, sql`${t.level} DESC`),
    check("agent_skills_level_check", sql`${t.level} BETWEEN 1 AND 5`),
    check("agent_skills_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
  ],
);

/** 5.3 skill_evidence — append-only evidence trail. */
export const skillEvidence = pgTable(
  "skill_evidence",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentSkillId: uuid("agent_skill_id")
      .notNull()
      .references(() => agentSkills.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    weight: real("weight").notNull(),
    ref: text("ref").notNull(),
    note: text("note"),
  },
  (t) => [
    index("skill_evidence_agent_skill_created_idx").on(
      t.agentSkillId,
      sql`${t.createdAt} DESC`,
    ),
    check(
      "skill_evidence_kind_check",
      sql`${t.kind} IN ('task_success','review_accepted','production_result','peer_eval','manager_eval','experiment','failure','failure_resolved')`,
    ),
    check("skill_evidence_weight_check", sql`${t.weight} >= -1 AND ${t.weight} <= 1`),
  ],
);

/** 5.4 performance_snapshots — weekly per-agent rollups. */
export const performanceSnapshots = pgTable(
  "performance_snapshots",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    tasksFailed: integer("tasks_failed").notNull().default(0),
    reviewsGiven: integer("reviews_given").notNull().default(0),
    reviewsReceivedApproved: integer("reviews_received_approved").notNull().default(0),
    reviewsReceivedChanges: integer("reviews_received_changes").notNull().default(0),
    escalations: integer("escalations").notNull().default(0),
    messagesSent: integer("messages_sent").notNull().default(0),
    tokensTotal: bigint("tokens_total", { mode: "number" }).notNull().default(0),
    costCents: bigint("cost_cents", { mode: "number" }).notNull().default(0),
    extra: jsonb("extra").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [uniqueIndex("performance_snapshots_agent_period_uq").on(t.agentId, t.periodStart)],
);
