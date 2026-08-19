// B1' — platform-data araçlarının wiring testi (17 §4, 12 §7).
//
// `task.query` ve `memory.search` katalogda kayıtlıydı ve grant'i vardı ama
// dispatch'te karşılığı yoktu: ajan aracı çağırıyor, bir adım + bir LLM
// çağrısı yakıyor, `${tool} dispatch lands with a later task` hatasını
// alıyordu. Bu kusur tip sistemine görünmez — yalnız davranış testi tutar.
//
// Bu iki araç workspace/konteyner İSTEMEZ, o yüzden testin Docker'a ihtiyacı
// yok; yalnız gerçek Postgres gerekiyor. Çağrılar Gateway'den geçiyor (INV-3):
// grant → policy → audit satırı → dispatch.
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
  companies,
  memories,
  memoryRetrievals,
  orgUnits,
  positions,
  projects,
  tasks,
  toolInvocations,
  toolPermissions,
  users,
} from "@acos/db/schema";
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import { createSandboxDispatchPort } from "../../src/modules/tools/dispatch.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let gateway: ToolGateway;
let companyId = "";
let DEV = "";
let OTHER = "";
let taskId = "";
let projectId = "";

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  gateway = new ToolGateway({
    db: guardedDb,
    // Bu iki araç sandbox-manager'a hiç uğramıyor; URL bilinçli olarak ölü.
    dispatch: createSandboxDispatchPort({
      guardedDb,
      sandboxManagerUrl: "http://127.0.0.1:1",
      internalApiToken: "unused-in-this-suite-0123456789",
    }),
  });

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@platform-tools.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "PlatformCo", slug: "platformco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const mkAgent = async (employeeNumber: number, name: string) => {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber,
        name,
        status: "active",
        positionId: position!.id,
        orgUnitId: unit!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: "Dev.",
      })
      .returning();
    return row!.id;
  };
  DEV = await mkAgent(1, "Dana Dev");
  OTHER = await mkAgent(2, "Osman Other");

  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "webshop",
      name: "Webshop",
      objectiveMd: "Ship it",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;

  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      projectId,
      number: 91,
      kind: "task",
      title: "Add OAuth login",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: DEV,
    })
    .returning();
  taskId = task!.id;
  await db.insert(tasks).values({
    companyId,
    projectId,
    number: 92,
    kind: "task",
    title: "Fix the checkout total",
    objective: "x",
    status: "DONE",
    ownerAgentId: OTHER,
  });

  for (const tool of ["task.query", "memory.search"]) {
    await db.insert(toolPermissions).values({
      companyId,
      toolName: tool,
      subjectKind: "agent",
      subjectId: DEV,
    });
  }

  // 12 §7: yalnız `active` satırlar geri gelir; scope izolasyonu INV-15.
  await db.insert(memories).values([
    {
      companyId,
      scope: "company",
      scopeRef: null,
      type: "procedural",
      title: "OAuth entegrasyon yordamı",
      content: "OAuth akışında state parametresi zorunlu.",
      summary: "OAuth: state parametresi zorunlu",
      importance: 0.9,
      confidence: 0.9,
      status: "active",
    },
    {
      companyId,
      scope: "agent",
      scopeRef: DEV,
      type: "episodic",
      title: "OAuth denemesi",
      content: "Kendi OAuth denemem başarısız oldu.",
      summary: "OAuth denemesi başarısız",
      importance: 0.4,
      confidence: 0.8,
      status: "active",
    },
    {
      companyId,
      scope: "agent",
      scopeRef: OTHER,
      type: "episodic",
      title: "Osman'ın OAuth notu",
      content: "Bu satır BAŞKA ajanın; DEV asla görmemeli.",
      summary: "başka ajanın OAuth notu",
      importance: 1,
      confidence: 1,
      status: "active",
    },
    {
      companyId,
      scope: "company",
      scopeRef: null,
      type: "semantic",
      title: "Eski OAuth kararı",
      content: "Bu satır arşivlendi, OAuth içeriyor ama dönmemeli.",
      summary: "arşivlenmiş OAuth kaydı",
      importance: 1,
      confidence: 1,
      status: "archived",
    },
  ]);
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("platform-data araçları gateway'den dispatch'e (B1')", () => {
  it("task.query şirketin kendi görev panosunu okur ve filtreler", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "task.query",
      input: { status: ["IN_PROGRESS"], limit: 25 },
      taskId,
    });
    expect(res.decision).toBe("allow");
    // Bağlanmadan önce burası "dispatch lands with a later task" ile failed'di.
    expect(res.status, `dispatch hatası: ${res.error ?? res.reason ?? "yok"}`).toBe("succeeded");
    const output = res.output as {
      tasks: Array<{ number: number; title: string; status: string }>;
      total: number;
      provenance: string;
    };
    expect(output.provenance).toBe("platform");
    expect(output.tasks.map((t) => t.number)).toEqual([91]);
    expect(output.total).toBe(1);

    // Gateway denetim satırı da yazıldı (17 §4 adım 7).
    const [row] = await db
      .select()
      .from(toolInvocations)
      .where(
        and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.id, res.invocationId!)),
      );
    expect(row!.status).toBe("succeeded");
  });

  it("task.query serbest metin araması başlığa vurur", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "task.query",
      input: { search: "checkout", limit: 25 },
      taskId,
    });
    expect(res.status).toBe("succeeded");
    const output = res.output as { tasks: Array<{ number: number }> };
    expect(output.tasks.map((t) => t.number)).toEqual([92]);
  });

  it("memory.search yalnız aktif + görünür scope'ları döndürür (INV-15)", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "memory.search",
      input: { query: "OAuth", limit: 10 },
      taskId,
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch hatası: ${res.error ?? res.reason ?? "yok"}`).toBe("succeeded");
    const output = res.output as {
      memories: Array<{ title: string; scope: string; score: number }>;
      provenance: string;
    };
    expect(output.provenance).toBe("platform");

    const titles = output.memories.map((m) => m.title);
    expect(titles).toContain("OAuth entegrasyon yordamı"); // company scope
    expect(titles).toContain("OAuth denemesi"); // kendi agent scope'u
    expect(titles).not.toContain("Osman'ın OAuth notu"); // başka ajanın satırı
    expect(titles).not.toContain("Eski OAuth kararı"); // archived
    // Skorlama 12 §7'nin bağlayıcı formülü: önem/tazelik/güven sıralar.
    expect(output.memories[0]!.score).toBeGreaterThan(0);
    expect(output.memories.map((m) => m.score)).toEqual(
      [...output.memories.map((m) => m.score)].sort((a, b) => b - a),
    );
  });

  it("memory.search scope daraltmasına uyar ve pull şeridini kaydeder (§7.4)", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "memory.search",
      input: { query: "OAuth", scopes: ["company"], limit: 10 },
      taskId,
    });
    expect(res.status).toBe("succeeded");
    const output = res.output as { memories: Array<{ scope: string }> };
    expect(output.memories.length).toBeGreaterThan(0);
    expect(output.memories.every((m) => m.scope === "company")).toBe(true);

    const lanes = await db
      .select()
      .from(memoryRetrievals)
      .where(
        and(eq(memoryRetrievals.companyId, companyId), eq(memoryRetrievals.lane, "tool_search")),
      );
    expect(lanes.length).toBeGreaterThan(0);
    // Embedding dispatch kenarında yok — §7.5c'nin degrade modu dürüstçe işaretli.
    expect(lanes[0]!.semanticSkipped).toBe(true);
  });

  it("eşleşme yoksa boş liste döner, hata değil", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "memory.search",
      input: { query: "kubernetes-servis-mesh", limit: 10 },
      taskId,
    });
    expect(res.status).toBe("succeeded");
    expect((res.output as { memories: unknown[] }).memories).toEqual([]);
  });
});
