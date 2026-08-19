// Task engine core (07 §1–5; _DECISIONS §7). Lives in packages/db so BOTH
// consumers of the single status-writer share one implementation: apps/server
// routes and workers/agent-worker activities (08 §3) — the dependency matrix
// allows db → domain/events, and neither app may import the other.
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  authorizeTaskTransition,
  formatTaskNumber,
  type TaskActorKind,
  type TaskStatus,
} from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import { nextSequenceValue } from "./sequences.js";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { SkillsService } from "./skills.js";
import { agents, positions, taskAssignments, taskDependencies, tasks } from "./schema/index.js";

/** Catalog-validated emission (same contract as the server's emitDomainEvent —
 *  T22): an uncatalogued type or payload mismatch aborts the transaction. */
async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export type TaskRow = typeof tasks.$inferSelect;
export type TaskActorInput =
  | { kind: "founder" }
  | { kind: "system" }
  | { kind: "approval_engine" } // APPROVAL→DONE/REJECTED only (07 §5, T35)
  | { kind: "agent"; agentId: string };

export class TaskEngineError extends Error {
  constructor(
    public readonly code:
      | "TASK_NOT_FOUND"
      | "TASK_TRANSITION_INVALID"
      | "TASK_DEPENDENCY_CYCLE"
      | "TASK_HIERARCHY_INVALID"
      | "TASK_REASSIGNMENT_LIMIT"
      | "AGENT_NOT_ACTIVE",
    message: string,
  ) {
    super(message);
    this.name = "TaskEngineError";
  }
}

/** 07 §2: parent kind must be strictly one level higher — no level skipping. */
const KIND_PARENT: Record<string, string | null> = {
  goal: null,
  initiative: "goal",
  epic: "initiative",
  task: "epic",
  subtask: "task",
};
/** Kinds allowed to exist without a parent (07 §2 [WRITER-DECISION]). */
const PARENTLESS_KINDS = new Set(["goal", "task"]);

const TERMINAL: ReadonlySet<string> = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * Kapanmış görevin panoda kalma süresi (gün).
 *
 * Kapanan iş bir süre görünür kalmalı — dün ne bitti, ne iptal oldu sorusunun
 * cevabı panodadır. Ama süresiz kalırsa pano ölü kartlarla doluyor (canlı
 * örnek: 32 iptal karşısında 3 tamamlanmış görev). Bu eşikten sonra görev
 * kendiliğinden arşiv görünümüne geçer; hiçbir satır silinmez, `include`
 * parametresiyle her an geri getirilir.
 */
export const TERMINAL_FADE_DAYS = 7;

export class TasksService {
  constructor(private readonly db: GuardedDb) {}

  async create(
    ctx: CompanyContext,
    input: {
      /** Deterministic caller id (stepId-derived) = idempotency under
       *  at-least-once activity execution (R1, T50): a replayed create
       *  returns the existing row instead of a duplicate child. */
      id?: string | undefined;
      projectId?: string | undefined;
      parentId?: string | undefined;
      kind: string;
      title: string;
      objective: string;
      priority?: string | undefined;
      successCriteria?: string[] | undefined;
      risk?: string | undefined;
      budgetCents?: number | undefined;
      deadline?: string | undefined;
      orgUnitId?: string | undefined;
      context?: Record<string, unknown> | undefined;
    },
    creator: { kind: "founder" } | { kind: "agent"; agentId: string },
  ): Promise<TaskRow> {
    return this.db.transaction(async (tx) => {
      if (input.id) {
        const [existing] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.id)));
        if (existing) return existing; // idempotent replay
      }
      let delegationDepth = 0;
      let inheritedProjectId: string | null = null;
      if (input.parentId) {
        const [parent] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.parentId)));
        if (!parent) throw new TaskEngineError("TASK_NOT_FOUND", "parent task not found");
        if (KIND_PARENT[input.kind] !== parent.kind) {
          throw new TaskEngineError(
            "TASK_HIERARCHY_INVALID",
            `a ${input.kind} must sit under ${KIND_PARENT[input.kind] ?? "no parent"}, not ${parent.kind}`,
          );
        }
        delegationDepth = parent.delegationDepth + 1;
        if (delegationDepth > 5) {
          throw new TaskEngineError("TASK_HIERARCHY_INVALID", "delegation depth exceeds 5");
        }
        // a subtree belongs to its project (14 §1): children inherit unless
        // the creator scopes them explicitly (T42)
        inheritedProjectId = parent.projectId;
      } else if (!PARENTLESS_KINDS.has(input.kind)) {
        throw new TaskEngineError(
          "TASK_HIERARCHY_INVALID",
          `a ${input.kind} requires a ${KIND_PARENT[input.kind]} parent`,
        );
      }

      const number = await nextSequenceValue(tx, ctx, "task_number");
      const [task] = await tx
        .insert(tasks)
        .values({
          ...(input.id && { id: input.id }),
          companyId: ctx.companyId,
          projectId: input.projectId ?? inheritedProjectId,
          parentId: input.parentId ?? null,
          number,
          kind: input.kind,
          title: input.title,
          objective: input.objective,
          priority: input.priority ?? "P2",
          successCriteria: input.successCriteria ?? [],
          risk: input.risk ?? "low",
          budgetCents: input.budgetCents ?? null,
          deadline: input.deadline ? new Date(input.deadline) : null,
          orgUnitId: input.orgUnitId ?? null,
          context: input.context ?? {},
          creatorAgentId: creator.kind === "agent" ? creator.agentId : null,
          delegationDepth,
        })
        .returning();

      // a task can never exist without its thread (11 §2) — same tx
      if (["task", "subtask", "epic"].includes(input.kind)) {
        const { ChannelService } = await import("./comms.js");
        await new ChannelService(this.db).provisionInTx(tx, ctx, {
          kind: "task_thread",
          taskId: task!.id,
          memberAgentIds: creator.kind === "agent" ? [creator.agentId] : [],
        });
      }

      await emitDomainEvent(tx, ctx, {
        type: "task.created",
        actor:
          creator.kind === "agent"
            ? { kind: "agent", id: creator.agentId }
            : { kind: "founder", id: null },
        taskId: task!.id,
        ...(creator.kind === "agent" && { agentId: creator.agentId }),
        payload: {
          number,
          kind: task!.kind,
          title: task!.title,
          parentTaskId: task!.parentId ?? undefined,
          priority: task!.priority,
          risk: task!.risk,
          budgetCents: task!.budgetCents ?? undefined,
          successCriteria: task!.successCriteria,
          delegationDepth,
        },
      });
      return task!;
    });
  }

  async get(ctx: CompanyContext, taskId: string): Promise<TaskRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    return row;
  }

  async list(
    ctx: CompanyContext,
    filters: {
      projectId?: string | undefined;
      kind?: string | undefined;
      status?: string[] | undefined;
      ownerAgentId?: string | undefined;
      orgUnitId?: string | undefined;
      priority?: string | undefined;
      risk?: string | undefined;
      parentId?: string | undefined;
      q?: string | undefined;
      /**
       * Görünürlük penceresi (varsayılan "active"):
       *   active   — arşivlenmemiş VE (açık ya da yeni kapanmış) görevler
       *   archived — yalnız gizlenmiş olanlar (arşiv görünümü)
       *   all      — hepsi (denetim/dışa aktarım)
       */
      include?: "active" | "archived" | "all" | undefined;
    },
  ): Promise<TaskRow[]> {
    const conditions: SQL[] = [eq(tasks.companyId, ctx.companyId) as SQL];
    // Görünürlük filtresi status filtresinden ÖNCE: durum sorulmuş olsa bile
    // arşivlenmiş görev varsayılan panoda çıkmamalı.
    const include = filters.include ?? "active";
    if (include === "active") {
      conditions.push(
        sql`${tasks.archivedAt} IS NULL
            AND (${tasks.closedAt} IS NULL
                 OR ${tasks.closedAt} > now() - ${sql.raw(`interval '${TERMINAL_FADE_DAYS} days'`)})`,
      );
    } else if (include === "archived") {
      conditions.push(
        sql`${tasks.archivedAt} IS NOT NULL
            OR (${tasks.closedAt} IS NOT NULL
                AND ${tasks.closedAt} <= now() - ${sql.raw(`interval '${TERMINAL_FADE_DAYS} days'`)})`,
      );
    }
    if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId) as SQL);
    if (filters.kind) conditions.push(eq(tasks.kind, filters.kind) as SQL);
    if (filters.status && filters.status.length > 0) {
      conditions.push(
        sql`${tasks.status} IN (${sql.join(filters.status.map((s) => sql`${s}`), sql`, `)})`,
      );
    }
    if (filters.ownerAgentId) conditions.push(eq(tasks.ownerAgentId, filters.ownerAgentId) as SQL);
    if (filters.orgUnitId) conditions.push(eq(tasks.orgUnitId, filters.orgUnitId) as SQL);
    if (filters.priority) conditions.push(eq(tasks.priority, filters.priority) as SQL);
    if (filters.risk) conditions.push(eq(tasks.risk, filters.risk) as SQL);
    if (filters.parentId) conditions.push(eq(tasks.parentId, filters.parentId) as SQL);
    if (filters.q) conditions.push(sql`${tasks.title} ILIKE ${"%" + filters.q + "%"}`);
    return this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(tasks.number));
  }

  /**
   * Founder panodan kaldırır / geri getirir.
   *
   * Bilerek SİLMİYOR ve bilerek bir durum geçişi DEĞİL: silmek olay
   * zincirini ve o görevden doğan anıları sakat bırakırdı (INV-11), yeni bir
   * durum ise 07 §5'in 16 durumluk makinesini değiştirmek olurdu. Arşiv
   * yalnızca bir görünüm niteliğidir, bu yüzden izin matrisinden ve durum
   * makinesinden geçmez — ama SADECE Founder çağırabilir (rota katmanı).
   */
  async setArchived(
    ctx: CompanyContext,
    taskId: string,
    archived: boolean,
  ): Promise<TaskRow | undefined> {
    const [row] = await this.db
      .update(tasks)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
      .returning();
    return row;
  }

  async update(
    ctx: CompanyContext,
    taskId: string,
    patch: Record<string, unknown>,
  ): Promise<TaskRow | undefined> {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if ("deadline" in cleaned && typeof cleaned.deadline === "string") {
      cleaned.deadline = new Date(cleaned.deadline);
    }
    if (Object.keys(cleaned).length === 0) return this.get(ctx, taskId);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasks)
        .set(cleaned)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .returning();
      if (!updated) return undefined;
      await emitDomainEvent(tx, ctx, {
        type: "task.updated",
        actor: { kind: "founder", id: null },
        taskId,
        payload: { diff: Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) },
      });
      return updated;
    });
  }

  /** Recursive subtree (GET /tasks/:id/tree) — ids via CTE, rows via ORM. */
  async subtree(ctx: CompanyContext, rootId: string): Promise<TaskRow[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE sub AS (
        SELECT t.id FROM tasks t
        WHERE t.company_id = ${ctx.companyId} AND t.id = ${rootId}
        UNION ALL
        SELECT t.id FROM tasks t
        JOIN sub ON t.parent_id = sub.id
        WHERE t.company_id = ${ctx.companyId}
      )
      SELECT id FROM sub LIMIT 10000
    `);
    const ids = (result.rows as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          sql`${tasks.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
        ),
      )
      .orderBy(asc(tasks.number));
  }

  // ---------- dependency DAG (07 §3) ----------

  async addDependency(ctx: CompanyContext, taskId: string, dependsOnTaskId: string) {
    if (taskId === dependsOnTaskId) {
      throw new TaskEngineError("TASK_DEPENDENCY_CYCLE", "a task cannot depend on itself");
    }
    return this.db.transaction(async (tx) => {
      for (const id of [taskId, dependsOnTaskId]) {
        const [row] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, id)));
        if (!row) throw new TaskEngineError("TASK_NOT_FOUND", "task not found");
      }
      // cycle check: walk outgoing blocks-edges from dependsOnTaskId; reaching
      // taskId means the new edge would close a cycle (same tx — 07 §3)
      const cycle = await tx.execute(sql`
        WITH RECURSIVE walk AS (
          SELECT d.depends_on_task_id AS next FROM task_dependencies d
          WHERE d.company_id = ${ctx.companyId} AND d.task_id = ${dependsOnTaskId}
            AND d.resolved_at IS NULL
          UNION ALL
          SELECT d.depends_on_task_id FROM task_dependencies d
          JOIN walk ON d.task_id = walk.next
          WHERE d.company_id = ${ctx.companyId} AND d.resolved_at IS NULL
        )
        SELECT 1 FROM walk WHERE next = ${taskId} LIMIT 1
      `);
      if (cycle.rows.length > 0) {
        throw new TaskEngineError("TASK_DEPENDENCY_CYCLE", "dependency would create a cycle");
      }
      const [edge] = await tx
        .insert(taskDependencies)
        .values({ companyId: ctx.companyId, taskId, dependsOnTaskId })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "task.dependency.added",
        actor: { kind: "founder", id: null },
        taskId,
        payload: { dependsOnTaskId },
      });
      return edge!;
    });
  }

  async removeDependency(ctx: CompanyContext, taskId: string, depId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [edge] = await tx
        .update(taskDependencies)
        .set({ resolvedAt: sql`now()` })
        .where(
          and(
            eq(taskDependencies.companyId, ctx.companyId),
            eq(taskDependencies.id, depId),
            eq(taskDependencies.taskId, taskId),
            isNull(taskDependencies.resolvedAt),
          ),
        )
        .returning();
      if (!edge) return false;
      await emitDomainEvent(tx, ctx, {
        type: "task.dependency.resolved",
        actor: { kind: "founder", id: null },
        taskId,
        payload: { dependsOnTaskId: edge.dependsOnTaskId, result: "removed" },
      });
      return true;
    });
  }

  async dependencies(ctx: CompanyContext, taskId: string) {
    const blockedBy = await this.db
      .select()
      .from(taskDependencies)
      .where(and(eq(taskDependencies.companyId, ctx.companyId), eq(taskDependencies.taskId, taskId)));
    const blocks = await this.db
      .select()
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.companyId, ctx.companyId),
          eq(taskDependencies.dependsOnTaskId, taskId),
        ),
      );
    return { blockedBy, blocks };
  }

  async listAllDependencies(ctx: CompanyContext) {
    return this.db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.companyId, ctx.companyId));
  }

  async listAssignments(ctx: CompanyContext, taskId: string) {
    return this.db
      .select()
      .from(taskAssignments)
      .where(and(eq(taskAssignments.companyId, ctx.companyId), eq(taskAssignments.taskId, taskId)))
      .orderBy(asc(taskAssignments.assignedAt));
  }
}

// ---------------------------------------------------------------------------

export class TaskStateService {
  constructor(private readonly db: GuardedDb) {}

  /**
   * The single status-write path. Row-locked; actor classes are resolved
   * server-side from org data (07 §5) and checked with the pure domain
   * matrix. All transitions emit task.status.changed; terminal transitions
   * additionally emit task.failed/task.cancelled and DONE resolves the
   * dependency edges of dependents.
   */
  async transition(
    ctx: CompanyContext,
    taskId: string,
    to: TaskStatus,
    actor: TaskActorInput,
    opts: { note?: string | undefined } = {},
  ): Promise<TaskRow> {
    return this.db.transaction((tx) => this.transitionInTx(tx, ctx, taskId, to, actor, opts));
  }

  /** Same single write path, composable into a caller's transaction (T35:
   *  the Approval Engine settles a parked task atomically with the verdict). */
  async transitionInTx(
    tx: Tx,
    ctx: CompanyContext,
    taskId: string,
    to: TaskStatus,
    actor: TaskActorInput,
    opts: {
      note?: string | undefined;
      /**
       * A5 (07 §2): the container roll-up. A `goal`/`initiative` holds no work
       * of its own — nobody reviews a goal — so its terminal state is DERIVED
       * from its children rather than walked through the work-task machine
       * (whose REVIEW/QA hops exist for a diff). Only `rollUpContainer` passes
       * this; INV-13 still holds, because this is still the one status writer.
       */
      derived?: boolean | undefined;
    } = {},
  ): Promise<TaskRow> {
    {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .for("update");
      if (!task) throw new TaskEngineError("TASK_NOT_FOUND", "task not found");
      const from = task.status as TaskStatus;

      // The derived path skips BOTH the permission matrix and the work-task
      // machine, so it is fenced to containers: a `task` can never reach DONE
      // without its review/QA hops, whatever the caller passes.
      if (opts.derived && task.kind !== "goal" && task.kind !== "initiative") {
        throw new TaskEngineError(
          "TASK_TRANSITION_INVALID",
          `derived transitions are for containers only (07 §2); ${task.kind} must walk the state machine`,
        );
      }

      // A5: a container must not be closed by hand while its children are
      // still running — that is exactly how a `goal` used to reach DONE the
      // moment the CEO delegated it, with none of the work delivered.
      if (
        !opts.derived &&
        (task.kind === "goal" || task.kind === "initiative") &&
        (to === "DONE" || to === "FAILED")
      ) {
        throw new TaskEngineError(
          "TASK_TRANSITION_INVALID",
          `a ${task.kind} is a container (07 §2): its status is derived from its children, so it closes by roll-up when they are terminal — not by a direct ${to}`,
        );
      }

      const classes = await this.actorClasses(tx, ctx, actor, task);
      let reason = `no actor class of [${classes.join(", ")}] may perform ${from} → ${to}`;
      const agentId = actor.kind === "agent" ? actor.agentId : null;
      const allowed =
        opts.derived === true ||
        classes.some((kind) => {
          const verdict = authorizeTaskTransition(from, to, { kind, agentId }, {
            ownerAgentId: task.ownerAgentId,
          });
          if (!verdict.allowed) reason = verdict.reason;
          return verdict.allowed;
        });
      if (!allowed) throw new TaskEngineError("TASK_TRANSITION_INVALID", reason);

      const [updated] = await tx
        .update(tasks)
        .set({ status: to, ...(TERMINAL.has(to) && { closedAt: sql`now()` }) })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .returning();

      // envelope actor enum is agent|founder|system (10 §4) — the
      // approval_engine class acts as `system` in the event record
      const byActor =
        actor.kind === "agent"
          ? { kind: "agent" as const, id: actor.agentId }
          : { kind: actor.kind === "approval_engine" ? ("system" as const) : actor.kind, id: null };
      await emitDomainEvent(tx, ctx, {
        type: "task.status.changed",
        actor: byActor,
        taskId,
        ...(agentId && { agentId }),
        payload: { from, to, byActor, note: opts.note },
      });
      if (to === "FAILED") {
        await emitDomainEvent(tx, ctx, {
          type: "task.failed",
          actor: byActor,
          taskId,
          payload: { reason: opts.note, decidedBy: actor.kind },
        });
      }
      if (to === "CANCELLED") {
        await emitDomainEvent(tx, ctx, {
          type: "task.cancelled",
          actor: byActor,
          taskId,
          payload: { reason: opts.note, decidedBy: actor.kind },
        });
      }
      if (to === "DONE") {
        // terminal marker the memory-trigger consumer subscribes to
        // (co.*.task.completed, 10 §5 / 12 §5.0)
        await emitDomainEvent(tx, ctx, {
          type: "task.completed",
          actor: byActor,
          taskId,
          payload: { resultSummary: opts.note },
        });
        await this.resolveDependents(tx, ctx, taskId);
      }
      // skill evidence (13 §5, T47): terminal outcomes attribute to the
      // task's skill tags — untagged tasks are a no-op
      if (to === "DONE" || to === "FAILED" || to === "QA_FAILED") {
        await new SkillsService(this.db).recordTaskOutcomeInTx(tx, ctx, {
          taskId,
          ownerAgentId: task.ownerAgentId,
          context: task.context,
          outcome: to === "DONE" ? "success" : "failure",
        });
      }
      // A5 (07 §2): container status is "derived-but-persisted … child-
      // completion triggers move a container to DONE when all children are
      // terminal-successful, FAILED if any critical-path child FAILED without
      // replacement". The trigger did not exist, so a `goal`/`initiative`
      // closed the moment its owner said so — with the delegated work still
      // running. This is the join the delivery loop was missing.
      if (TERMINAL.has(to) && task.parentId) {
        await this.rollUpContainer(tx, ctx, task.parentId);
      }
      return updated!;
    }
  }

  /**
   * "Rafa kaldır" (Founder UX, 2026-08-19): bir projenin (veya şirketin)
   * TÜM görevlerini tek hamlede kapatıp panodan kaldırır. SİLME DEĞİL —
   * satırlar, olaylar ve o görevlerden doğan ANILAR aynen kalır (INV-11);
   * başka bir projede "daha önce böyle bir şey yapmıştık" diyebilmenin
   * güvencesi budur.
   *
   * Açık görevler önce YASAL geçişlerle CANCELLED'a çekilir (16 durumluk
   * makine ve izin matrisi dokunulmaz): Founder'ın doğrudan iptal edemediği
   * dört durumda (CHANGES_REQUESTED / QA_FAILED / REJECTED / APPROVAL)
   * mekanik bir geri-sarım uygulanır — sahibi adına IN_PROGRESS'e (owner
   * izinli geçiş), APPROVAL'da approval_engine ile REJECTED'a — sonra
   * founder iptali. Her adım kendi olayını üretir. Ardından hepsi arşivlenir.
   */
  async shelve(
    ctx: CompanyContext,
    opts: { projectId?: string | null | undefined; note?: string | undefined } = {},
  ): Promise<{ scanned: number; cancelled: number; archived: number; cancelFailed: string[] }> {
    const note = opts.note ?? "Founder: rafa kaldırıldı";
    const rows = await this.db
      .select({ id: tasks.id, status: tasks.status, ownerAgentId: tasks.ownerAgentId })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          isNull(tasks.archivedAt),
          ...(opts.projectId ? [eq(tasks.projectId, opts.projectId)] : []),
        ),
      );
    const OPEN = (s: string) => !["DONE", "FAILED", "CANCELLED"].includes(s);
    let cancelled = 0;
    const cancelFailed: string[] = [];
    for (const row of rows.filter((r) => OPEN(r.status))) {
      try {
        let status = row.status;
        // geri-sarım: founder iptalinin makine-yasal olmadığı durumlar
        if (status === "APPROVAL") {
          await this.transition(ctx, row.id, "REJECTED", { kind: "approval_engine" }, { note });
          status = "REJECTED";
        }
        if (["CHANGES_REQUESTED", "QA_FAILED", "REJECTED"].includes(status)) {
          if (!row.ownerAgentId) throw new TaskEngineError("TASK_TRANSITION_INVALID", "no owner to unwind with");
          await this.transition(
            ctx,
            row.id,
            "IN_PROGRESS",
            { kind: "agent", agentId: row.ownerAgentId },
            { note },
          );
        }
        await this.transition(ctx, row.id, "CANCELLED", { kind: "founder" }, { note });
        cancelled += 1;
      } catch {
        cancelFailed.push(row.id);
      }
    }
    // arşiv: durum ne olursa olsun panodan kalkar (görünüm niteliği)
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await this.db
        .update(tasks)
        .set({ archivedAt: sql`now()` })
        .where(and(eq(tasks.companyId, ctx.companyId), inArray(tasks.id, ids)));
    }
    return { scanned: rows.length, cancelled, archived: ids.length, cancelFailed };
  }

  /**
   * Owner assignment (21 §3.7 POST /assignments). On PLANNED the task also
   * moves PLANNED→ASSIGNED (manager/founder only, via the same matrix).
   * Replacing an existing owner bumps reassignment_count (≤3 — the DB CHECK
   * plus this guard; 07 §8) and emits task.reassigned.
   */
  async assign(
    ctx: CompanyContext,
    taskId: string,
    input: {
      agentId: string;
      role?: "owner" | "reviewer" | "qa" | "collaborator" | undefined;
      reason?: string | undefined;
    },
    actor: TaskActorInput,
    opts: { force?: boolean | undefined } = {},
  ): Promise<TaskRow> {
    const role = input.role ?? "owner";
    return this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .for("update");
      if (!task) throw new TaskEngineError("TASK_NOT_FOUND", "task not found");

      // 2026-08-14 saha bulgusu: işten çıkarılmış bir ajana atama kabul
      // ediliyordu — hayalet oturum açılıp jeton yakıyor, Tool Gateway
      // (haklı olarak) IDENTITY_INVALID basıyordu. Atanan HER rol için
      // ajan bu şirkette ve AKTİF olmak zorunda.
      const [assignee] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, input.agentId)))
        .limit(1);
      if (!assignee || assignee.status !== "active") {
        throw new TaskEngineError(
          "AGENT_NOT_ACTIVE",
          `assignee ${input.agentId} is ${assignee?.status ?? "missing"} — only active agents can take assignments`,
        );
      }

      const byAgentId = actor.kind === "agent" ? actor.agentId : null;
      if (role !== "owner") {
        await tx.insert(taskAssignments).values({
          companyId: ctx.companyId,
          taskId,
          agentId: input.agentId,
          role,
          assignedByAgentId: byAgentId,
          reason: input.reason ?? null,
        });
        return task;
      }

      // owner path — authorize as PLANNED→ASSIGNED (or a reassignment)
      const from = task.status as TaskStatus;
      const previousOwner = task.ownerAgentId;
      const isReassignment = previousOwner !== null && previousOwner !== input.agentId;
      if (from === "PLANNED") {
        const classes = await this.actorClasses(tx, ctx, actor, task);
        const allowed = classes.some(
          (kind) =>
            authorizeTaskTransition("PLANNED", "ASSIGNED", { kind, agentId: byAgentId }, {
              ownerAgentId: task.ownerAgentId,
            }).allowed,
        );
        if (!allowed) {
          throw new TaskEngineError(
            "TASK_TRANSITION_INVALID",
            "only manager-or-above (or the Founder) may assign a planned task",
          );
        }
      } else if (!isReassignment && previousOwner === input.agentId) {
        return task; // no-op
      }

      let forced = false;
      if (isReassignment && task.reassignmentCount >= 3) {
        // 07 §8: only Manager+ with an explicit force_reassign override
        // (audited via the task.reassigned note) may move it again
        const classes = await this.actorClasses(tx, ctx, actor, task);
        const managerial = classes.includes("manager") || classes.includes("founder");
        if (!opts.force || !managerial) {
          throw new TaskEngineError(
            "TASK_REASSIGNMENT_LIMIT",
            "reassignment limit (3) reached — manager intervention required (07 §8)",
          );
        }
        forced = true;
      }

      await tx
        .update(taskAssignments)
        .set({ unassignedAt: sql`now()` })
        .where(
          and(
            eq(taskAssignments.companyId, ctx.companyId),
            eq(taskAssignments.taskId, taskId),
            eq(taskAssignments.role, "owner"),
            isNull(taskAssignments.unassignedAt),
          ),
        );
      await tx.insert(taskAssignments).values({
        companyId: ctx.companyId,
        taskId,
        agentId: input.agentId,
        role: "owner",
        assignedByAgentId: byAgentId,
        reason: input.reason ?? null,
      });

      // a forced move keeps the count at the cap (DB CHECK <= 3)
      const reassignmentCount = task.reassignmentCount + (isReassignment && !forced ? 1 : 0);
      const [updated] = await tx
        .update(tasks)
        .set({
          ownerAgentId: input.agentId,
          reassignmentCount,
          ...(from === "PLANNED" && { status: "ASSIGNED" }),
        })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .returning();

      // the new owner joins the task thread (11 §2 membership rule)
      {
        const { ChannelService } = await import("./comms.js");
        const channelService = new ChannelService(this.db);
        const thread = await channelService.provisionInTx(tx, ctx, {
          kind: "task_thread",
          taskId,
          memberAgentIds: [],
        });
        await channelService.addMemberInTx(tx, ctx, thread.id, input.agentId);
      }

      const eventActor =
        actor.kind === "agent"
          ? { kind: "agent" as const, id: actor.agentId }
          : { kind: actor.kind === "approval_engine" ? ("system" as const) : actor.kind, id: null };
      if (from === "PLANNED") {
        await emitDomainEvent(tx, ctx, {
          type: "task.status.changed",
          actor: eventActor,
          taskId,
          payload: { from: "PLANNED", to: "ASSIGNED", byActor: eventActor, note: input.reason },
        });
      }
      await emitDomainEvent(tx, ctx, {
        type: "agent.task.assigned",
        actor: eventActor,
        taskId,
        agentId: input.agentId,
        payload: { taskId, agentId: input.agentId, byAgentId: byAgentId ?? undefined, reassignmentCount },
      });
      if (isReassignment) {
        await emitDomainEvent(tx, ctx, {
          type: "task.reassigned",
          actor: eventActor,
          taskId,
          payload: {
            fromAgentId: previousOwner ?? undefined,
            toAgentId: input.agentId,
            reassignmentCount,
            ...(forced && { note: "force_reassign override" }),
          },
        });
      }
      return updated!;
    });
  }

  // ---------- actor-class resolution (07 §5, server-side) ----------

  private async actorClasses(
    tx: Tx,
    ctx: CompanyContext,
    actor: TaskActorInput,
    task: TaskRow,
  ): Promise<TaskActorKind[]> {
    if (actor.kind === "founder") return ["founder"];
    if (actor.kind === "system") return ["system"];
    if (actor.kind === "approval_engine") return ["approval_engine"];
    const agentId = actor.agentId;
    const classes: TaskActorKind[] = [];
    if (task.ownerAgentId === agentId) classes.push("owner");
    if (task.creatorAgentId === agentId) classes.push("creator");

    // capability roles: explicit task assignment or position default_role
    const [assignmentRows, [positionRow]] = await Promise.all([
      tx
        .select({ role: taskAssignments.role })
        .from(taskAssignments)
        .where(
          and(
            eq(taskAssignments.companyId, ctx.companyId),
            eq(taskAssignments.taskId, task.id),
            eq(taskAssignments.agentId, agentId),
            isNull(taskAssignments.unassignedAt),
          ),
        ),
      tx
        .select({ defaultRole: positions.defaultRole })
        .from(agents)
        .innerJoin(positions, eq(agents.positionId, positions.id))
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId))),
    ]);
    const assignedRoles = new Set(assignmentRows.map((r) => r.role));
    const defaultRole = positionRow?.defaultRole ?? "member";
    if (assignedRoles.has("reviewer") || defaultRole === "reviewer" || defaultRole === "lead") {
      classes.push("reviewer");
    }
    if (assignedRoles.has("qa") || defaultRole === "reviewer") classes.push("qa");

    // Manager+ (07 §5): on the owner's upward reports_to chain, or an
    // executive; for unowned tasks any manager-capable role qualifies.
    let isManager = defaultRole === "executive";
    if (!isManager && task.ownerAgentId) {
      const chain = await tx.execute(sql`
        WITH RECURSIVE up AS (
          SELECT e.to_agent_id, 1 AS depth FROM org_edges e
          WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${task.ownerAgentId}
            AND e.kind = 'reports_to' AND e.ended_at IS NULL
          UNION ALL
          SELECT e.to_agent_id, up.depth + 1 FROM org_edges e
          JOIN up ON e.from_agent_id = up.to_agent_id
          WHERE e.company_id = ${ctx.companyId} AND e.kind = 'reports_to'
            AND e.ended_at IS NULL AND up.depth < 50
        )
        SELECT 1 FROM up WHERE to_agent_id = ${agentId} LIMIT 1
      `);
      isManager = chain.rows.length > 0;
    } else if (!isManager && !task.ownerAgentId) {
      isManager = defaultRole === "manager" || defaultRole === "lead";
    }
    if (isManager) classes.push("manager");
    return classes;
  }

  /**
   * A5 (07 §2) — container roll-up. Containers (`goal`, `initiative`) hold no
   * work of their own; their status is derived from their children. Runs
   * inside the caller's transaction so the child's terminal state and the
   * container's follow-on state commit together (INV-11), and recurses so a
   * finished epic can close its initiative and that initiative its goal.
   *
   * Deliberately narrow:
   * - only containers roll up; an `epic`/`task` keeps its own lifecycle
   * - a container with NO children never auto-closes (nothing was delivered)
   * - CANCELLED children do not block the roll-up (the work was withdrawn),
   *   but a FAILED child fails the container — 07 §2's "critical-path child
   *   FAILED without replacement". Replacement = a sibling of the same kind
   *   that reached DONE, which is exactly what a retry produces.
   */
  private async rollUpContainer(tx: Tx, ctx: CompanyContext, parentId: string): Promise<void> {
    const [parent] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, parentId)))
      .for("update");
    if (!parent) return;
    if (parent.kind !== "goal" && parent.kind !== "initiative") return;
    if (TERMINAL.has(parent.status)) return; // already closed

    const children = await tx
      .select({ id: tasks.id, status: tasks.status, kind: tasks.kind })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.parentId, parentId)));
    if (children.length === 0) return;
    if (children.some((c) => !TERMINAL.has(c.status))) return; // still working

    const failed = children.filter((c) => c.status === "FAILED");
    const succeeded = children.filter((c) => c.status === "DONE");
    // a FAILED child is tolerated when a sibling of the same kind delivered
    const replaced = failed.every((f) => succeeded.some((s) => s.kind === f.kind));
    const target = failed.length > 0 && !replaced ? "FAILED" : "DONE";
    if (target === "DONE" && succeeded.length === 0) return; // only cancellations

    await this.transitionInTx(tx, ctx, parentId, target, { kind: "system" }, {
      derived: true,
      note: `container roll-up: ${succeeded.length}/${children.length} child task(s) delivered${
        failed.length > 0 ? `, ${failed.length} failed` : ""
      }`,
    });
    // …and a closed initiative may in turn close its goal
    if (parent.parentId) await this.rollUpContainer(tx, ctx, parent.parentId);
  }

  /** DONE ⇒ dependents' edges resolve + task.dependency.resolved (07 §3). */
  private async resolveDependents(tx: Tx, ctx: CompanyContext, taskId: string): Promise<void> {
    const resolved = await tx
      .update(taskDependencies)
      .set({ resolvedAt: sql`now()` })
      .where(
        and(
          eq(taskDependencies.companyId, ctx.companyId),
          eq(taskDependencies.dependsOnTaskId, taskId),
          isNull(taskDependencies.resolvedAt),
        ),
      )
      .returning();
    for (const edge of resolved) {
      await emitDomainEvent(tx, ctx, {
        type: "task.dependency.resolved",
        actor: { kind: "system", id: null },
        taskId: edge.taskId,
        payload: { dependsOnTaskId: taskId, result: "done" },
      });
    }
  }
}

export { formatTaskNumber };
