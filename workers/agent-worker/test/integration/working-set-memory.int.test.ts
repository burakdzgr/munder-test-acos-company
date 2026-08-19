// T45 — buildWorkingSetActivity renders 08 §8 sections 4–6 from REAL memory
// rows: company/project/agent blocks appear between the task card and the
// thread, labeled with memory ids; retrieval degradation (no embedding
// target) never breaks the build. Direct activity invocation — no Temporal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { uuidv7 } from "@acos/domain";
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
  users,
} from "@acos/db/schema";
import { eq } from "drizzle-orm";
import type { ModelRouter } from "@acos/llm";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { startPostgres } from "./helpers";

const DIM = 768;

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let companyId = "";
let agentId = "";
let projectId = "";
let taskId = "";

function unit(index: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[index] = 1;
  return v;
}

/** Embed-only fake router: the fixed unit(0) query vector. */
const embedRouter = {
  complete: async () => {
    throw new Error("not used");
  },
  embed: async () => ({
    embedding: unit(0),
    dimension: DIM,
    usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 },
    providerId: "fake",
    model: "unit-0",
    latencyMs: 1,
    costCents: 0,
  }),
} as unknown as ModelRouter;

function activitiesWith(router: ModelRouter) {
  return createAgentTaskActivities({
    guardedDb,
    router,
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "embedding", providerId: "fake", model: "unit-0" }],
    }),
  });
}

beforeAll(async () => {
  pgContainer = await startPostgres();
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t45ws.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "WsCo", slug: "wsco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unitRow] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Ws Dev",
      status: "active",
      positionId: position!.id,
      orgUnitId: unitRow!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Builds.",
    })
    .returning();
  agentId = agent!.id;
  projectId = uuidv7();
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "WsProj",
    slug: "wsproj",
    objectiveMd: "x",
    status: "active",
    createdByUserId: founder!.id,
  });
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 1,
      kind: "task",
      title: "Fix the exporter",
      objective: "Exporter must stream.",
      status: "IN_PROGRESS",
      ownerAgentId: agentId,
      projectId,
      context: {},
    })
    .returning();
  taskId = task!.id;

  const seedMemory = async (input: {
    scope: "agent" | "project" | "company";
    type: string;
    title: string;
    embedding: number[] | null;
  }) => {
    await db.insert(memories).values({
      companyId,
      scope: input.scope,
      scopeRef:
        input.scope === "project" ? projectId : input.scope === "agent" ? agentId : null,
      type: input.type,
      title: input.title,
      content: `content: ${input.title}`,
      summary: `summary: ${input.title}`,
      entities: {},
      importance: 0.8,
      confidence: 0.9,
      status: "active",
      ...(input.embedding && {
        embedding: `[${input.embedding.join(",")}]`,
        embeddingDim: DIM,
      }),
      embeddingModel: input.embedding ? "unit-0" : null,
    });
  };
  await seedMemory({
    scope: "company",
    type: "procedural",
    title: "Run npm test before review",
    embedding: null, // SQL lane
  });
  await seedMemory({
    scope: "project",
    type: "decision",
    title: "ADR-3: streaming exports",
    embedding: null, // SQL lane
  });
  await seedMemory({
    scope: "agent",
    type: "semantic",
    title: "Exporter internals notes",
    embedding: unit(0), // semantic lane: cosine 1.0 to the fake query vector
  });
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await pgContainer?.stop();
});

describe("working set memory sections (08 §8 / 12 §7)", { timeout: 60_000 }, () => {
  it("renders sections 4–6 with labeled memory blocks and logs the retrieval", async () => {
    const activities = activitiesWith(embedRouter);
    const ws = await activities.buildWorkingSetActivity({
      companyId,
      agentId,
      taskId,
      sessionId: uuidv7(),
      stepNo: 1,
    });
    const user = ws.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("# Company memory");
    expect(user).toContain("Run npm test before review");
    expect(user).toContain("# Project memory");
    expect(user).toContain("ADR-3: streaming exports");
    expect(user).toContain("# Agent memory");
    expect(user).toContain("Exporter internals notes");
    expect(user).toMatch(/\[memory [0-9a-f-]{36} \| procedural \| conf 0\.90\]/);

    const logs = await db
      .select()
      .from(memoryRetrievals)
      .where(eq(memoryRetrievals.companyId, companyId));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.semanticSkipped).toBe(false);
    expect(logs[0]!.returnedIds.length).toBeGreaterThanOrEqual(3);
  });

  // B3 (26 §3): prompt caching'in üzerinde durduğu tek varsayım, işaretlenen
  // önekin adımlar arasında BİREBİR aynı kalması. Değişken bir alan oraya
  // sızarsa cache her adımda ıskalar; fatura düşmez, artar. Bu yüzden asıl
  // iddia "cache açık" değil, "önek gerçekten sabit".
  it("cache'lenen sabit önek adımlar arasında birebir aynı kalır", async () => {
    const activities = activitiesWith(embedRouter);
    const first = await activities.buildWorkingSetActivity({
      companyId,
      agentId,
      taskId,
      sessionId: uuidv7(),
      stepNo: 1,
    });
    const second = await activities.buildWorkingSetActivity({
      companyId,
      agentId,
      taskId,
      sessionId: uuidv7(),
      stepNo: 7, // farklı adım, farklı oturum, farklı sinyaller
      signalMarkers: ["[signal:reviewVerdict=changes_requested]"],
    });

    const prefixOf = (ws: { messages: Array<{ role: string; content: string; cacheable?: boolean }> }) =>
      ws.messages.find((m) => m.cacheable === true);

    const a = prefixOf(first);
    const b = prefixOf(second);
    expect(a, "cache breakpoint işaretlenmemiş").toBeDefined();
    expect(b).toBeDefined();
    expect(b!.content).toBe(a!.content); // birebir aynı → cache isabet eder
    // önek gerçekten ödemeye değecek kadar büyük olmalı (katalog içeride)
    expect(a!.content).toContain("AgentAction catalog");
    expect(a!.content.length).toBeGreaterThan(1000);

    // …ve adıma özgü her şey ÖNEKTEN SONRA: aksi hâlde ikinci çağrıda cache ıskalar
    expect(a!.content).not.toContain("lastExitCode");
    expect(a!.content).not.toContain("Step 1");
    const userSecond = second.messages.find((m) => m.role === "user")!.content;
    expect(userSecond).toContain("[signal:reviewVerdict=changes_requested]");
    expect(userSecond).toContain("Step 7");
    // iki adımın değişken kısmı farklı — yani test sabitliği tesadüfen ölçmüyor
    expect(userSecond).not.toBe(first.messages.find((m) => m.role === "user")!.content);
  });

  it("no embedding target ⇒ semantic lane skipped, build still succeeds (12 §7.5c)", async () => {
    const failingRouter = {
      complete: async () => {
        throw new Error("not used");
      },
      embed: async () => {
        throw new Error("no embedding provider");
      },
    } as unknown as ModelRouter;
    const activities = activitiesWith(failingRouter);
    const ws = await activities.buildWorkingSetActivity({
      companyId,
      agentId,
      taskId,
      sessionId: uuidv7(),
      stepNo: 1,
    });
    const user = ws.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("ADR-3: streaming exports"); // SQL lanes still serve
    expect(user).not.toContain("Exporter internals notes"); // semantic lane dark

    const logs = await db
      .select()
      .from(memoryRetrievals)
      .where(eq(memoryRetrievals.companyId, companyId));
    expect(logs.some((l) => l.semanticSkipped)).toBe(true);
  });
});
