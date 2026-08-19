// Memory Observatory REST (T48; 12 §8, 21 §API): list/search with queue
// badges, the relation graph (capped 500), the provenance inspector detail,
// the contradiction queue + resolution, and the Founder edit/archive path.
// Reads are member-visible; mutations are Founder-only (12 §8.7–8.8).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  ContradictionQueueResponseSchema,
  FounderMemoryPatchResponseSchema,
  FounderMemoryPatchSchema,
  MemoryDetailResponseSchema,
  MemoryDtoSchema,
  MemoryGraphResponseSchema,
  MemoryListResponseSchema,
  ResolveContradictionRequestSchema,
} from "@acos/contracts";
import {
  MemoryConsolidationService,
  MemoryPromotionService,
  companyContext,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  memories,
  memoryEvidence,
  memoryRelations,
  memoryVersions,
  projects,
} from "@acos/db/schema";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export interface MemoryRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
}

const CompanyParamsSchema = z.object({ companyId: z.uuid() });
const MemoryParamsSchema = z.object({ companyId: z.uuid(), memoryId: z.uuid() });
const RelationParamsSchema = z.object({ companyId: z.uuid(), relationId: z.uuid() });
const ListQuerySchema = z.object({
  scope: z.enum(["company", "project", "agent"]).optional(),
  type: z.string().optional(),
  status: z.string().optional(), // default active; "all" widens (12 §8.1)
  q: z.string().max(200).optional(),
});
const GRAPH_CAP = 500;

function toDto(row: typeof memories.$inferSelect) {
  return MemoryDtoSchema.parse({
    id: row.id,
    scope: row.scope,
    scopeRef: row.scopeRef,
    type: row.type,
    title: row.title,
    summary: row.summary,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status,
    retrievalCount: row.retrievalCount,
    createdByAgentId: row.createdByAgentId,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

export async function registerMemoryRoutes(
  app: FastifyInstance,
  deps: MemoryRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function requireMember(userId: string, companyId: string): Promise<string> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return role;
  }

  async function queueCounts(db: GuardedDb, ctx: CompanyContext) {
    const [contradictions] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.companyId, ctx.companyId),
          eq(memoryRelations.kind, "contradicts"),
        ),
      );
    const [lowConfidence] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(and(eq(memories.companyId, ctx.companyId), eq(memories.status, "candidate")));
    return { contradictions: contradictions?.n ?? 0, lowConfidence: lowConfidence?.n ?? 0 };
  }

  typed.get(
    "/api/v1/companies/:companyId/memories",
    {
      schema: {
        params: CompanyParamsSchema,
        querystring: ListQuerySchema,
        response: { 200: MemoryListResponseSchema },
        tags: ["memories"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const { scope, type, status, q } = request.query;
      const rows = await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.companyId, ctx.companyId),
            ...(scope ? [eq(memories.scope, scope)] : []),
            ...(type ? [eq(memories.type, type)] : []),
            ...(status === "all"
              ? []
              : [eq(memories.status, status ?? "active")]),
            ...(q
              ? [or(ilike(memories.title, `%${q}%`), ilike(memories.content, `%${q}%`))]
              : []),
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(200);
      return { items: rows.map(toDto), ...(await queueCounts(db, ctx)) };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/memories/graph",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: MemoryGraphResponseSchema },
        tags: ["memories"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const rows = await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.companyId, ctx.companyId),
            inArray(memories.status, ["active", "candidate", "superseded"]),
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(GRAPH_CAP + 1);
      const capped = rows.length > GRAPH_CAP;
      const nodes = rows.slice(0, GRAPH_CAP);
      const ids = new Set(nodes.map((n) => n.id));

      // ADR-021: kapsam sahibinin ADI. Galaksi kolları proje bazlı ayrılıyor
      // ve tooltip "kimin anısı" diyebiliyor. İki küçük toplu sorgu — düğüm
      // başına sorgu (N+1) 500 düğümde 500 gidiş-dönüş olurdu.
      const projectIds = [
        ...new Set(
          nodes.filter((n) => n.scope === "project" && n.scopeRef).map((n) => n.scopeRef!),
        ),
      ];
      const agentIds = [
        ...new Set(
          nodes.filter((n) => n.scope === "agent" && n.scopeRef).map((n) => n.scopeRef!),
        ),
      ];
      const labels = new Map<string, string>();
      if (projectIds.length > 0) {
        for (const row of await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, ctx.companyId), inArray(projects.id, projectIds)))) {
          labels.set(row.id, row.name);
        }
      }
      if (agentIds.length > 0) {
        for (const row of await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, ctx.companyId), inArray(agents.id, agentIds)))) {
          labels.set(row.id, row.name);
        }
      }
      const relationRows = await db
        .select()
        .from(memoryRelations)
        .where(eq(memoryRelations.companyId, ctx.companyId))
        .limit(2000);
      return {
        nodes: nodes.map((n) => ({
          id: n.id,
          title: n.title,
          type: n.type,
          scope: n.scope,
          scopeRef: n.scopeRef,
          scopeLabel: n.scopeRef ? (labels.get(n.scopeRef) ?? null) : null,
          importance: n.importance,
          confidence: n.confidence,
          status: n.status,
        })),
        edges: relationRows
          .filter((r) => ids.has(r.fromMemoryId) && ids.has(r.toMemoryId))
          .map((r) => ({ from: r.fromMemoryId, to: r.toMemoryId, kind: r.kind })),
        capped,
      };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/memories/contradictions",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: ContradictionQueueResponseSchema },
        tags: ["memories"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const relations = await db
        .select()
        .from(memoryRelations)
        .where(
          and(
            eq(memoryRelations.companyId, ctx.companyId),
            eq(memoryRelations.kind, "contradicts"),
          ),
        )
        .orderBy(asc(memoryRelations.createdAt))
        .limit(50);
      const items = [];
      for (const relation of relations) {
        const [a] = await db
          .select()
          .from(memories)
          .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, relation.fromMemoryId)));
        const [b] = await db
          .select()
          .from(memories)
          .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, relation.toMemoryId)));
        // resolved pairs (either side superseded/archived) leave the queue
        if (!a || !b || a.status === "superseded" || b.status === "superseded") continue;
        if (a.status === "archived" || b.status === "archived") continue;
        items.push({
          relationId: relation.id,
          a: { ...toDto(a), content: a.content },
          b: { ...toDto(b), content: b.content },
        });
      }
      return { items };
    },
  );

  typed.post(
    "/api/v1/companies/:companyId/memories/contradictions/:relationId/resolve",
    {
      schema: {
        params: RelationParamsSchema,
        body: ResolveContradictionRequestSchema,
        response: { 200: z.object({ loserMemoryId: z.uuid() }) },
        tags: ["memories"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, relationId } = request.params;
      const role = await requireMember(user.id, companyId);
      if (role !== "founder") throw new ApiError("forbidden", "founder resolves contradictions");
      const result = await new MemoryPromotionService(deps.guardedDb()).resolveContradiction(
        companyContext(companyId),
        {
          relationId,
          winnerMemoryId: request.body.winnerMemoryId,
          resolvedByAgentId: null, // Founder resolution (12 §8.7)
          note: request.body.note,
        },
      );
      return { loserMemoryId: result.loserMemoryId };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/memories/:memoryId",
    {
      schema: {
        params: MemoryParamsSchema,
        response: { 200: MemoryDetailResponseSchema },
        tags: ["memories"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, memoryId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const [row] = await db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, memoryId)));
      if (!row) throw new ApiError("not_found", "memory not found");
      let creatorName: string | null = null;
      if (row.createdByAgentId) {
        const [creator] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, row.createdByAgentId)));
        creatorName = creator?.name ?? null;
      }
      const evidence = await db
        .select()
        .from(memoryEvidence)
        .where(
          and(eq(memoryEvidence.companyId, ctx.companyId), eq(memoryEvidence.memoryId, memoryId)),
        )
        .orderBy(asc(memoryEvidence.createdAt));
      const relations = await db
        .select()
        .from(memoryRelations)
        .where(
          and(
            eq(memoryRelations.companyId, ctx.companyId),
            or(eq(memoryRelations.fromMemoryId, memoryId), eq(memoryRelations.toMemoryId, memoryId)),
          ),
        );
      const relationItems = [];
      for (const relation of relations) {
        const direction = relation.fromMemoryId === memoryId ? "out" : "in";
        const otherId = direction === "out" ? relation.toMemoryId : relation.fromMemoryId;
        const [other] = await db
          .select({ title: memories.title })
          .from(memories)
          .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, otherId)));
        relationItems.push({
          relationId: relation.id,
          kind: relation.kind,
          direction: direction as "out" | "in",
          otherId,
          otherTitle: other?.title ?? "(gone)",
        });
      }
      const versions = await db
        .select()
        .from(memoryVersions)
        .where(
          and(eq(memoryVersions.companyId, ctx.companyId), eq(memoryVersions.memoryId, memoryId)),
        )
        .orderBy(asc(memoryVersions.version));
      return {
        memory: {
          ...toDto(row),
          content: row.content,
          sourceEventId: row.sourceEventId,
          entities: row.entities as Record<string, unknown>,
          createdByAgentName: creatorName,
        },
        evidence: evidence.map((e) => ({
          id: e.id,
          kind: e.kind,
          ref: e.ref,
          weight: e.weight,
          createdAt: e.createdAt.toISOString(),
        })),
        relations: relationItems,
        versions: versions.map((v) => ({
          version: v.version,
          title: v.title,
          status: v.status,
          importance: v.importance,
          confidence: v.confidence,
          changedBy: v.changedBy,
          changeReason: v.changeReason,
          createdAt: v.createdAt.toISOString(),
        })),
      };
    },
  );

  typed.patch(
    "/api/v1/companies/:companyId/memories/:memoryId",
    {
      schema: {
        params: MemoryParamsSchema,
        body: FounderMemoryPatchSchema,
        response: { 200: FounderMemoryPatchResponseSchema },
        tags: ["memories"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, memoryId } = request.params;
      const role = await requireMember(user.id, companyId);
      if (role !== "founder") throw new ApiError("forbidden", "founder edits memories (12 §8.8)");
      const service = new MemoryConsolidationService(deps.guardedDb());
      return service.founderUpdate(companyContext(companyId), memoryId, {
        byUserId: user.id,
        title: request.body.title,
        content: request.body.content,
        importance: request.body.importance,
        archive: request.body.archive,
        note: request.body.note,
      });
    },
  );
}
