// Working-Set memory retrieval (T45; 12 §7, _DECISIONS §10). Lives in
// @acos/db for the shared-single-implementation reason: the worker's
// buildWorkingSetActivity, the nightly perf lane and the Observatory health
// widget (T48) all read through the SAME lanes, scoring and packing — the
// budgets and the "only active rows are retrievable" rule cannot diverge.
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  MEMORY_TOKEN_BUDGETS,
  packMemories,
  recencyDecay,
  scoreMemoryRetrieval,
  type PackableMemory,
} from "@acos/domain";
import type { CompanyContext } from "./context.js";
import type { Db } from "./index.js";
import type { GuardedDb } from "./tenant.js";
import { memories, memoryRetrievals } from "./schema/index.js";

/** §7.5(d) latency threshold. */
const SLOW_MS = 1_500;
/** k before re-ranking (12 §7.2 WRITER-DECISION). */
const SEMANTIC_K = 24;

export interface RetrieveInput {
  agentId: string;
  taskId: string | null;
  projectId: string | null;
  /** semantic-lane query vector; null ⇒ semantic lane skipped (§7.5c) */
  queryEmbedding: number[] | null;
  /** workspace paths for the exact-match failure lane (§7.1) */
  taskFilePaths?: string[] | undefined;
  /** agents on the task's thread for the relationship lane (§7.1) */
  threadAgentIds?: string[] | undefined;
}

export interface WorkingSetMemories {
  /** packed prompt blocks per scope (08 §8 sections 4–6); "" when empty */
  sections: { company: string; project: string; agent: string };
  ids: string[];
  scores: number[];
  tokensUsed: number;
  flags: { empty: boolean; truncated: boolean; semanticSkipped: boolean; slow: boolean };
  durationMs: number;
}

type MemoryRow = {
  id: string;
  scope: string;
  type: string;
  title: string;
  content: string;
  summary: string;
  importance: number;
  confidence: number;
  createdAt: Date;
  cosine?: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toPackable(row: MemoryRow, mustKnow: boolean, now: Date): PackableMemory {
  const ageDays = Math.max(0, (now.getTime() - row.createdAt.getTime()) / 86_400_000);
  const score = scoreMemoryRetrieval({
    cosine: clamp01(row.cosine ?? 0),
    importance: clamp01(row.importance),
    recencyDecay: recencyDecay(row.type, ageDays),
    confidence: clamp01(row.confidence),
  });
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    type: row.type,
    confidence: row.confidence,
    score,
    mustKnow,
  };
}

export class MemoryRetrievalService {
  constructor(private readonly db: GuardedDb) {}

  private baseColumns() {
    return {
      id: memories.id,
      scope: memories.scope,
      type: memories.type,
      title: memories.title,
      content: memories.content,
      summary: memories.summary,
      importance: memories.importance,
      confidence: memories.confidence,
      createdAt: memories.createdAt,
    };
  }

  /**
   * The full §7 retrieval: structured SQL lanes first (budget-reserved
   * "must know" set), semantic top-k per scope re-ranked with the binding
   * formula, per-scope packing, one memory_retrievals observability row.
   */
  async retrieveForWorkingSet(
    ctx: CompanyContext,
    input: RetrieveInput,
  ): Promise<WorkingSetMemories> {
    const started = Date.now();
    const now = new Date();
    const active = eq(memories.status, "active"); // only active rows, ever (12 §7)

    // ---- structured SQL lanes (12 §7.1) ----
    const laneRows: Array<{ row: MemoryRow; bucket: "agent" | "project" | "company" }> = [];

    if (input.projectId) {
      const decisions = await this.db
        .select(this.baseColumns())
        .from(memories)
        .where(
          and(
            eq(memories.companyId, ctx.companyId),
            active,
            eq(memories.type, "decision"),
            eq(memories.scope, "project"),
            eq(memories.scopeRef, input.projectId),
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(10);
      for (const row of decisions) laneRows.push({ row, bucket: "project" });
    }

    // role procedures: company + project scope, recall must be complete —
    // ordered by importance (role-tag entity matching joins with T47 skills)
    const procedures = await this.db
      .select(this.baseColumns())
      .from(memories)
      .where(
        and(
          eq(memories.companyId, ctx.companyId),
          active,
          eq(memories.type, "procedural"),
          input.projectId
            ? sql`(${memories.scope} = 'company' OR (${memories.scope} = 'project' AND ${memories.scopeRef} = ${input.projectId}))`
            : eq(memories.scope, "company"),
        ),
      )
      .orderBy(desc(memories.importance))
      .limit(10);
    for (const row of procedures) {
      laneRows.push({ row, bucket: row.scope === "company" ? "company" : "project" });
    }

    if (input.projectId && input.taskFilePaths?.length) {
      const paths = sql.join(
        input.taskFilePaths.map((p) => sql`${p}`),
        sql`, `,
      );
      const failures = await this.db
        .select(this.baseColumns())
        .from(memories)
        .where(
          and(
            eq(memories.companyId, ctx.companyId),
            active,
            eq(memories.type, "failure"),
            eq(memories.scope, "project"),
            eq(memories.scopeRef, input.projectId),
            sql`${memories.entities} -> 'files' ?| ARRAY[${paths}]::text[]`,
          ),
        )
        .limit(10);
      for (const row of failures) laneRows.push({ row, bucket: "project" });
    }

    if (input.threadAgentIds?.length) {
      const agentsArr = sql.join(
        input.threadAgentIds.map((a) => sql`${a}`),
        sql`, `,
      );
      const relationships = await this.db
        .select(this.baseColumns())
        .from(memories)
        .where(
          and(
            eq(memories.companyId, ctx.companyId),
            active,
            eq(memories.type, "relationship"),
            eq(memories.scope, "agent"),
            eq(memories.scopeRef, input.agentId),
            sql`${memories.entities} -> 'agents' ?| ARRAY[${agentsArr}]::text[]`,
          ),
        )
        .limit(10);
      for (const row of relationships) laneRows.push({ row, bucket: "agent" });
    }

    let codeIndexDigest = "";
    // ---- CodeIndex lane (REVISION TASK 5): dokunulan dosyalar CodeIndex ile
    // komşu dosya + sembollere genişletilir; canonical file/symbol/commit/test
    // referansı taşıyan anılar (entities.files/.symbols/.tests) daraltılmış
    // kümeyle eşleşirse working set'e girer.
    if (input.projectId && input.taskFilePaths?.length) {
      try {
        const seedPaths = sql.join(
          input.taskFilePaths.map((p) => sql`${p}`),
          sql`, `,
        );
        const expansion = await this.db.execute(sql`
          WITH seed AS (
            SELECT id FROM code_files
            WHERE company_id = ${ctx.companyId} AND project_id = ${input.projectId}
              AND path = ANY(ARRAY[${seedPaths}]::text[])
          ),
          neighbors AS (
            SELECT id FROM seed
            UNION
            SELECT e.to_file_id FROM code_edges e JOIN seed s ON e.from_file_id = s.id
              WHERE e.company_id = ${ctx.companyId} AND e.to_file_id IS NOT NULL
            UNION
            SELECT e.from_file_id FROM code_edges e JOIN seed s ON e.to_file_id = s.id
              WHERE e.company_id = ${ctx.companyId}
          )
          SELECT
            coalesce((SELECT array_agg(DISTINCT f.path) FROM code_files f
              WHERE f.id IN (SELECT id FROM neighbors)), '{}') AS rel_files,
            coalesce((SELECT array_agg(DISTINCT cs.name) FROM code_symbols cs
              WHERE cs.company_id = ${ctx.companyId}
                AND cs.file_id IN (SELECT id FROM seed)), '{}') AS rel_symbols
        `);
        const expanded = expansion.rows[0] as
          | { rel_files: string[]; rel_symbols: string[] }
          | undefined;
        const relFiles = (expanded?.rel_files ?? []).slice(0, 100);
        const relSymbols = (expanded?.rel_symbols ?? []).slice(0, 200);
        // "gerekli kod parçaları": dokunulan dosyaların sembol haritası —
        // dosya dökmeden konum işaretçileri (path:satır aralığı)
        const digestRows = await this.db.execute(sql`
          SELECT f.path, cs.name, cs.kind, cs.start_line, cs.end_line
          FROM code_symbols cs
          JOIN code_files f ON f.id = cs.file_id
          WHERE cs.company_id = ${ctx.companyId} AND f.company_id = ${ctx.companyId}
            AND f.project_id = ${input.projectId}
            AND f.path = ANY(ARRAY[${seedPaths}]::text[])
          ORDER BY f.path, cs.start_line
          LIMIT 15
        `);
        codeIndexDigest = (digestRows.rows as Array<{
          path: string; name: string; kind: string; start_line: number; end_line: number;
        }>)
          .map((r) => `- ${r.path}:${r.start_line}-${r.end_line} ${r.kind} ${r.name}`)
          .join("\n");
        if (relFiles.length > 0 || relSymbols.length > 0) {
          const fileArr = sql.join(
            (relFiles.length > 0 ? relFiles : ["__none__"]).map((p) => sql`${p}`),
            sql`, `,
          );
          const symbolArr = sql.join(
            (relSymbols.length > 0 ? relSymbols : ["__none__"]).map((s) => sql`${s}`),
            sql`, `,
          );
          const codeLinked = await this.db
            .select(this.baseColumns())
            .from(memories)
            .where(
              and(
                eq(memories.companyId, ctx.companyId),
                active,
                eq(memories.scope, "project"),
                eq(memories.scopeRef, input.projectId),
                sql`(
                  ${memories.entities} -> 'files' ?| ARRAY[${fileArr}]::text[]
                  OR ${memories.entities} -> 'tests' ?| ARRAY[${fileArr}]::text[]
                  OR ${memories.entities} -> 'symbols' ?| ARRAY[${symbolArr}]::text[]
                )`,
              ),
            )
            .orderBy(desc(memories.importance))
            .limit(10);
          const already = new Set(laneRows.map((l) => l.row.id));
          for (const row of codeLinked) {
            if (!already.has(row.id)) laneRows.push({ row, bucket: "project" });
          }
        }
      } catch {
        // CodeIndex boş/eksikse lane sessizce atlanır — retrieval kırılmaz
      }
    }

    const laneIds = new Set(laneRows.map((l) => l.row.id));

    // ---- semantic lane per scope (12 §7.2), dedupe against SQL lanes ----
    const semanticRows: Array<{ row: MemoryRow; bucket: "agent" | "project" | "company" }> = [];
    const semanticSkipped = input.queryEmbedding === null;
    if (input.queryEmbedding) {
      const dim = input.queryEmbedding.length;
      const dimLit = sql.raw(String(dim));
      const qvec = `[${input.queryEmbedding.join(",")}]`;
      const distance = sql<number>`(${memories.embedding}::vector(${dimLit}) <=> ${qvec}::vector(${dimLit}))`;
      const scopes: Array<{ bucket: "agent" | "project" | "company"; where: ReturnType<typeof and> }> = [
        {
          bucket: "agent",
          where: and(eq(memories.scope, "agent"), eq(memories.scopeRef, input.agentId)),
        },
        ...(input.projectId
          ? [
              {
                bucket: "project" as const,
                where: and(eq(memories.scope, "project"), eq(memories.scopeRef, input.projectId)),
              },
            ]
          : []),
        { bucket: "company", where: eq(memories.scope, "company") },
      ];
      for (const scope of scopes) {
        const rows = await this.db
          .select({ ...this.baseColumns(), distance })
          .from(memories)
          .where(
            and(
              eq(memories.companyId, ctx.companyId),
              active,
              scope.where,
              eq(memories.embeddingDim, dim),
              isNotNull(memories.embedding),
            ),
          )
          .orderBy(distance)
          .limit(SEMANTIC_K);
        for (const { distance: d, ...row } of rows) {
          if (laneIds.has(row.id)) continue; // dedupe by id (12 §7.2)
          semanticRows.push({ row: { ...row, cosine: 1 - Number(d) }, bucket: scope.bucket });
        }
      }
    }

    // ---- re-rank + pack per scope budget (12 §7.3) ----
    const buckets: Record<"agent" | "project" | "company", PackableMemory[]> = {
      agent: [],
      project: [],
      company: [],
    };
    for (const { row, bucket } of laneRows) buckets[bucket].push(toPackable(row, true, now));
    for (const { row, bucket } of semanticRows) buckets[bucket].push(toPackable(row, false, now));

    const packedByScope = {
      agent: packMemories(buckets.agent, MEMORY_TOKEN_BUDGETS.agent),
      project: packMemories(buckets.project, MEMORY_TOKEN_BUDGETS.project),
      company: packMemories(buckets.company, MEMORY_TOKEN_BUDGETS.company),
    };

    const allPackables = [...buckets.agent, ...buckets.project, ...buckets.company];
    const scoreById = new Map(allPackables.map((p) => [p.id, p.score]));
    const packedAll = [
      ...packedByScope.company.packed,
      ...packedByScope.project.packed,
      ...packedByScope.agent.packed,
    ];
    const ids = packedAll.map((p) => p.id);
    const scores = ids.map((id) => scoreById.get(id) ?? 0);
    const tokensUsed =
      packedByScope.agent.tokensUsed +
      packedByScope.project.tokensUsed +
      packedByScope.company.tokensUsed;
    const droppedTotal =
      packedByScope.agent.droppedCount +
      packedByScope.project.droppedCount +
      packedByScope.company.droppedCount;

    const durationMs = Date.now() - started;
    const flags = {
      empty: ids.length === 0,
      // §7.5(b): budget starvation truncated ≥50% of scored rows
      truncated: allPackables.length > 0 && droppedTotal >= allPackables.length / 2,
      semanticSkipped,
      slow: durationMs > SLOW_MS,
    };

    const render = (scope: "company" | "project" | "agent") =>
      packedByScope[scope].packed.map((p) => p.rendered).join("\n");

    // §7.4: one UNLOGGED observability row per build — the per-minute batch
    // (applyRetrievalCounts) aggregates into memories.retrieval_count.
    // Best-effort: an insert failure must never break the agent loop.
    try {
      await this.db.insert(memoryRetrievals).values({
        companyId: ctx.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        lane: "working_set",
        queryRef: input.taskId,
        returnedIds: ids,
        scores,
        budgetTokensUsed: tokensUsed,
        empty: flags.empty,
        truncated: flags.truncated,
        semanticSkipped: flags.semanticSkipped,
        slow: flags.slow,
        durationMs,
      });
    } catch {
      /* observability only */
    }

    // TASK 15 (MemoryOS ayrımı): anılar DENEYİMSEL bağlamdır; kodun güncel
    // gerçeği CodeIndex + dosyadır. İki kaynak Context Compiler'da yan yana
    // gelir, birbirinin yerine geçmez.
    const projectSection = [
      render("project"),
      codeIndexDigest ? `[CodeIndex]\n${codeIndexDigest}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      sections: { company: render("company"), project: projectSection, agent: render("agent") },
      ids,
      scores,
      tokensUsed,
      flags,
      durationMs,
    };
  }

  /**
   * B1' — the on-demand lane behind the `memory.search` tool (17 §4). The
   * working set is pushed at step start; this is the agent PULLING with a
   * question of its own, so the shape is per-row rather than packed prose.
   *
   * Same rules as §7: only `active` rows are retrievable, the same binding
   * score formula ranks them, and INV-15 scope isolation is enforced HERE
   * rather than trusted from the caller — `agent` means this agent's own
   * rows, `project` means the task's project, `company` is shared.
   *
   * There is no embedding at the dispatch edge, so the semantic lane is
   * skipped and matching is lexical; §7.5c already defines that degraded
   * mode, and the cosine term simply contributes 0 to the score.
   */
  async searchScoped(
    ctx: CompanyContext,
    input: {
      agentId: string;
      projectId: string | null;
      taskId: string | null;
      query: string;
      scopes: Array<"agent" | "project" | "company">;
      limit: number;
    },
  ): Promise<Array<{ id: string; title: string; summary: string; scope: string; score: number }>> {
    const started = Date.now();
    const now = new Date();
    const wanted = input.scopes.length > 0 ? input.scopes : ["agent", "project", "company"];
    const visible = [
      ...(wanted.includes("agent")
        ? [and(eq(memories.scope, "agent"), eq(memories.scopeRef, input.agentId))]
        : []),
      ...(wanted.includes("project") && input.projectId
        ? [and(eq(memories.scope, "project"), eq(memories.scopeRef, input.projectId))]
        : []),
      ...(wanted.includes("company") ? [eq(memories.scope, "company")] : []),
    ];
    if (visible.length === 0) return [];

    const term = `%${input.query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db
      .select(this.baseColumns())
      .from(memories)
      .where(
        and(
          eq(memories.companyId, ctx.companyId),
          eq(memories.status, "active"),
          or(...visible),
          sql`(${memories.title} ILIKE ${term} OR ${memories.summary} ILIKE ${term} OR ${memories.content} ILIKE ${term})`,
        ),
      )
      .orderBy(desc(memories.importance))
      .limit(Math.min(input.limit * 4, 200));

    const ranked = rows
      .map((row) => {
        const packable = toPackable(row, false, now);
        return {
          id: row.id,
          title: row.title,
          summary: row.summary,
          scope: row.scope,
          score: packable.score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);

    // §7.4 observability: the pull lane is counted like the push lane, so a
    // memory the agent keeps asking for shows up in retrieval_count too.
    try {
      await this.db.insert(memoryRetrievals).values({
        companyId: ctx.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        lane: "tool_search",
        queryRef: input.query.slice(0, 200),
        returnedIds: ranked.map((r) => r.id),
        scores: ranked.map((r) => r.score),
        budgetTokensUsed: 0,
        empty: ranked.length === 0,
        truncated: false,
        semanticSkipped: true,
        slow: Date.now() - started > SLOW_MS,
        durationMs: Date.now() - started,
      });
    } catch {
      /* observability only */
    }
    return ranked;
  }
}

/**
 * Per-minute batch (12 §7.4): aggregate uncounted memory_retrievals into
 * memories.retrieval_count (avoids write-amplifying the hot table per step),
 * then sweep rows past the 14-day retention. System-wide maintenance — runs
 * on the unguarded connection like sweepApprovals.
 */
export async function applyRetrievalCounts(
  db: Db,
): Promise<{ applied: number; swept: number }> {
  return db.transaction(async (tx) => {
    const batch = await tx.execute(sql`
      SELECT id, returned_ids FROM memory_retrievals
      WHERE counted = false
      ORDER BY created_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    `);
    const rows = batch.rows as Array<{ id: string; returned_ids: string[] }>;
    if (rows.length > 0) {
      const retrievalIds = rows.map((r) => r.id);
      const idList = sql.join(
        retrievalIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      await tx.execute(sql`
        WITH counts AS (
          SELECT unnest(returned_ids) AS memory_id, count(*)::int AS n
          FROM memory_retrievals
          WHERE id IN (${idList})
          GROUP BY 1
        )
        UPDATE memories m
        SET retrieval_count = m.retrieval_count + counts.n
        FROM counts WHERE m.id = counts.memory_id
      `);
      await tx
        .update(memoryRetrievals)
        .set({ counted: true })
        .where(inArray(memoryRetrievals.id, retrievalIds));
    }
    const swept = await tx.execute(
      sql`DELETE FROM memory_retrievals WHERE created_at < now() - interval '14 days'`,
    );
    return { applied: rows.length, swept: swept.rowCount ?? 0 };
  });
}
