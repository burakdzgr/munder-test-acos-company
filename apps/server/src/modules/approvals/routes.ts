// Approval Center API (19 §11–12, 21 §3.10, T35). Approval CREATION has no
// public endpoint — requests are born from agent escalations through the
// shared engine (@acos/db ApprovalsService). Verdicts are Founder-only and
// require an interactive session: PAT bearers are refused outright (19 §12,
// T16's banned founder:approve scope) — a recorded narrowing of 21 §3.10's
// perm column. The verdict signal into the waiting Temporal workflow is
// delivered post-commit, best-effort (19 §7): the DB row stays authoritative.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ApprovalDetailSchema,
  ApprovalListQuerySchema,
  ApprovalSchema,
  ApprovalVerdictRequestSchema,
} from "@acos/contracts";
import { ApprovalBriefSchema } from "@acos/events";
import {
  ApprovalError,
  ApprovalsService,
  companyContext,
  TaskEngineError,
  type ApprovalRow,
  type ChainEntry,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

const idParam = z.object({ id: z.uuid() });
const approvalParam = idParam.extend({ approvalId: z.uuid() });

/** Post-commit verdict delivery into the waiting workflow (19 §7). */
export type ApprovalSignalPort = (input: {
  workflowId: string;
  approvalId: string;
  verdict: string;
  note?: string | undefined;
}) => Promise<boolean>;

export function toApiApproval(
  service: ApprovalsService,
  row: ApprovalRow & { requesterName?: string | null },
) {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as never,
    title: row.title,
    brief: ApprovalBriefSchema.parse(JSON.parse(row.requestMd)),
    requestedByAgentId: row.requestedByAgentId,
    requesterName: row.requesterName ?? null,
    chain: (row.chain as ChainEntry[]) ?? [],
    status: row.status as never,
    risk: row.risk as never,
    costCents: row.costCents,
    urgency: row.urgency as never,
    deadline: row.deadline?.toISOString() ?? null,
    expiresAt: service.expiresAt(row).toISOString(),
    taskId: row.taskId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapApprovalError(err: unknown): never {
  if (err instanceof ApprovalError) {
    switch (err.code) {
      case "APPROVAL_NOT_FOUND":
        throw new ApiError("not_found", err.message);
      case "APPROVAL_ALREADY_DECIDED":
        throw new ApiError("conflict", err.message);
      case "APPROVAL_ENDORSER_NOT_IN_CHAIN":
        throw new ApiError("forbidden", err.message);
      default:
        throw new ApiError("validation_failed", err.message);
    }
  }
  if (err instanceof TaskEngineError) throw new ApiError("conflict", err.message);
  throw err;
}

export async function registerApprovalRoutes(
  rawApp: FastifyInstance,
  deps: {
    guardedDb: () => GuardedDb;
    companiesSvc: () => CompanyService;
    approvalSignal: () => ApprovalSignalPort | null;
  },
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const service = () => new ApprovalsService(deps.guardedDb());

  async function requireCompany(
    request: FastifyRequest,
    companyId: string,
  ): Promise<{ ctx: CompanyContext; role: string }> {
    const user = request.requireUser();
    const role = await deps.companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return { ctx: companyContext(companyId), role };
  }

  app.get(
    "/api/v1/companies/:id/approvals",
    {
      schema: {
        operationId: "listApprovals",
        tags: ["approvals"],
        params: idParam,
        querystring: ApprovalListQuerySchema,
        response: { 200: z.array(ApprovalSchema) },
      },
    },
    async (request) => {
      const { ctx } = await requireCompany(request, request.params.id);
      const svc = service();
      const rows = await svc.list(ctx, request.query);
      return rows.map((row) => toApiApproval(svc, row));
    },
  );

  app.get(
    "/api/v1/companies/:id/approvals/:approvalId",
    {
      schema: {
        operationId: "getApproval",
        tags: ["approvals"],
        params: approvalParam,
        response: { 200: ApprovalDetailSchema },
      },
    },
    async (request) => {
      const { ctx } = await requireCompany(request, request.params.id);
      const svc = service();
      const row = await svc.get(ctx, request.params.approvalId).catch(mapApprovalError);
      return { ...toApiApproval(svc, row), task: row.task };
    },
  );

  app.post(
    "/api/v1/companies/:id/approvals/:approvalId/verdict",
    {
      schema: {
        operationId: "approvalVerdict",
        tags: ["approvals"],
        params: approvalParam,
        body: ApprovalVerdictRequestSchema,
        response: { 200: ApprovalSchema },
      },
    },
    async (request) => {
      const user = request.requireUser();
      // interactive Founder session only — no PAT path to verdicts (19 §12)
      if (request.principal?.scopes !== null) {
        throw new ApiError("forbidden", "approval verdicts require an interactive session");
      }
      const { ctx, role } = await requireCompany(request, request.params.id);
      if (role !== "founder") {
        throw new ApiError("forbidden", "only the Founder decides approvals (S6)");
      }
      const svc = service();
      const result = await svc
        .verdict(ctx, request.params.approvalId, request.body.verdict, {
          userId: user.id,
          note: request.body.note,
        })
        .catch(mapApprovalError);
      const port = deps.approvalSignal();
      if (result.signal && port) {
        await port({ approvalId: result.row.id, ...result.signal }).catch(() => false);
      }
      // LIVE-CONSOLE TASK 2: karar anı Agent Console'a canlı düşer
      // ("✓ Founder approval received"). Ephemeral rt.* kanalı — truth DB'de.
      request.server.realtime?.publishRuntime(ctx.companyId, {
        v: 1,
        type: "approval.received",
        companyId: ctx.companyId,
        sessionId: null,
        agentId: result.row.requestedByAgentId,
        taskId: result.row.taskId,
        stepNo: null,
        opId: null,
        ts: Date.now(),
        payload: {
          approvalId: result.row.id,
          verdict: request.body.verdict,
          note: request.body.note ?? null,
          title: result.row.title,
        },
      });
      // TASK 9/10: kadro onayı (kind=hire, GOAL'e bağlı staffingPlan) →
      // Agent Factory planı uygular ve planlama kaldığı yerden sürer.
      if (
        request.body.verdict === "approved" &&
        result.row.kind === "hire" &&
        result.row.taskId
      ) {
        void (async () => {
          const db = deps.guardedDb();
          const { tasks } = await import("@acos/db/schema");
          const { and, eq } = await import("drizzle-orm");
          const [goal] = await db
            .select({ context: tasks.context, projectId: tasks.projectId })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, result.row.taskId!)));
          const goalContext = (goal?.context ?? {}) as {
            staffingPlan?: Array<{ capability: string; count: number }>;
          };
          if (!goal?.projectId || !goalContext.staffingPlan?.length) return;
          const { StaffingService, continueProjectPlanning } = await import(
            "../staffing/service.js"
          );
          await new StaffingService(db).applyPlan(ctx, goalContext.staffingPlan, {
            projectId: goal.projectId,
          });
          await continueProjectPlanning(
            { guardedDb: db, startAgentWorkflow: request.server.agentWorkflowStarter },
            ctx.companyId,
            goal.projectId,
          );
        })().catch((err) =>
          request.log.warn({ err, approvalId: result.row.id }, "staffing apply failed"),
        );
      }
      return toApiApproval(svc, result.row);
    },
  );
}
