// Events — the source of truth (20 §9) — migration 0005.
// `events` is a partitioned parent (monthly RANGE on occurred_at): the
// generated CREATE TABLE is hand-audited into PARTITION BY RANGE + monthly
// partitions + a DEFAULT safety-net partition.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./common.js";
import { companies, companyId } from "./companies.js";

/** 9.1 events — PARTITIONED; PK (id, occurred_at). Append-only outbox. */
export const events = pgTable(
  "events",
  {
    id: idColumn(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    version: smallint("version").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actor: jsonb("actor").notNull(),
    taskId: uuid("task_id"),
    projectId: uuid("project_id"),
    agentId: uuid("agent_id"),
    correlationId: uuid("correlation_id"),
    causationId: uuid("causation_id"),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    uniqueIndex("events_company_seq_occurred_uq").on(t.companyId, t.seq, t.occurredAt),
    index("events_company_seq_idx").on(t.companyId, t.seq),
    index("events_company_type_occurred_idx").on(t.companyId, t.type, t.occurredAt),
    index("events_outbox_pidx")
      .on(t.occurredAt)
      .where(sql`${t.publishedAt} IS NULL`),
    index("events_task_occurred_pidx")
      .on(t.taskId, t.occurredAt)
      .where(sql`${t.taskId} IS NOT NULL`),
    index("events_agent_occurred_pidx")
      .on(t.agentId, t.occurredAt)
      .where(sql`${t.agentId} IS NOT NULL`),
    index("events_payload_gin").using("gin", sql`${t.payload} jsonb_path_ops`),
  ],
);

/** 9.2 dead_events — JetStream DLQ landing zone. */
export const deadEvents = pgTable(
  "dead_events",
  {
    id: idColumn().primaryKey(),
    companyId: companyId(),
    createdAt: createdAt(),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    consumer: text("consumer").notNull(),
    deliveries: integer("deliveries").notNull().default(0),
    error: text("error").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("dead"),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("dead_events_event_consumer_uq").on(t.eventId, t.consumer),
    index("dead_events_dead_pidx")
      .on(t.companyId)
      .where(sql`${t.status} = 'dead'`),
    check("dead_events_status_check", sql`${t.status} IN ('dead','replayed','discarded')`),
  ],
);
