// Reviews REST surface (T43; 15 §2.1/§3.5): per-task review rows + the
// branch diff for the review UI, served from the task's live workspace via
// sandbox-manager (small diffs render container-free for the VIEWER — the
// exec itself runs in the existing workspace container).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, eq } from "drizzle-orm";
import {
  ReviewDiffResponseSchema,
  ReviewListResponseSchema,
  ReviewDtoSchema,
} from "@acos/contracts";
import { companyContext, ReviewsService, type GuardedDb } from "@acos/db";
import { agents, reviews, workspaces } from "@acos/db/schema";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export interface ReviewRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  sandbox: () => { url: string; token: string } | null;
}

const TaskParamsSchema = z.object({ companyId: z.uuid(), taskId: z.uuid() });
const ReviewParamsSchema = z.object({ companyId: z.uuid(), reviewId: z.uuid() });
const DIFF_CAP = 200_000;

export async function registerReviewRoutes(
  app: FastifyInstance,
  deps: ReviewRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function requireMember(userId: string, companyId: string): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
  }

  typed.get(
    "/api/v1/companies/:companyId/tasks/:taskId/reviews",
    {
      schema: {
        params: TaskParamsSchema,
        response: { 200: ReviewListResponseSchema },
        tags: ["reviews"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, taskId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const rows = await new ReviewsService(db).listForTask(ctx, taskId);
      const agentIds = [
        ...new Set(rows.flatMap((r) => [r.authorAgentId, r.reviewerAgentId]).filter(Boolean)),
      ] as string[];
      const names = new Map<string, string>();
      for (const id of agentIds) {
        const [row] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, id)));
        if (row) names.set(id, row.name);
      }
      return {
        items: rows.map((r) =>
          ReviewDtoSchema.parse({
            id: r.id,
            taskId: r.taskId,
            kind: r.kind,
            branch: r.branch,
            status: r.status,
            authorAgentId: r.authorAgentId,
            authorName: names.get(r.authorAgentId) ?? null,
            reviewerAgentId: r.reviewerAgentId,
            reviewerName: r.reviewerAgentId ? (names.get(r.reviewerAgentId) ?? null) : null,
            verdictMd: r.verdictMd,
            mergedCommit: r.mergedCommit,
            createdAt: r.createdAt.toISOString(),
            decidedAt: r.decidedAt?.toISOString() ?? null,
          }),
        ),
      };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/reviews/:reviewId/diff",
    {
      schema: {
        params: ReviewParamsSchema,
        response: { 200: ReviewDiffResponseSchema },
        tags: ["reviews"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, reviewId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const [review] = await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, reviewId)));
      if (!review) throw new ApiError("not_found", "review not found");
      if (!review.workspaceId) throw new ApiError("not_found", "review has no workspace");
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, review.workspaceId)));
      if (!workspace || ["destroyed", "failed"].includes(workspace.status)) {
        throw new ApiError("not_found", "workspace is gone — download the merged commit instead");
      }
      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "sandbox not wired");
      const res = await fetch(`${sandbox.url}/internal/v1/workspaces/${workspace.id}/exec`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandbox.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: ["git", "diff", "origin/main...HEAD"],
          cwd: "/work",
          env: {},
          timeoutMs: 30_000,
        }),
      });
      if (!res.ok) throw new ApiError("internal", `diff exec failed (${res.status})`);
      const result = (await res.json()) as { exitCode: number; stdout: string; stderr: string };
      if (result.exitCode !== 0) {
        throw new ApiError("internal", `git diff failed: ${result.stderr.slice(0, 200)}`);
      }
      return {
        diff: result.stdout.slice(0, DIFF_CAP),
        truncated: result.stdout.length > DIFF_CAP,
      };
    },
  );
}
