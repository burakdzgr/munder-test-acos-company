// E4/A (T30) — canlı oturum kapısı: iki kural, tek yer.
//
// Ajan turu konteynerde koşan bir CLI süreci olunca "N ajan = N canlı süreç"
// oluyor ve köprünün fiili 3-paralel tavanı ortadan kalkıyor. Açık bir tavan
// koymazsak makineyi yine yere seririz — bir kez serdik (Docker çöküşü, 149GB
// vhdx, 20GB disk).
//
// Sözleşme (bu test): (1) meşgul ajana ikinci oturum açılmaz, (2) AYNI görev
// için yeniden başlatma engellenmez (çöküş/sweep/rework — o yeni bir
// eşzamanlılık değil, var olanın devamı), (3) şirket tavanı dolduğunda BAŞKA
// ajanın işi de başlamaz, (4) tavan yalnız CANLI oturumları sayar — kapanmış
// oturum kapasiteyi işgal etmez, (5) kapasite boşalınca şirket kuyruğu
// öncelik/yaş sırasıyla seçilir ve canlı oturumu olan ajanlar elenir.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import {
  checkSessionGate,
  createDb,
  createGuardedDb,
  pickCompanyQueuedTasks,
  runMigrations,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  agentSessions,
  agents,
  companies,
  orgUnits,
  positions,
  tasks,
  users,
} from "../../src/schema/index.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let companyId = "";
let unitId = "";
const AGENT: Record<string, string> = {};
let counter = 0;

async function seedTask(
  ownerAgentId: string,
  status = "ASSIGNED",
  priority = "P2",
): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 900 + counter,
      kind: "task",
      title: `T${counter}`,
      objective: "o",
      status,
      priority,
      ownerAgentId,
      orgUnitId: unitId,
    })
    .returning();
  return row!.id;
}

async function openSession(agentId: string, taskId: string | null): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(agentSessions)
    .values({
      companyId,
      agentId,
      taskId,
      workflowId: `wf-${counter}`,
      runId: `run-${counter}`,
      status: "running",
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@gate.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "GateCo", slug: "gateco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  unitId = unit!.id;
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  for (const [index, name] of ["ada", "bora", "ceyda", "deniz"].entries()) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber: 900 + index,
        name,
        status: "active",
        positionId: position!.id,
        orgUnitId: unitId,
        seniority: "mid",
        autonomyLevel: 3,
        persona: "x",
      })
      .returning();
    AGENT[name] = agent!.id;
  }
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("canlı oturum kapısı (E4/A)", { timeout: 300_000 }, () => {
  it("meşgul ajana ikinci oturum açılmaz; AYNI görev yeniden başlatılabilir", async () => {
    const busyTask = await seedTask(AGENT.ada!);
    const queued = await seedTask(AGENT.ada!);
    await openSession(AGENT.ada!, busyTask);

    const second = await checkSessionGate(guardedDb, {
      companyId,
      agentId: AGENT.ada!,
      taskId: queued,
      maxLiveSessionsPerCompany: 10,
    });
    expect(second).toMatchObject({ ok: false, reason: "agent_busy" });

    // çöküş sonrası restart / sweep / rework: yeni eşzamanlılık DEĞİL
    const restart = await checkSessionGate(guardedDb, {
      companyId,
      agentId: AGENT.ada!,
      taskId: busyTask,
      maxLiveSessionsPerCompany: 1,
    });
    expect(restart.ok).toBe(true);
  });

  it("şirket tavanı dolunca BAŞKA ajanın işi de başlamaz", async () => {
    // ada zaten canlı (1). tavan 2 → bora geçer, ceyda geçemez.
    const boraTask = await seedTask(AGENT.bora!);
    expect(
      await checkSessionGate(guardedDb, {
        companyId,
        agentId: AGENT.bora!,
        taskId: boraTask,
        maxLiveSessionsPerCompany: 2,
      }),
    ).toEqual({ ok: true });
    const boraSession = await openSession(AGENT.bora!, boraTask);

    const ceydaTask = await seedTask(AGENT.ceyda!);
    const blocked = await checkSessionGate(guardedDb, {
      companyId,
      agentId: AGENT.ceyda!,
      taskId: ceydaTask,
      maxLiveSessionsPerCompany: 2,
    });
    expect(blocked).toMatchObject({ ok: false, reason: "company_cap", liveSessions: 2 });

    // tavan yalnız CANLI oturumları sayar: bora kapanınca yer açılır
    await db
      .update(agentSessions)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(agentSessions.id, boraSession));
    expect(
      (
        await checkSessionGate(guardedDb, {
          companyId,
          agentId: AGENT.ceyda!,
          taskId: ceydaTask,
          maxLiveSessionsPerCompany: 2,
        })
      ).ok,
    ).toBe(true);
  });

  it("tavan verilmezse yalnız ajan-başına-tek kuralı işler (eski davranış)", async () => {
    const denizTask = await seedTask(AGENT.deniz!);
    expect(await checkSessionGate(guardedDb, { companyId, agentId: AGENT.deniz!, taskId: denizTask })).toEqual({
      ok: true,
    });
  });

  it("şirket kuyruğu öncelik/yaş sırasıyla seçilir ve meşgul ajanlar elenir", async () => {
    // ada hâlâ canlı → kuyruğundaki işi seçilmemeli
    await seedTask(AGENT.ada!, "ASSIGNED", "P0");
    const denizP1 = await seedTask(AGENT.deniz!, "ASSIGNED", "P1");
    const ceydaP0 = await seedTask(AGENT.ceyda!, "CHANGES_REQUESTED", "P0");

    const picked = await pickCompanyQueuedTasks(guardedDb, companyId, 5);
    const ids = picked.map((p) => p.taskId);
    expect(ids).toContain(ceydaP0);
    expect(ids).toContain(denizP1);
    // P0 önce (ada'nın P0'ı meşgul olduğu için elendi → ceyda ilk sırada)
    expect(ids[0]).toBe(ceydaP0);
    // canlı oturumu olan ajan hiç görünmez
    expect(picked.some((p) => p.agentId === AGENT.ada!)).toBe(false);
    // ajan başına EN FAZLA bir iş (aynı ajana iki oturum açılmasın)
    expect(new Set(picked.map((p) => p.agentId)).size).toBe(picked.length);

    // boşalan kapasite kadarı alınır
    expect(await pickCompanyQueuedTasks(guardedDb, companyId, 1)).toHaveLength(1);
    expect(await pickCompanyQueuedTasks(guardedDb, companyId, 0)).toEqual([]);
  });
});
