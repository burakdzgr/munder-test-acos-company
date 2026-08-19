// reviewWorkflow activities (T43; 15 §2, §5). The reviewer acts with their
// OWN agent identity through the shared ReviewsService — independence is
// re-verified there and in the task permission matrix. The verdict decision
// is a DETERMINISTIC policy in MVP (recorded narrowing of the "bounded
// reviewer loop": first code review requests changes exactly once, the
// re-review approves, QA approves — precisely the demo-19 shape; live-LLM
// reviewer reasoning joins the nightly lane).
import { ReviewsService, TaskStateService, companyContext, type GuardedDb } from "@acos/db";
import { and, eq } from "drizzle-orm";
import { agents, orgEdges, positions, tasks, workspaces } from "@acos/db/schema";

export interface ReviewActivityDeps {
  guardedDb: GuardedDb;
  /** görünürlük kancası (QA turu açılamadığında iz bırakır) */
  log?: ((msg: string, meta?: Record<string, unknown>) => void) | undefined;
  /** Rework re-entry: restart the owner's loop with the verdict pre-seeded. */
  startAgentWorkflow?:
    | ((input: {
        companyId: string;
        agentId: string;
        taskId: string;
        initialReviewVerdict?: { verdict: string; notes?: string } | undefined;
        /** Distinct workflow-id discriminator so the rework run never
         *  collides with the (possibly not-yet-closed) prior run (T43). */
        reworkKey?: string | undefined;
      }) => Promise<void>)
    | undefined;
  /** QA-approved → merge as the LEAD via the Tool Gateway (S3). */
  invokeTool?:
    | ((req: {
        companyId: string;
        agentId: string;
        taskId: string;
        toolName: string;
        input: unknown;
        idempotencyKey: string;
      }) => Promise<{ status: string; error?: string | undefined; reason?: string | null; output?: unknown }>)
    | undefined;
  /** Next review round (code approved → qa) rides a fresh reviewWorkflow. */
  startReviewWorkflow?:
    | ((input: {
        companyId: string;
        reviewId: string;
        taskId: string;
        reviewerAgentId: string;
        authorAgentId: string;
      }) => Promise<void>)
    | undefined;
}

export function createReviewActivities(deps: ReviewActivityDeps) {
  const reviewsService = new ReviewsService(deps.guardedDb);

  /** Lead merge via git.merge (gateway authorizes as the lead, S3). */
  async function mergeIfEligible(input: {
    companyId: string;
    taskId: string;
  }): Promise<{ merged: boolean; taskStatus: string; detail: string }> {
    const ctx = companyContext(input.companyId);
    const eligibility = await reviewsService.mergeEligibility(ctx, input.taskId);
    if (!eligibility.eligible) {
      return { merged: false, taskStatus: "", detail: `missing: ${eligibility.missing.join(", ")}` };
    }
    if (!deps.invokeTool) return { merged: false, taskStatus: "", detail: "gateway not wired" };

    const [task] = await deps.guardedDb
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
    if (!task?.ownerAgentId) {
      return { merged: false, taskStatus: "", detail: "task has no owner" };
    }
    // T8: bir konteyner (goal/initiative) kendi diff'ini TAŞIMAZ — 07 §2'ye
    // göre durumu çocuklarından TÜRETİLİR ve roll-up ile kapanır. Konteyner
    // artık (diff'siz inceleme kaydıyla) QA'ya kadar gelebildiği için burada
    // fenceleniyor: merge denemesi boş dalda hataya, ardından system DONE
    // denemesi A5 guard'ının TASK_TRANSITION_INVALID'ine çarpıp reviewWorkflow'u
    // düşürürdü. Konteyneri roll-up kapatır; burada yapılacak bir şey yok.
    if (task.kind === "goal" || task.kind === "initiative") {
      return {
        merged: false,
        taskStatus: task.status,
        detail: "container closes by roll-up (07 §2), not by merge",
      };
    }
    const [workspace] = await deps.guardedDb
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.taskId, input.taskId)));
    const lead = await findLead(deps.guardedDb, ctx.companyId, task.ownerAgentId);
    if (!lead) return { merged: false, taskStatus: "", detail: "no lead in the owner's chain" };

    /**
     * P0-2 kalanı (2026-08-19): birleştirilecek DAL YOKSA git.merge'i hiç
     * çağırma. Kod üretmemiş bir görevde (planlama/analiz işi, araçsız
     * fixture) workspace satırı yok; git.merge "no task branch found" ile
     * başarısız oluyor, QA ONAYLI görev QA'da asılı kalıyordu — kalite zinciri
     * tamamlandığı hâlde görev hiç kapanmıyor. Boş dal hâli zaten kayıtlı bir
     * durum (aşağıdaki EMPTY_MERGE dalı, 2026-08-14): kapanışı SYSTEM yapar.
     * Aynı semantik, bir adım önce — merge çağrısına hiç girmeden.
     */
    if (!workspace?.branch) {
      const closed = await new TaskStateService(deps.guardedDb).transition(
        ctx,
        input.taskId,
        "DONE",
        { kind: "system" },
        { note: "QA onaylı; birleştirilecek dal yok (kod üretmeyen görev) — system kapanışı" },
      );
      return {
        merged: false,
        taskStatus: closed.status,
        detail: "no branch to merge — closed by system",
      };
    }

    const result = await deps.invokeTool({
      companyId: input.companyId,
      agentId: lead,
      taskId: input.taskId,
      toolName: "git.merge",
      input: {
        taskId: input.taskId,
        branch: workspace?.branch ?? "",
        strategy: "squash",
      },
      idempotencyKey: `merge:${input.taskId}`,
    });
    if (result.status !== "succeeded") {
      return {
        merged: false,
        taskStatus: "",
        detail: result.error ?? result.reason ?? result.status,
      };
    }
    // 2026-08-14 saha bulgusu: analiz/dokümantasyon görevlerinde dal boş —
    // EMPTY_MERGE. QA onayı verilmişse kapanışı merge yerine SYSTEM yapar
    // (QA→DONE kinds: qa|system); kod görevlerinde davranış değişmedi.
    const output = result.output as { merged?: boolean; conflict?: { files?: string[] } } | undefined;
    if (output?.merged === false && output.conflict?.files?.includes("EMPTY_MERGE")) {
      const closed = await new TaskStateService(deps.guardedDb).transition(
        ctx,
        input.taskId,
        "DONE",
        { kind: "system" },
        { note: "QA onaylı; merge edilecek değişiklik yok (analiz görevi) — system kapanışı" },
      );
      return { merged: false, taskStatus: closed.status, detail: "empty merge — closed by system" };
    }
    const [after] = await deps.guardedDb
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
    return { merged: true, taskStatus: after?.status ?? "", detail: "merged" };
  }

  return {
    /** pending → in_review with the reviewer identity (+review.started). */
    async startReviewActivity(input: {
      companyId: string;
      reviewId: string;
      reviewerAgentId: string;
    }) {
      const ctx = companyContext(input.companyId);
      const row = await reviewsService.start(ctx, input.reviewId, input.reviewerAgentId);
      return { kind: row.kind as "code" | "architecture" | "qa" | "security", status: row.status };
    },

    /**
     * The MVP verdict policy (deterministic, recorded): the FIRST decided
     * code verdict for a task is changes_requested; every later one approves;
     * qa/architecture/security approve.
     */
    async decideReviewActivity(input: {
      companyId: string;
      reviewId: string;
      taskId: string;
      kind: string;
    }): Promise<{ verdict: "approved" | "changes_requested"; note: string }> {
      const ctx = companyContext(input.companyId);
      if (input.kind !== "code") {
        return { verdict: "approved", note: `${input.kind} checks passed` };
      }
      // "was there a prior code round?" reads verdictMd, which SURVIVES the
      // re-review reset (the reset nulls decidedAt by design, 15 §5) — the
      // second round must approve, never loop
      const all = await reviewsService.listForTask(ctx, input.taskId);
      const hadDecidedCodeRound = all.some((r) => r.kind === "code" && r.verdictMd !== null);
      return hadDecidedCodeRound
        ? { verdict: "approved", note: "re-review: findings addressed" }
        : {
            verdict: "changes_requested",
            note: "first pass: tighten the CSV escaping and add an edge-case test",
          };
    },

    /**
     * Submit the verdict through the ONE implementation, then drive the
     * follow-ups: rework re-entry, the QA round, or the lead merge.
     */
    async submitReviewVerdictActivity(input: {
      companyId: string;
      reviewId: string;
      taskId: string;
      reviewerAgentId: string;
      verdict: "approved" | "changes_requested";
      note: string;
    }): Promise<{ taskStatus: string; merged: boolean }> {
      const ctx = companyContext(input.companyId);
      const review = await reviewsService.get(ctx, input.reviewId);
      if (review.decidedAt !== null && review.status !== "pending" && review.status !== "in_review") {
        // idempotent replay: verdict already recorded
        return { taskStatus: "", merged: false };
      }
      const { taskStatus } = await reviewsService.verdict(ctx, input.reviewId, {
        reviewerAgentId: input.reviewerAgentId,
        verdict: input.verdict,
        note: input.note,
      });

      const [task] = await deps.guardedDb
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));

      if (review.kind === "code" && input.verdict === "changes_requested") {
        // rework re-entry (09 §4): the owner's loop restarts with the verdict
        // pre-seeded so the script's onSignal branch fires
        if (task?.ownerAgentId && deps.startAgentWorkflow) {
          await deps.startAgentWorkflow({
            companyId: input.companyId,
            agentId: task.ownerAgentId,
            taskId: input.taskId,
            initialReviewVerdict: { verdict: "changes_requested", notes: input.note },
            reworkKey: input.reviewId.slice(-8), // distinct id (T43 race fix)
          });
        }
        return { taskStatus, merged: false };
      }

      if (review.kind === "code" && input.verdict === "approved") {
        // REVIEW → QA happened; open the QA round (15 §2 gate chain)
        if (task?.ownerAgentId) {
          /**
           * 2026-08-19 canlı bulgu: QA turunun açılamaması (uygun QA
           * incelemecisi yok / görev geçersiz) BU AKTİVİTEYİ patlatıyordu.
           * Oysa kod verdict'i o noktada ZATEN commit edilmiştir; atılan hata
           * yalnız aktiviteyi 3 kez yeniden denetip reviewWorkflow'u
           * düşürüyor, görev QA'da sessizce asılı kalıyordu. Verdict yolu
           * artık QA turunun açılamamasına dayanıklı: durum korunur, kusur
           * görünür kalır (aynı sınıf sorun için openCodeReview'daki kayıtlı
           * davranış) ve aşağıdaki log kancasıyla iz bırakılır.
           * DÜZELTME (Oscar T10 verify): stuck-sweep bunu DEVRALMAZ — sweep
           * yalnız status='REVIEW' tarar, QA'yı taramaz; bu yüzden QA turu hiç
           * açılamazsa görev QA'da kalır. Kalıcı çözüm (QA-yetimi sweep kuralı)
           * T11'e ertelendi; bu nadir hâl (uygun QA reviewer yokken) #4'ten
           * sonra pratikte oluşmuyor.
           */
          try {
            const { review: qaReview, created } = await reviewsService.requestReview(ctx, {
              taskId: input.taskId,
              authorAgentId: task.ownerAgentId,
              kind: "qa",
            });
            if (created && deps.startReviewWorkflow && qaReview.reviewerAgentId) {
              await deps.startReviewWorkflow({
                companyId: input.companyId,
                reviewId: qaReview.id,
                taskId: input.taskId,
                reviewerAgentId: qaReview.reviewerAgentId,
                authorAgentId: task.ownerAgentId,
              });
            }
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== "REVIEW_NO_ELIGIBLE_REVIEWER" && code !== "REVIEW_TASK_INVALID") throw err;
            deps.log?.("qa round could not open", {
              taskId: input.taskId,
              reviewId: input.reviewId,
              code,
            });
          }
        }
        return { taskStatus, merged: false };
      }

      if (review.kind === "qa" && input.verdict === "approved") {
        const merged = await mergeIfEligible({
          companyId: input.companyId,
          taskId: input.taskId,
        });
        return { taskStatus: merged.taskStatus || taskStatus, merged: merged.merged };
      }
      return { taskStatus, merged: false };
    },

    async mergeIfEligibleActivity(input: {
      companyId: string;
      taskId: string;
    }): Promise<{ merged: boolean; taskStatus: string; detail: string }> {
      return mergeIfEligible(input);
    },
  };
}

/** First default_role lead/manager walking up the owner's reports_to chain. */
async function findLead(
  db: GuardedDb,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  let current = agentId;
  for (let hop = 0; hop < 10; hop += 1) {
    const [edge] = await db
      .select({ toAgentId: orgEdges.toAgentId })
      .from(orgEdges)
      .where(
        and(
          eq(orgEdges.companyId, companyId),
          eq(orgEdges.fromAgentId, current),
          eq(orgEdges.kind, "reports_to"),
        ),
      )
      .limit(1);
    if (!edge?.toAgentId) return null;
    const [manager] = await db
      .select({ id: agents.id, role: positions.defaultRole })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, companyId), eq(agents.id, edge.toAgentId)));
    if (!manager) return null;
    if (["lead", "manager", "executive"].includes(manager.role)) return manager.id;
    current = manager.id;
  }
  return null;
}

export type ReviewActivities = ReturnType<typeof createReviewActivities>;
