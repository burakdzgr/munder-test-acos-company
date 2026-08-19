// Staffing rotaları (LIFECYCLE TASK 9+10): planning devam ucu (internal,
// intake workflow çağırır) + Founder'ın "planlamaya devam" ucu (kadro elle
// kurulduysa) — ikisi de aynı idempotent continueProjectPlanning'e iner.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { GuardedDb } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import { continueProjectPlanning } from "./service.js";

export interface StaffingRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  internalApiToken: () => string;
  /** app.agentWorkflowStarter — kayıt anında henüz bağlı olmayabilir. */
  starter: () =>
    | ((input: { companyId: string; agentId: string; taskId: string }) => Promise<boolean>)
    | null;
}

export async function registerStaffingRoutes(
  app: FastifyInstance,
  deps: StaffingRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/internal/v1/staffing/continue",
    {
      schema: {
        body: z.object({ companyId: z.uuid(), projectId: z.uuid() }),
        tags: ["staffing"],
        hide: true,
      },
    },
    async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${deps.internalApiToken()}`) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      return continueProjectPlanning(
        { guardedDb: deps.guardedDb(), startAgentWorkflow: deps.starter() },
        request.body.companyId,
        request.body.projectId,
      );
    },
  );

  // Founder: kadroyu elle kurduktan sonra planlamayı sürdür
  typed.post(
    "/api/v1/companies/:companyId/projects/:projectId/planning/continue",
    {
      schema: {
        params: z.object({ companyId: z.uuid(), projectId: z.uuid() }),
        tags: ["staffing"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      if (role !== "founder") {
        throw new ApiError("forbidden", "planlamayı yalnız Founder sürdürür");
      }
      return continueProjectPlanning(
        { guardedDb: deps.guardedDb(), startAgentWorkflow: deps.starter() },
        companyId,
        projectId,
      );
    },
  );
}
