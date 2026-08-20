// E4/A (T30) — MCP yüzeyi: CLI oturumu kontrol düzlemini BAYPAS EDEMEZ.
//
// Ajan turu artık konteynerde koşan bir `claude` süreci olabiliyor. O sürecin
// ACOS'a bir yolu olmalı; bu testin sözleşmesi o yolun NEREDEN geçtiğidir.
//
// (1) Kimlik JETONDAN türer, argümandan değil — istekte agentId yollamak
//     hiçbir şeyi değiştirmez; denetim satırı jetonun ajanını yazar.
// (2) Araç çağrısı Tool Gateway'e girer: aynı yetkilendirme, aynı risk sınıfı,
//     aynı `tool_invocations` satırı.
// (3) İlan edilen araç kümesi oturuma göredir — CEO yetenekleri (agent.hire,
//     org.team.create…) sıradan bir ajana GÖSTERİLMEZ.
// (4) Jeton ölümlüdür: iptal, süre, pasif ajan ve KAPANMIŞ görev ayrı ayrı
//     kapıdır. Teslim edilmiş işe geç gelen bir oturum yazamaz.
// (5) Onay bekleyişi HATA DEĞİLDİR (isError:false) — hata olsaydı model aynı
//     çağrıyı döngüye sokardı.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  orgEdges,
  orgUnits,
  positions,
  tasks,
  toolInvocations,
  toolPermissions,
} from "@acos/db/schema";
import type { ToolDispatchPort } from "../../src/modules/tools/gateway.js";
import { buildApp, type App } from "../../src/app.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 23).toString("base64");
const INTERNAL_TOKEN = "internal-mcp-token";
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let ctx: CompanyContext;
let companyId = "";
let unitId = "";
let DEV = "";
let CEO = "";
let PAUSED = "";
let openTaskId = "";
let closedTaskId = "";
let sessionCookie = "";
let csrfToken = "";

const fakePort: ToolDispatchPort = {
  async dispatch({ tool }) {
    if (tool.name === "task.query") {
      return { output: { tasks: [], total: 0, provenance: "platform" } };
    }
    if (tool.name === "memory.search") {
      return { output: { memories: [], provenance: "platform" } };
    }
    throw new Error(`fake port has no handler for ${tool.name}`);
  },
};

/** Broker (host tarafı) jetonu böyle basar — internal token KONTEYNERE GİRMEZ. */
async function mint(input: {
  agentId: string;
  taskId?: string | null;
  ttlSec?: number;
}): Promise<{ sessionToken: string; mcpSessionId: string; mcpUrl: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/internal/v1/mcp/sessions",
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { companyId, ...input },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function rpc(
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
) {
  return app.inject({
    method: "POST",
    url: "/mcp/v1",
    ...(token && { headers: { authorization: `Bearer ${token}` } }),
    payload: { jsonrpc: "2.0", id, method, ...(params && { params }) },
  });
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
    internalApiToken: INTERNAL_TOKEN,
    mcpPublicUrl: "http://server:3000/mcp/v1",
  });
  app.toolDispatchPort = fakePort;
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@mcp.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/companies",
    headers: {
      cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    payload: { name: "McpCo", slug: "mcpco" },
  });
  companyId = created.json().id;
  ctx = companyContext(companyId);

  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  unitId = unit!.id;
  const position = async (title: string, role: string) =>
    (
      await db
        .insert(positions)
        .values({ companyId, title, seniorityTrack: ["mid"], defaultRole: role })
        .returning()
    )[0]!.id;
  const memberPos = await position("Gelistirici", "member");
  const execPos = await position("CEO", "executive");
  const hire = async (n: number, name: string, positionId: string, status = "active") =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: n,
          name,
          status,
          positionId,
          orgUnitId: unitId,
          seniority: "senior",
          autonomyLevel: 4,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  DEV = await hire(901, "Dana Dev", memberPos);
  CEO = await hire(902, "Cem CEO", execPos);
  PAUSED = await hire(903, "Paula Paused", memberPos, "paused");
  for (const agentId of [DEV, CEO]) {
    await db
      .insert(orgEdges)
      .values({ companyId, fromAgentId: agentId, kind: "member_of", toUnitId: unitId });
  }

  const mkTask = async (n: number, status: string, ownerAgentId: string) =>
    (
      await db
        .insert(tasks)
        .values({
          companyId,
          number: n,
          kind: "task",
          title: `T${n}`,
          objective: "o",
          status,
          ownerAgentId,
          orgUnitId: unitId,
        })
        .returning()
    )[0]!.id;
  openTaskId = await mkTask(901, "IN_PROGRESS", DEV);
  closedTaskId = await mkTask(902, "DONE", DEV);

  // Grant'lar MCP'de de geçerlidir: task.query takıma verilir, memory.search
  // BİLEREK verilmez — CLI oturumunun izinsiz araca ulaşamadığı görülsün.
  await db.insert(toolPermissions).values({
    companyId,
    toolName: "task.query",
    subjectKind: "org_unit",
    subjectId: unitId,
    constraints: {},
  });
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("MCP tool-gateway (E4/A)", { timeout: 300_000 }, () => {
  it("ilan edilen araçların adı düzleştirilmiştir ve küme OTURUMA göredir", async () => {
    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const devTools = (await rpc(dev.sessionToken, "tools/list")).json().result.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    const names = devTools.map((t) => t.name);
    expect(names).toContain("fs_read");
    expect(names).toContain("task_query");
    expect(names.some((n) => n.includes("."))).toBe(false); // MCP ad kuralı
    // CEO yetenekleri sıradan ajana GÖSTERİLMEZ
    expect(names).not.toContain("agent_hire");
    expect(names).not.toContain("org_team_create");
    // proje veritabanı yok → db_inspect ilan edilmez
    expect(names).not.toContain("db_inspect");
    // şema gerçekten araçtan türetilir (boş nesne değil)
    const taskQuery = devTools.find((t) => t.name === "task_query")!;
    expect(taskQuery.inputSchema.type).toBe("object");
    expect(Object.keys(taskQuery.inputSchema.properties as object)).toContain("status");

    const ceo = await mint({ agentId: CEO, taskId: openTaskId });
    const ceoNames = ((await rpc(ceo.sessionToken, "tools/list")).json().result.tools as Array<{
      name: string;
    }>).map((t) => t.name);
    expect(ceoNames).toContain("agent_hire");
    expect(ceoNames).toContain("org_team_create");
  });

  it("araç çağrısı Tool Gateway'den geçer ve denetim satırı yazılır", async () => {
    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const response = await rpc(dev.sessionToken, "tools/call", {
      name: "task_query",
      arguments: { status: ["IN_PROGRESS"], limit: 5 },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json().result;
    expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
    expect(result.structuredContent.status).toBe("succeeded");
    expect(result.structuredContent.riskClass).toBe("R0");
    expect(result.structuredContent.invocationId).toBeTruthy();

    const [row] = await db
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.companyId, companyId),
          eq(toolInvocations.id, result.structuredContent.invocationId),
        ),
      );
    expect(row!.toolName).toBe("task.query"); // kanonik ad kayıtta noktalı kalır
    expect(row!.agentId).toBe(DEV);
    expect(row!.taskId).toBe(openTaskId);
  });

  it("KİMLİK jetondan gelir — argümanla başka ajan adına iş yapılamaz", async () => {
    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const response = await rpc(dev.sessionToken, "tools/call", {
      name: "task_query",
      // sözde kimlik alanları: sözleşmede yokturlar, yok sayılmalıdırlar
      arguments: { status: [], limit: 5, agentId: CEO, companyId: "00000000-0000-4000-8000-000000000001" },
    });
    const invocationId = response.json().result.structuredContent.invocationId;
    const [row] = await db
      .select({ agentId: toolInvocations.agentId, companyId: toolInvocations.companyId })
      .from(toolInvocations)
      .where(
        and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.id, invocationId)),
      );
    expect(row!.agentId).toBe(DEV); // CEO DEĞİL
    expect(row!.companyId).toBe(companyId);
  });

  it("grant'ı olmayan araç MCP üzerinden de REDDEDİLİR", async () => {
    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const response = await rpc(dev.sessionToken, "tools/call", {
      name: "memory_search",
      arguments: { query: "sirket hafizasi", limit: 5 },
    });
    const envelope = response.json().result.structuredContent;
    // Araç İLAN EDİLİR (model deneyip öğrenebilmeli) ama çağrı kapıda durur.
    expect(envelope.status).toBe("denied");
    expect(envelope.reason).toBe("NO_PERMISSION_GRANT");
    expect(response.json().result.isError).toBe(true);
  });

  it("bilinmeyen araç 500 değil, isError:true zarfı döner", async () => {
    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const response = await rpc(dev.sessionToken, "tools/call", { name: "rm_rf_slash" });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.isError).toBe(true);
    expect(response.json().result.structuredContent.status).toBe("denied");
  });

  it("jeton olmadan, iptalden sonra ve süresi dolunca geçilmez", async () => {
    expect((await rpc(null, "tools/list")).statusCode).toBe(401);
    expect((await rpc("garbage", "tools/list")).statusCode).toBe(401);
    expect((await rpc(`${companyId}.yanlis-sir`, "tools/list")).statusCode).toBe(401);

    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    expect((await rpc(dev.sessionToken, "tools/list")).statusCode).toBe(200);
    const revoked = await app.inject({
      method: "POST",
      url: `/internal/v1/mcp/sessions/${dev.mcpSessionId}/revoke`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { companyId },
    });
    expect(revoked.statusCode).toBe(200);
    expect((await rpc(dev.sessionToken, "tools/list")).statusCode).toBe(401);
  });

  it("PASİF ajanın jetonu 403, KAPANMIŞ görevin jetonu 409", async () => {
    const paused = await mint({ agentId: PAUSED, taskId: openTaskId });
    expect((await rpc(paused.sessionToken, "tools/list")).statusCode).toBe(403);

    const closed = await mint({ agentId: DEV, taskId: closedTaskId });
    // teslim edilmiş işe geç gelen oturum kontrol düzlemine yazamaz
    expect((await rpc(closed.sessionToken, "tools/list")).statusCode).toBe(409);
  });

  it("broker ucu internal token ister; konteyner jetonu oraya geçmez", async () => {
    const noToken = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp/sessions",
      payload: { companyId, agentId: DEV },
    });
    expect(noToken.statusCode).toBe(401);

    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const withSessionToken = await app.inject({
      method: "POST",
      url: "/internal/v1/mcp/sessions",
      headers: { authorization: `Bearer ${dev.sessionToken}` },
      payload: { companyId, agentId: CEO },
    });
    // oturum jetonu YENİ jeton bastıramaz — yetki yükseltme yolu kapalı
    expect(withSessionToken.statusCode).toBe(401);
  });

  it("initialize + ping MCP el sıkışmasını tamamlar, bildirim 202 döner", async () => {
    const dev = await mint({ agentId: DEV, taskId: openTaskId });
    const init = await rpc(dev.sessionToken, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "claude-code", version: "1" },
    });
    expect(init.json().result.serverInfo.name).toBe("acos");
    expect(init.json().result.capabilities.tools).toBeDefined();

    const notification = await app.inject({
      method: "POST",
      url: "/mcp/v1",
      headers: { authorization: `Bearer ${dev.sessionToken}` },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notification.statusCode).toBe(202);

    const unsupported = await rpc(dev.sessionToken, "resources/list");
    expect(unsupported.json().error.code).toBe(-32601);
  });
});
