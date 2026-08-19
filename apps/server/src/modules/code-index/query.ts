// Context Compiler'ın CodeIndex sorgusu (LIFECYCLE TASK 13).
//
// Canonical + task overlay BİRLİKTE okunur (INVARIANT 5): overlay'de dosyanın
// gölgesi varsa canonical satır elenir. Sorgu deterministiktir; LLM yalnız
// sonucu görür — kod tamamı asla prompt'a taşınmaz (INVARIANT 14).
import { and, eq, isNull, sql } from "drizzle-orm";
import { companyContext, type GuardedDb } from "@acos/db";
import { projects } from "@acos/db/schema";
import { updateTaskOverlayIndex, type CodeIndexerDeps } from "./service.js";

export interface CodeIndexQueryResult {
  indexState: string;
  indexCommitSha: string | null;
  stale: boolean;
  symbols: Array<{
    path: string;
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    layer: "canonical" | "overlay";
    exported: boolean;
  }>;
  /** sembol komşuları: bu sembolleri çağıran/test eden dosyalar */
  relations: Array<{ kind: string; fromPath: string; symbolName: string | null }>;
}

/** Görev metninden deterministic arama terimleri (Task Analyzer'ın kod ayağı). */
export function extractSearchTerms(text: string, extra: string[] = []): string[] {
  const STOP = new Set([
    "için", "veya", "gibi", "daha", "sonra", "önce", "this", "that", "with", "from",
    "task", "gorev", "görev", "proje", "project", "the", "and", "bir", "olan", "have",
  ]);
  const tokens = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_./çğıöşüÇĞİÖŞÜ-]+/)) {
    const t = raw.trim();
    if (t.length < 3 || t.length > 80) continue;
    if (STOP.has(t.toLowerCase())) continue;
    // sembol/dosya benzeri tokenlar öncelikli: CamelCase, snake_case, nokta/slash
    if (/[A-Z].*[a-z]|_|\.|\//.test(t) || t.length >= 5) tokens.add(t);
  }
  for (const e of extra) if (e.length >= 3) tokens.add(e);
  return [...tokens].slice(0, 12);
}

export async function queryCodeIndex(
  deps: CodeIndexerDeps,
  input: {
    companyId: string;
    projectId: string;
    taskId?: string | null | undefined;
    terms: string[];
    limit?: number | undefined;
  },
): Promise<CodeIndexQueryResult> {
  const ctx = companyContext(input.companyId);
  const db: GuardedDb = deps.guardedDb;
  const limit = Math.min(input.limit ?? 10, 30);

  // TASK 5/13: sorgudan önce görev overlay'i tazelenir (worktree varsa) —
  // agent kendi commit edilmemiş değişikliklerini de "bilir"
  if (input.taskId) {
    await updateTaskOverlayIndex(deps, input.companyId, input.projectId, input.taskId).catch(
      () => null,
    );
  }

  const [project] = await db
    .select({
      indexState: projects.indexState,
      indexCommitSha: projects.indexCommitSha,
    })
    .from(projects)
    .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, input.projectId)));

  const overlayRef = input.taskId ? `task:${input.taskId}` : null;
  const terms = input.terms.filter((t) => t.length >= 3).slice(0, 12);
  if (terms.length === 0) {
    return {
      indexState: project?.indexState ?? "none",
      indexCommitSha: project?.indexCommitSha ?? null,
      stale: (project?.indexState ?? "none") !== "ready",
      symbols: [],
      relations: [],
    };
  }

  const likeList = terms.map((t) => `%${t}%`);
  const result = await db.execute(sql`
    WITH layer_files AS (
      SELECT f.id, f.path, f.overlay_ref
      FROM code_files f
      WHERE f.company_id = ${ctx.companyId} AND f.project_id = ${input.projectId}
        AND (f.overlay_ref IS NULL OR f.overlay_ref = ${overlayRef})
        -- overlay gölgesi olan canonical dosya elenir (INVARIANT 5)
        AND NOT (f.overlay_ref IS NULL AND EXISTS (
          SELECT 1 FROM code_files o
          WHERE o.company_id = ${ctx.companyId} AND o.project_id = ${input.projectId}
            AND o.overlay_ref = ${overlayRef} AND o.path = f.path
        ))
    )
    SELECT lf.path, s.name, s.kind, s.start_line, s.end_line, s.exported,
      CASE WHEN lf.overlay_ref IS NULL THEN 'canonical' ELSE 'overlay' END AS layer,
      s.id AS symbol_id
    FROM code_symbols s
    JOIN layer_files lf ON lf.id = s.file_id
    WHERE s.company_id = ${ctx.companyId}
      AND (
        s.name ILIKE ANY(ARRAY[${sql.join(likeList.map((l) => sql`${l}`), sql`, `)}]::text[])
        OR lf.path ILIKE ANY(ARRAY[${sql.join(likeList.map((l) => sql`${l}`), sql`, `)}]::text[])
      )
    ORDER BY (CASE WHEN lf.overlay_ref IS NULL THEN 1 ELSE 0 END), s.exported DESC, s.start_line
    LIMIT ${limit}
  `);
  const symbols = (result.rows as Array<{
    path: string;
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
    exported: boolean;
    layer: "canonical" | "overlay";
    symbol_id: string;
  }>);

  let relations: CodeIndexQueryResult["relations"] = [];
  if (symbols.length > 0) {
    const ids = symbols.map((s) => s.symbol_id);
    const rel = await db.execute(sql`
      SELECT e.kind, ff.path AS from_path, e.symbol_name
      FROM code_edges e
      JOIN code_files ff ON ff.id = e.from_file_id
      WHERE e.company_id = ${ctx.companyId}
        AND e.to_symbol_id = ANY(ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::uuid[])
      LIMIT 20
    `);
    relations = (rel.rows as Array<{ kind: string; from_path: string; symbol_name: string | null }>).map(
      (r) => ({ kind: r.kind, fromPath: r.from_path, symbolName: r.symbol_name }),
    );
  }

  return {
    indexState: project?.indexState ?? "none",
    indexCommitSha: project?.indexCommitSha ?? null,
    stale: (project?.indexState ?? "none") !== "ready",
    symbols: symbols.map((s) => ({
      path: s.path,
      name: s.name,
      kind: s.kind,
      startLine: Number(s.start_line),
      endLine: Number(s.end_line),
      layer: s.layer,
      exported: Boolean(s.exported),
    })),
    relations,
  };
}
