// T29 / Founder karari B — "sen boldun ama burayi ben halledecegim".
//
// Oscar'in manager-self-assignment.int.test.ts'i AKSIYON sozlesmesini tek dilim
// uzerinden kanitliyor: SELF sentinel ise yoneticinin ustune yazar. Bu dosya
// Founder'in tarif ettigi ASIL SEKLI kanitliyor — yonetici isi COK dilime
// boler, BIRINI kendine alir, kalanini asagi verir — ve kendine aldigi dilimin
// olu uca dusmedigini gosterir.
//
// Neden canli kapi degil de hedefli entegrasyon testi: kendine almak bir MODEL
// karari (aksiyon sozlugu sentinel'i sunuyor, agent-task.ts:971). Hedefi tek
// yaprakli cozulen bir canli kosumda yoneticinin saklayacak dilimi olmaz, yani
// canli assert hicbir defo olmadan kirmizi yanabilir. Burasi ayni karari her
// seferinde deterministik olarak egzersiz eder.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import {
  ASSIGNED_QUEUE_CAP,
  TasksService,
  companyContext,
  createDb,
  createGuardedDb,
  pickNextQueuedTaskId,
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

describe("yonetici bir dilimi kendine tutar (T29, cok dilimli sekil)", { timeout: 300_000 }, () => {
  let pgContainer: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let pool: Pool | undefined;
  let db: Db;
  let guardedDb: GuardedDb;
  let ctx: CompanyContext;
  let tasksSvc: TasksService;
  let companyId = "";
  let CEO = "";
  let MIRA = ""; // lead — CEO'nun raporu, ADA + BORA'nin yoneticisi
  let ADA = "";
  let BORA = "";
  let ZEKI = ""; // raporu OLMAYAN yonetici
  let activities: ReturnType<typeof createAgentTaskActivities>;
  let epicId = "";
  const slices: string[] = [];
  let counter = 0;

  const act = async (agentId: string, taskId: string, action: Record<string, unknown>) =>
    activities.executeActionActivity({
      companyId,
      agentId,
      taskId,
      sessionId: uuidv7(),
      stepId: uuidv7(),
      action: action as never,
    });

  const rowOf = async (taskId: string) =>
    (
      await db
        .select({ ownerAgentId: tasks.ownerAgentId, status: tasks.status, parentId: tasks.parentId })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
    )[0]!;

  /** MIRA'nin epic'i altinda yeni bir dilim (sahipsiz dogar, atamayi delege yapar). */
  async function newSlice(parentId: string): Promise<string> {
    counter += 1;
    const child = await tasksSvc.create(
      ctx,
      { kind: "task", parentId, title: `Dilim ${counter}`, objective: "o" },
      { kind: "agent", agentId: MIRA },
    );
    return child.id;
  }

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
      .values({ email: "founder@keepslice.local", passwordHash: "x", displayName: "F" })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: "KeepSliceCo", slug: "keepsliceco", createdByUserId: founder!.id })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    await db.insert(companyMembers).values({ companyId, userId: founder!.id, role: "founder" });

    const unit = async (name: string, slug: string) =>
      (await db.insert(orgUnits).values({ companyId, kind: "team", name, slug }).returning())[0]!.id;
    const execUnit = await unit("Executive", "executive");
    const productUnit = await unit("Product", "product");

    const position = async (title: string, defaultRole: string) =>
      (
        await db
          .insert(positions)
          .values({ companyId, title, seniorityTrack: ["senior"], defaultRole })
          .returning()
      )[0]!.id;
    const execPos = await position("CEO", "executive");
    const leadPos = await position("Takim Lideri", "manager");
    const memberPos = await position("Gelistirici", "member");

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
    CEO = await hire(801, "Cem Ozkan", execPos, execUnit);
    MIRA = await hire(802, "Mira Sonmez", leadPos, productUnit);
    ADA = await hire(803, "Ada Kaya", memberPos, productUnit);
    BORA = await hire(804, "Bora Aslan", memberPos, productUnit);
    ZEKI = await hire(805, "Zeki Duman", leadPos, execUnit);
    await db.insert(orgEdges).values([
      { companyId, fromAgentId: CEO, toAgentId: MIRA, kind: "manages" },
      { companyId, fromAgentId: MIRA, toAgentId: ADA, kind: "manages" },
      { companyId, fromAgentId: MIRA, toAgentId: BORA, kind: "manages" },
    ]);

    activities = createAgentTaskActivities({
      guardedDb,
      router: null as unknown as ModelRouter, // bu yollarin hicbiri LLM'e ugramaz
      routingFor: async () => ({ bindings: [], profiles: [] }),
    });

    // Canli seklin aynisi: CEO hedefi kirar (07 §2 hiyerarsisi: goal <
    // initiative < epic < task), epic'i lead'e verir, lead onu boler.
    const asCeo = { kind: "agent" as const, agentId: CEO };
    const goal = await tasksSvc.create(
      ctx,
      { kind: "goal", title: "Saglik ucu", objective: "o" },
      asCeo,
    );
    const initiative = await tasksSvc.create(
      ctx,
      { kind: "initiative", parentId: goal.id, title: "Saglik ucu servisi", objective: "o" },
      asCeo,
    );
    const epic = await tasksSvc.create(
      ctx,
      { kind: "epic", parentId: initiative.id, title: "Saglik ucu ve testleri", objective: "o" },
      asCeo,
    );
    epicId = epic.id;
    const handoff = await act(CEO, epicId, {
      type: "delegate_task",
      taskId: epicId,
      toAgentId: MIRA,
      note: "bu epic senin",
    });
    expect(handoff).toMatchObject({ ok: true, toAgentId: MIRA });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("uc dilimden BIRINI kendine alir, kalan ikisini raporlarina verir", async () => {
    for (let i = 0; i < 3; i += 1) slices.push(await newSlice(epicId));
    const [mine, forAda, forBora] = slices as [string, string, string];

    const kept = await act(MIRA, epicId, {
      type: "delegate_task",
      taskId: mine,
      toAgentId: SELF_SENTINEL_UUID,
      note: "bu dilimi ben aliyorum",
    });
    expect(kept).toMatchObject({ ok: true, delegated: true, toAgentId: MIRA });

    for (const [taskId, to] of [
      [forAda, ADA],
      [forBora, BORA],
    ] as const) {
      const pushed = await act(MIRA, epicId, {
        type: "delegate_task",
        taskId,
        toAgentId: to,
        note: "sende",
      });
      expect(pushed).toMatchObject({ ok: true, toAgentId: to });
      expect((pushed as { note?: string }).note).toBeUndefined(); // Scheduler override YOK
    }

    const owners = await Promise.all(slices.map(async (id) => (await rowOf(id)).ownerAgentId));
    expect(owners.filter((o) => o === MIRA)).toHaveLength(1); // BIR dilim, hepsi degil
    expect(new Set(owners)).toEqual(new Set([MIRA, ADA, BORA]));
  });

  it("kendine alinan dilim, canli kapinin (10b) aradigi yuklemi saglar", async () => {
    // 10b'nin assert'i tam olarak bu: bir cocuk gorev, EBEVEYNIYLE AYNI
    // sahipte. Canli kosumda ayni yuklem DONE bekler; buradaki mekanik kanit
    // sahiplik kismidir, DONE'a giden inceleme zinciri 10. asamanin isi.
    const epic = await rowOf(epicId);
    const kept = await rowOf(slices[0]!);
    expect(epic.ownerAgentId).toBe(MIRA);
    expect(kept.parentId).toBe(epicId);
    expect(kept.ownerAgentId).toBe(epic.ownerAgentId);
  });

  it("kendine alinan dilim olu uca dusmez — yoneticinin sirasi onu secer", async () => {
    // Epic sahibinin elinde ACIK isken sirada bekleyen sey, kendine ayirdigi
    // dilimdir: drain (agent.session.ended) bunu bulur, yoksa is sahipli ama
    // hicbir zaman baslamayan bir kayit olarak kalirdi.
    const started = await act(MIRA, epicId, {
      type: "update_task_status",
      taskId: epicId,
      to: "IN_PROGRESS",
      note: "epic'i suruyorum",
    });
    expect(started).toMatchObject({ ok: true });
    const next = await pickNextQueuedTaskId(guardedDb, companyId, MIRA);
    expect(next).toBe(slices[0]);
  });

  it("kendine almak KENDI tavanina sayilir — kuyruk dolunca reddedilir", async () => {
    // Founder karari yoneticinin dilim tutmasina izin verir, isi istiflemesine
    // degil. Tavan capacityCheck: kuyruk dolunca SELF de reddedilir ve model
    // delege etmeye yonelir.
    let refusal: { ok: boolean; error?: string } | null = null;
    for (let i = 0; i < ASSIGNED_QUEUE_CAP + 2 && !refusal; i += 1) {
      const result = (await act(MIRA, epicId, {
        type: "delegate_task",
        taskId: await newSlice(epicId),
        toAgentId: SELF_SENTINEL_UUID,
        note: "bunu da ben",
      })) as { ok: boolean; error?: string };
      if (!result.ok) refusal = result;
    }
    expect(refusal).not.toBeNull();
    expect(["WIP_LIMIT", "QUEUE_CAP", "TEAM_WIP_LIMIT"]).toContain(refusal!.error);
  });

  it("raporu OLMAYAN yonetici kendini secemez — once ekibi kur", async () => {
    // delegation.ts izin yolu: havuza kendini katmak yalnizca ekip VARKEN
    // gecerli. Aksi halde kadrosuz bir CEO her alt gorevi sessizce ustlenir ve
    // sirket hic kurulmaz — bos havuz "once ekibi kur" demeye devam etmeli.
    const parent = await tasksSvc.create(
      ctx,
      { kind: "task", title: "Zeki isi", objective: "o" },
      { kind: "agent", agentId: ZEKI },
    );
    const child = await tasksSvc.create(
      ctx,
      { kind: "subtask", parentId: parent.id, title: "Zeki dilimi", objective: "o" },
      { kind: "agent", agentId: ZEKI },
    );
    const result = await act(ZEKI, parent.id, {
      type: "delegate_task",
      taskId: child.id,
      toAgentId: CONTEXT_SENTINEL_UUID,
      note: "birine ver",
    });
    expect(result).toMatchObject({ ok: false, error: "NO_ELIGIBLE_DELEGATE" });
    expect((await rowOf(child.id)).ownerAgentId).toBeNull();
  });
});
