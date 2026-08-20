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
import { checkSessionGate, companyContext, type GuardedDb } from "@acos/db";
import { auditBuiltinTool } from "./builtin-audit.js";
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
  /** E4/A: şirket başına eşzamanlı canlı oturum tavanı (broker admission). */
  maxLiveSessionsPerCompany: () => number;
  /** Family B: ORTAK eylem dağıtıcısı (@acos/agent-actions). */
  dispatcher: () => import("@acos/agent-actions").ActionDispatcher;
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

  // --- broker (host): oturum kabulü (şirket eşzamanlılık tavanı) --------
  // Kevin'in broker'ı CLI sürecini DOĞURMADAN ÖNCE burayı sorar. Tavanın
  // kendisi Scheduler'ın (bu uç yalnız aynı kapıyı — @acos/db checkSessionGate
  // — okur), yani iki farklı yerde iki farklı tavan oluşamaz.
  //
  // SERBEST BIRAKMA UCU YOK, bilerek: yer, `agent_sessions` satırı
  // starting/running olmaktan çıkınca boşalır. Broker'a ayrı bir "release"
  // vermek, oturum yaşam döngüsünün İKİNCİ bir sahibini yaratırdı; broker
  // çökerse yer, oturumu kapatan mevcut yollarla (workflow kapanışı + 30 dk
  // stuck sweep) yine boşalır.
  typed.post(
    "/internal/v1/agent-sessions/admit",
    {
      schema: {
        body: z.object({
          companyId: z.uuid(),
          agentId: z.uuid(),
          taskId: z.uuid(),
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
      const cap = deps.maxLiveSessionsPerCompany();
      const gate = await checkSessionGate(deps.guardedDb(), {
        companyId: request.body.companyId,
        agentId: request.body.agentId,
        taskId: request.body.taskId,
        maxLiveSessionsPerCompany: cap,
      });
      if (gate.ok) return { admitted: true, cap };
      return {
        admitted: false,
        cap,
        reason: gate.reason,
        liveSessions: gate.liveSessions,
        // tavan sürekli değişen bir şey değil; agresif yoklama makineyi
        // yormasın diye ölçülü bir geri çekilme öneriyoruz
        retryAfterMs: 30_000,
      };
    },
  );

  // --- konteyner: CLI'ın YERLEŞİK araçları için denetim + politika ------
  // Kevin'in PreToolUse kancası her Bash/Read/Edit/Write'tan ÖNCE burayı
  // çağırır; INV-3 böylece korunur (işlem başına karar + tool_invocations
  // satırı). Çalıştırma CLI'da kalır — gateway koşturmaz (auditOnly).
  //
  // Bu uç /internal/* altında ama SADECE oturum jetonunu kabul eder: onu
  // çağıran taraf KONTEYNERDİR ve şirket çapındaki internal token oraya
  // hiçbir koşulda girmez.
  app.post("/internal/v1/tool-invocations/builtin", { schema: { hide: true } }, async (request, reply) => {
    const auth = await verifyMcpToken(deps.guardedDb(), bearerValue(request.headers.authorization));
    if (!auth.ok) {
      const status =
        auth.failure.code === "forbidden" ? 403 : auth.failure.code === "conflict" ? 409 : 401;
      return reply.status(status).send({ allow: false, ...auth.failure });
    }
    const body = z
      .object({
        tool: z.string().min(1).max(80),
        input: z.record(z.string(), z.unknown()).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(request.body);
    if (!body.success) {
      // fail-closed: anlamadığımız istek geçmez
      return reply
        .status(400)
        .send({ allow: false, reason: "validation_failed", issues: body.error.issues });
    }
    const result = await auditBuiltinTool(deps.gateway(), auth.identity, {
      tool: body.data.tool,
      args: body.data.args ?? body.data.input ?? {},
    });
    await touchMcpSession(
      deps.guardedDb(),
      companyContext(auth.identity.companyId),
      auth.identity.mcpSessionId,
    ).catch(() => {});
    return reply.status(200).send(result);
  });

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
      { db: deps.guardedDb, gateway: deps.gateway, dispatcher: deps.dispatcher },
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
