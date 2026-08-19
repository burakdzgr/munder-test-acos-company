// Organization structure (20 §4.1–4.2) — migration 0002.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";

/** 4.1 org_units */
export const orgUnits = pgTable(
  "org_units",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    parentId: uuid("parent_id").references((): AnyPgColumn => orgUnits.id, {
      onDelete: "restrict",
    }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("org_units_company_slug_uq").on(t.companyId, t.slug),
    index("org_units_company_parent_idx").on(t.companyId, t.parentId),
    check("org_units_kind_check", sql`${t.kind} IN ('department','team','office','division')`),
    check("org_units_no_self_parent_check", sql`${t.parentId} <> ${t.id}`),
  ],
);

/** 4.2 positions */
export const positions = pgTable(
  "positions",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    title: text("title").notNull(),
    seniorityTrack: text("seniority_track").array().notNull(),
    defaultRole: text("default_role").notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("positions_company_title_uq").on(t.companyId, t.title)],
);
