// T29 (Founder kararı, 2026-08-20) — YÖNETİCİ KENDİNE İŞ ALABİLİR.
//
// Founder'ın sözü: "sana görev verdim, sen Dwight ve Oscar'a iş böldün ama
// burayı ben halledeceğim dedin. Aynısı ACOS'ta da olmalı."
//
// Gözlenen gerçek davranış: izin katmanı kendine atamayı ZATEN onaylıyordu
// (mayDelegate: managerAgentId === toAgentId → ok) ama YOL yoktu —
// scoreDelegateCandidates yalnız AKTİF DOĞRUDAN RAPORLARI skorluyordu, yani
// yönetici aday kümesinde hiç yer almıyordu ve resolveDelegateTarget kendisini
// asla seçemiyordu. Sonuç: CEO/lead her şeyi aşağı devrediyor, bir dilimi bile
// kendi üstlenmiyordu.
//
// Sözleşme (bu test): (1) yönetici KENDİ aday havuzundadır, (2) açık niyetle
// kendine aldığı iş gerçekten kendi üstüne yazılır, (3) bu iş KENDİ WIP
// tavanına sayılır — tavan doluysa reddedilir (ters uç: CEO her şeyi kendine
// alır, ekip aç kalır), (4) DOĞRUDAN RAPORU OLMAYAN yönetici kendi adayı
// DEĞİLDİR — boş havuz hâlâ "önce ekibi kur" demektir (agent.hire yolu),
// (5) tavanı dolu bir aday tüm delegasyonu düşürmez, sıradaki adaya geçilir.
//
// INV-10 korunur: atamayı yine Scheduler yapar; havuza yalnız "ben de adayım"
// eklenir, açık self niyeti ise izin + kapasite katmanlarından geçer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  DelegationService,
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  WIP_LIMIT_BY_ROLE,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  agents,
  companies,
  orgEdges,
  orgUnits,
  positions,
  projects,
  tasks,
  users,
} from "../../src/schema/index.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let tasksSvc: TasksService;
let delegation: DelegationService;
let companyId = "";
let founderUserId = "";
let projectId = "";
let unitId = "";
let MIRA = ""; // manager — ADA ve BORA'yı yönetir
let ADA = ""; // member, projede geçmişi var → en yüksek skor
let BORA = ""; // member, geçmişi yok
let LEYLA = ""; // lead, HİÇ raporu yok
let counter = 0;

/** Durum makinesini atlayarak ham satır — skorlayıcı/kapasite girdisi. */
async function seedTask(
  ownerAgentId: string,
  status: string,
  opts: { project?: boolean } = {},
): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 900 + counter,
      kind: "task",
      title: `Seed ${counter}`,
      objective: "o",
      status,
      ownerAgentId,
      orgUnitId: unitId,
      ...(opts.project && { projectId }),
    })
    .returning();
  return row!.id;
}

/** MIRA'nın böldüğü bir alt görev — devredilmeye hazır (DRAFT). */
async function childOfMira(): Promise<string> {
  const parent = await tasksSvc.create(
    ctx,
    { kind: "task", title: `Ana is ${(counter += 1)}`, objective: "o", projectId },
    { kind: "agent", agentId: MIRA },
  );
  const child = await delegation.createChildTask(ctx, MIRA, {
    parentTaskId: parent.id,
    kind: "subtask",
    title: `Alt is ${counter}`,
    objective: "o",
    projectId,
  });
  return child.id;
}

const ownerOf = async (taskId: string) =>
  (
    await db
      .select({ ownerAgentId: tasks.ownerAgentId })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
  )[0]!.ownerAgentId;

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  tasksSvc = new TasksService(guardedDb);
  delegation = new DelegationService(guardedDb, tasksSvc, new TaskStateService(guardedDb));

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@selfassign.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "SelfCo", slug: "selfco", createdByUserId: founderUserId })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Product", slug: "product" })
    .returning();
  unitId = unit!.id;
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "selfp",
      name: "SelfP",
      objectiveMd: "o",
      status: "executing",
      createdByUserId: founderUserId,
    })
    .returning();
  projectId = project!.id;

  const position = async (title: string, role: string) =>
    (
      await db
        .insert(positions)
        .values({ companyId, title, seniorityTrack: ["senior"], defaultRole: role })
        .returning()
    )[0]!.id;
  const managerPos = await position("Ürün Yöneticisi", "manager");
  const memberPos = await position("Geliştirici", "member");
  const leadPos = await position("Takım Lideri", "lead");

  const hire = async (n: number, name: string, positionId: string) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: n,
          name,
          status: "active",
          positionId,
          orgUnitId: unitId,
          seniority: "senior",
          autonomyLevel: 3,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  // Beraberlik employee_number ile bozulur: MIRA'ya BİLEREK yüksek numara
  // verildi, böylece "kendine alma" bir eşitlikten kazanmaz.
  ADA = await hire(11, "Ada Kaya", memberPos);
  BORA = await hire(12, "Bora Demir", memberPos);
  MIRA = await hire(20, "Mira Sonmez", managerPos);
  LEYLA = await hire(30, "Leyla Ay", leadPos);

  await db.insert(orgEdges).values([
    { companyId, fromAgentId: MIRA, toAgentId: ADA, kind: "manages" },
    { companyId, fromAgentId: MIRA, toAgentId: BORA, kind: "manages" },
  ]);
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("yönetici kendine iş alabilir (T29)", { timeout: 300_000 }, () => {
  it("yönetici KENDİ aday havuzundadır", async () => {
    const taskId = await childOfMira();
    const scored = await delegation.scoreDelegateCandidates(ctx, MIRA, taskId);
    const ids = scored.map((s) => s.agentId);
    // ÖNCEDEN: yalnız [ADA, BORA] — yönetici kendini asla seçemezdi
    expect(ids).toContain(MIRA);
    expect(ids).toEqual(expect.arrayContaining([ADA, BORA]));
  });

  it("tavanı dolu aday tüm delegasyonu düşürmez — sıradakine geçilir", async () => {
    // ADA en yüksek skorlu: projede 5 kapanmış iş (aşinalık + başarı oranı)
    for (let i = 0; i < 5; i += 1) await seedTask(ADA, "DONE", { project: true });
    const taskId = await childOfMira();
    const scored = await delegation.scoreDelegateCandidates(ctx, MIRA, taskId);
    expect(scored[0]?.agentId).toBe(ADA);

    // …ama WIP tavanı dolu (member = 2)
    for (let i = 0; i < WIP_LIMIT_BY_ROLE.member!; i += 1) await seedTask(ADA, "IN_PROGRESS");
    const target = await delegation.resolveDelegateTarget(ctx, MIRA, "bu işi devral", taskId);
    // ÖNCEDEN: ADA döner, delegateTask WIP_LIMIT ile düşer, iş hiç dağıtılmaz
    expect(target).not.toBe(ADA);
    expect(target).toBe(BORA); // MIRA ile eşit skorda, düşük sicil numarası kazanır
  });

  it("açık niyetle kendine aldığı iş gerçekten kendi üstüne yazılır", async () => {
    const taskId = await childOfMira();
    const result = await delegation.delegateTask(ctx, MIRA, taskId, MIRA);
    expect(result.ok).toBe(true);
    expect(await ownerOf(taskId)).toBe(MIRA);
  });

  it("kendine alınan iş KENDİ WIP tavanına sayılır — tavan doluysa reddedilir", async () => {
    const limit = WIP_LIMIT_BY_ROLE.manager!;
    // bir önceki testten kalan ASSIGNED iş WIP değil; tavanı aktif işle doldur
    for (let i = 0; i < limit; i += 1) await seedTask(MIRA, "IN_PROGRESS");
    const taskId = await childOfMira();
    const result = await delegation.delegateTask(ctx, MIRA, taskId, MIRA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("WIP_LIMIT");
    // reddedilirken alternatifler döner → model delege etmeye yönelir
    expect(result.candidates.map((c) => c.agentId)).toEqual(
      expect.arrayContaining([ADA, BORA]),
    );
    expect(await ownerOf(taskId)).toBeNull();
  });

  it("doğrudan raporu OLMAYAN yönetici kendi adayı değildir — 'önce ekibi kur' korunur", async () => {
    const parent = await tasksSvc.create(
      ctx,
      { kind: "task", title: "Leyla ana is", objective: "o", projectId },
      { kind: "agent", agentId: LEYLA },
    );
    const child = await delegation.createChildTask(ctx, LEYLA, {
      parentTaskId: parent.id,
      kind: "subtask",
      title: "Leyla alt is",
      objective: "o",
      projectId,
    });
    expect(await delegation.scoreDelegateCandidates(ctx, LEYLA, child.id)).toEqual([]);
    // boş havuz → NO_ELIGIBLE_DELEGATE → agent.hire ipucu (E2 kadro yolu)
    expect(await delegation.resolveDelegateTarget(ctx, LEYLA, "devral", child.id)).toBeNull();
  });
});
