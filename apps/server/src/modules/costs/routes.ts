// Costs + Reports REST (T49; 26 §9/§12): dashboard aggregates over the REAL
// cost_entries ledger (direct SUM — the MV+tail composite is a recorded
// narrowing until ledger volume warrants it), the drill-down, the
// deterministic burn-rate forecast per active budget, and the executive
// report list (demo 24).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { forecastBreach, projectedSpendCents } from "@acos/domain";
import {
  CostEntriesResponseSchema,
  CostForecastResponseSchema,
  CostSummaryResponseSchema,
  LlmUsageResponseSchema,
  ReportListResponseSchema,
} from "@acos/contracts";
import { periodStart, type GuardedDb } from "@acos/db";
import { agents, artifacts, budgets, costEntries, llmCalls, projects, tasks } from "@acos/db/schema";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export interface CostRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
}

const CompanyParamsSchema = z.object({ companyId: z.uuid() });
const SummaryQuerySchema = z.object({
  groupBy: z.enum(["kind", "agent", "project", "task"]).default("kind"),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
const EntriesQuerySchema = z.object({
  taskId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function registerCostRoutes(
  app: FastifyInstance,
  deps: CostRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function requireMember(userId: string, companyId: string): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
  }

  // today's llm_calls aggregate — the top-bar token/cache pill (36 §9 — U11)
  typed.get(
    "/api/v1/companies/:companyId/llm/usage",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: LlmUsageResponseSchema },
        tags: ["costs"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const db = deps.guardedDb();
      const [row] = await db
        .select({
          calls: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(${llmCalls.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${llmCalls.tokensOut}), 0)::int`,
          tokensCached: sql<number>`coalesce(sum(${llmCalls.tokensCached}), 0)::int`,
          costCents: sql<number>`coalesce(sum(${llmCalls.costCents}), 0)::int`,
        })
        .from(llmCalls)
        .where(
          and(
            eq(llmCalls.companyId, companyId),
            sql`${llmCalls.createdAt} >= date_trunc('day', now())`,
          ),
        );
      return row!;
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/costs",
    {
      schema: {
        params: CompanyParamsSchema,
        querystring: SummaryQuerySchema,
        response: { 200: CostSummaryResponseSchema },
        tags: ["costs"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const db = deps.guardedDb();
      const to = request.query.to ? new Date(request.query.to) : new Date();
      const from = request.query.from
        ? new Date(request.query.from)
        : new Date(to.getTime() - 7 * 86_400_000);
      const groupBy = request.query.groupBy;
      const groupColumn =
        groupBy === "agent"
          ? costEntries.agentId
          : groupBy === "project"
            ? costEntries.projectId
            : groupBy === "task"
              ? costEntries.taskId
              : costEntries.kind;

      const window = and(
        eq(costEntries.companyId, companyId),
        gte(costEntries.occurredAt, from),
        lte(costEntries.occurredAt, to),
      );
      const rows = await db
        .select({
          key: sql<string | null>`${groupColumn}::text`,
          amountCents: sql<number>`coalesce(sum(${costEntries.amountCents}), 0)::int`,
        })
        .from(costEntries)
        .where(window)
        .groupBy(groupColumn)
        .orderBy(desc(sql`sum(${costEntries.amountCents})`))
        .limit(50);
      const totalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);

      const resolveName = async (key: string | null): Promise<string | null> => {
        if (!key) return "platform"; // non-task/system work bucket (26 §13)
        if (groupBy === "agent") {
          const [row] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), eq(agents.id, key)));
          return row?.name ?? null;
        }
        if (groupBy === "project") {
          const [row] = await db
            .select({ name: projects.name })
            .from(projects)
            .where(and(eq(projects.companyId, companyId), eq(projects.id, key)));
          return row?.name ?? null;
        }
        if (groupBy === "task") {
          const [row] = await db
            .select({ title: tasks.title })
            .from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.id, key)));
          return row?.title ?? null;
        }
        return null;
      };

      const groups = [];
      for (const row of rows) {
        groups.push({
          key: row.key ?? "platform",
          name: await resolveName(row.key),
          amountCents: row.amountCents,
        });
      }
      return { totalCents, from: from.toISOString(), to: to.toISOString(), groups };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/costs/entries",
    {
      schema: {
        params: CompanyParamsSchema,
        querystring: EntriesQuerySchema,
        response: { 200: CostEntriesResponseSchema },
        tags: ["costs"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const db = deps.guardedDb();
      const rows = await db
        .select()
        .from(costEntries)
        .where(
          and(
            eq(costEntries.companyId, companyId),
            ...(request.query.taskId ? [eq(costEntries.taskId, request.query.taskId)] : []),
            ...(request.query.projectId
              ? [eq(costEntries.projectId, request.query.projectId)]
              : []),
          ),
        )
        .orderBy(desc(costEntries.occurredAt))
        .limit(request.query.limit);
      return {
        items: rows.map((row) => ({
          id: row.id!,
          kind: row.kind,
          ref: row.ref,
          agentId: row.agentId,
          taskId: row.taskId,
          projectId: row.projectId,
          amountCents: row.amountCents,
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/costs/forecast",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: CostForecastResponseSchema },
        tags: ["costs"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const db = deps.guardedDb();
      const now = new Date();
      const budgetRows = await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.companyId, companyId), eq(budgets.enabled, true)))
        .limit(50);

      const items = [];
      for (const budget of budgetRows) {
        // "total" budgets have no period start — spend from the beginning
        const start =
          periodStart(budget.period as "daily" | "monthly" | "total", now) ?? new Date(0);
        const periodEnd =
          budget.period === "daily"
            ? new Date(start.getTime() + 86_400_000)
            : budget.period === "monthly"
              ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
              : now; // total: no horizon — projection equals spend
        const scopeFilter =
          budget.scopeKind === "company"
            ? undefined
            : budget.scopeKind === "project"
              ? eq(costEntries.projectId, budget.scopeRef!)
              : budget.scopeKind === "task"
                ? eq(costEntries.taskId, budget.scopeRef!)
                : eq(costEntries.agentId, budget.scopeRef!);
        const spent = await db
          .select({ cents: sql<number>`coalesce(sum(${costEntries.amountCents}), 0)::int` })
          .from(costEntries)
          .where(
            and(
              eq(costEntries.companyId, companyId),
              gte(costEntries.occurredAt, start),
              ...(scopeFilter ? [scopeFilter] : []),
            ),
          );
        const trailing = await db
          .select({ cents: sql<number>`coalesce(sum(${costEntries.amountCents}), 0)::int` })
          .from(costEntries)
          .where(
            and(
              eq(costEntries.companyId, companyId),
              gte(costEntries.occurredAt, new Date(now.getTime() - 86_400_000)),
              ...(scopeFilter ? [scopeFilter] : []),
            ),
          );
        const spentCents = spent[0]?.cents ?? 0;
        const projectedCents = projectedSpendCents({
          spentSoFarCents: spentCents,
          trailing24hCents: trailing[0]?.cents ?? 0,
          hoursElapsedInPeriod: (now.getTime() - start.getTime()) / 3_600_000,
          hoursRemainingInPeriod: Math.max(0, (periodEnd.getTime() - now.getTime()) / 3_600_000),
        });
        items.push({
          budgetId: budget.id,
          scopeKind: budget.scopeKind,
          scopeRef: budget.scopeRef,
          period: budget.period,
          kind: budget.kind,
          limitCents: budget.limitCents,
          spentCents,
          projectedCents,
          breach: forecastBreach({
            projectedCents,
            limitCents: budget.limitCents,
            hoursRemainingInPeriod: (periodEnd.getTime() - now.getTime()) / 3_600_000,
          }),
        });
      }
      return { items };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/reports",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: ReportListResponseSchema },
        tags: ["costs"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const db = deps.guardedDb();
      const rows = await db
        .select({
          id: artifacts.id,
          projectId: artifacts.projectId,
          title: artifacts.title,
          contentMd: artifacts.contentMd,
          createdByAgentId: artifacts.createdByAgentId,
          createdAt: artifacts.createdAt,
          projectName: projects.name,
        })
        .from(artifacts)
        .leftJoin(
          projects,
          and(eq(artifacts.projectId, projects.id), eq(projects.companyId, companyId)),
        )
        .where(and(eq(artifacts.companyId, companyId), eq(artifacts.kind, "executive_report")))
        .orderBy(desc(artifacts.createdAt))
        .limit(50);
      const items = [];
      for (const row of rows) {
        let creatorName: string | null = null;
        if (row.createdByAgentId) {
          const [creator] = await db
            .select({ name: agents.name })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), eq(agents.id, row.createdByAgentId)));
          creatorName = creator?.name ?? null;
        }
        items.push({
          id: row.id,
          projectId: row.projectId,
          projectName: row.projectName ?? null,
          title: row.title,
          contentMd: row.contentMd,
          createdByAgentName: creatorName,
          createdAt: row.createdAt.toISOString(),
        });
      }
      return { items };
    },
  );
}
