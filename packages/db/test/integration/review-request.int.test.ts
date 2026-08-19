// T8 — request_review'in review SATIRINI gercekten yaratmasi (15 §2, 07 §12).
//
// Canli kanit (2026-08-19, scripted gate): goal#1, initiative#2 ve epic#3'un
// UCU de REVIEW'da asili kaldi ve `reviews` tablosu 0 SATIRDI. Her
// complete_task {reviewRequested:true} donuyordu — REVIEW gecisi calisiyor,
// ama inceleme kaydi dogmuyor, reviewer atanmiyor ve hicbir gorev REVIEW'dan
// cikamiyordu (close→merge→memory zinciri hic baslamiyordu).
//
// Kok neden: requestReview CANLI WORKSPACE sart kosuyordu; kendi diff'i
// olmayan gorevlerde (epic — 07 §12 "then moves epic to REVIEW"; analiz/
// dokumantasyon gorevleri) atilan REVIEW_TASK_INVALID cagirranda sessizce
// yutuluyordu. Akisin geri kalani diff'siz incelemeyi zaten varsayiyor
// (review activities `workspace?.branch ?? ""`, git.merge EMPTY_MERGE →
// system kapanisi) — eksik olan tek halka bu kayitti.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  ReviewError,
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
let reviewsService: ReviewsService;

let companyId = "";
let founderUserId = "";
let projectId = "";
let repositoryId = "";
let unitId = "";
let AUTHOR = "";
let LEAD = "";
let counter = 0;

/** IN_PROGRESS'e kadar yurutulmus, AUTHOR'a ait bir gorev. */
async function workingTask(kind: string, title: string) {
  counter += 1;
  const task = await service.create(
    ctx,
    { kind, title: `${title} ${counter}`, objective: "x", projectId },
    { kind: "founder" },
  );
  await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
  await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
  await state.assign(ctx, task.id, { agentId: AUTHOR }, { kind: "founder" });
  await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: AUTHOR });
  return task;
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  service = new TasksService(guardedDb);
  state = new TaskStateService(guardedDb);
  reviewsService = new ReviewsService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t8.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "ReviewCo", slug: "reviewco", createdByUserId: founderUserId })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  unitId = unit!.id;
  const [memberPos] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [leadPos] = await db
    .insert(positions)
    .values({ companyId, title: "Backend Lideri", seniorityTrack: ["senior"], defaultRole: "lead" })
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
          orgUnitId: unitId,
          seniority: "mid",
          autonomyLevel: 3,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  AUTHOR = await hire(1, "Deniz Dev", memberPos!.id);
  LEAD = await hire(2, "Lider Leyla", leadPos!.id);
  await db.insert(orgEdges).values([
    { companyId, fromAgentId: AUTHOR, kind: "reports_to", toAgentId: LEAD },
    { companyId, fromAgentId: LEAD, kind: "manages", toAgentId: AUTHOR },
  ]);

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
  projectId = project!.id;
  const [repo] = await db
    .insert(repositories)
    .values({
      companyId,
      projectId,
      name: "reviewproj",
      barePath: `/data/repos/${projectId}.git`,
    })
    .returning();
  repositoryId = repo!.id;
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
}, 120_000);

describe("requestReview (T8: review satiri + reviewer atamasi)", { timeout: 120_000 }, () => {
  it("diff'i OLMAYAN gorev (07 §12 epic) icin de review satiri dogar ve bagimsiz reviewer atanir", async () => {
    const task = await workingTask("task", "Diffsiz teslim");
    // kanitin aynisi: gorev REVIEW'a gecer…
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: AUTHOR });

    const { review, created } = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: AUTHOR,
    });

    // …ve artik inceleme kaydi GERCEKTEN yaratilir
    expect(created).toBe(true);
    expect(review.status).toBe("pending");
    expect(review.reviewerAgentId).toBe(LEAD); // INV-14: yazar degil
    // workspace yok → proje deposuna baglanir, dal bos kalir
    expect(review.repositoryId).toBe(repositoryId);
    expect(review.workspaceId).toBeNull();
    expect(review.branch).toBe("");

    const rows = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(1);

    // reviewer atamasi da yazilir (07 §5 actor sinifi buradan turer; yoksa
    // REVIEW→QA / CHANGES_REQUESTED izin matrisinde reddedilirdi)
    const assignments = await db
      .select({ agentId: taskAssignments.agentId, role: taskAssignments.role })
      .from(taskAssignments)
      .where(and(eq(taskAssignments.companyId, companyId), eq(taskAssignments.taskId, task.id)));
    expect(assignments.some((a) => a.agentId === LEAD && a.role === "reviewer")).toBe(true);

    // idempotent: ikinci istek ayni satiri dondurur, kopya uretmez
    const again = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: AUTHOR,
    });
    expect(again.created).toBe(false);
    expect(again.review.id).toBe(review.id);
  });

  it("canli workspace VARSA inceleme eskisi gibi o dala/depoya baglanir (regresyon)", async () => {
    const task = await workingTask("task", "Kodlu teslim");
    const branch = `task/${counter}-code`;
    await db.insert(workspaces).values({
      companyId,
      projectId,
      taskId: task.id,
      repositoryId,
      agentId: AUTHOR,
      isolationLevel: "coding",
      image: "acos/workspace-node",
      branch,
      status: "in_use",
    });
    await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: AUTHOR });

    const { review } = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: AUTHOR,
    });
    expect(review.workspaceId).not.toBeNull();
    expect(review.branch).toBe(branch);
    expect(review.repositoryId).toBe(repositoryId);
    expect(review.reviewerAgentId).toBe(LEAD);
  });

  it("deposu OLMAYAN projede fail-closed kalir (sessiz kabul yok)", async () => {
    const [bare] = await db
      .insert(projects)
      .values({
        companyId,
        slug: "norepo",
        name: "norepo",
        objectiveMd: "x",
        status: "executing",
        createdByUserId: founderUserId,
      })
      .returning();
    counter += 1;
    const task = await service.create(
      ctx,
      { kind: "task", title: `Reposuz ${counter}`, objective: "x", projectId: bare!.id },
      { kind: "founder" },
    );
    await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, task.id, { agentId: AUTHOR }, { kind: "founder" });

    await expect(
      reviewsService.requestReview(ctx, { taskId: task.id, authorAgentId: AUTHOR }),
    ).rejects.toBeInstanceOf(ReviewError);
    const rows = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    expect(rows).toHaveLength(0);
  });

  it("yazar kendi isini inceleyemez (INV-14 korunur)", async () => {
    const task = await workingTask("task", "Kendi incelemesi");
    await expect(
      reviewsService.requestReview(ctx, {
        taskId: task.id,
        authorAgentId: AUTHOR,
        reviewerAgentId: AUTHOR,
      }),
    ).rejects.toBeInstanceOf(ReviewError);
  });
});
