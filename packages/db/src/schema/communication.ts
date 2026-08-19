// Communication (20 §8) + notifications (20 §15.1) — migration 0006.
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";
import { agents } from "./agents.js";
import { orgUnits } from "./org.js";
import { projects } from "./projects.js";
import { reviews, tasks } from "./tasks.js";
import { users } from "./identity.js";

/** 8.1 channels */
export const channels = pgTable(
  "channels",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    kind: text("kind").notNull(),
    name: text("name"),
    orgUnitId: uuid("org_unit_id").references(() => orgUnits.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "restrict" }),
    dmKey: text("dm_key"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("channels_dm_key_uq")
      .on(t.companyId, t.dmKey)
      .where(sql`${t.kind} = 'dm'`),
    uniqueIndex("channels_task_thread_uq")
      .on(t.taskId)
      .where(sql`${t.kind} = 'task_thread'`),
    uniqueIndex("channels_review_uq")
      .on(t.reviewId)
      .where(sql`${t.kind} = 'review'`),
    check(
      "channels_kind_check",
      sql`${t.kind} IN ('dm','team','department','project','task_thread','review','escalation')`,
    ),
    check(
      "channels_kind_ref_check",
      sql`(${t.kind} <> 'task_thread' OR ${t.taskId} IS NOT NULL) AND (${t.kind} <> 'review' OR ${t.reviewId} IS NOT NULL) AND (${t.kind} <> 'dm' OR ${t.dmKey} IS NOT NULL)`,
    ),
  ],
);

/** 8.2 channel_members — agent_id NULL = the Founder. */
export const channelMembers = pgTable(
  "channel_members",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("channel_members_active_uq")
      .on(
        t.channelId,
        sql`coalesce(${t.agentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.leftAt} IS NULL`),
    index("channel_members_agent_idx").on(t.agentId),
  ],
);

/** 8.3 messages — persisted independently of any LLM context. */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    senderAgentId: uuid("sender_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    kind: text("kind").notNull().default("text"),
    body: text("body").notNull(),
    refs: jsonb("refs").notNull().default(sql`'{}'::jsonb`),
    replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    index("messages_channel_created_idx").on(t.channelId, t.createdAt),
    index("messages_company_created_idx").on(t.companyId, sql`${t.createdAt} DESC`),
    index("messages_body_trgm_gin").using("gin", sql`${t.body} gin_trgm_ops`),
    index("messages_refs_gin").using("gin", sql`${t.refs} jsonb_path_ops`),
    check(
      "messages_kind_check",
      sql`${t.kind} IN ('text','help_request','review_request','escalation','status','system')`,
    ),
  ],
);

/** 15.1 notifications — Founder-facing feed. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md"),
    refs: jsonb("refs").notNull().default(sql`'{}'::jsonb`),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_unread_pidx")
      .on(t.userId, sql`${t.createdAt} DESC`)
      .where(sql`${t.readAt} IS NULL`),
  ],
);
