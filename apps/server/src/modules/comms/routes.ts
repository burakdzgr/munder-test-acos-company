// Communication routes (11 §4.2, T33) — the Founder's REST surface. Agents
// have NO HTTP path; their only entry is sendMessageActivity → the same
// MessageService (guards impossible to bypass). Delivery signalling is
// best-effort post-commit via the Temporal SignalPort main.ts attaches.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ChannelMemberSchema,
  ChannelSchema,
  CreateDmRequestSchema,
  MessageSchema,
  SendMessageRequestSchema,
} from "@acos/contracts";
import { uuidv7 } from "@acos/domain";
import {
  ChannelService,
  CommsError,
  MessageService,
  companyContext,
  deliverMessage,
  type ChannelRow,
  type CompanyContext,
  type GuardedDb,
  type MessageRow,
  type SignalPort,
} from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

const idParam = z.object({ id: z.uuid() });
const channelParam = idParam.extend({ channelId: z.uuid() });

function toApiChannel(c: ChannelRow) {
  return {
    id: c.id,
    kind: c.kind as never,
    name: c.name,
    orgUnitId: c.orgUnitId,
    projectId: c.projectId,
    taskId: c.taskId,
    reviewId: c.reviewId,
    dmKey: c.dmKey,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

function toApiMessage(m: MessageRow) {
  return {
    id: m.id,
    channelId: m.channelId,
    senderAgentId: m.senderAgentId,
    kind: m.kind as never,
    body: m.body,
    refs: (m.refs as Array<{ kind: string; id: string }>) ?? [],
    replyToMessageId: m.replyToMessageId,
    createdAt: m.createdAt.toISOString(),
  };
}

function mapCommsError(err: unknown): never {
  if (err instanceof CommsError) {
    if (err.code === "CHANNEL_NOT_FOUND") throw new ApiError("not_found", err.message);
    throw new ApiError("validation_failed", err.message);
  }
  throw err;
}

export async function registerCommsRoutes(
  rawApp: FastifyInstance,
  deps: {
    guardedDb: () => GuardedDb;
    companiesSvc: () => CompanyService;
    signalPort: () => SignalPort | null;
  },
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const channelSvc = () => new ChannelService(deps.guardedDb());
  const messageSvc = () => new MessageService(deps.guardedDb());

  async function requireCompany(request: FastifyRequest, companyId: string): Promise<CompanyContext> {
    const user = request.requireUser();
    const role = await deps.companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return companyContext(companyId);
  }

  app.get(
    "/api/v1/companies/:id/channels",
    {
      schema: {
        operationId: "listChannels",
        tags: ["comms"],
        params: idParam,
        querystring: z.object({ kind: z.string().optional() }),
        response: { 200: z.array(ChannelSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const rows = await channelSvc().list(ctx, { kind: request.query.kind });
      return rows.map(toApiChannel);
    },
  );

  app.post(
    "/api/v1/companies/:id/channels",
    {
      schema: {
        operationId: "createChannel",
        tags: ["comms"],
        params: idParam,
        body: CreateDmRequestSchema,
        response: { 200: ChannelSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      // Founder ↔ agent DM get-or-create (11 §2)
      const channel = await channelSvc().getOrCreateDm(ctx, null, request.body.agentId);
      return toApiChannel(channel);
    },
  );

  app.get(
    "/api/v1/companies/:id/channels/:channelId/messages",
    {
      schema: {
        operationId: "listMessages",
        tags: ["comms"],
        params: channelParam,
        querystring: z.object({
          beforeId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.array(MessageSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const rows = await messageSvc().page(ctx, request.params.channelId, request.query);
      return rows.map(toApiMessage);
    },
  );

  app.post(
    "/api/v1/companies/:id/channels/:channelId/messages",
    {
      schema: {
        operationId: "sendMessage",
        tags: ["comms"],
        params: channelParam,
        body: SendMessageRequestSchema,
        response: { 201: MessageSchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const plan = await messageSvc()
        .send(ctx, {
          channelId: request.params.channelId,
          senderAgentId: null, // the Founder
          kind: request.body.kind,
          body: request.body.body,
          refs: request.body.refs,
          mentions: request.body.mentions,
          replyToMessageId: request.body.replyToMessageId,
          idempotencyKey: uuidv7(), // server mints for Founder sends (11 §4.2)
        })
        .catch(mapCommsError);
      const port = deps.signalPort();
      // O3: the message row is committed either way, but a failed delivery
      // signal means the recipient never WAKES — the Founder writes to an
      // agent and nothing happens, with nothing anywhere saying why. The
      // send still succeeds (the thread is durable, 11 §4.4), but the failure
      // is logged instead of vanishing.
      if (port) {
        await deliverMessage(deps.guardedDb(), ctx, plan, port).catch((err: unknown) => {
          request.log.warn(
            { err, channelId: request.params.channelId, messageId: plan.message.id },
            "message delivery signal failed — recipient will pick it up on its next poll",
          );
        });
      }
      return reply.status(201).send(toApiMessage(plan.message));
    },
  );

  app.post(
    "/api/v1/companies/:id/channels/:channelId/read",
    {
      schema: {
        operationId: "markChannelRead",
        tags: ["comms"],
        params: channelParam,
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      await channelSvc().markRead(ctx, request.params.channelId, null);
      return { ok: true };
    },
  );

  app.get(
    "/api/v1/companies/:id/channels/:channelId/members",
    {
      schema: {
        operationId: "listChannelMembers",
        tags: ["comms"],
        params: channelParam,
        response: { 200: z.array(ChannelMemberSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const rows = await channelSvc().members(ctx, request.params.channelId);
      return rows.map((m) => ({
        agentId: m.agentId,
        joinedAt: m.joinedAt.toISOString(),
        lastReadAt: m.lastReadAt?.toISOString() ?? null,
      }));
    },
  );
}
