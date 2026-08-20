// P0-2 kalanı (2026-08-19, canlı kanıt golden path stage 10) — KOD ÜRETMEYEN
// GÖREVİN KAPANIŞ ZİNCİRİ.
//
// Gözlenen gerçek davranış: kalite zinciri (REVIEW → QA) tamamlansa bile,
// birleştirilecek DALI OLMAYAN bir görev kapanmıyordu — `mergeIfEligible`
// git.merge'i yine de çağırıyor, araç "no task branch found" ile başarısız
// oluyor ve QA ONAYLI görev QA'da asılı kalıyordu. Görev sonsuza dek açık:
// roll-up bekleyen konteyner ebeveynleri de onunla birlikte donuyordu.
//
// Beklenen (bu test): inceleme kaydı workspace'siz görevde de açılır (depo
// projeden), code onayı görevi QA'ya taşır, QA onayı birleştirilecek dal
// yokken git.merge'e HİÇ girmeden SYSTEM kapanışıyla görevi DONE yapar.
// Kod üreten görevlerde (dalı olan) davranış birebir aynı kalır: merge yolu.
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
} from "@acos/db";
import {
  agents,
  companies,
  orgEdges,
  orgUnits,
  positions,
  projects,
  repositories,
  reviews,
  tasks,
  users,
  workspaces,
} from "@acos/db/schema";
import { createReviewActivities } from "../../src/review/activities.js";
import { startPostgres } from "./helpers";

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let tasksService: TasksService;
let state: TaskStateService;
let reviewsService: ReviewsService;
let activities: ReturnType<typeof createReviewActivities>;
let companyId = "";
let projectId = "";
let repoId = "";
let OWNER = "";
let LEAD = "";
let counter = 0;
/** git.merge çağrıları — dalı olmayan görevde SIFIR olmalı. */
const mergeCalls: string[] = [];

async function ownedTask(title: string) {
  counter += 1;
  const task = await tasksService.create(
    ctx,
    { kind: "task", title: `${title} ${counter}`, objective: "x", projectId },
    { kind: "founder" },
  );
  await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
  await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
  await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
  await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
  await state.transition(ctx, task.id, "REVIEW", { kind: "agent", agentId: OWNER });
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
  pgContainer = await startPostgres();
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  tasksService = new TasksService(guardedDb);
  state = new TaskStateService(guardedDb);
  reviewsService = new ReviewsService(guardedDb);
  activities = createReviewActivities({
    guardedDb,
    invokeTool: async ({ toolName, taskId }) => {
      mergeCalls.push(`${toolName}:${taskId}`);
      return {
        invocationId: null,
        decision: "allow",
        status: "failed", // gerçek davranış: dalsız görevde git.merge başarısız
        reason: null,
        error: "git.merge: no task branch found",
      };
    },
  });

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@close.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "CloseCo", slug: "closeco", createdByUserId: founder!.id })
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
      slug: "closeproj",
      name: "CloseProj",
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
      name: "closeproj",
      defaultBranch: "main",
      barePath: `/data/repos/${projectId}.git`,
    })
    .returning();
  repoId = repo!.id;
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await pgContainer?.stop();
});

describe("review → QA → kapanış (P0-2)", { timeout: 120_000 }, () => {
  it("dalsız görev: code onayı → QA, QA onayı → git.merge'e girmeden SYSTEM kapanışı (DONE)", async () => {
    const task = await ownedTask("Kod üretmeyen teslim");
    mergeCalls.length = 0;

    // 1) inceleme kaydı workspace OLMADAN açılır (depo projeden)
    const { review } = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: OWNER,
    });
    expect(review.repositoryId).toBe(repoId);
    expect(review.reviewerAgentId).toBe(LEAD); // INV-14

    // 2) code onayı → REVIEW'dan QA'ya + QA turu açılır
    const codeVerdict = await activities.submitReviewVerdictActivity({
      companyId,
      reviewId: review.id,
      taskId: task.id,
      reviewerAgentId: LEAD,
      verdict: "approved",
      note: "iyi",
    });
    expect(codeVerdict.taskStatus).toBe("QA");
    const qaRows = await db
      .select({ id: reviews.id, kind: reviews.kind, reviewerAgentId: reviews.reviewerAgentId })
      .from(reviews)
      .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)));
    const qaReview = qaRows.find((r) => r.kind === "qa");
    expect(qaReview).toBeDefined();
    expect(qaReview!.reviewerAgentId).not.toBe(OWNER);

    // 3) QA onayı → birleştirilecek dal yok: git.merge HİÇ çağrılmaz, görev
    //    SYSTEM kapanışıyla DONE olur (zincir asılı kalmaz)
    const qaVerdict = await activities.submitReviewVerdictActivity({
      companyId,
      reviewId: qaReview!.id,
      taskId: task.id,
      reviewerAgentId: qaReview!.reviewerAgentId!,
      verdict: "approved",
      note: "kabul",
    });
    expect(mergeCalls).toHaveLength(0);
    expect(qaVerdict.merged).toBe(false);
    expect(await statusOf(task.id)).toBe("DONE");
  });

  it("dalı olan görev: QA onayı merge yolundan geçer (davranış değişmedi)", async () => {
    const task = await ownedTask("Kodlu teslim");
    await db.insert(workspaces).values({
      companyId,
      projectId,
      taskId: task.id,
      repositoryId: repoId,
      agentId: OWNER,
      isolationLevel: "coding",
      image: "acos/workspace-node",
      branch: `task/${counter}-kodlu`,
      status: "in_use",
    });
    mergeCalls.length = 0;

    const { review } = await reviewsService.requestReview(ctx, {
      taskId: task.id,
      authorAgentId: OWNER,
    });
    await activities.submitReviewVerdictActivity({
      companyId,
      reviewId: review.id,
      taskId: task.id,
      reviewerAgentId: LEAD,
      verdict: "approved",
      note: "iyi",
    });
    const qaRow = (
      await db
        .select({ id: reviews.id, kind: reviews.kind, reviewerAgentId: reviews.reviewerAgentId })
        .from(reviews)
        .where(and(eq(reviews.companyId, companyId), eq(reviews.taskId, task.id)))
    ).find((r) => r.kind === "qa")!;
    await activities.submitReviewVerdictActivity({
      companyId,
      reviewId: qaRow.id,
      taskId: task.id,
      reviewerAgentId: qaRow.reviewerAgentId!,
      verdict: "approved",
      note: "kabul",
    });
    // merge YOLU denendi (stub başarısız döndürdüğü için görev QA'da kalır —
    // gerçek merge'de DONE olur; burada kanıtlanan: dal varsa yol değişmiyor)
    expect(mergeCalls.some((c) => c.startsWith("git.merge:"))).toBe(true);
    expect(await statusOf(task.id)).toBe("QA");
  });
});

// T53 — E4 canlı run #2'nin kök-nedeni: inceleme AÇILIYOR ama TURU BAŞLAMIYOR.
//
// `openCodeReview` eskiden `if (reviewer && deps.startReviewWorkflow)` diyordu:
// dep YOKSA hiçbir iz bırakmadan atlıyordu. Sunucunun MCP dispatcher'ı (CLI
// şeridinin TEK aksiyon yolu — Decision A) o dep olmadan kuruluyordu, yani her
// `request_review` sessizce yarım kalıyordu: `reviews` satırı `pending` açılır,
// görev REVIEW'a geçer, gözlem `{reviewRequested:true}` döner — ve incelemecinin
// turu HİÇ başlamaz. Canlı sonuç: 2 leaf REVIEW'da dondu, 5 konteyner çocuk-DONE
// bekleyerek WAITING'de kaldı, 0 DONE. Elle başlatılan TEK reviewWorkflow 300
// ms'de tamamlandı ve zincir kendiliğinden aktı — eksik olan tek şey BAŞLATICIYDI.
//
// Bu test o sessizliği kilitler: dep yoksa gözlem `reviewStarted:false` DEMEK
// ZORUNDA. "Başarı" ile "hiç başlamadı" ayırt edilebilir olmalı.
describe("request_review → reviewWorkflow başlatıcısı (T53)", { timeout: 120_000 }, () => {
  async function inProgressTask(title: string) {
    counter += 1;
    const task = await tasksService.create(
      ctx,
      { kind: "task", title: `${title} ${counter}`, objective: "x", projectId },
      { kind: "founder" },
    );
    await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    return task;
  }

  const requestReview = async (
    dispatcher: { dispatch: (i: Record<string, unknown>) => Promise<Record<string, unknown>> },
    taskId: string,
  ) =>
    dispatcher.dispatch({
      companyId,
      agentId: OWNER,
      taskId,
      sessionId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      action: { type: "request_review", taskId, summary: "bitti" },
    });

  it("başlatıcı YOKSA: satır açılır ama gözlem reviewStarted:false der (sessiz yutma yok)", async () => {
    const { createActionDispatcher } = await import("@acos/agent-actions");
    const dispatcher = createActionDispatcher({ guardedDb }); // dep BİLEREK yok
    const task = await inProgressTask("Başlatıcısız inceleme");

    const observation = await requestReview(dispatcher, task.id);

    expect(observation.ok).toBe(true);
    expect(observation.reviewRequested).toBe(true);
    // inceleme kaydı GERÇEKTEN açıldı — vakumlu bir "false" değil bu
    expect(observation.reviewId).toBeDefined();
    expect(await statusOf(task.id)).toBe("REVIEW");
    // ASIL İDDİA: gözlem yalan söylemiyor
    expect(observation.reviewStarted).toBe(false);
  });

  it("başlatıcı VAR ama BAŞLATAMIYORSA: reviewStarted:false — dep'in varlığı 'başladı' demek değil (F1)", async () => {
    // Jim'in review bulgusu: `startedWorkflow`'u yalnız dep'in VARLIĞINA
    // bakarak set etmek, sunucu yolunda dekoratif bir `true` üretiyordu —
    // Temporal kapalıyken/reddederken bile gözlem "tur başladı" diyordu. Yani
    // sessizliği kapatmak için eklenen alan, tam da o sessizliğin yeni bir
    // biçimi oluyordu. Başlatıcı `false` derse gözlem de `false` demeli.
    const { createActionDispatcher } = await import("@acos/agent-actions");
    const dispatcher = createActionDispatcher({
      guardedDb,
      startReviewWorkflow: async () => false, // Temporal reddetti
    });
    const task = await inProgressTask("Reddedilen başlatma");

    const observation = await requestReview(dispatcher, task.id);

    // satır GERÇEKTEN açıldı (vakumlu bir false değil) ama tur başlamadı
    expect(observation.reviewId).toBeDefined();
    expect(await statusOf(task.id)).toBe("REVIEW");
    expect(observation.reviewStarted).toBe(false);
  });

  it("başlatıcı VARSA: aynı akış reviewStarted:true der ve doğru review'u başlatır", async () => {
    const started: Array<{ reviewId: string; taskId: string; reviewerAgentId: string }> = [];
    const { createActionDispatcher } = await import("@acos/agent-actions");
    const dispatcher = createActionDispatcher({
      guardedDb,
      startReviewWorkflow: async (input) => {
        started.push({
          reviewId: input.reviewId,
          taskId: input.taskId,
          reviewerAgentId: input.reviewerAgentId,
        });
      },
    });
    const task = await inProgressTask("Başlatıcılı inceleme");

    const observation = await requestReview(dispatcher, task.id);

    expect(observation.reviewStarted).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]!.taskId).toBe(task.id);
    // açılan satırın TA KENDİSİ başlatılmalı — başkası değil
    expect(started[0]!.reviewId).toBe(observation.reviewId);
    // INV-14: yazarın kendisi değil
    expect(started[0]!.reviewerAgentId).not.toBe(OWNER);
  });
});
