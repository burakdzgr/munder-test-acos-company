// Office read-only route (36 §7 — U04; N1: additive GET only, 21-API
// conventions). Exposes the projector's floor plan so the client can render
// walls/rooms/desks. The layout stays a presentation read-model owned by the
// projector (23 §2) — nothing here writes.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { OfficeLayoutSchema } from "@acos/contracts";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import type { OfficeProjector } from "./projector.js";

const idParam = z.object({ id: z.uuid() });

export async function registerOfficeRoutes(
  rawApp: FastifyInstance,
  deps: { projector: () => OfficeProjector; companiesSvc: () => CompanyService },
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  async function requireMember(request: FastifyRequest, companyId: string): Promise<void> {
    const user = request.requireUser();
    const role = await deps.companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
  }

  app.get(
    "/api/v1/companies/:id/office/layout",
    {
      schema: {
        operationId: "getOfficeLayout",
        tags: ["office"],
        params: idParam,
        response: { 200: OfficeLayoutSchema },
      },
    },
    async (request) => {
      await requireMember(request, request.params.id);
      return deps.projector().layoutFor(request.params.id);
    },
  );
}
