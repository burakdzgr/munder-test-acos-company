// Delegation engine core — moved to @acos/db (T34): the worker's
// create_task/delegate_task action dispatch shares this implementation.
import { and, eq, isNull, sql } from "drizzle-orm";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { agents, budgets, orgEdges, positions, tasks } from "./schema/index.js";
import {
  TaskEngineError,
  TasksService,
  TaskStateService,
  type TaskRow,
} from "./task-engine.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

/** 07 §6.1 [WRITER-DECISION] defaults by position role (schema keeps the
 *  canonical 20 §4 columns — no wip_limit column, so limits are role-derived
 *  and configurable later via settings). */
export const WIP_LIMIT_BY_ROLE: Record<string, number> = {
  member: 2,
  reviewer: 2,
  lead: 3,
  manager: 5,
  executive: 8,
};
export const ASSIGNED_QUEUE_CAP = 5;
export const TEAM_WIP_MULTIPLIER = 2;
const ACTIVE_WIP_STATUSES = ["IN_PROGRESS", "REVIEW", "CHANGES_REQUESTED", "QA_FAILED", "REJECTED"];

export type DelegationResult =
  | { ok: true; task: TaskRow }
  | {
      ok: false;
      reason: "WIP_LIMIT" | "QUEUE_CAP" | "TEAM_WIP_LIMIT";
      candidates: Array<{ agentId: string; name: string; activeWip: number; assignedQueue: number }>;
    };

export class DelegationService {
  constructor(
    private readonly db: GuardedDb,
    private readonly tasksService: TasksService,
    private readonly taskState: TaskStateService,
  ) {}

  /** create_task action semantics: hierarchy + depth via TasksService; the
   *  effort weight (1–13 fibonacci) rides in context for the budget split. */
  async createChildTask(
    ctx: CompanyContext,
    managerAgentId: string,
    input: {
      /** stepId-derived deterministic id — idempotent replay (R1, T50) */
      id?: string | undefined;
      parentTaskId: string;
      kind: string;
      title: string;
      objective: string;
      priority?: string | undefined;
      estimatedEffort?: number | undefined;
      successCriteria?: string[] | undefined;
      risk?: string | undefined;
      orgUnitId?: string | undefined;
      projectId?: string | undefined;
      /** TASK 12: Scheduler atamayı bu yeteneklerle daraltır. */
      requiredCapabilities?: string[] | undefined;
    },
  ): Promise<TaskRow> {
    // Proje kalıtımı (2026-08-18, Founder gözlemi): model create_task'ta
    // projectId'yi çoğu zaman GEÇMİYOR ve çocuk görev projesiz doğuyordu —
    // kodlama ajanı "no project" duvarına çarpıp Founder'a eskale ediyordu.
    // Aksiyonda proje yoksa EBEVEYNİN projesi kalıtılır.
    let projectId = input.projectId;
    if (projectId === undefined) {
      const [parent] = await this.db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.parentTaskId)));
      projectId = parent?.projectId ?? undefined;
    }
    return this.tasksService.create(
      ctx,
      {
        id: input.id,
        parentId: input.parentTaskId,
        kind: input.kind,
        title: input.title,
        objective: input.objective,
        priority: input.priority,
        successCriteria: input.successCriteria,
        risk: input.risk,
        orgUnitId: input.orgUnitId,
        projectId,
        context: {
          estimatedEffort: input.estimatedEffort ?? 1,
          ...(input.requiredCapabilities?.length && {
            requiredCapabilities: input.requiredCapabilities,
          }),
        },
      },
      { kind: "agent", agentId: managerAgentId },
    );
  }

  /**
   * delegate_task action semantics (07 §6): reporting-line check → capacity
   * check (same tx as the assignment) → pro-rata budget materialization →
   * PLANNED→ASSIGNED via the single status writer. On the reassignment-limit
   * trip a P1 manager-intervention task is auto-created (07 §8).
   */
  async delegateTask(
    ctx: CompanyContext,
    managerAgentId: string,
    taskId: string,
    toAgentId: string,
    opts: { budgetOverrideCents?: number | undefined; force?: boolean | undefined } = {},
  ): Promise<DelegationResult> {
    const allowed = await this.mayDelegate(ctx, managerAgentId, toAgentId);
    if (!allowed.ok) {
      throw new TaskEngineError("TASK_TRANSITION_INVALID", allowed.reason);
    }

    const capacity = await this.capacityCheck(ctx, toAgentId);
    if (!capacity.ok) return capacity;

    // a freshly decomposed child is DRAFT — the delegating manager grooms it
    // through the single status writer (DRAFT→BACKLOG→PLANNED, both moves
    // creator/manager-permitted per 07 §5) so the assign lands on PLANNED
    // and the owner's workflow can start (T36)
    const [current] = await this.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    if (!current) throw new TaskEngineError("TASK_NOT_FOUND", "task not found");
    let status = current.status;
    if (status === "DRAFT") {
      await this.taskState.transition(ctx, taskId, "BACKLOG", { kind: "agent", agentId: managerAgentId }, { note: "delegation grooming" });
      status = "BACKLOG";
    }
    if (status === "BACKLOG") {
      await this.taskState.transition(ctx, taskId, "PLANNED", { kind: "agent", agentId: managerAgentId }, { note: "delegation grooming" });
    }

    try {
      const task = await this.taskState.assign(
        ctx,
        taskId,
        { agentId: toAgentId, reason: "delegated" },
        { kind: "agent", agentId: managerAgentId },
        { force: opts.force ?? false },
      );
      await this.allocateBudget(ctx, task, opts.budgetOverrideCents);
      const [fresh] = await this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
      return { ok: true, task: fresh! };
    } catch (err) {
      if (err instanceof TaskEngineError && err.code === "TASK_REASSIGNMENT_LIMIT") {
        await this.flagManagerIntervention(ctx, taskId, managerAgentId);
      }
      throw err;
    }
  }

  // ---------- context-sentinel resolution (T36) ----------

  /**
   * "The next task to hand off": the oldest open, unowned child of the
   * delegator's current task — each delegation consumes one child FIFO.
   */
  async resolveNextChildTask(ctx: CompanyContext, parentTaskId: string): Promise<TaskRow | null> {
    const [child] = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          eq(tasks.parentId, parentTaskId),
          isNull(tasks.ownerAgentId),
          sql`${tasks.status} IN ('DRAFT','BACKLOG','PLANNED')`,
        ),
      )
      .orderBy(tasks.number)
      .limit(1);
    return child ?? null;
  }

  /**
   * "An eligible report": an explicit `@Name` mention wins; otherwise the
   * Scheduler picks deterministically among ACTIVE direct reports (manages
   * edge) by composite score — skill match, workload, project familiarity,
   * historical success, memory affinity (REVISION TASK 1). The LLM only
   * describes the work; this scorer makes the choice. Tie-broken by
   * employee number, so scripted and live runs agree.
   */
  async resolveDelegateTarget(
    ctx: CompanyContext,
    managerAgentId: string,
    note: string,
    taskId?: string,
  ): Promise<string | null> {
    if (note.includes("@")) {
      const active = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.status, "active")));
      const named = active
        .filter((a) => note.includes(`@${a.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (named) return named.id;
    }
    const scored = await this.scoreDelegateCandidates(ctx, managerAgentId, taskId ?? null);
    // T29: the pool now contains the manager itself, whose WIP fills up like
    // anyone's. Handing back a candidate that cannot take the work would turn
    // a routine "this one is busy" into a failed delegation, so the top
    // permitted-AND-free candidate wins; if EVERYONE is full we still return
    // the top permitted one, so the caller gets the informative WIP_LIMIT
    // result (with candidates) instead of a bare "no eligible delegate".
    let firstPermitted: string | null = null;
    for (const row of scored) {
      const allowed = await this.mayDelegate(ctx, managerAgentId, row.agentId);
      if (!allowed.ok) continue;
      firstPermitted ??= row.agentId;
      const capacity = await this.capacityCheck(ctx, row.agentId);
      if (capacity.ok) return row.agentId;
    }
    return firstPermitted;
  }

  /**
   * Deterministic candidate scoring over the manager's ACTIVE direct reports
   * PLUS the manager itself (T29 — a manager may keep a slice of its own
   * decomposition). Self is scored by exactly the same formula, so it wins
   * only when it genuinely is the best fit; its own running parent task
   * already counts as load, which is the natural handicap that stops a lead
   * from hoarding. One SQL pass computes every component; weights live here in
   * code so the ranking is reproducible and auditable:
   *   +2.0 × skill match     (Σ level×confidence over skills named in the task text)
   *   +0.6 × familiarity     (DONE tasks in the same project, capped at 5)
   *   +2.0 × success rate    (DONE / closed, 0.5 prior when no history)
   *   +0.4 × memory affinity (active project-scope memories authored by the agent, capped at 5)
   *   −1.0 × workload        (open + queued tasks)
   */
  async scoreDelegateCandidates(
    ctx: CompanyContext,
    managerAgentId: string,
    taskId: string | null,
  ): Promise<Array<{ agentId: string; score: number }>> {
    const result = await this.db.execute(sql`
      WITH t AS (
        SELECT project_id,
          lower(coalesce(title,'') || ' ' || coalesce(kind,'') || ' ' || coalesce(objective,'')) AS text
        FROM tasks WHERE company_id = ${ctx.companyId} AND id = ${taskId}
      )
      SELECT a.id, a.employee_number,
        -- TASK 12: yetenek eşleşmesi — görev requiredCapabilities'i birim/
        -- pozisyon/skill adlarıyla ILIKE eşlenir (uymayan aday elenir)
        (SELECT coalesce(t2.context->'requiredCapabilities', '[]'::jsonb)
          FROM tasks t2 WHERE t2.company_id = ${ctx.companyId} AND t2.id = ${taskId}) AS req_caps,
        (SELECT count(*)::int FROM jsonb_array_elements_text(
            coalesce((SELECT t3.context->'requiredCapabilities' FROM tasks t3
              WHERE t3.company_id = ${ctx.companyId} AND t3.id = ${taskId}), '[]'::jsonb)
          ) AS rc(cap)
          WHERE EXISTS (
            SELECT 1 FROM agents a2
            LEFT JOIN positions p2 ON p2.id = a2.position_id
            LEFT JOIN org_units u2 ON u2.id = a2.org_unit_id
            WHERE a2.id = a.id AND (
              u2.slug ILIKE '%' || split_part(rc.cap, ' ', 1) || '%'
              OR p2.title ILIKE '%' || split_part(rc.cap, ' ', 1) || '%'
              OR EXISTS (SELECT 1 FROM agent_skills ask2 JOIN skills s2 ON s2.id = ask2.skill_id
                WHERE ask2.company_id = ${ctx.companyId} AND ask2.agent_id = a.id
                  AND s2.name ILIKE '%' || split_part(rc.cap, ' ', 1) || '%')
            )
          )) AS cap_hits,
        (SELECT count(*)::int FROM jsonb_array_elements_text(
            coalesce((SELECT t4.context->'requiredCapabilities' FROM tasks t4
              WHERE t4.company_id = ${ctx.companyId} AND t4.id = ${taskId}), '[]'::jsonb)
          )) AS cap_total,
        (SELECT count(*)::int FROM agent_model_bindings mb
          WHERE mb.company_id = ${ctx.companyId} AND mb.agent_id = a.id
            AND mb.purpose IN ('coding','default','primary')) AS coding_bindings,
        coalesce((SELECT sum(ask.level * ask.confidence)::float
          FROM agent_skills ask JOIN skills s ON s.id = ask.skill_id
          WHERE ask.company_id = ${ctx.companyId} AND ask.agent_id = a.id
            AND position(lower(s.name) in (SELECT text FROM t)) > 0), 0) AS skill,
        (SELECT count(*)::int FROM tasks w
          WHERE w.company_id = ${ctx.companyId} AND w.owner_agent_id = a.id
            AND w.status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED','ASSIGNED')) AS load,
        coalesce((SELECT count(*)::int FROM tasks p
          WHERE p.company_id = ${ctx.companyId} AND p.owner_agent_id = a.id
            AND p.project_id = (SELECT project_id FROM t) AND p.status = 'DONE'), 0) AS familiarity,
        (SELECT (count(*) FILTER (WHERE d.status = 'DONE'))::float / greatest(count(*), 1)
          FROM tasks d WHERE d.company_id = ${ctx.companyId} AND d.owner_agent_id = a.id
            AND d.status IN ('DONE','FAILED')) AS success,
        (SELECT count(*)::int FROM tasks h
          WHERE h.company_id = ${ctx.companyId} AND h.owner_agent_id = a.id
            AND h.status IN ('DONE','FAILED')) AS closed_count,
        coalesce((SELECT count(*)::int FROM memories m
          WHERE m.company_id = ${ctx.companyId} AND m.created_by_agent_id = a.id
            AND m.status = 'active' AND m.scope = 'project'
            AND m.scope_ref = (SELECT project_id FROM t)), 0) AS memory_hits
      FROM agents a
      WHERE a.company_id = ${ctx.companyId} AND a.status = 'active'
        AND (
          -- T29: the manager is a candidate for its OWN subtasks
          a.id = ${managerAgentId}
          OR EXISTS (
            SELECT 1 FROM org_edges e
            WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${managerAgentId}
              AND e.to_agent_id = a.id AND e.kind = 'manages' AND e.ended_at IS NULL
          )
        )
      ORDER BY a.employee_number ASC
    `);
    const rows = result.rows as Array<{
      id: string;
      employee_number: number;
      skill: number;
      load: number;
      familiarity: number;
      success: number | null;
      closed_count: number;
      memory_hits: number;
      cap_hits: number;
      cap_total: number;
      coding_bindings: number;
    }>;
    // TASK 12: gerekli yeteneklerin HİÇBİRİNE uymayan aday elenir — CEO
    // ilgisiz ajana zorla atayamaz (bypass koruması). Yetenek listesi boşsa
    // filtre uygulanmaz.
    // T29: a manager with NO active direct report is not its own delegate —
    // the empty pool must keep meaning "staff the team first" (the
    // NO_ELIGIBLE_DELEGATE hint that drives agent.hire), otherwise an
    // unstaffed CEO would quietly take every subtask itself and the company
    // would never be built. Self only competes once a team actually exists.
    const hasReports = rows.some((r) => r.id !== managerAgentId);
    const pool = hasReports ? rows : rows.filter((r) => r.id !== managerAgentId);
    const filtered = pool.filter(
      (r) => Number(r.cap_total) === 0 || Number(r.cap_hits) > 0,
    );
    return filtered
      .map((r) => ({
        agentId: r.id,
        employeeNumber: Number(r.employee_number),
        score:
          2.0 * Number(r.skill) +
          1.5 * Number(r.cap_hits) +
          0.6 * Math.min(Number(r.familiarity), 5) +
          2.0 * (Number(r.closed_count) > 0 ? Number(r.success ?? 0) : 0.5) +
          0.4 * Math.min(Number(r.memory_hits), 5) +
          0.3 * Math.min(Number(r.coding_bindings), 1) -
          1.0 * Number(r.load),
      }))
      .sort((a, b) => b.score - a.score || a.employeeNumber - b.employeeNumber)
      .map(({ agentId, score }) => ({ agentId, score }));
  }

  // ---------- reporting-line rule (07 §6) ----------

  private async mayDelegate(
    ctx: CompanyContext,
    managerAgentId: string,
    toAgentId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (managerAgentId === toAgentId) return { ok: true }; // self-assignment of own subtask
    const [managerRow] = await this.db
      .select({ defaultRole: positions.defaultRole })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, managerAgentId)));
    const [targetRow] = await this.db
      .select({ defaultRole: positions.defaultRole })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, toAgentId)));
    if (!managerRow || !targetRow) return { ok: false, reason: "agent not found" };

    if (managerRow.defaultRole === "executive") {
      // CEO-level (top of the forest) delegates to executives/managers/leads,
      // never to individual contributors (07 §6 policy rule)
      const [reportsUp] = await this.db
        .select({ id: orgEdges.id })
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, managerAgentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );
      const isTop = !reportsUp;
      if (isTop && !["executive", "manager", "lead"].includes(targetRow.defaultRole)) {
        return { ok: false, reason: "CEO-level agents delegate to executives, never to ICs" };
      }
      return { ok: true }; // executives hold cross_team_delegation
    }

    // transitive manages/leads closure downward from the manager
    const closure = await this.db.execute(sql`
      WITH RECURSIVE down AS (
        SELECT e.to_agent_id FROM org_edges e
        WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${managerAgentId}
          AND e.kind = 'manages' AND e.ended_at IS NULL
        UNION
        SELECT e.to_agent_id FROM org_edges e
        JOIN down ON e.from_agent_id = down.to_agent_id
        WHERE e.company_id = ${ctx.companyId} AND e.kind = 'manages' AND e.ended_at IS NULL
      )
      SELECT 1 FROM down WHERE to_agent_id = ${toAgentId} LIMIT 1
    `);
    if (closure.rows.length === 0) {
      return {
        ok: false,
        reason: "delegation follows reporting lines: target is outside the manages/leads closure",
      };
    }
    return { ok: true };
  }

  // ---------- capacity model (07 §6.1) ----------

  async capacityCheck(ctx: CompanyContext, toAgentId: string): Promise<DelegationResult> {
    const [target] = await this.db
      .select({
        id: agents.id,
        orgUnitId: agents.orgUnitId,
        defaultRole: positions.defaultRole,
      })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, toAgentId)));
    if (!target) throw new TaskEngineError("TASK_NOT_FOUND", "target agent not found");

    const load = async (agentId: string) => {
      const result = await this.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED'))::int AS active,
          count(*) FILTER (WHERE status = 'ASSIGNED')::int AS queued
        FROM tasks WHERE company_id = ${ctx.companyId} AND owner_agent_id = ${agentId}
      `);
      const row = result.rows[0] as { active: number; queued: number };
      return { active: Number(row.active), queued: Number(row.queued) };
    };

    const wipLimit = WIP_LIMIT_BY_ROLE[target.defaultRole] ?? 2;
    const targetLoad = await load(toAgentId);

    const candidates = async () => {
      const team = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, ctx.companyId),
            eq(agents.orgUnitId, target.orgUnitId),
            eq(agents.status, "active"),
          ),
        );
      const withLoad = [];
      for (const member of team) {
        if (member.id === toAgentId) continue;
        const memberLoad = await load(member.id);
        withLoad.push({
          agentId: member.id,
          name: member.name,
          activeWip: memberLoad.active,
          assignedQueue: memberLoad.queued,
        });
      }
      return withLoad.sort((a, b) => a.activeWip - b.activeWip);
    };

    if (targetLoad.active >= wipLimit) {
      return { ok: false, reason: "WIP_LIMIT", candidates: await candidates() };
    }
    if (targetLoad.queued >= ASSIGNED_QUEUE_CAP) {
      return { ok: false, reason: "QUEUE_CAP", candidates: await candidates() };
    }

    // team umbrella: 2 × active member count (07 §6.1)
    const teamResult = await this.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM agents
          WHERE company_id = ${ctx.companyId} AND org_unit_id = ${target.orgUnitId}
            AND status = 'active') AS members,
        (SELECT count(*)::int FROM tasks t
          JOIN agents a ON a.id = t.owner_agent_id AND a.company_id = t.company_id
          WHERE t.company_id = ${ctx.companyId} AND a.org_unit_id = ${target.orgUnitId}
            AND t.status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED')) AS team_wip
    `);
    const team = teamResult.rows[0] as { members: number; team_wip: number };
    if (Number(team.team_wip) >= TEAM_WIP_MULTIPLIER * Number(team.members)) {
      return { ok: false, reason: "TEAM_WIP_LIMIT", candidates: await candidates() };
    }
    return { ok: true, task: undefined as never };
  }

  // ---------- pro-rata budget inheritance (07 §9, 26 §4) ----------

  /**
   * floor(B × 0.8 × wi / Σw) with 20% reserved at the parent; later children
   * draw from the remaining 80%-pool. Materialized as a budgets row
   * (scope=task, period=total, mode=hard) so guards never walk the tree.
   */
  private async allocateBudget(
    ctx: CompanyContext,
    task: TaskRow,
    overrideCents?: number,
  ): Promise<void> {
    if (task.budgetCents !== null) return; // explicit budget — nothing to inherit
    if (!task.parentId) return;
    await this.db.transaction(async (tx) => {
      const [parent] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, task.parentId!)))
        .for("update");
      if (!parent || parent.budgetCents === null) return;

      const siblings = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.parentId, parent.id)));
      const allocated = siblings
        .filter((s) => s.id !== task.id && s.budgetCents !== null)
        .reduce((sum, s) => sum + (s.budgetCents ?? 0), 0);
      const pool = Math.floor(parent.budgetCents * 0.8) - allocated;
      if (pool <= 0) return;

      const effortOf = (t: TaskRow) =>
        Number((t.context as Record<string, unknown>).estimatedEffort ?? 1) || 1;
      // Σw runs over ALL open children (07 §9): the decompose batch shares
      // one denominator, so shares stay stable as siblings get delegated
      const openChildren = siblings.filter(
        (s) => !["DONE", "FAILED", "CANCELLED"].includes(s.status),
      );
      const totalWeight = openChildren.reduce((sum, s) => sum + effortOf(s), 0) || 1;
      const share = Math.min(
        pool,
        overrideCents ?? Math.floor((parent.budgetCents * 0.8 * effortOf(task)) / totalWeight),
      );
      if (share <= 0) return;

      await tx
        .update(tasks)
        .set({ budgetCents: share })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, task.id)));
      const [budgetRow] = await tx
        .insert(budgets)
        .values({
          companyId: ctx.companyId,
          scopeKind: "task",
          scopeRef: task.id,
          period: "total",
          limitCents: share,
          kind: "hard",
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "budget.created",
        actor: { kind: "system", id: null },
        taskId: task.id,
        payload: { budgetId: budgetRow!.id, scope: "task", limitCents: share },
      });
    });
  }

  // ---------- forced manager intervention (07 §8) ----------

  private async flagManagerIntervention(
    ctx: CompanyContext,
    taskId: string,
    managerAgentId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .for("update");
      if (!task) return;
      const context = task.context as Record<string, unknown>;
      if (context.needsManagerIntervention) return; // already flagged once
      await tx
        .update(tasks)
        .set({ context: { ...context, needsManagerIntervention: true } })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    });
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    if (!task || !(task.context as Record<string, unknown>).needsManagerIntervention) return;
    const existing = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          sql`${tasks.context}->>'interventionFor' = ${taskId}`,
        ),
      );
    if (existing.length > 0) return;
    await this.tasksService.create(
      ctx,
      {
        kind: "task",
        title: `Reassignment limit reached: TASK-${task.number}`,
        objective:
          "The task hit the 3-reassignment limit (hot-potato guard). Review, then move it with an explicit force_reassign override.",
        priority: "P1",
        context: { interventionFor: taskId, forManagerAgentId: managerAgentId },
      },
      { kind: "agent", agentId: managerAgentId },
    );
  }
}

export { ACTIVE_WIP_STATUSES };

/**
 * Scheduler queue pick (REVISION TASK 1): the next task WAITING ON ITS OWNER
 * for an agent, priority-first (P0 < P1 < P2 < P3 sorts lexically) then FIFO,
 * and dependency-aware — a task whose unresolved `blocks` predecessor is still
 * open is skipped so the agent never burns its single session on work that
 * cannot proceed yet.
 *
 * T14 (A7 canlı koşumu, 2026-08-20): kuyruk yalnız ASSIGNED'a bakıyordu, ama
 * 07 §5'te SAHİBİNİN sırası olan durum bir değil DÖRT tane: ASSIGNED ve
 * yeniden-giriş üçlüsü CHANGES_REQUESTED / QA_FAILED / REJECTED (üçünün de
 * tek çıkışı owner|manager ile IN_PROGRESS). İnceleme changes_requested
 * verdiğinde yeniden-giriş workflow'u BİR KEZ başlatılır; o koşum ölürse
 * (canlı kanıt: 'model llama3.2:3b not found') görev CHANGES_REQUESTED'ta
 * kalır ve HİÇBİR mekanizma onu geri almaz — drain görmez, sweep taramaz.
 * Şirket, sahibi boşta otururken kilitlenir. Kuyruk artık dördünü de görür.
 */
export async function pickNextQueuedTaskId(
  db: GuardedDb,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT t.id FROM tasks t
    WHERE t.company_id = ${companyId} AND t.owner_agent_id = ${agentId}
      AND t.status IN ('ASSIGNED','CHANGES_REQUESTED','QA_FAILED','REJECTED')
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dep ON dep.id = td.depends_on_task_id AND dep.company_id = td.company_id
        WHERE td.company_id = ${companyId} AND td.task_id = t.id
          AND td.resolved_at IS NULL AND dep.status NOT IN ('DONE','CANCELLED')
      )
    ORDER BY t.priority ASC, t.created_at ASC
    LIMIT 1
  `);
  const row = result.rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}
