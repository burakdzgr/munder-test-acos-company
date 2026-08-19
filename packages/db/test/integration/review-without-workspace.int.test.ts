// P0-2 kalanı (2026-08-19, canlı kanıt golden path stage 10) — İNCELEME KAYDI
// WORKSPACE'E BAĞLI DEĞİLDİR.
//
// Gözlenen gerçek davranış: `requestReview` inceleme satırını YALNIZ görevin
// canlı bir workspace'i varsa açabiliyordu (repository kimliği oradan
// türetiliyordu). Kod üretmemiş ama REVIEW'a taşınmış görevlerde (planlama /
// analiz işi, araçsız fixture, workspace'i henüz açılmamış sahip) çağrı
// `REVIEW_TASK_INVALID` ile düşüyor, çağıran taraf sessizce "transition-only"
// yoluna girip görevi REVIEW'da bırakıyordu: reviews tablosunda SIFIR satır,
// atanmış reviewer yok, onaylayacak kimse yok → görev sonsuza kadar asılı
// (canlı koşuda 3 görev birden: goal/initiative/epic, reviews=0).
//
// Beklenen (bu test): workspace yoksa depo kimliği görevin PROJESİNDEN gelir —
// satır açılır, INV-14 (reviewer ≠ author) korunur, reviewer görev ataması
// olarak da yazılır (izin matrisinin `reviewer` sınıfını türettiği yer) ve
// canlı workspace varsa eski davranış birebir aynı kalır.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  ReviewsService,
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
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
  repositories,
  reviews,
  taskAssignments,
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
let tasksService: TasksService;
let state: TaskStateService;
let reviewsService: ReviewsService;
let companyId = "";
let projectId = "";
let repoId = "";
let OWNER = "";
let LEAD = "";
let counter = 0;

/** Sahibine atanmış, IN_PROGRESS bir görev (kind seçilebilir). */
async function ownedTask(kind: "task", title: string) {
  counter += 1;
  const task = await tasksService.create(
    ctx,
    { kind, title: `${title} ${counter}`, objective: "x", projectId },
    { kind: "founder" },
  );
  await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
  await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
  await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
  await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
  return task;
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  tasksService = new TasksService(guardedDb);
  state = new TaskStateService(guardedDb);
  reviewsService = new ReviewsService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@rev.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "RevCo", slug: "revco", createdByUserId: founder!.id })
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
  const [leadPos] = await db
    .insert(positions)
    .values({ companyId, title: "Lead", seniorityTrack: ["lead"], defaultRole: "lead" })
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
          autonomyLevel: 3,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  OWNER = await hire(1, "Deniz Dev", devPos!.id);
  LEAD = await hire(2, "Kerem Lead", leadPos!.id);
  await db
    .insert(orgEdges)
    .values({ companyId, fromAgentId: OWNER, kind: "reports_to", toAgentId: LEAD });
  await db
    .insert(orgEdges)
    .values({ companyId, fromAgentId: LEAD, kind: "manages", toAgentId: OWNER });

  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "revproj",
      name: "RevProj",
      objectiveMd: "x",
      status: "executing",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;
  const [repo] = await db
    .insert(repositories)
    .values({
      companyId,
      projectId,
      name: "revproj",
      defaultBranch: "main",
      barePath: `/data/repos/${projectId}.git`,
    })
    .returning();
  repoId = repo!.id;
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("requestReview — workspace'siz görev (P0-2)", { timeout: 60_000 }, () => {
  it("workspace YOKKEN inceleme satırı açılır: depo projeden, reviewer bağımsız", async () => {
    // `task` kindi: hiyerarşide ebeveynsiz olabilir (07 §2) ve gerçek
    // dünyada da kod üretmeyen teslimlerin çoğu bu seviyededir
    const task = await ownedTask("task", "Kod üretmeyen teslim");
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });

    const { review, created } = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: OWNER,
    });
    expect(created).toBe(true);
    expect(review.repositoryId).toBe(repoId); // projenin deposu
    expect(review.workspaceId).toBeNull(); // workspace yok — sütun nullable
    expect(review.branch).toBe("main"); // deponun varsayılan dalı
    expect(review.status).toBe("pending");
    // INV-14: yazar kendini inceleyemez — bağımsız (lead) seçildi
    expect(review.reviewerAgentId).toBe(LEAD);
    expect(review.reviewerAgentId).not.toBe(OWNER);

    // izin matrisinin `reviewer` sınıfını türettiği görev ataması da yazıldı
    const assignment = await db
      .select({ agentId: taskAssignments.agentId, role: taskAssignments.role })
      .from(taskAssignments)
      .where(and(eq(taskAssignments.companyId, companyId), eq(taskAssignments.taskId, task.id)));
    expect(assignment.some((a) => a.agentId === LEAD && a.role === "reviewer")).toBe(true);

    // ve gerçekten TEK satır (idempotent tekrar yeni satır açmaz)
    const again = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: OWNER,
    });
    expect(again.created).toBe(false);
    expect(again.review.id).toBe(review.id);
    const rows = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(1);
  });

  it("canlı workspace VARSA davranış aynı: depo + dal workspace'ten gelir", async () => {
    const task = await ownedTask("task", "Kodlu teslim");
    await db.insert(workspaces).values({
      companyId,
      projectId,
      taskId: task.id,
      repositoryId: repoId,
      agentId: OWNER,
      isolationLevel: "coding",
      image: "acos/workspace-node",
      branch: `task/${counter}-kodlu-teslim`,
      status: "in_use",
    });
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });

    const { review } = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: OWNER,
    });
    expect(review.workspaceId).not.toBeNull();
    expect(review.branch).toBe(`task/${counter}-kodlu-teslim`);
    expect(review.reviewerAgentId).toBe(LEAD);
  });

  it("proje deposu da yoksa AÇIKÇA reddedilir (sessiz dead-end değil)", async () => {
    const [otherProject] = await db
      .insert(projects)
      .values({
        companyId,
        slug: "norepo",
        name: "NoRepo",
        objectiveMd: "x",
        status: "executing",
        createdByUserId: (await db.select({ id: users.id }).from(users))[0]!.id,
      })
      .returning();
    counter += 1;
    const task = await tasksService.create(
      ctx,
      { kind: "task", title: `Deposuz ${counter}`, objective: "x", projectId: otherProject!.id },
      { kind: "founder" },
    );
    await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });

    await expect(
      reviewsService.requestReview(ctx, { taskId: task.id, authorAgentId: OWNER }),
    ).rejects.toThrow(/repository/i);
    const rows = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(0);
  });
});
