// Org routes (T18) under /api/v1/companies/:id/org/* (04 §4).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ArchiveOrgUnitResponseSchema,
  CreateOrgEdgeRequestSchema,
  CreateOrgUnitRequestSchema,
  CreatePositionRequestSchema,
  EscalationChainSchema,
  MoveOrgUnitRequestSchema,
  OrgEdgeSchema,
  OrgUnitSchema,
  PositionSchema,
  TeamRosterEntrySchema,
} from "@acos/contracts";
import { companyContext, type CompanyContext } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import { OrgConflictError, OrgCycleError, type OrgService } from "./service.js";

const idParam = z.object({ id: z.uuid() });

function toApiUnit(u: { id: string; name: string; slug: string; kind: string; parentId: string | null }) {
  return { id: u.id, name: u.name, slug: u.slug, kind: u.kind as never, parentId: u.parentId };
}

function toApiEdge(e: {
  id: string;
  fromAgentId: string;
  toAgentId: string | null;
  toUnitId: string | null;
  kind: string;
  endedAt: Date | null;
}) {
  return {
    id: e.id,
    fromAgentId: e.fromAgentId,
    toAgentId: e.toAgentId,
    toUnitId: e.toUnitId,
    kind: e.kind as never,
    endedAt: e.endedAt?.toISOString() ?? null,
  };
}

function mapOrgError(err: unknown): never {
  if (err instanceof OrgCycleError) {
    throw new ApiError("org_cycle_detected", err.message);
  }
  if (err instanceof OrgConflictError) {
    throw new ApiError("state_precondition_failed", err.message);
  }
  const root = (err as { cause?: unknown }).cause ?? err;
  const pg = root as { code?: string; constraint?: string };
  if (pg.code === "23505" && pg.constraint === "org_edges_reports_to_single_manager_uq") {
    throw new ApiError("conflict", "agent already has an active manager");
  }
  if (pg.code === "23505") throw new ApiError("conflict", "duplicate org record");
  if (pg.code === "23514") throw new ApiError("validation_failed", "org constraint violated");
  throw err;
}

export async function registerOrgRoutes(
  rawApp: FastifyInstance,
  orgSvc: () => OrgService,
  companiesSvc: () => CompanyService,
  guardedDb?: () => import("@acos/db").GuardedDb,
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  async function requireCompany(request: FastifyRequest, companyId: string): Promise<CompanyContext> {
    const user = request.requireUser();
    const role = await companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return companyContext(companyId);
  }

  app.post(
    "/api/v1/companies/:id/org/units",
    {
      schema: {
        operationId: "createOrgUnit",
        tags: ["org"],
        params: idParam,
        body: CreateOrgUnitRequestSchema,
        response: { 201: OrgUnitSchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const unit = await orgSvc()
        .createUnit(ctx, request.body)
        .catch(mapOrgError);
      // Yeni birim kurulur kurulmaz araç izinleri (2026-08-19): grant tohumu
      // boot'ta koşuyordu — boot SONRASI sihirbazla kurulan şirketin ekibi
      // restart'a kadar NO_PERMISSION_GRANT yiyordu. Idempotent, best-effort.
      try {
        if (guardedDb) {
          const { seedToolGrants } = await import("../../seed.js");
          await seedToolGrants(guardedDb(), ctx);
        }
      } catch (err) {
        request.log.warn({ err, unitId: unit.id }, "tool grant seeding failed");
      }
      return reply.status(201).send(toApiUnit(unit));
    },
  );

  app.get(
    "/api/v1/companies/:id/org/units",
    {
      schema: {
        operationId: "listOrgUnits",
        tags: ["org"],
        params: idParam,
        response: { 200: z.array(OrgUnitSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await orgSvc().listUnits(ctx)).map(toApiUnit);
    },
  );

  app.patch(
    "/api/v1/companies/:id/org/units/:unitId",
    {
      schema: {
        operationId: "moveOrgUnit",
        tags: ["org"],
        params: idParam.extend({ unitId: z.uuid() }),
        body: MoveOrgUnitRequestSchema,
        response: { 200: OrgUnitSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const unit = await orgSvc()
        .moveUnit(ctx, request.params.unitId, request.body.parentId)
        .catch(mapOrgError);
      if (!unit) throw new ApiError("not_found", "unit not found");
      return toApiUnit(unit);
    },
  );

  app.post(
    "/api/v1/companies/:id/org/units/:unitId/archive",
    {
      schema: {
        operationId: "archiveOrgUnit",
        tags: ["org"],
        params: idParam.extend({ unitId: z.uuid() }),
        response: { 200: ArchiveOrgUnitResponseSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const unit = await orgSvc()
        .archiveUnit(ctx, request.params.unitId)
        .catch(mapOrgError);
      if (!unit) throw new ApiError("not_found", "unit not found");
      return { id: unit.id, archivedAt: unit.archivedAt!.toISOString() };
    },
  );

  app.patch(
    "/api/v1/companies/:id/org/positions/:positionId",
    {
      schema: {
        operationId: "updatePositionRole",
        tags: ["org"],
        params: idParam.extend({ positionId: z.uuid() }),
        body: z.object({
          defaultRole: z.enum(["member", "reviewer", "lead", "manager", "executive"]),
        }),
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const row = await orgSvc().updatePositionRole(
        ctx,
        request.params.positionId,
        request.body.defaultRole,
      );
      if (!row) throw new ApiError("not_found", "position not found");
      return {
        id: row.id,
        title: row.title,
        seniorityTrack: row.seniorityTrack,
        defaultRole: row.defaultRole,
        description: row.description,
      };
    },
  );

  app.post(
    "/api/v1/companies/:id/org/positions",
    {
      schema: {
        operationId: "createPosition",
        tags: ["org"],
        params: idParam,
        body: CreatePositionRequestSchema,
        response: { 201: PositionSchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const position = await orgSvc().createPosition(ctx, request.body);
      return reply.status(201).send({
        id: position.id,
        title: position.title,
        seniorityTrack: position.seniorityTrack,
        defaultRole: position.defaultRole,
        description: position.description,
      });
    },
  );

  app.post(
    "/api/v1/companies/:id/org/positions/:positionId/archive",
    {
      schema: {
        operationId: "archivePosition",
        tags: ["org"],
        params: idParam.extend({ positionId: z.uuid() }),
        response: { 200: ArchiveOrgUnitResponseSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const position = await orgSvc()
        .archivePosition(ctx, request.params.positionId)
        .catch(mapOrgError);
      if (!position) throw new ApiError("not_found", "position not found");
      return { id: position.id, archivedAt: position.archivedAt!.toISOString() };
    },
  );

  app.get(
    "/api/v1/companies/:id/org/positions",
    {
      schema: {
        operationId: "listPositions",
        tags: ["org"],
        params: idParam,
        response: { 200: z.array(PositionSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await orgSvc().listPositions(ctx)).map((p) => ({
        id: p.id,
        title: p.title,
        seniorityTrack: p.seniorityTrack,
        defaultRole: p.defaultRole,
        description: p.description,
      }));
    },
  );

  app.post(
    "/api/v1/companies/:id/org/edges",
    {
      schema: {
        operationId: "createOrgEdge",
        tags: ["org"],
        params: idParam,
        body: CreateOrgEdgeRequestSchema,
        response: { 201: OrgEdgeSchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const edge = await orgSvc()
        .createEdge(ctx, request.body)
        .catch(mapOrgError);
      return reply.status(201).send(toApiEdge(edge));
    },
  );

  app.get(
    "/api/v1/companies/:id/org/edges",
    {
      schema: {
        operationId: "listOrgEdges",
        tags: ["org"],
        params: idParam,
        response: { 200: z.array(OrgEdgeSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await orgSvc().listEdges(ctx)).map(toApiEdge);
    },
  );

  app.post(
    "/api/v1/companies/:id/org/edges/:edgeId/end",
    {
      schema: {
        operationId: "endOrgEdge",
        tags: ["org"],
        params: idParam.extend({ edgeId: z.uuid() }),
        response: { 200: OrgEdgeSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const edge = await orgSvc().endEdge(ctx, request.params.edgeId);
      if (!edge) throw new ApiError("not_found", "active edge not found");
      return toApiEdge(edge);
    },
  );

  app.get(
    "/api/v1/companies/:id/org/agents/:agentId/chain",
    {
      schema: {
        operationId: "getEscalationChain",
        tags: ["org"],
        params: idParam.extend({ agentId: z.uuid() }),
        response: { 200: EscalationChainSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return orgSvc().escalationChain(ctx, request.params.agentId);
    },
  );

  app.get(
    "/api/v1/companies/:id/org/units/:unitId/roster",
    {
      schema: {
        operationId: "getTeamRoster",
        tags: ["org"],
        params: idParam.extend({ unitId: z.uuid() }),
        response: { 200: z.array(TeamRosterEntrySchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return orgSvc().teamRoster(ctx, request.params.unitId);
    },
  );
}
