// Phase-2 Marketing (20 §15.2–15.5) — migration 0011. Schema ships in MVP,
// features stay dark (_DECISIONS §23). Asset HNSW indexes hand-audited.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
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
import { projects } from "./projects.js";
import { experiments } from "./memory.js";

const vector = customType<{ data: string }>({
  dataType() {
    return "vector";
  },
});

/** 15.2 assets */
export const assets = pgTable(
  "assets",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    uri: text("uri").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingDim: smallint("embedding_dim"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("assets_tags_gin").using("gin", t.tags),
    index("assets_company_kind_idx").on(t.companyId, t.kind),
    check(
      "assets_kind_check",
      sql`${t.kind} IN ('image','video','audio','copy','template','brand')`,
    ),
  ],
);

/** 15.3 content_items */
export const contentItems = pgTable(
  "content_items",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    platform: text("platform").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("idea"),
    title: text("title").notNull(),
    briefMd: text("brief_md"),
    scriptMd: text("script_md"),
    assetIds: uuid("asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    experimentId: uuid("experiment_id").references(() => experiments.id, {
      onDelete: "restrict",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("content_items_company_platform_status_idx").on(t.companyId, t.platform, t.status),
    index("content_items_asset_ids_gin").using("gin", t.assetIds),
    check(
      "content_items_platform_check",
      sql`${t.platform} IN ('instagram','tiktok','youtube','x','linkedin','blog','other')`,
    ),
    check(
      "content_items_kind_check",
      sql`${t.kind} IN ('reel','post','story','article','ad','carousel')`,
    ),
    check(
      "content_items_status_check",
      sql`${t.status} IN ('idea','concept','script','production','qa','scheduled','published','archived')`,
    ),
  ],
);

/** 15.4 publish_jobs */
export const publishJobs = pgTable(
  "publish_jobs",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "restrict" }),
    platform: text("platform").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("scheduled"),
    attempts: smallint("attempts").notNull().default(0),
    externalId: text("external_id"),
    error: text("error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("publish_jobs_dispatcher_pidx")
      .on(t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
    check(
      "publish_jobs_status_check",
      sql`${t.status} IN ('scheduled','publishing','published','failed','cancelled')`,
    ),
  ],
);

/** 15.5 metric_snapshots */
export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "restrict" }),
    platform: text("platform").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    views: bigint("views", { mode: "number" }),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    saves: integer("saves"),
    ctr: real("ctr"),
    watchTimeS: bigint("watch_time_s", { mode: "number" }),
    followersDelta: integer("followers_delta"),
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("metric_snapshots_content_platform_captured_uq").on(
      t.contentItemId,
      t.platform,
      t.capturedAt,
    ),
    index("metric_snapshots_company_captured_idx").on(t.companyId, t.capturedAt),
  ],
);
