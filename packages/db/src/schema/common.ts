// Shared column builders (20-DATABASE-DESIGN.md §1): app-side UUIDv7 ids,
// created_at, and the tenant company_id FK as the second column.
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "@acos/domain";

export const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** For partitioned tables where id is part of a composite PK. */
export const idColumn = () => uuid("id").$defaultFn(() => uuidv7());

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Envelope-encrypted blobs (libsodium sealed boxes). */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
