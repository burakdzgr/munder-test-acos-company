// A6 — stuck-task sweep (09 §9, 07 §8).
//
// 09 §9 Schedules tablosu bu sweep'i adıyla listeliyor: `stuck-task-sweep`,
// 30 dakikada bir, "detects ASSIGNED-too-long / WAITING-past-SLA tasks →
// manager notifications". Kodda yoktu.
//
// Pratik sonucu: iş yalnız üç yoldan ilerliyordu (HTTP route, delegate_task,
// intake). Bir görev WAITING'e park edilirse onu geri alan hiçbir mekanizma
// yoktu; sahibinin workflow'u öldüyse görev sonsuza kadar orada kalıyor ve
// bunu gösteren tek bir işaret bile üretilmiyordu.
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
  pickNextQueuedTaskId,
  runMigrations,
  sweepStuckTasks,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  agentSessions,
  agents,
  companies,
  events,
  orgEdges,
  orgUnits,
  positions,
  projects,
  repositories,
  reviews,
  tasks,
  users,
  workspaces,
} from "../../src/schema/index.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let service: TasksService;
let state: TaskStateService;
let companyId = "";
let founderUserId = "";
let OWNER = "";
let MANAGER = "";
let counter = 0;

/** Bir görevi ASSIGNED'a taşır. */
async function assignedTask(title: string) {
  counter += 1;
  const task = await service.create(
    ctx,
    { kind: "task", title: `${title} ${counter}`, objective: "x" },
    { kind: "founder" },
  );
  await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
  await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
  await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
  return task;
}

const statusOf = async (taskId: string) =>
  (
    await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
  )[0]!.status;

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  service = new TasksService(guardedDb);
  state = new TaskStateService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@stuck.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "StuckCo", slug: "stuckco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [devPos] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [mgrPos] = await db
    .insert(positions)
    .values({ companyId, title: "EM", seniorityTrack: ["lead"], defaultRole: "manager" })
    .returning();
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
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  OWNER = await hire(1, "Deniz Dev", devPos!.id);
  MANAGER = await hire(2, "Kerem Manager", mgrPos!.id);
  await db
    .insert(orgEdges)
    .values({ companyId, fromAgentId: OWNER, kind: "reports_to", toAgentId: MANAGER });
  // hire() gerçek akışta çifti birlikte yazar; Scheduler adayları manages
  // kenarından okur (scoreDelegateCandidates)
  await db
    .insert(orgEdges)
    .values({ companyId, fromAgentId: MANAGER, kind: "manages", toAgentId: OWNER });
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("stuck-task sweep (09 §9, 07 §8)", { timeout: 60_000 }, () => {
  it("wait_for süresi dolan WAITING görevi BLOCKED'a alır ve eskalasyon üretir", async () => {
    const task = await assignedTask("Yardım bekleyen iş");
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await state.transition(ctx, task.id, "WAITING", { kind: "agent", agentId: OWNER });

    // henüz süre dolmadı — sweep dokunmamalı
    const early = await sweepStuckTasks(db, guardedDb);
    expect(early.findings.filter((f) => f.taskId === task.id)).toHaveLength(0);
    expect(await statusOf(task.id)).toBe("WAITING");

    // 07 §8: wait_for (varsayılan 2 saat) dolduğunda
    const later = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("waiting_past_sla");
    expect(finding!.managerAgentId).toBe(MANAGER); // reports_to bir üst
    expect(await statusOf(task.id)).toBe("BLOCKED");

    // eskalasyon olayı düştü — Founder'ın bildirim yüzeyi bunu dinliyor
    const escalations = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.type, "agent.escalated"),
          eq(events.taskId, task.id),
        ),
      );
    expect(escalations).toHaveLength(1);
  });

  it("uzun süredir ASSIGNED duran görevi bildirir ve ölü döngüyü işaretler", async () => {
    const task = await assignedTask("Başlamayan iş");
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("assigned_too_long");
    // canlı oturumu yok → çağıran workflow'u yeniden başlatmalı
    expect(finding!.needsWorkflowRestart).toBe(true);
    // ASSIGNED bir durum değişimi DEĞİL: görev yerinde kalır, yalnız bildirilir
    expect(await statusOf(task.id)).toBe("ASSIGNED");
  });

  it("yetim çocuğu (decompose edilmiş, delege edilmemiş) Scheduler seçimiyle delege eder (P0-3)", async () => {
    // ebeveyn YÖNETİCİDE: CEO/lead decompose etti ama döngüsü delege etmeden
    // kapandı senaryosu — canlı kanıt: initiative DRAFT+sahipsiz kaldı
    counter += 1;
    const parent = await service.create(
      ctx,
      { kind: "task", title: `Decompose eden iş ${counter}`, objective: "x" },
      { kind: "founder" },
    );
    await state.transition(ctx, parent.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, parent.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, parent.id, { agentId: MANAGER }, { kind: "founder" });

    const delegation = new DelegationService(guardedDb, service, state);
    // 07 §2 hiyerarşi katı: task'ın çocuğu subtask'tır
    const child = await delegation.createChildTask(ctx, MANAGER, {
      parentTaskId: parent.id,
      kind: "subtask",
      title: "Yetim alt görev",
      objective: "backend ucu yaz",
      requiredCapabilities: ["backend"],
    });
    expect(await statusOf(child.id)).toBe("DRAFT");

    // eşik dolmadan sweep dokunmaz
    const early = await sweepStuckTasks(db, guardedDb);
    expect(early.findings.filter((f) => f.taskId === child.id)).toHaveLength(0);
    expect(await statusOf(child.id)).toBe("DRAFT");

    // eşik dolunca: Scheduler'ın deterministik seçicisi (INVARIANT 10) ile
    // ebeveyn sahibinin uygun raporuna delege edilir, workflow restart istenir
    const later = new Date(Date.now() + 6 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === child.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("orphan_child_assigned");
    expect(finding!.ownerAgentId).toBe(OWNER); // MANAGER'ın tek raporu
    expect(finding!.needsWorkflowRestart).toBe(true);
    expect(await statusOf(child.id)).toBe("ASSIGNED");

    // ikinci sweep aynı çocuğu bir daha almaz (artık sahipli)
    const again = await sweepStuckTasks(db, guardedDb, { now: later });
    expect(again.findings.filter((f) => f.taskId === child.id && f.kind === "orphan_child_assigned")).toHaveLength(0);
  });

  it("reviewersız REVIEW görevini kadro uygunsa yeniden açar (P0-2)", async () => {
    // reviews proje + canlı workspace şart koşar (15 §2)
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        slug: "reviewproj",
        name: "reviewproj",
        objectiveMd: "x",
        status: "executing",
        createdByUserId: founderUserId,
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        companyId,
        projectId: project!.id,
        name: "reviewproj",
        barePath: `/data/repos/${project!.id}.git`,
      })
      .returning();
    counter += 1;
    const task = await service.create(
      ctx,
      { kind: "task", title: `İncelenecek iş ${counter}`, objective: "x", projectId: project!.id },
      { kind: "founder" },
    );
    await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await db.insert(workspaces).values({
      companyId,
      projectId: project!.id,
      taskId: task.id,
      repositoryId: repo!.id,
      agentId: OWNER,
      isolationLevel: "coding",
      image: "acos/workspace-node",
      branch: `task/${counter}-review`,
      status: "in_use",
    });
    // request_review'un REVIEW'a taşıyıp review satırı AÇAMADIĞI an (P0-2):
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });

    // eşik dolmadan dokunmaz
    const early = await sweepStuckTasks(db, guardedDb);
    expect(early.findings.filter((f) => f.taskId === task.id)).toHaveLength(0);

    const later = new Date(Date.now() + 6 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("review_reopened");
    // INV-14: yazar değil — inceleme-yetkin MANAGER seçildi
    expect(finding!.review?.reviewerAgentId).toBe(MANAGER);
    const rows = await db
      .select({ id: reviews.id, status: reviews.status, reviewerAgentId: reviews.reviewerAgentId })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");

    // Açık review satırı varken sweep aynı görevi bir daha YENİDEN AÇMAZ...
    const again = await sweepStuckTasks(db, guardedDb, { now: later });
    expect(again.findings.filter((f) => f.kind === "review_reopened" && f.taskId === task.id)).toHaveLength(0);
    // ...ama T53'ten beri sessizce bırakmaz da: satır `pending` ve incelemecinin
    // turu hiç açılmadıysa 4b kuralı onu `review_never_started` olarak bildirir
    // ve çağıran aynı `review.<reviewId>` ile workflow'u başlatır. Eskiden bu
    // hal HİÇBİR kuralın kapsamında değildi — görev REVIEW'da kalıcı kilitliydi.
    const stalled = again.findings.find(
      (f) => f.taskId === task.id && f.kind === "review_never_started",
    );
    expect(stalled).toBeDefined();
    expect(stalled!.review?.reviewId).toBe(rows[0]!.id);
    expect(stalled!.review?.reviewerAgentId).toBe(MANAGER);
    // F2 (Jim review): kurtarma AYNI incelemeyi başlatmalı — ikinci bir review
    // satırı açmak turu geri sarar. Değiştirdiğim assert bunu yalnız ÖRTÜK
    // tutuyordu; açıkça ölçüyoruz.
    const afterRows = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(afterRows).toHaveLength(1);
  });

  it("QA'da incelemecisiz asılı kalan görevi de yeniden açar — ve turu QA olarak açar (T11b)", async () => {
    // Aynı yetimlik, bir sonraki aşamada: QA turu açılamazsa görev SESSİZCE
    // QA'da kalıyordu, çünkü bu sweep yalnız status='REVIEW'a bakıyordu.
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        slug: `qaproj${(counter += 1)}`,
        name: "qaproj",
        objectiveMd: "x",
        status: "executing",
        createdByUserId: founderUserId,
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        companyId,
        projectId: project!.id,
        name: "qarepo",
        barePath: `/data/repos/${project!.id}.git`,
      })
      .returning();
    const task = await service.create(
      ctx,
      { kind: "task", title: `QA'da asılı iş ${counter}`, objective: "x", projectId: project!.id },
      { kind: "founder" },
    );
    await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await db.insert(workspaces).values({
      companyId,
      projectId: project!.id,
      taskId: task.id,
      repositoryId: repo!.id,
      agentId: OWNER,
      isolationLevel: "coding",
      image: "acos/workspace-node",
      branch: `task/${counter}-qa`,
      status: "in_use",
    });
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });
    // incelemeci onayladı, görev QA'ya geçti — ama QA turu açılamadı
    await db
      .update(tasks)
      .set({ status: "QA" })
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, task.id)));

    const later = new Date(Date.now() + 6 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    // ÖNCEDEN: bu görev hiç görülmezdi
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("review_reopened");
    const rows = await db
      .select({ kind: reviews.kind, status: reviews.status })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(1);
    // QA'daki bir görev için 'code' turu açmak incelemeyi bir adım geri sarardı
    expect(rows[0]!.kind).toBe("qa");
  });

  it("incelemecisi ATANMIŞ ama turu hiç başlamamış incelemeyi kurtarır (T53 — E4 canlı platosu)", async () => {
    // E4 canlı run #2'nin donduğu tam hal: dispatcher review satırını AÇTI,
    // incelemeciyi ATADI, ama reviewWorkflow'u hiç BAŞLATMADI (sunucunun MCP
    // dispatcher'ında dep eksikti). §4 yalnız review satırı OLMAYAN yetimi
    // görüyor (`NOT EXISTS pending|in_review`), yani bu hal kuralın bilerek
    // dışındaydı: görev REVIEW'da KALICI kilitliydi — 30 dk sonra da açılmazdı.
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        slug: `stalledproj${(counter += 1)}`,
        name: "stalledproj",
        objectiveMd: "x",
        status: "executing",
        createdByUserId: founderUserId,
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        companyId,
        projectId: project!.id,
        name: "stalledproj",
        barePath: `/data/repos/${project!.id}.git`,
      })
      .returning();
    const task = await service.create(
      ctx,
      { kind: "task", title: `Turu başlamayan inceleme ${counter}`, objective: "x", projectId: project!.id },
      { kind: "founder" },
    );
    await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });
    // dispatcher'ın yaptığı: satır açıldı + incelemeci atandı, workflow YOK
    const [review] = await db
      .insert(reviews)
      .values({
        companyId,
        taskId: task.id,
        projectId: project!.id,
        repositoryId: repo!.id,
        branch: `task/${counter}-stalled`,
        kind: "code",
        authorAgentId: OWNER,
        reviewerAgentId: MANAGER,
      })
      .returning();

    // eşik dolmadan dokunmaz — sağlıklı bir inceleme yarıda yakalanmasın
    const early = await sweepStuckTasks(db, guardedDb);
    expect(early.findings.filter((f) => f.taskId === task.id)).toHaveLength(0);

    const later = new Date(Date.now() + 6 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    // ÖNCEDEN: bu görev hiç görülmezdi
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("review_never_started");
    // Çağıran AYNI review'u başlatmalı — yenisini açmak turu geri sarardı
    expect(finding!.review?.reviewId).toBe(review!.id);
    expect(finding!.review?.reviewerAgentId).toBe(MANAGER);
    expect(finding!.review?.authorAgentId).toBe(OWNER);
    // ve YENİ review satırı AÇILMAMALI (tek inceleme, tek yürütme)
    const rows = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(1);

    // turu BAŞLAMIŞ bir inceleme (in_review) bu kuralın işi değildir
    await db
      .update(reviews)
      .set({ status: "in_review" })
      .where(and(eq(reviews.companyId, companyId), eq(reviews.id, review!.id)));
    const afterStart = await sweepStuckTasks(db, guardedDb, { now: later });
    expect(
      afterStart.findings.filter((f) => f.taskId === task.id && f.kind === "review_never_started"),
    ).toHaveLength(0);
  });

  it("HİÇ çocuğu olmayan konteyneri bildirir ve BİR KEZ eskale eder (T11a)", async () => {
    // 07 §2: konteyner kendi işini yapmaz, çocuklarından türeyerek kapanır.
    // Sahibi hiç bölmediyse kapanışı türetecek çocuk yoktur; roll-up 0 çocukta
    // erken döner ve bu sweep IN_PROGRESS'i hiç taramazdı → sonsuz IN_PROGRESS.
    counter += 1;
    const goal = await service.create(
      ctx,
      { kind: "goal", title: `Bölünmemiş hedef ${counter}`, objective: "x" },
      { kind: "founder" },
    );
    await state.transition(ctx, goal.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, goal.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, goal.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, goal.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });

    // eşik dolmadan dokunmaz: CEO hâlâ bölüyor olabilir
    const early = await sweepStuckTasks(db, guardedDb);
    expect(early.findings.filter((f) => f.taskId === goal.id)).toHaveLength(0);

    const later = new Date(Date.now() + 31 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === goal.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("container_childless");
    // eksik olan bir tur değil, bir KARAR (böl ya da iptal et) — döngüyü
    // yeniden başlatmak hiçbir şey çözmez
    expect(finding!.needsWorkflowRestart).toBe(false);
    // sweep konteynerin durumunu YAZMAZ: onu roll-up yazar (INV-13)
    expect(await statusOf(goal.id)).toBe("IN_PROGRESS");

    const escalations = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.taskId, goal.id),
          eq(events.type, "agent.escalated"),
        ),
      );
    expect(escalations).toHaveLength(1);

    // 30 dakikada bir aynı şeyi bağırmaz: ikinci sweep sessiz kalır
    const again = await sweepStuckTasks(db, guardedDb, { now: later });
    expect(again.findings.filter((f) => f.taskId === goal.id)).toHaveLength(0);
  });

  it("çocuğu OLAN konteyner sweep'e hiç girmez", async () => {
    counter += 1;
    const goal = await service.create(
      ctx,
      { kind: "goal", title: `Bölünmüş hedef ${counter}`, objective: "x" },
      { kind: "founder" },
    );
    await state.transition(ctx, goal.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, goal.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, goal.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, goal.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await service.create(
      ctx,
      { kind: "initiative", parentId: goal.id, title: `Girişim ${counter}`, objective: "x" },
      { kind: "founder" },
    );

    const later = new Date(Date.now() + 31 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    expect(result.findings.filter((f) => f.kind === "container_childless" && f.taskId === goal.id)).toHaveLength(0);
  });

  it("canlı oturumu olan görev için yeniden başlatma istenmez", async () => {
    const task = await assignedTask("Çalışan iş");
    await db.insert(agentSessions).values({
      companyId,
      agentId: OWNER,
      taskId: task.id,
      workflowId: `agent-task.${task.id}.${OWNER}`,
      runId: "01a0052e-0000-7000-8000-000000000099",
      status: "running",
    });
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.needsWorkflowRestart).toBe(false);
  });

  // ------------------------------------------------------------------
  // T14 — düzeltme turu (rework re-entry) kaybolmamalı.
  // A7 canlı koşumu (2026-08-20): inceleme changes_requested verdi, yeniden
  // giriş workflow'u BİR KEZ başladı ve çöktü ('model llama3.2:3b not
  // found'). Görev CHANGES_REQUESTED'ta, sahibi BOŞTA kaldı; ne drain
  // kuyruğu ne sweep o durumu tarıyordu, şirket kilitlendi.
  // ------------------------------------------------------------------

  /** Fikstür: sweep/kuyruk yalnız STATUS okur; turu kurmak için ham güncelleme
   *  yeterli (inceleme zinciri bu dosyanın konusu değil). */
  async function reworkTask(title: string, status: "CHANGES_REQUESTED" | "QA_FAILED" | "REJECTED") {
    const task = await assignedTask(title);
    await db
      .update(tasks)
      .set({ status })
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, task.id)));
    return task;
  }

  it("CHANGES_REQUESTED'ta çakılı kalan düzeltme turunu bildirir ve yeniden başlatılmasını ister", async () => {
    const task = await reworkTask("Düzeltme bekleyen iş", "CHANGES_REQUESTED");
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("rework_stalled");
    // sahibi boşta → çağıran (main.ts) döngüyü yeniden başlatmalı
    expect(finding!.needsWorkflowRestart).toBe(true);
    // sweep durumu DEĞİŞTİRMEZ: düzeltme turu kendi geçişini yapar
    expect(await statusOf(task.id)).toBe("CHANGES_REQUESTED");
  });

  it("QA_FAILED ve REJECTED de aynı kümede taranır", async () => {
    const qaFailed = await reworkTask("QA'dan dönen iş", "QA_FAILED");
    const rejected = await reworkTask("Founder'ın reddettiği iş", "REJECTED");
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    for (const t of [qaFailed, rejected]) {
      const finding = result.findings.find((f) => f.taskId === t.id);
      expect(finding?.kind).toBe("rework_stalled");
    }
  });

  it("drain kuyruğu CHANGES_REQUESTED görevi sıradaki iş olarak döndürür", async () => {
    // bu ajanın BAŞKA açık işi kalmasın: kuyruk seçicisi tek satır döner
    await db
      .update(tasks)
      .set({ status: "CANCELLED" })
      .where(and(eq(tasks.companyId, companyId), eq(tasks.ownerAgentId, OWNER)));
    const task = await reworkTask("Sıradaki düzeltme", "CHANGES_REQUESTED");
    const next = await pickNextQueuedTaskId(guardedDb, companyId, OWNER);
    expect(next).toBe(task.id);
  });
});
