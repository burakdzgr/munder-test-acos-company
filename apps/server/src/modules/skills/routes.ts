// Skills REST surface (T47; 13 §10): the agents × skills matrix — real
// agent_skills rows, levels always from the deterministic recompute.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  PromoteSkillRequestSchema,
  PromoteSkillResponseSchema,
  SkillCandidatesResponseSchema,
  SkillMatrixResponseSchema,
  SkillMatrixRowSchema,
} from "@acos/contracts";
import { companyContext, SkillsService, type GuardedDb } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import { EmergentSkillsService } from "./emergent.js";

export interface SkillRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
}

const CompanyParamsSchema = z.object({ companyId: z.uuid() });

export async function registerSkillRoutes(
  app: FastifyInstance,
  deps: SkillRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/v1/companies/:companyId/skills/matrix",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: SkillMatrixResponseSchema },
        tags: ["skills"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      const rows = await new SkillsService(deps.guardedDb()).matrix(companyContext(companyId));
      return {
        items: rows.map((row) =>
          SkillMatrixRowSchema.parse({
            ...row,
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          }),
        ),
      };
    },
  );

  // ---------- emergent skill discovery (36 §10 — U12) ----------

  typed.get(
    "/api/v1/companies/:companyId/skills/candidates",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: SkillCandidatesResponseSchema },
        tags: ["skills"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      const service = new EmergentSkillsService(deps.guardedDb());
      const ctx = companyContext(companyId);
      const items = await service.discover(ctx);
      // surfacing IS the proposal — first-sight pairs emit the event
      await service.proposeNew(ctx, items);
      return { items };
    },
  );

  typed.post(
    "/api/v1/companies/:companyId/skills/candidates/promote",
    {
      schema: {
        params: CompanyParamsSchema,
        body: PromoteSkillRequestSchema,
        response: { 201: PromoteSkillResponseSchema },
        tags: ["skills"],
      },
    },
    async (request, reply) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      const service = new EmergentSkillsService(deps.guardedDb());
      const result = await service.promote(companyContext(companyId), request.body);
      return reply.status(201).send(result);
    },
  );
}
