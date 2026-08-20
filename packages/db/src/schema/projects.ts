// Projects & Engineering (20 §6) — migration 0004 (first half).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";
import { users } from "./identity.js";
import { agents } from "./agents.js";

/** 6.1 projects */
export const projects = pgTable(
  "projects",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    objectiveMd: text("objective_md").notNull(),
    constraintsMd: text("constraints_md"),
    status: text("status").notNull().default("proposed"),
    /** TASK 3 (INVARIANT 3): READY, indeksin commit SHA'sına bağlıdır. */
    headSha: text("head_sha"),
    indexState: text("index_state").notNull().default("none"),
    indexCommitSha: text("index_commit_sha"),
    /** TASK 7: proje yalnız bağlantı referansı taşır — token değil. */
    githubConnectionId: uuid("github_connection_id"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // FK to artifacts appended at the end of migration 0004 (created later there).
    intakeReportArtifactId: uuid("intake_report_artifact_id"),
    /**
     * D4 (27 §12): "per-workspace additions come from project settings via a
     * generated include". The doc names project settings as the source of the
     * egress allowlist; there was no such column, so agents could only ever
     * reach the built-in package registries. Shape today:
     * `{ egressDomains: string[] }` — additive, defaults to `{}`.
     */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("projects_company_slug_uq").on(t.companyId, t.slug),
    index("projects_company_status_idx").on(t.companyId, t.status),
    check(
      "projects_status_check",
      sql`${t.status} IN ('draft','repository_setup','indexing','ready','planning','staffing_review','waiting_for_founder','executing','failed','proposed','intake','active','paused','completed','archived','cancelled')`,
    ),
  ],
);

/** 6.2 project_members */
export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("project_members_active_uq")
      .on(t.projectId, t.agentId, t.role)
      .where(sql`${t.removedAt} IS NULL`),
    index("project_members_agent_idx").on(t.agentId),
    check(
      "project_members_role_check",
      sql`${t.role} IN ('owner','architect','lead','engineer','qa','devops','marketer','stakeholder')`,
    ),
  ],
);

/** 6.3 repositories */
export const repositories = pgTable(
  "repositories",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    barePath: text("bare_path").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    originUrl: text("origin_url"),
    githubRemote: text("github_remote"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    languages: jsonb("languages").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("repositories_project_name_uq").on(t.projectId, t.name),
    uniqueIndex("repositories_bare_path_uq").on(t.barePath),
  ],
);

/** 6.4 environments */
export const environments = pgTable(
  "environments",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("environments_project_name_uq").on(t.projectId, t.name),
    check("environments_name_check", sql`${t.name} IN ('local','staging','production')`),
  ],
);

/** 6.5 deployments — dark in MVP, schema present. */
export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
    // FK to tasks appended at the end of migration 0004.
    taskId: uuid("task_id"),
    gitRef: text("git_ref").notNull(),
    status: text("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    logsUri: text("logs_uri"),
  },
  (t) => [
    index("deployments_project_created_idx").on(t.projectId, sql`${t.createdAt} DESC`),
    check(
      "deployments_status_check",
      sql`${t.status} IN ('pending','running','succeeded','failed','rolled_back')`,
    ),
  ],
);

/**
 * E2/W1 (T17) — proje ↔ takım GERÇEK bağı, migration 0026.
 *
 * Bugüne kadar bu ilişki yalnız İŞTEN türüyordu (tasks.project_id ×
 * tasks.org_unit_id): iş almamış projenin takımı yoktu, yani sihirbazın
 * kurduğu ekip ilk görev dağıtılana kadar görünmüyordu. Bağ artık kalıcı.
 *
 * Neden JOIN tablosu, neden `orgUnits.projectId` DEĞİL: bir takım aynı anda
 * birden çok projede çalışabilir (09 §2) ve ajan kalıcı bir ŞİRKET varlığıdır
 * — `agents.orgUnitId`'yi projeye taşımak ajanı projeye hapsederdi. Proje↔ajan
 * bağı `projectMembers`'ta kalır; burası yalnız proje↔BİRİM.
 */
export const projectTeamMemberships = pgTable(
  "project_team_memberships",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    orgUnitId: uuid("org_unit_id").notNull(),
    /** kim bağladı: sihirbaz/Agent Factory (system), Founder, ajan, ya da göç */
    addedBy: text("added_by").notNull().default("system"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("project_team_memberships_active_uq")
      .on(t.projectId, t.orgUnitId)
      .where(sql`${t.removedAt} IS NULL`),
    index("project_team_memberships_company_project_idx").on(t.companyId, t.projectId),
    index("project_team_memberships_unit_idx").on(t.companyId, t.orgUnitId),
    check(
      "project_team_memberships_added_by_check",
      sql`${t.addedBy} IN ('system','founder','agent','backfill')`,
    ),
  ],
);
