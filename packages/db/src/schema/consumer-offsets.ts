// consumer_offsets (10 §6 [WRITER-DECISION]): per-consumer, per-company
// last_seq high-water-mark — the default consumer idempotency mechanism.
import { bigint, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const consumerOffsets = pgTable(
  "consumer_offsets",
  {
    consumer: text("consumer").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.companyId] })],
);
