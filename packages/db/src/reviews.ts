// Review flow core (T43; 15 §2, ADR-010). Lives in @acos/db for the shared-
// single-implementation reason: the worker's request_review dispatch, the
// reviewWorkflow's verdict activity, the merge tool's eligibility check and
// the server's REST surface all drive the SAME rules — reviewer independence
// (15 §2.2) and the verdict-driven task transitions cannot diverge.
//
// Independence is enforced twice structurally: the DB CHECK
// (reviewer != author, T12) and this service's typed rejection; the task
// transition itself re-verifies via the T27 permission matrix (the reviewer
// actor class requires a distinct agent).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { SkillsService } from "./skills.js";
import { TaskStateService } from "./task-engine.js";
import {
  agents,
  positions,
  repositories,
  reviews,
  taskAssignments,
  tasks,
  workspaces,
} from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewKind = "code" | "architecture" | "qa" | "security";
export type ReviewVerdictValue = "approved" | "changes_requested";

export class ReviewError extends Error {
  constructor(
    public readonly code:
      | "REVIEW_NOT_FOUND"
      | "REVIEW_SELF_REVIEW"
      | "REVIEW_ALREADY_DECIDED"
      | "REVIEW_NO_ELIGIBLE_REVIEWER"
      | "REVIEW_TASK_INVALID"
      | "REVIEW_NOT_ELIGIBLE_FOR_MERGE",
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

/** Roles that may hold each review kind (15 §2.2; qa per 20 §7.5 kinds). */
const REVIEWER_ROLES: Record<ReviewKind, string[]> = {
  code: ["reviewer", "lead", "manager"],
  architecture: ["lead", "manager", "executive"],
  // 2026-08-19 canlı bulgu (golden path stage 10): kod incelemesi onaylanınca
  // açılan QA turu, QA/reviewer ROLÜ olmayan şirketlerde (Agent Factory bir
  // LEAD işe alıyor) "no eligible qa reviewer" ile patlıyor ve QA ONAYLI
  // olmayan görev QA'da asılı kalıyordu. 15 §2'nin org tablosunda QA Lead'in
  // rolü zaten `lead`; küçük kadroda kaliteyi lead/manager devralır (INV-14
  // bağımsızlığı değişmez — yazar hiçbir zaman aday değildir).
  qa: ["qa", "reviewer", "lead", "manager"],
  security: ["reviewer", "lead"],
};

export class ReviewsService {
  private readonly taskState: TaskStateService;

  constructor(private readonly db: GuardedDb) {
    this.taskState = new TaskStateService(db);
  }

  /**
   * Reviewer selection (15 §2.2): the least-loaded eligible agent — never
   * the author. Eligibility = active + position default_role fits the kind;
   * same-team members first, then anyone eligible in the company.
   */
  async pickReviewer(
    ctx: CompanyContext,
    input: { kind: ReviewKind; authorAgentId: string; orgUnitId: string | null },
  ): Promise<{ id: string; name: string }> {
    const candidates = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        employeeNumber: agents.employeeNumber,
        orgUnitId: agents.orgUnitId,
      })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(
        and(
          eq(agents.companyId, ctx.companyId),
          eq(agents.status, "active"),
          inArray(positions.defaultRole, REVIEWER_ROLES[input.kind]),
        ),
      );
    const eligible = candidates.filter((c) => c.id !== input.authorAgentId);
    if (eligible.length === 0) {
      throw new ReviewError(
        "REVIEW_NO_ELIGIBLE_REVIEWER",
        `no eligible ${input.kind} reviewer distinct from the author`,
      );
    }
    const loads = await this.db
      .select({ reviewerAgentId: reviews.reviewerAgentId, n: sql<number>`count(*)::int` })
      .from(reviews)
      .where(
        and(eq(reviews.companyId, ctx.companyId), inArray(reviews.status, ["pending", "in_review"])),
      )
      .groupBy(reviews.reviewerAgentId);
    const loadOf = new Map(loads.map((l) => [l.reviewerAgentId, Number(l.n)]));
    const ranked = [...eligible].sort((a, b) => {
      const sameTeamA = a.orgUnitId === input.orgUnitId ? 0 : 1;
      const sameTeamB = b.orgUnitId === input.orgUnitId ? 0 : 1;
      if (sameTeamA !== sameTeamB) return sameTeamA - sameTeamB;
      const loadA = loadOf.get(a.id) ?? 0;
      const loadB = loadOf.get(b.id) ?? 0;
      if (loadA !== loadB) return loadA - loadB;
      return a.employeeNumber - b.employeeNumber;
    });
    return { id: ranked[0]!.id, name: ranked[0]!.name };
  }

  /**
   * request_review (15 §2.1/§3.5): get-or-reset the review row for the kind.
   * A re-request after changes_requested RESETS the SAME row to pending
   * (15 §5 — same reviews row, re-review). Emits review.requested.
   */
  async requestReview(
    ctx: CompanyContext,
    input: {
      taskId: string;
      authorAgentId: string;
      kind?: ReviewKind | undefined;
      reviewerAgentId?: string | undefined;
    },
  ): Promise<{ review: ReviewRow; created: boolean }> {
    const kind = input.kind ?? "code";
    // independence is a SECURITY property — reject before any other path
    // (including the existing-row early returns) can mask it (15 §2.2)
    if (input.reviewerAgentId !== undefined && input.reviewerAgentId === input.authorAgentId) {
      throw new ReviewError("REVIEW_SELF_REVIEW", "author cannot review their own work (15 §2.2)");
    }
    return this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)))
        .limit(1);
      if (!task) throw new ReviewError("REVIEW_NOT_FOUND", `task ${input.taskId} not found`);
      if (!task.projectId) {
        throw new ReviewError(
          "REVIEW_TASK_INVALID",
          "reviews need a project (branch + repository)",
        );
      }
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.companyId, ctx.companyId),
            eq(workspaces.taskId, input.taskId),
            sql`${workspaces.status} NOT IN ('merged','discarded','failed','destroyed')`,
          ),
        )
        .limit(1);
      /**
       * P0-2 kalanı (2026-08-19, canlı kanıt golden path stage 10): inceleme
       * KAYDI yalnız canlı bir task workspace'i varsa açılabiliyordu. Kodda
       * hiçbir şey üretmemiş ama REVIEW'a taşınmış bir görev (planlama/analiz
       * işi, araçsız fixture, henüz workspace açmamış sahip) bu yüzden
       * `REVIEW_TASK_INVALID` alıyor, çağıran taraf sessizce "transition-only"
       * yoluna düşüyordu: görev REVIEW'da, reviews tablosunda SIFIR satır,
       * atanmış reviewer yok, onaylayacak kimse yok → görev sonsuza dek asılı
       * (canlıda 3 görev: goal/initiative/epic, reviews=0).
       *
       * İnceleme ROW'u iş ürününe değil GÖREVE aittir; deponun kimliği de
       * görevin PROJESİNDEN türetilebilir (workspace yalnız bir kısayoldu).
       * Workspace yoksa projenin deposuna düşülür: `workspace_id` NULL kalır
       * (sütun zaten nullable), `branch` görevin dalı ya da deponun varsayılan
       * dalıdır. Şema/ad/INV değişmedi; INV-14 (reviewer≠author) aynı iki
       * yapısal kapıdan geçer. Merge yolu değişmez — birleştirilecek dal yoksa
       * QA onayı görevi SYSTEM kapanışıyla bitirir (15 §3.6 boş-merge kaydı).
       */
      let repositoryId = workspace?.repositoryId ?? null;
      let branch = workspace?.branch ?? "";
      if (!repositoryId) {
        const [repo] = await tx
          .select({ id: repositories.id, defaultBranch: repositories.defaultBranch })
          .from(repositories)
          .where(
            and(
              eq(repositories.companyId, ctx.companyId),
              eq(repositories.projectId, task.projectId),
            ),
          )
          .orderBy(asc(repositories.createdAt))
          .limit(1);
        if (!repo) {
          throw new ReviewError(
            "REVIEW_TASK_INVALID",
            "reviews need a repository — neither a live task workspace nor a project repository exists",
          );
        }
        repositoryId = repo.id;
        branch = repo.defaultBranch;
      }

      const [existing] = await tx
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.companyId, ctx.companyId),
            eq(reviews.taskId, input.taskId),
            eq(reviews.kind, kind),
          ),
        )
        .orderBy(asc(reviews.createdAt))
        .limit(1);

      if (existing && ["pending", "in_review"].includes(existing.status)) {
        return { review: existing, created: false }; // already awaiting a verdict
      }
      if (existing && existing.status === "changes_requested") {
        // 15 §5: re-review on the SAME row, same reviewer
        const [reset] = await tx
          .update(reviews)
          .set({ status: "pending", decidedAt: null })
          .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, existing.id)))
          .returning();
        await emitDomainEvent(tx, ctx, {
          type: "review.requested",
          actor: { kind: "agent", id: input.authorAgentId },
          taskId: input.taskId,
          projectId: task.projectId,
          agentId: input.authorAgentId,
          payload: {
            reviewId: reset!.id,
            taskId: input.taskId,
            reviewerAgentId: reset!.reviewerAgentId ?? undefined,
          },
        });
        return { review: reset!, created: false };
      }

      const reviewer =
        input.reviewerAgentId !== undefined
          ? { id: input.reviewerAgentId, name: "" }
          : await this.pickReviewer(ctx, {
              kind,
              authorAgentId: input.authorAgentId,
              orgUnitId: task.orgUnitId,
            });
      if (reviewer.id === input.authorAgentId) {
        throw new ReviewError("REVIEW_SELF_REVIEW", "author cannot review their own work (15 §2.2)");
      }

      const [row] = await tx
        .insert(reviews)
        .values({
          companyId: ctx.companyId,
          taskId: input.taskId,
          projectId: task.projectId,
          repositoryId,
          ...(workspace && { workspaceId: workspace.id }),
          branch,
          kind,
          authorAgentId: input.authorAgentId,
          reviewerAgentId: reviewer.id,
        })
        .returning();
      // 2026-08-15 live finding: the reviewer must ALSO be recorded as a task
      // assignment. `TaskStateService.actorClasses` derives the `reviewer`/`qa`
      // classes from task_assignments or the position's default_role — so a
      // manager picked by `pickReviewer` (REVIEWER_ROLES.code allows manager)
      // was rejected by the permission matrix on REVIEW → CHANGES_REQUESTED
      // ("manager may not perform …"), deadlocking every review it decided.
      // The assignment is the canonical carrier of a per-task capability role
      // (07 §5); INV-14 independence is unaffected (author ≠ reviewer is
      // enforced above and by the DB check).
      await tx
        .insert(taskAssignments)
        .values({
          companyId: ctx.companyId,
          taskId: input.taskId,
          agentId: reviewer.id,
          role: kind === "qa" ? "qa" : "reviewer",
          reason: `review:${kind}`,
        })
        .onConflictDoNothing();
      await emitDomainEvent(tx, ctx, {
        type: "review.requested",
        actor: { kind: "agent", id: input.authorAgentId },
        taskId: input.taskId,
        projectId: task.projectId,
        agentId: input.authorAgentId,
        payload: { reviewId: row!.id, taskId: input.taskId, reviewerAgentId: reviewer.id },
      });
      return { review: row!, created: true };
    });
  }

  async get(ctx: CompanyContext, reviewId: string): Promise<ReviewRow> {
    const [row] = await this.db
      .select()
      .from(reviews)
      .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, reviewId)))
      .limit(1);
    if (!row) throw new ReviewError("REVIEW_NOT_FOUND", `review ${reviewId} not found`);
    return row;
  }

  async listForTask(ctx: CompanyContext, taskId: string): Promise<ReviewRow[]> {
    return this.db
      .select()
      .from(reviews)
      .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.taskId, taskId)))
      .orderBy(asc(reviews.createdAt));
  }

  /** pending → in_review + review.started (idempotent). */
  async start(ctx: CompanyContext, reviewId: string, reviewerAgentId: string): Promise<ReviewRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(reviews)
        .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, reviewId)))
        .for("update");
      if (!row) throw new ReviewError("REVIEW_NOT_FOUND", `review ${reviewId} not found`);
      if (row.status !== "pending") return row;
      const [updated] = await tx
        .update(reviews)
        .set({ status: "in_review" })
        .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, reviewId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "review.started",
        actor: { kind: "agent", id: reviewerAgentId },
        taskId: row.taskId,
        projectId: row.projectId,
        agentId: reviewerAgentId,
        payload: { reviewId, reviewerAgentId },
      });
      return updated!;
    });
  }

  /**
   * The verdict: reviewer independence re-checked, row decided, the task
   * driven through the ONE status writer with the REVIEWER'S identity (the
   * permission matrix enforces distinct-from-owner structurally):
   *   code approved            → REVIEW → QA
   *   code changes_requested   → REVIEW → CHANGES_REQUESTED
   *   qa approved              → no transition (merge-eligible; merge → DONE)
   *   qa changes_requested     → QA → QA_FAILED
   */
  async verdict(
    ctx: CompanyContext,
    reviewId: string,
    input: {
      reviewerAgentId: string;
      verdict: ReviewVerdictValue;
      note?: string | undefined;
      findings?: { path: string; line?: number; severity: string; note: string }[] | undefined;
    },
  ): Promise<{ review: ReviewRow; taskStatus: string }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(reviews)
        .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, reviewId)))
        .for("update");
      if (!row) throw new ReviewError("REVIEW_NOT_FOUND", `review ${reviewId} not found`);
      if (row.authorAgentId === input.reviewerAgentId) {
        throw new ReviewError("REVIEW_SELF_REVIEW", "author cannot review their own work (15 §2.2)");
      }
      if (!["pending", "in_review"].includes(row.status)) {
        throw new ReviewError("REVIEW_ALREADY_DECIDED", `review ${reviewId} is ${row.status}`);
      }

      const status = input.verdict === "approved" ? "approved" : "changes_requested";
      const [decided] = await tx
        .update(reviews)
        .set({
          status,
          reviewerAgentId: input.reviewerAgentId,
          verdictMd: input.note ?? null,
          diffStat: input.findings ? { findings: input.findings } : row.diffStat,
          decidedAt: new Date(),
        })
        .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, reviewId)))
        .returning();

      const reviewerActor = { kind: "agent" as const, agentId: input.reviewerAgentId };
      let taskStatus = "";
      if (row.kind === "code" || row.kind === "architecture" || row.kind === "security") {
        const to = input.verdict === "approved" ? "QA" : "CHANGES_REQUESTED";
        const task = await this.taskState.transitionInTx(tx, ctx, row.taskId, to, reviewerActor, {
          note: input.note,
        });
        taskStatus = task.status;
        if (to === "QA") {
          // 13 §5.1 (T47): independent acceptance is the strongest routine
          // signal — review_accepted per skill tag for the author
          await new SkillsService(this.db).recordReviewAcceptedInTx(tx, ctx, {
            taskId: row.taskId,
            ownerAgentId: task.ownerAgentId,
            context: task.context,
            reviewId,
          });
        }
      } else {
        // qa: approved ⇒ merge-eligible (merge drives DONE); rejected ⇒ QA_FAILED
        if (input.verdict === "changes_requested") {
          const task = await this.taskState.transitionInTx(
            tx,
            ctx,
            row.taskId,
            "QA_FAILED",
            reviewerActor,
            { note: input.note },
          );
          taskStatus = task.status;
        } else {
          const [task] = await tx
            .select({ status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, row.taskId)));
          taskStatus = task?.status ?? "";
        }
      }

      await emitDomainEvent(tx, ctx, {
        type: "review.completed",
        actor: { kind: "agent", id: input.reviewerAgentId },
        taskId: row.taskId,
        projectId: row.projectId,
        agentId: input.reviewerAgentId,
        payload: {
          reviewId,
          verdict: status,
          notes: (input.note ?? "").slice(0, 500),
          durationMs: Date.now() - row.createdAt.getTime(),
        },
      });
      return { review: decided!, taskStatus };
    });
  }

  /** Merge gate (15 §3.6a): every review row of the task must be approved. */
  async mergeEligibility(
    ctx: CompanyContext,
    taskId: string,
  ): Promise<{ eligible: boolean; missing: string[] }> {
    const rows = await this.listForTask(ctx, taskId);
    if (rows.length === 0) return { eligible: false, missing: ["code"] };
    const missing = rows.filter((r) => r.status !== "approved").map((r) => `${r.kind}:${r.status}`);
    return { eligible: missing.length === 0, missing };
  }

  /** Stamp the squash commit on the task's reviews after a merge. */
  async recordMerge(ctx: CompanyContext, taskId: string, mergeCommit: string): Promise<void> {
    await this.db
      .update(reviews)
      .set({ mergedCommit: mergeCommit })
      .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.taskId, taskId)));
  }
}
