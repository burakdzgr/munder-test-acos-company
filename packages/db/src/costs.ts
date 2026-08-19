// Cost management core — moved to @acos/db (T34) so worker activities and
// server modules share the one breach/breaker implementation.
import { and, eq, sql } from "drizzle-orm";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { agents, budgets, costEntries, positions, tasks } from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export type BudgetScope = "company" | "unit" | "project" | "task" | "agent";
export type BudgetPeriod = "daily" | "weekly" | "monthly" | "total";
export type BudgetRow = typeof budgets.$inferSelect;

export interface CostEntryInput {
  /** deterministic id (uuidv5 from stepId) makes the write idempotent (08 §11). */
  id?: string | undefined;
  kind: "llm" | "tool" | "compute" | "media" | "api";
  ref: string;
  amountCents: number;
  quantity?: number | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  projectId?: string | undefined;
  orgUnitId?: string | undefined;
}

export interface BudgetStatus {
  budget: BudgetRow;
  spentCents: number;
  remainingCents: number;
  breached: boolean;
}

/** Period window start (UTC; company-timezone refinement is a later pass). */
export function periodStart(period: string, now: Date): Date | null {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "daily") return start;
  if (period === "weekly") {
    const day = (start.getUTCDay() + 6) % 7; // Monday start
    start.setUTCDate(start.getUTCDate() - day);
    return start;
  }
  if (period === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return null; // total — never resets
}

export class CostService {
  constructor(
    private readonly db: GuardedDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- budgets ----------

  async setBudget(
    ctx: CompanyContext,
    input: {
      scopeKind: BudgetScope;
      scopeRef?: string | undefined;
      period: BudgetPeriod;
      limitCents: number;
      kind?: "hard" | "soft" | undefined;
    },
  ): Promise<BudgetRow> {
    return this.db.transaction(async (tx) => {
      const scopeRef = input.scopeRef ?? null;
      const [existing] = await tx
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.companyId, ctx.companyId),
            eq(budgets.scopeKind, input.scopeKind),
            scopeRef === null ? sql`${budgets.scopeRef} IS NULL` : eq(budgets.scopeRef, scopeRef),
            eq(budgets.period, input.period),
          ),
        );
      const values = { limitCents: input.limitCents, kind: input.kind ?? "soft", enabled: true };
      const [row] = existing
        ? await tx
            .update(budgets)
            .set({ ...values, updatedAt: sql`now()` })
            .where(and(eq(budgets.companyId, ctx.companyId), eq(budgets.id, existing.id)))
            .returning()
        : await tx
            .insert(budgets)
            .values({
              companyId: ctx.companyId,
              scopeKind: input.scopeKind,
              scopeRef,
              period: input.period,
              ...values,
            })
            .returning();
      await emitDomainEvent(tx, ctx, {
        type: existing ? "budget.updated" : "budget.created",
        actor: { kind: "founder", id: null },
        payload: { budgetId: row!.id, scope: input.scopeKind, limitCents: input.limitCents },
      });
      return row!;
    });
  }

  /** Raise/restore a budget: paused-by-breaker agents resume automatically. */
  async restoreBudget(ctx: CompanyContext, budgetId: string, limitCents?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [budget] = await tx
        .select()
        .from(budgets)
        .where(and(eq(budgets.companyId, ctx.companyId), eq(budgets.id, budgetId)));
      if (!budget) throw new Error("budget not found");
      if (limitCents !== undefined) {
        await tx
          .update(budgets)
          .set({ limitCents, updatedAt: sql`now()` })
          .where(and(eq(budgets.companyId, ctx.companyId), eq(budgets.id, budgetId)));
      }
      await emitDomainEvent(tx, ctx, {
        type: "budget.restored",
        actor: { kind: "founder", id: null },
        payload: { budgetId },
      });
      // resume everyone the breaker paused (26 §5 — resume is automatic)
      const paused = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, ctx.companyId),
            eq(agents.status, "paused"),
            sql`${agents.employment}->>'paused_by_breaker' = 'true'`,
          ),
        );
      for (const agent of paused) {
        const employment = { ...(agent.employment as Record<string, unknown>) };
        delete employment.paused_by_breaker;
        await tx
          .update(agents)
          .set({ status: "active", employment })
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agent.id)));
        await emitDomainEvent(tx, ctx, {
          type: "agent.resumed",
          actor: { kind: "system", id: null },
          agentId: agent.id,
          payload: { reason: "budget restored" },
        });
      }
    });
  }

  // ---------- consumption ----------

  private async spentCents(
    tx: Tx,
    ctx: CompanyContext,
    budget: Pick<BudgetRow, "scopeKind" | "scopeRef" | "period">,
  ): Promise<number> {
    const start = periodStart(budget.period, this.now());
    const scope =
      budget.scopeKind === "task"
        ? sql`task_id IN (
            WITH RECURSIVE sub AS (
              SELECT t.id FROM tasks t WHERE t.company_id = ${ctx.companyId} AND t.id = ${budget.scopeRef}
              UNION ALL
              SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
              WHERE t.company_id = ${ctx.companyId}
            ) SELECT id FROM sub)`
        : budget.scopeKind === "company"
          ? sql`TRUE`
          : budget.scopeKind === "unit"
            ? sql`org_unit_id = ${budget.scopeRef}`
            : budget.scopeKind === "project"
              ? sql`project_id = ${budget.scopeRef}`
              : sql`agent_id = ${budget.scopeRef}`;
    const result = await tx.execute(sql`
      SELECT coalesce(sum(amount_cents), 0)::bigint AS spent FROM cost_entries
      WHERE company_id = ${ctx.companyId} AND (${scope})
        ${start ? sql`AND occurred_at >= ${start}` : sql``}
    `);
    return Number((result.rows[0] as { spent: string | number }).spent);
  }

  async status(ctx: CompanyContext, scopeKind: BudgetScope, scopeRef?: string): Promise<BudgetStatus[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.companyId, ctx.companyId),
            eq(budgets.scopeKind, scopeKind),
            scopeRef === undefined
              ? sql`${budgets.scopeRef} IS NULL`
              : eq(budgets.scopeRef, scopeRef),
            eq(budgets.enabled, true),
          ),
        );
      const statuses: BudgetStatus[] = [];
      for (const budget of rows) {
        const spent = await this.spentCents(tx, ctx, budget);
        statuses.push({
          budget,
          spentCents: spent,
          remainingCents: budget.limitCents - spent,
          breached: spent >= budget.limitCents,
        });
      }
      return statuses;
    });
  }

  // ---------- the ledger write (breach detection on the crossing) ----------

  async recordCost(ctx: CompanyContext, entry: CostEntryInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.recordCostInTx(tx, ctx, entry);
    });
  }

  /**
   * The same ledger write, joined to a caller-owned transaction.
   *
   * A2 (2026-08-15 code review; 26 §2): "the cost entry is written in the SAME
   * Postgres transaction as the invocation record it prices — `llm_calls` +
   * its `cost_entries` row commit together; `tool_invocations` + cost entry
   * together [...] no async billing pipeline, no drift, no lost attribution
   * on crash". Callers that already own a transaction (the Tool Gateway's
   * settle step, the agent worker's `persistStep`) must use this variant;
   * `recordCost` stays for callers with nothing else to commit.
   *
   * INV-11 holds either way: the `cost.entry.recorded` / `budget.*` events are
   * appended through the outbox inside whichever transaction is running.
   */
  async recordCostInTx(tx: Tx, ctx: CompanyContext, entry: CostEntryInput): Promise<void> {
    if (entry.id) {
      const existing = await tx.execute(
        sql`SELECT 1 FROM cost_entries WHERE company_id = ${ctx.companyId} AND id = ${entry.id} LIMIT 1`,
      );
      if (existing.rows.length > 0) return; // replayed activity — exactly-once
    }
    await tx.insert(costEntries).values({
      ...(entry.id && { id: entry.id }),
      companyId: ctx.companyId,
      kind: entry.kind,
      ref: entry.ref,
      amountCents: entry.amountCents,
      quantity: entry.quantity?.toString() ?? null,
      agentId: entry.agentId ?? null,
      taskId: entry.taskId ?? null,
      projectId: entry.projectId ?? null,
      orgUnitId: entry.orgUnitId ?? null,
    });
    if (entry.taskId) {
      await tx
        .update(tasks)
        .set({ spentCents: sql`${tasks.spentCents} + ${entry.amountCents}` })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, entry.taskId)));
    }
    await emitDomainEvent(tx, ctx, {
      type: "cost.entry.recorded",
      actor: { kind: "system", id: null },
      ...(entry.agentId && { agentId: entry.agentId }),
      ...(entry.taskId && { taskId: entry.taskId }),
      ...(entry.projectId && { projectId: entry.projectId }),
      payload: { kind: entry.kind, amountCents: entry.amountCents, refs: { ref: entry.ref } },
    });

    // applicable budget scopes for this entry (26 §4 — a step must pass all)
    const applicable = await tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.companyId, ctx.companyId), eq(budgets.enabled, true)));
    for (const budget of applicable) {
      const matches =
        budget.scopeKind === "company" ||
        (budget.scopeKind === "unit" && budget.scopeRef === entry.orgUnitId) ||
        (budget.scopeKind === "project" && budget.scopeRef === entry.projectId) ||
        (budget.scopeKind === "agent" && budget.scopeRef === entry.agentId) ||
        (budget.scopeKind === "task" && budget.scopeRef !== null && entry.taskId !== undefined);
      if (!matches) continue;
      const spent = await this.spentCents(tx, ctx, budget);
      if (budget.scopeKind === "task" && spent === 0) continue; // entry outside this task's subtree
      const crossed = spent >= budget.limitCents && spent - entry.amountCents < budget.limitCents;
      if (!crossed) continue;
      if (budget.kind === "hard") {
        const pausedAgentIds =
          budget.scopeKind === "company" ? await this.tripBreaker(tx, ctx) : [];
        await emitDomainEvent(tx, ctx, {
          type: "budget.exceeded",
          actor: { kind: "system", id: null },
          payload: {
            scope: budget.scopeKind,
            budgetId: budget.id,
            spentCents: spent,
            limitCents: budget.limitCents,
            pausedAgentIds,
          },
        });
      } else {
        await emitDomainEvent(tx, ctx, {
          type: "budget.warning",
          actor: { kind: "system", id: null },
          payload: {
            scope: budget.scopeKind,
            budgetId: budget.id,
            spentCents: spent,
            limitCents: budget.limitCents,
          },
        });
      }
    }
  }

  /** 26 §5 circuit breaker: pause every non-critical active agent. */
  private async tripBreaker(tx: Tx, ctx: CompanyContext): Promise<string[]> {
    const activeAgents = await tx
      .select({
        id: agents.id,
        employment: agents.employment,
        seniorityTrack: positions.seniorityTrack,
      })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.status, "active")));

    const governanceOwners = await tx.execute(sql`
      SELECT DISTINCT owner_agent_id FROM tasks
      WHERE company_id = ${ctx.companyId} AND owner_agent_id IS NOT NULL
        AND status IN ('REVIEW','QA','APPROVAL')
    `);
    const protectedOwners = new Set(
      (governanceOwners.rows as Array<{ owner_agent_id: string }>).map((r) => r.owner_agent_id),
    );

    const paused: string[] = [];
    for (const agent of activeAgents) {
      const track = agent.seniorityTrack;
      const critical =
        track.includes("lead") ||
        track.includes("executive") ||
        protectedOwners.has(agent.id) ||
        (agent.employment as Record<string, unknown>).critical === true;
      if (critical) continue;
      const employment = {
        ...(agent.employment as Record<string, unknown>),
        paused_by_breaker: "true",
      };
      await tx
        .update(agents)
        .set({ status: "paused", employment })
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agent.id)));
      await emitDomainEvent(tx, ctx, {
        type: "agent.paused",
        actor: { kind: "system", id: null },
        agentId: agent.id,
        payload: { reason: "company budget circuit breaker" },
      });
      paused.push(agent.id);
    }
    return paused;
  }
}
