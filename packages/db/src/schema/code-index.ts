// CodeIndex (REVISION TASK 4) — AST/symbol tabanlı kod grafiği; migration 0019.
// Dosya, sembol (class/function/method/…), kenar (import/reference/call/tests).
// called_by saklanmaz: call kenarının ters sorgusudur.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.js";
import { companyId } from "./companies.js";
import { projects } from "./projects.js";

export const codeFiles = pgTable(
  "code_files",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    path: text("path").notNull(),
    language: text("language").notNull(),
    sha: text("sha").notNull(),
    loc: integer("loc").notNull().default(0),
    isTest: boolean("is_test").notNull().default(false),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    /** TASK 5: NULL = canonical (default branch HEAD); 'task:<id>' = overlay. */
    overlayRef: text("overlay_ref"),
  },
  (t) => [
    uniqueIndex("code_files_project_path_overlay_uq").on(
      t.companyId,
      t.projectId,
      t.path,
      sql`COALESCE(${t.overlayRef}, '')`,
    ),
    index("code_files_overlay_pidx")
      .on(t.companyId, t.projectId, t.overlayRef)
      .where(sql`${t.overlayRef} IS NOT NULL`),
  ],
);

export const codeSymbols = pgTable(
  "code_symbols",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").notNull(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => codeFiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    startLine: integer("start_line").notNull().default(1),
    endLine: integer("end_line").notNull().default(1),
    exported: boolean("exported").notNull().default(false),
  },
  (t) => [
    index("code_symbols_project_name_idx").on(t.companyId, t.projectId, t.name),
    index("code_symbols_file_idx").on(t.fileId),
    check(
      "code_symbols_kind_check",
      sql`${t.kind} IN ('class','function','method','interface','type','enum','const')`,
    ),
  ],
);

export const codeEdges = pgTable(
  "code_edges",
  {
    id: id(),
    companyId: companyId(),
    createdAt: createdAt(),
    projectId: uuid("project_id").notNull(),
    kind: text("kind").notNull(),
    fromFileId: uuid("from_file_id")
      .notNull()
      .references(() => codeFiles.id, { onDelete: "cascade" }),
    toFileId: uuid("to_file_id").references(() => codeFiles.id, { onDelete: "cascade" }),
    toSymbolId: uuid("to_symbol_id").references(() => codeSymbols.id, { onDelete: "cascade" }),
    symbolName: text("symbol_name"),
    toModule: text("to_module"),
  },
  (t) => [
    index("code_edges_project_kind_idx").on(t.companyId, t.projectId, t.kind),
    index("code_edges_from_file_idx").on(t.fromFileId),
    index("code_edges_to_file_idx").on(t.toFileId),
    index("code_edges_to_symbol_idx").on(t.toSymbolId),
    check(
      "code_edges_kind_check",
      sql`${t.kind} IN ('import','reference','call','tests','implements','extends')`,
    ),
  ],
);
