// E4/A (T30) — MCP yüzeyinin HTTP uçları.
//
// İki ayrı kapı, iki ayrı kimlik:
//  * `/internal/v1/mcp/sessions*` — HOST tarafı (broker). INTERNAL_API_TOKEN
//    ile korunur, jeton basar/iptal eder. Bu jeton konteynere GİRMEZ.
//  * `/mcp/v1` — KONTEYNER tarafı. Yalnız basılmış oturum jetonunu kabul eder;
//    kimlik o jetondan türer, istek gövdesinden asla.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual } from "node:crypto";
import { companyContext, type GuardedDb } from "@acos/db";
import type { ToolGateway } from "../tools/gateway.js";
import { handleMcpRpc, type JsonRpcRequest } from "./server.js";
import {
  MCP_TOKEN_MAX_TTL_SEC,
  mintMcpSession,
  revokeMcpSession,
  touchMcpSession,
  verifyMcpToken,
} from "./sessions.js";

export interface McpRoutesDeps {
  guardedDb: () => GuardedDb;
  gateway: () => ToolGateway;
  internalApiToken: () => string;
  /** Konteynerin çağıracağı mutlak adres (workspace ağından erişilebilir). */
  publicMcpUrl: () => string;
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function bearerValue(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

const JsonRpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function registerMcpRoutes(app: FastifyInstance, deps: McpRoutesDeps): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // --- broker (host): jeton bas ---------------------------------------
  typed.post(
    "/internal/v1/mcp/sessions",
    {
      schema: {
        body: z.object({
          companyId: z.uuid(),
          agentId: z.uuid(),
          taskId: z.uuid().nullish(),
          agentSessionId: z.uuid().nullish(),
          ttlSec: z.number().int().min(60).max(MCP_TOKEN_MAX_TTL_SEC).optional(),
        }),
        tags: ["mcp"],
        hide: true,
      },
    },
    async (request, reply) => {
      if (!bearerOk(request.headers.authorization, deps.internalApiToken())) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const { companyId, agentId } = request.body;
      const minted = await mintMcpSession(deps.guardedDb(), companyContext(companyId), {
        agentId,
        taskId: request.body.taskId ?? null,
        agentSessionId: request.body.agentSessionId ?? null,
        ...(request.body.ttlSec !== undefined && { ttlSec: request.body.ttlSec }),
      });
      return { ...minted, mcpUrl: deps.publicMcpUrl() };
    },
  );

  // --- broker (host): jeton iptal --------------------------------------
  typed.post(
    "/internal/v1/mcp/sessions/:mcpSessionId/revoke",
    {
      schema: {
        params: z.object({ mcpSessionId: z.uuid() }),
        body: z.object({ companyId: z.uuid() }),
        tags: ["mcp"],
        hide: true,
      },
    },
    async (request, reply) => {
      if (!bearerOk(request.headers.authorization, deps.internalApiToken())) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const result = await revokeMcpSession(
        deps.guardedDb(),
        companyContext(request.body.companyId),
        request.params.mcpSessionId,
      );
      return reply.status(result.revoked ? 200 : 404).send(result);
    },
  );

  // --- konteyner: MCP (JSON-RPC 2.0) -----------------------------------
  app.post("/mcp/v1", { schema: { hide: true } }, async (request, reply) => {
    const auth = await verifyMcpToken(deps.guardedDb(), bearerValue(request.headers.authorization));
    if (!auth.ok) {
      const status =
        auth.failure.code === "forbidden" ? 403 : auth.failure.code === "conflict" ? 409 : 401;
      return reply.status(status).send(auth.failure);
    }
    const parsed = JsonRpcSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "invalid JSON-RPC request" },
      });
    }
    const response = await handleMcpRpc(
      { db: deps.guardedDb, gateway: deps.gateway },
      auth.identity,
      parsed.data as JsonRpcRequest,
    );
    // Kullanım izi denetim içindir; başarısız olması çağrıyı düşürmemeli.
    await touchMcpSession(
      deps.guardedDb(),
      companyContext(auth.identity.companyId),
      auth.identity.mcpSessionId,
    ).catch(() => {});
    if (!response) return reply.status(202).send();
    return reply.status(200).send(response);
  });
}
