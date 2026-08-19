// Agents routes (T19) under /api/v1/companies/:id/agents.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentSchema,
  AgentSessionSchema,
  AgentStepSchema,
  CompanyAgentSessionSchema,
  ChangeAgentPlacementRequestSchema,
  HireAgentRequestSchema,
  LifecycleActionRequestSchema,
  ModelBindingSchema,
  SetModelBindingRequestSchema,
  UpdateAgentRequestSchema,
} from "@acos/contracts";
import { companyContext, type CompanyContext } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import { OrgCycleError } from "../org/service.js";
import { AgentLifecycleError, formatEmployeeNumber, type AgentsService, type AgentRow } from "./service.js";

const idParam = z.object({ id: z.uuid() });
const agentParam = idParam.extend({ agentId: z.uuid() });

function toApiAgent(a: AgentRow) {
  return {
    id: a.id,
    employeeNumber: a.employeeNumber,
    displayNumber: formatEmployeeNumber(a.employeeNumber),
    name: a.name,
    avatarUrl: a.avatarUrl,
    status: a.status as never,
    positionId: a.positionId,
    orgUnitId: a.orgUnitId,
    seniority: a.seniority as never,
    autonomyLevel: a.autonomyLevel,
    persona: a.persona,
    createdAt: a.createdAt.toISOString(),
  };
}

function mapAgentError(err: unknown): never {
  if (err instanceof AgentLifecycleError) {
    if (err.message === "AGENT_NOT_FOUND") throw new ApiError("not_found", "agent not found");
    throw new ApiError("state_precondition_failed", err.message);
  }
  if (err instanceof OrgCycleError) throw new ApiError("org_cycle_detected", err.message);
  throw err;
}

export async function registerAgentRoutes(
  rawApp: FastifyInstance,
  agentsSvc: () => AgentsService,
  companiesSvc: () => CompanyService,
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  async function requireCompany(request: FastifyRequest, companyId: string): Promise<CompanyContext> {
    const user = request.requireUser();
    const role = await companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return companyContext(companyId);
  }

  // TASK 11: model registry — binding seçimleri buradan yapılır; provider/
  // model stringleri koda dağılmaz.
  app.get(
    "/api/v1/companies/:id/model-registry",
    { schema: { operationId: "modelRegistry", tags: ["agents"], params: idParam, hide: true } },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return agentsSvc().modelRegistry(ctx);
    },
  );

  app.post(
    "/api/v1/companies/:id/agents",
    {
      schema: {
        operationId: "hireAgent",
        tags: ["agents"],
        params: idParam,
        body: HireAgentRequestSchema,
        response: { 201: AgentSchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const agent = await agentsSvc().hire(ctx, request.body).catch(mapAgentError);
      return reply.status(201).send(toApiAgent(agent));
    },
  );

  app.get(
    "/api/v1/companies/:id/agents",
    {
      schema: {
        operationId: "listAgents",
        tags: ["agents"],
        params: idParam,
        querystring: z.object({ include: z.enum(["active", "all"]).optional() }),
        response: { 200: z.array(AgentSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await agentsSvc().list(ctx, { include: request.query.include })).map(toApiAgent);
    },
  );

  app.get(
    "/api/v1/companies/:id/agents/:agentId",
    {
      schema: {
        operationId: "getAgent",
        tags: ["agents"],
        params: agentParam,
        response: { 200: AgentSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const agent = await agentsSvc().get(ctx, request.params.agentId);
      if (!agent) throw new ApiError("not_found", "agent not found");
      return toApiAgent(agent);
    },
  );

  app.patch(
    "/api/v1/companies/:id/agents/:agentId",
    {
      schema: {
        operationId: "updateAgent",
        tags: ["agents"],
        params: agentParam,
        body: UpdateAgentRequestSchema,
        response: { 200: AgentSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const agent = await agentsSvc().update(ctx, request.params.agentId, request.body);
      if (!agent) throw new ApiError("not_found", "agent not found");
      return toApiAgent(agent);
    },
  );

  app.patch(
    "/api/v1/companies/:id/agents/:agentId/placement",
    {
      schema: {
        operationId: "changeAgentPlacement",
        tags: ["agents"],
        params: agentParam,
        body: ChangeAgentPlacementRequestSchema,
        response: { 200: AgentSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const agent = await agentsSvc()
        .changePlacement(ctx, request.params.agentId, request.body)
        .catch(mapAgentError);
      return toApiAgent(agent);
    },
  );

  for (const action of ["activate", "pause", "resume", "offboard"] as const) {
    app.post(
      `/api/v1/companies/:id/agents/:agentId/${action}`,
      {
        schema: {
          operationId: `${action}Agent`,
          tags: ["agents"],
          params: agentParam,
          body: LifecycleActionRequestSchema.optional(),
          response: { 200: AgentSchema },
        },
      },
      async (request) => {
        const ctx = await requireCompany(request, request.params.id);
        const service = agentsSvc();
        const body = request.body ?? {};
        const agent = await (action === "activate"
          ? service.activate(ctx, request.params.agentId, body.topLevel ?? false)
          : action === "pause"
            ? service.pause(ctx, request.params.agentId, body.reason)
            : action === "resume"
              ? service.resume(ctx, request.params.agentId, body.reason)
              : service.offboard(ctx, request.params.agentId, body.reason)
        ).catch(mapAgentError);
        return toApiAgent(agent);
      },
    );
  }

  app.put(
    "/api/v1/companies/:id/agents/:agentId/model-bindings",
    {
      schema: {
        operationId: "setModelBinding",
        tags: ["agents"],
        params: agentParam,
        body: SetModelBindingRequestSchema,
        response: { 200: ModelBindingSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const binding = await agentsSvc().setBinding(ctx, request.params.agentId, request.body);
      return {
        id: binding.id,
        agentId: binding.agentId,
        purpose: binding.purpose as never,
        providerId: binding.providerId,
        model: binding.model,
        priority: binding.priority,
      };
    },
  );

  app.get(
    "/api/v1/companies/:id/agents/:agentId/model-bindings",
    {
      schema: {
        operationId: "listModelBindings",
        tags: ["agents"],
        params: agentParam,
        response: { 200: z.array(ModelBindingSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await agentsSvc().listBindings(ctx, request.params.agentId)).map((b) => ({
        id: b.id,
        agentId: b.agentId,
        purpose: b.purpose as never,
        providerId: b.providerId,
        model: b.model,
        priority: b.priority,
      }));
    },
  );

  app.get(
    "/api/v1/companies/:id/agents/:agentId/sessions",
    {
      schema: {
        operationId: "listAgentSessions",
        tags: ["agents"],
        params: agentParam,
        response: { 200: z.array(AgentSessionSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await agentsSvc().listSessions(ctx, request.params.agentId)).map((s) => ({
        id: s.id,
        agentId: s.agentId,
        taskId: s.taskId,
        workflowId: s.workflowId,
        status: s.status as never,
        currentActivity: s.currentActivity,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        stepsCount: s.stepsCount,
        costCents: s.costCents,
      }));
    },
  );

  // Komuta merkezi oturum hücreleri (2026-08-18): şirket genelindeki canlı
  // ajan oturumları — ana sayfa terminal ızgarası her görev alan ajan (CEO
  // dahil) için bir "oturum" hücresi açar; içeriği /agents/:id/steps besler.
  app.get(
    "/api/v1/companies/:id/agent-sessions",
    {
      schema: {
        operationId: "listCompanyAgentSessions",
        tags: ["agents"],
        params: idParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: z.array(CompanyAgentSessionSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return (await agentsSvc().listCompanySessions(ctx, { limit: request.query.limit })).map(
        (s) => ({ ...s, status: s.status as never }),
      );
    },
  );

  // Founder gözlemi (2026-08-14): canlı süreç akışı — salt-okunur adım listesi
  app.get(
    "/api/v1/companies/:id/agents/:agentId/steps",
    {
      schema: {
        operationId: "listAgentSteps",
        tags: ["agents"],
        params: agentParam,
        querystring: z.object({
          sessionId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(40),
        }),
        response: { 200: z.array(AgentStepSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      return agentsSvc().listSteps(ctx, request.params.agentId, {
        sessionId: request.query.sessionId,
        limit: request.query.limit,
      });
    },
  );
}
