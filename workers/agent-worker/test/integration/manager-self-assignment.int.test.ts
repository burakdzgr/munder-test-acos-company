// T29 — "burayı ben halledeceğim" AKSİYON düzeyinde.
//
// packages/db tarafı yolu açtı (yönetici artık aday havuzunda). Buradaki
// sözleşme aksiyon sözlüğünün kendisi: model kendine iş almayı NASIL söyler ve
// söylediğinde ne olur.
//
// Sözleşme (bu test): (1) toAgentId = SELF_SENTINEL → iş gerçekten yöneticinin
// üstüne yazılır, (2) bu açık niyet TASK 12 yetenek-override'ına TAKILMAZ —
// o kural "CEO ilgisiz ajana iş dayatmasın" içindir; kendi alt görevinin
// sorumluluğunu almak dayatma değildir (07 §6 izin katmanı zaten onaylar),
// (3) CONTEXT_SENTINEL yolu bozulmadan durur: Scheduler yine raporu seçer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import {
  TasksService,
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
  companyMembers,
  orgEdges,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import type { ModelRouter } from "@acos/llm";
import { CONTEXT_SENTINEL_UUID, SELF_SENTINEL_UUID } from "@acos/llm/agent-action";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { startPostgres } from "./helpers";

describe("yönetici kendine iş alır (T29, aksiyon sözlüğü)", { timeout: 300_000 }, () => {
  let pgContainer: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let pool: Pool | undefined;
  let db: Db;
  let guardedDb: GuardedDb;
  let ctx: CompanyContext;
  let tasksSvc: TasksService;
  let companyId = "";
  let MIRA = ""; // manager
  let ADA = ""; // frontend member — MIRA'nın raporu
  let activities: ReturnType<typeof createAgentTaskActivities>;
  let counter = 0;

  /** MIRA'nın kendi işini bölmesi: ana iş + bir alt görev. */
  async function decompose(requiredCapabilities?: string[]): Promise<string> {
    counter += 1;
    const parent = await tasksSvc.create(
      ctx,
      { kind: "task", title: `Ana is ${counter}`, objective: "o" },
      { kind: "agent", agentId: MIRA },
    );
    const child = await tasksSvc.create(
      ctx,
      {
        kind: "subtask",
        parentId: parent.id,
        title: `Alt is ${counter}`,
        objective: "o",
        ...(requiredCapabilities && { context: { requiredCapabilities } }),
      },
      { kind: "agent", agentId: MIRA },
    );
    return child.id;
  }

  const delegate = async (taskId: string, toAgentId: string) =>
    activities.executeActionActivity({
      companyId,
      agentId: MIRA,
      taskId,
      sessionId: uuidv7(),
      stepId: uuidv7(),
      action: { type: "delegate_task", taskId, toAgentId, note: "bu dilimi ben alıyorum" },
    });

  const ownerOf = async (taskId: string) =>
    (
      await db
        .select({ ownerAgentId: tasks.ownerAgentId })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
    )[0]!.ownerAgentId;

  beforeAll(async () => {
    pgContainer = await startPostgres();
    await runMigrations(pgContainer.getConnectionUri());
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on("error", () => {});
    db = createDb(pool);
    guardedDb = createGuardedDb(pool);
    tasksSvc = new TasksService(guardedDb);

    const [founder] = await db
      .insert(users)
      .values({ email: "founder@selfaction.local", passwordHash: "x", displayName: "F" })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: "SelfActionCo", slug: "selfactionco", createdByUserId: founder!.id })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    await db.insert(companyMembers).values({ companyId, userId: founder!.id, role: "founder" });

    const [productUnit] = await db
      .insert(orgUnits)
      .values({ companyId, kind: "team", name: "Product", slug: "product" })
      .returning();
    // ADA'nın takımı yetenek eşleşmesini sağlar (u2.slug ILIKE '%frontend%')
    const [frontendUnit] = await db
      .insert(orgUnits)
      .values({ companyId, kind: "team", name: "Frontend", slug: "frontend" })
      .returning();
    const [managerPos] = await db
      .insert(positions)
      .values({
        companyId,
        title: "Ürün Yöneticisi",
        seniorityTrack: ["senior"],
        defaultRole: "manager",
      })
      .returning();
    const [memberPos] = await db
      .insert(positions)
      .values({
        companyId,
        title: "Arayüz Geliştirici",
        seniorityTrack: ["mid"],
        defaultRole: "member",
      })
      .returning();
    const hire = async (n: number, name: string, positionId: string, orgUnitId: string) =>
      (
        await db
          .insert(agents)
          .values({
            companyId,
            employeeNumber: n,
            name,
            status: "active",
            positionId,
            orgUnitId,
            seniority: "senior",
            autonomyLevel: 3,
            persona: "x",
          })
          .returning()
      )[0]!.id;
    MIRA = await hire(901, "Mira Sonmez", managerPos!.id, productUnit!.id);
    ADA = await hire(902, "Ada Kaya", memberPos!.id, frontendUnit!.id);
    await db
      .insert(orgEdges)
      .values({ companyId, fromAgentId: MIRA, toAgentId: ADA, kind: "manages" });

    activities = createAgentTaskActivities({
      guardedDb,
      router: null as unknown as ModelRouter, // bu yollar LLM'e hiç uğramaz
      routingFor: async () => ({ bindings: [], profiles: [] }),
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("SELF sentinel işi yöneticinin ÜSTÜNE yazar", async () => {
    const taskId = await decompose();
    const result = await delegate(taskId, SELF_SENTINEL_UUID);
    expect(result).toMatchObject({ ok: true, delegated: true, toAgentId: MIRA });
    expect(await ownerOf(taskId)).toBe(MIRA);
  });

  it("açık self niyeti yetenek-override'ına TAKILMAZ", async () => {
    // Alt görev 'frontend' istiyor: ADA uyar, MIRA (Product/Ürün Yöneticisi)
    // uymaz. TASK 12 override'ı ACIK hedefi Scheduler'ın seçimiyle değiştirir —
    // ama kendine atama dayatma değildir, niyet aynen uygulanır.
    const taskId = await decompose(["frontend"]);
    const result = await delegate(taskId, SELF_SENTINEL_UUID);
    expect(result).toMatchObject({ ok: true, toAgentId: MIRA });
    expect(result.note).toBeUndefined(); // "Scheduler hedefi değiştirdi" YOK
    expect(await ownerOf(taskId)).toBe(MIRA);
  });

  it("CONTEXT_SENTINEL yolu bozulmaz — Scheduler yine raporu seçer", async () => {
    const taskId = await decompose(["frontend"]);
    const result = await delegate(taskId, CONTEXT_SENTINEL_UUID);
    expect(result).toMatchObject({ ok: true, toAgentId: ADA });
    expect(await ownerOf(taskId)).toBe(ADA);
  });
});
