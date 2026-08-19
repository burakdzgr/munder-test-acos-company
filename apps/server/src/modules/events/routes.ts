// Events timeline routes (T22) under /api/v1/companies/:id/events (21 §3.11).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  EventListQuerySchema,
  EventListResponseSchema,
  EventReplayQuerySchema,
  EventReplayResponseSchema,
  EventSchema,
} from "@acos/contracts";
import { companyContext, type CompanyContext } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import type { EventsReadService } from "./read.js";

const idParam = z.object({ id: z.uuid() });

export async function registerEventRoutes(
  rawApp: FastifyInstance,
  eventsSvc: () => EventsReadService,
  companiesSvc: () => CompanyService,
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  async function requireCompany(request: FastifyRequest, companyId: string): Promise<CompanyContext> {
    const user = request.requireUser();
    const role = await companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return companyContext(companyId);
  }

  app.get(
    "/api/v1/companies/:id/events",
    {
      schema: {
        operationId: "listEvents",
        tags: ["events"],
        params: idParam,
        querystring: EventListQuerySchema,
        response: { 200: EventListResponseSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const { types, limit, cursor, ...filters } = request.query;
      return eventsSvc().list(
        ctx,
        { ...filters, types: typeof types === "string" ? [types] : types },
        limit,
        cursor,
      );
    },
  );

  app.get(
    "/api/v1/companies/:id/events/replay",
    {
      schema: {
        operationId: "replayEvents",
        tags: ["events"],
        params: idParam,
        querystring: EventReplayQuerySchema,
        response: { 200: EventReplayResponseSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return eventsSvc().replay(ctx, request.query.afterSeq, request.query.limit);
    },
  );

  app.get(
    "/api/v1/companies/:id/events/:eventId",
    {
      schema: {
        operationId: "getEvent",
        tags: ["events"],
        params: idParam.extend({ eventId: z.uuid() }),
        response: { 200: EventSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const event = await eventsSvc().get(ctx, request.params.eventId);
      if (!event) throw new ApiError("not_found", "event not found");
      return event;
    },
  );
}
