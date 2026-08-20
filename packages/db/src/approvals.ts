// Approval Engine core (19 §1–8, §12; _DECISIONS §15; T35). Lives in
// @acos/db for the same reason as the task engine: ONE implementation shared
// by the server's Approval module (REST verdicts, sweeps) and the worker's
// escalate activity — brief validation, chain rules and audit cannot be
// bypassed from either side. Verdict SIGNAL delivery into waiting Temporal
// workflows is the caller's post-commit concern (19 §7).
//
// Recorded deviations, bounded by the canonical schema (20 §12.5):
// - `request_md` is a text column — the validated brief is stored as JSON.
// - there is no `expires_at` column: expiry is DERIVED deterministically as
//   min(created_at + urgency window, business deadline) via @acos/domain, so
//   the engine, the sweep and the waiting workflow always agree.
// - approval kinds are the canonical 8 of 20 §12.5, not doc 19 §2's aliases.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  approvalExpiresAt,
  approvalMachine,
  APPROVAL_REMINDER_FRACTIONS,
  approvalReminderAt,
  isApprovalKind,
  isTaskRisk,
  URGENCIES,
  type ApprovalStatus,
  type Urgency,
} from "@acos/domain";
import { ApprovalBriefSchema, parseEventPayload, type ApprovalBrief } from "@acos/events";
import { nextSequenceValue } from "./sequences.js";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import { companyContext, type CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import type { Db } from "./index.js";
import { TaskStateService } from "./task-engine.js";
import { agents, approvals, auditLog, tasks } from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export type ApprovalRow = typeof approvals.$inferSelect;

/** Append-only executive chain entry (19 §5 actions on the 20 §10 shape). */
export interface ChainEntry {
  agentId: string | null;
  verdict: "requested" | "endorsed" | "objected" | "revised";
  note: string | null;
  at: string;
}

export class ApprovalError extends Error {
  constructor(
    public readonly code:
      | "APPROVAL_NOT_FOUND"
      | "APPROVAL_BRIEF_INVALID"
      | "APPROVAL_KIND_INVALID"
      | "APPROVAL_ALREADY_DECIDED"
      | "APPROVAL_INVALID_STATE"
      | "APPROVAL_ENDORSER_NOT_IN_CHAIN",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export interface CreateApprovalInput {
  /** Deterministic id from the caller (e.g. uuidv5 of the step) = idempotency. */
  id?: string | undefined;
  kind: string;
  brief: unknown;
  requestedByAgentId: string;
  risk: string;
  urgency?: string | undefined;
  costCents?: number | undefined;
  deadline?: Date | null | undefined;
  taskId?: string | undefined;
  workflowId?: string | undefined;
}

export interface ApprovalVerdictResult {
  row: ApprovalRow;
  /** Verdict the waiting workflow must receive (19 §7); expiry maps to "expired". */
  signal: { workflowId: string; verdict: string; note?: string | undefined } | null;
}

const OPEN_STATUSES: ApprovalStatus[] = ["pending", "needs_review"];

export class ApprovalsService {
  private readonly taskState: TaskStateService;

  constructor(private readonly db: GuardedDb) {
    this.taskState = new TaskStateService(db);
  }

  /** Derived engine expiry (19 §6) — deterministic from the row itself. */
  expiresAt(row: Pick<ApprovalRow, "createdAt" | "urgency" | "deadline">): Date {
    return approvalExpiresAt(row.createdAt, row.urgency as Urgency, row.deadline);
  }

  /**
   * Create a pending approval from a validated structured brief. Idempotent
   * on a caller-supplied deterministic id: the replayed activity gets the
   * existing row back and no duplicate events fire.
   */
  async create(
    ctx: CompanyContext,
    input: CreateApprovalInput,
  ): Promise<{ row: ApprovalRow; created: boolean }> {
    if (!isApprovalKind(input.kind)) {
      throw new ApprovalError("APPROVAL_KIND_INVALID", `unknown approval kind "${input.kind}"`);
    }
    const parsed = ApprovalBriefSchema.safeParse(input.brief);
    if (!parsed.success) {
      throw new ApprovalError(
        "APPROVAL_BRIEF_INVALID",
        `brief violates the 11-field contract (19 §3): ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const brief: ApprovalBrief = parsed.data;
    if (!isTaskRisk(input.risk)) {
      throw new ApprovalError("APPROVAL_BRIEF_INVALID", `unknown risk "${input.risk}"`);
    }
    const urgency = input.urgency ?? "normal";
    if (!(URGENCIES as readonly string[]).includes(urgency)) {
      throw new ApprovalError("APPROVAL_BRIEF_INVALID", `unknown urgency "${urgency}"`);
    }

    return this.db.transaction((tx) => this.insertApproval(tx, ctx, input, brief, urgency));
  }

  /**
   * T57: aynı gövde, ÇAĞIRANIN transaction'ında. Tool Gateway onay kaydını
   * `tool_invocations` satırıyla AYNI transaction'da açmak zorunda — ayrı
   * transaction, "onay bekleyen ama kaydı olmayan çağrı" penceresini geri
   * açardı ki T57'nin kilidi tam olarak oydu.
   */
  async createInTx(
    tx: Tx,
    ctx: CompanyContext,
    input: CreateApprovalInput,
  ): Promise<{ row: ApprovalRow; created: boolean }> {
    const parsed = ApprovalBriefSchema.safeParse(input.brief);
    if (!parsed.success) {
      throw new ApprovalError(
        "APPROVAL_BRIEF_INVALID",
        `brief violates the 11-field contract (19 §3): ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    if (!isApprovalKind(input.kind)) {
      throw new ApprovalError("APPROVAL_KIND_INVALID", `unknown approval kind "${input.kind}"`);
    }
    if (!isTaskRisk(input.risk)) {
      throw new ApprovalError("APPROVAL_BRIEF_INVALID", `unknown risk "${input.risk}"`);
    }
    return this.insertApproval(tx, ctx, input, parsed.data, input.urgency ?? "normal");
  }

  private async insertApproval(
    tx: Tx,
    ctx: CompanyContext,
    input: CreateApprovalInput,
    brief: ApprovalBrief,
    urgency: string,
  ): Promise<{ row: ApprovalRow; created: boolean }> {
    {
      if (input.id) {
        const [existing] = await tx
          .select()
          .from(approvals)
          .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, input.id)));
        if (existing) return { row: existing, created: false };
      }
      const number = await nextSequenceValue(tx, ctx, "approval_number");
      const now = new Date();
      const chain: ChainEntry[] = [
        {
          agentId: input.requestedByAgentId,
          verdict: "requested",
          note: null,
          at: now.toISOString(),
        },
      ];
      const [row] = await tx
        .insert(approvals)
        .values({
          ...(input.id && { id: input.id }),
          companyId: ctx.companyId,
          number,
          kind: input.kind,
          title: brief.title,
          requestMd: JSON.stringify(brief),
          requestedByAgentId: input.requestedByAgentId,
          chain,
          status: "pending",
          risk: input.risk,
          costCents: input.costCents ?? brief.cost.amount_cents,
          urgency,
          deadline: input.deadline ?? (brief.deadline ? new Date(brief.deadline) : null),
          taskId: input.taskId ?? null,
          workflowId: input.workflowId ?? null,
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "approval.requested",
        actor: { kind: "agent", id: input.requestedByAgentId },
        ...(input.taskId && { taskId: input.taskId }),
        agentId: input.requestedByAgentId,
        payload: {
          approvalId: row!.id,
          kind: input.kind,
          title: brief.title,
          brief,
          risk: input.risk,
          costCents: row!.costCents ?? undefined,
          urgency,
          deadline: row!.deadline?.toISOString(),
        },
      });
      await tx.insert(auditLog).values({
        companyId: ctx.companyId,
        actorKind: "agent",
        actorId: input.requestedByAgentId,
        action: "approval.requested",
        targetKind: "approval",
        targetId: row!.id,
        meta: { kind: input.kind, urgency },
      });
      return { row: row!, created: true };
    }
  }

  /** Inbox query (19 §11, 21 §3.10): urgency desc, then oldest first. */
  async list(
    ctx: CompanyContext,
    filters: {
      status?: string | undefined;
      kind?: string | undefined;
      urgency?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<Array<ApprovalRow & { requesterName: string | null }>> {
    const conditions = [eq(approvals.companyId, ctx.companyId)];
    if (filters.status) conditions.push(eq(approvals.status, filters.status));
    if (filters.kind) conditions.push(eq(approvals.kind, filters.kind));
    if (filters.urgency) conditions.push(eq(approvals.urgency, filters.urgency));
    const rows = await this.db
      .select({ approval: approvals, requesterName: agents.name })
      .from(approvals)
      .leftJoin(
        agents,
        and(eq(agents.companyId, ctx.companyId), eq(agents.id, approvals.requestedByAgentId)),
      )
      .where(and(...conditions))
      .orderBy(
        sql`CASE ${approvals.urgency} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
        approvals.createdAt,
      )
      .limit(Math.min(filters.limit ?? 50, 200))
      .offset(filters.offset ?? 0);
    return rows.map((r) => ({ ...r.approval, requesterName: r.requesterName }));
  }

  async get(
    ctx: CompanyContext,
    approvalId: string,
  ): Promise<
    ApprovalRow & {
      requesterName: string | null;
      task: { id: string; number: number; title: string; status: string } | null;
    }
  > {
    const [found] = await this.db
      .select({ approval: approvals, requesterName: agents.name })
      .from(approvals)
      .leftJoin(
        agents,
        and(eq(agents.companyId, ctx.companyId), eq(agents.id, approvals.requestedByAgentId)),
      )
      .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)));
    if (!found) throw new ApprovalError("APPROVAL_NOT_FOUND", "approval not found");
    let task = null;
    if (found.approval.taskId) {
      const [taskRow] = await this.db
        .select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, found.approval.taskId)));
      task = taskRow ?? null;
    }
    return { ...found.approval, requesterName: found.requesterName, task };
  }

  /**
   * Founder verdict (19 §4, §12.1): row-locked UPDATE from `pending` only —
   * a concurrent second verdict gets APPROVAL_ALREADY_DECIDED. approved and
   * rejected also settle a task parked in APPROVAL via the single status
   * writer with the `approval_engine` actor class (07 §5).
   */
  async verdict(
    ctx: CompanyContext,
    approvalId: string,
    verdict: "approved" | "rejected" | "needs_review",
    by: { userId: string; note?: string | undefined },
  ): Promise<ApprovalVerdictResult> {
    if (verdict !== "approved" && !by.note?.trim()) {
      throw new ApprovalError(
        "APPROVAL_INVALID_STATE",
        `a decision note is required for ${verdict} (19 §11)`,
      );
    }
    return this.db.transaction(async (tx) => {
      const row = await this.lockOpenRow(tx, ctx, approvalId, ["pending"]);
      approvalMachine.assertTransition(row.status as ApprovalStatus, verdict);
      const decided = verdict !== "needs_review";
      const [updated] = await tx
        .update(approvals)
        .set({
          status: verdict,
          decisionNote: by.note ?? null,
          ...(decided && { decidedByUserId: by.userId, decidedAt: sql`now()` }),
        })
        .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)))
        .returning();

      if (verdict === "needs_review") {
        // route back to the top endorsing executive, or the requester (19 §4)
        const chain = (row.chain as ChainEntry[]) ?? [];
        const topEndorser = [...chain].reverse().find((e) => e.verdict === "endorsed");
        await emitDomainEvent(tx, ctx, {
          type: "approval.needs_review",
          actor: { kind: "founder", id: null },
          ...(row.taskId && { taskId: row.taskId }),
          payload: {
            approvalId,
            executiveAgentId: topEndorser?.agentId ?? row.requestedByAgentId,
          },
        });
      } else {
        await emitDomainEvent(tx, ctx, {
          type: verdict === "approved" ? "approval.approved" : "approval.rejected",
          actor: { kind: "founder", id: null },
          ...(row.taskId && { taskId: row.taskId }),
          payload: { approvalId, decisionNote: by.note, decidedBy: by.userId },
        });
      }
      await tx.insert(auditLog).values({
        companyId: ctx.companyId,
        actorKind: "user",
        actorId: by.userId,
        action: `approval.${verdict}`,
        targetKind: "approval",
        targetId: approvalId,
        meta: { note: by.note ?? null },
      });
      if (decided) await this.settleParkedTask(tx, ctx, row, verdict === "approved");
      return {
        row: updated!,
        signal: row.workflowId
          ? { workflowId: row.workflowId, verdict, note: by.note }
          : null,
      };
    });
  }

  /**
   * Engine expiry (19 §6): safe default — consumers treat `expired` exactly
   * like `rejected`. Idempotent against verdict/sweep/workflow-timer races:
   * a row no longer open is returned untouched (whoever committed first won).
   */
  async expire(
    ctx: CompanyContext,
    approvalId: string,
    note = "expired without a verdict",
  ): Promise<ApprovalVerdictResult> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)))
        .for("update");
      if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND", "approval not found");
      if (!OPEN_STATUSES.includes(row.status as ApprovalStatus)) {
        return { row, signal: null }; // already decided — the race is settled
      }
      const [updated] = await tx
        .update(approvals)
        .set({ status: "expired", decisionNote: note })
        .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "approval.expired",
        actor: { kind: "system", id: null },
        ...(row.taskId && { taskId: row.taskId }),
        payload: { approvalId },
      });
      await tx.insert(auditLog).values({
        companyId: ctx.companyId,
        actorKind: "system",
        actorId: null,
        action: "approval.expired",
        targetKind: "approval",
        targetId: approvalId,
        meta: { note },
      });
      await this.settleParkedTask(tx, ctx, row, false);
      return {
        row: updated!,
        signal: row.workflowId
          ? { workflowId: row.workflowId, verdict: "expired", note }
          : null,
      };
    });
  }

  /**
   * Executive endorsement (19 §5, §12): the endorser MUST sit on the
   * requester's upward reports_to chain — forged endorsements are impossible
   * via any path (34 T7). `objected` never blocks; it surfaces dissent.
   */
  async endorse(
    ctx: CompanyContext,
    approvalId: string,
    input: { executiveAgentId: string; verdict?: "endorsed" | "objected"; note?: string },
  ): Promise<ApprovalRow> {
    const verdict = input.verdict ?? "endorsed";
    return this.db.transaction(async (tx) => {
      const row = await this.lockOpenRow(tx, ctx, approvalId, OPEN_STATUSES);
      const chainCheck = await tx.execute(sql`
        WITH RECURSIVE up AS (
          SELECT e.to_agent_id, 1 AS depth FROM org_edges e
          WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${row.requestedByAgentId}
            AND e.kind = 'reports_to' AND e.ended_at IS NULL
          UNION ALL
          SELECT e.to_agent_id, up.depth + 1 FROM org_edges e
          JOIN up ON e.from_agent_id = up.to_agent_id
          WHERE e.company_id = ${ctx.companyId} AND e.kind = 'reports_to'
            AND e.ended_at IS NULL AND up.depth < 50
        )
        SELECT 1 FROM up WHERE to_agent_id = ${input.executiveAgentId} LIMIT 1
      `);
      if (chainCheck.rows.length === 0) {
        throw new ApprovalError(
          "APPROVAL_ENDORSER_NOT_IN_CHAIN",
          "endorsing agent is not on the requester's reports_to chain (34 T7)",
        );
      }
      const entry: ChainEntry = {
        agentId: input.executiveAgentId,
        verdict,
        note: input.note ?? null,
        at: new Date().toISOString(),
      };
      const chain = [...((row.chain as ChainEntry[]) ?? []), entry];
      const [updated] = await tx
        .update(approvals)
        .set({ chain })
        .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "approval.endorsed",
        actor: { kind: "agent", id: input.executiveAgentId },
        ...(row.taskId && { taskId: row.taskId }),
        agentId: input.executiveAgentId,
        payload: { approvalId, executiveAgentId: input.executiveAgentId, verdict, note: input.note },
      });
      await tx.insert(auditLog).values({
        companyId: ctx.companyId,
        actorKind: "agent",
        actorId: input.executiveAgentId,
        action: "approval.endorsed",
        targetKind: "approval",
        targetId: approvalId,
        meta: { verdict, note: input.note ?? null },
      });
      return updated!;
    });
  }

  /**
   * needs_review → pending (19 §4): the executive (or requester) revises the
   * brief on the SAME approval id — history stays in chain + audit.
   */
  async resubmit(
    ctx: CompanyContext,
    approvalId: string,
    input: { byAgentId: string; brief: unknown; note?: string },
  ): Promise<ApprovalRow> {
    const parsed = ApprovalBriefSchema.safeParse(input.brief);
    if (!parsed.success) {
      throw new ApprovalError(
        "APPROVAL_BRIEF_INVALID",
        `revised brief violates the contract: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return this.db.transaction(async (tx) => {
      const row = await this.lockOpenRow(tx, ctx, approvalId, ["needs_review"]);
      approvalMachine.assertTransition("needs_review", "pending");
      const entry: ChainEntry = {
        agentId: input.byAgentId,
        verdict: "revised",
        note: input.note ?? null,
        at: new Date().toISOString(),
      };
      const chain = [...((row.chain as ChainEntry[]) ?? []), entry];
      const [updated] = await tx
        .update(approvals)
        .set({
          status: "pending",
          requestMd: JSON.stringify(parsed.data),
          title: parsed.data.title,
          chain,
          decisionNote: null,
        })
        .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "approval.requested",
        actor: { kind: "agent", id: input.byAgentId },
        ...(row.taskId && { taskId: row.taskId }),
        agentId: input.byAgentId,
        payload: {
          approvalId,
          kind: row.kind,
          title: parsed.data.title,
          brief: parsed.data,
          urgency: row.urgency,
        },
      });
      await tx.insert(auditLog).values({
        companyId: ctx.companyId,
        actorKind: "agent",
        actorId: input.byAgentId,
        action: "approval.resubmitted",
        targetKind: "approval",
        targetId: approvalId,
        meta: { note: input.note ?? null },
      });
      return updated!;
    });
  }

  /** verdict approved/rejected/expired settles a task parked in APPROVAL (07 §5). */
  private async settleParkedTask(
    tx: Tx,
    ctx: CompanyContext,
    row: ApprovalRow,
    approved: boolean,
  ): Promise<void> {
    if (!row.taskId) return;
    const [task] = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, row.taskId)));
    if (task?.status !== "APPROVAL") return;
    await this.taskState.transitionInTx(tx, ctx, row.taskId, approved ? "DONE" : "REJECTED", {
      kind: "approval_engine",
    }, { note: `approval ${row.id} ${approved ? "approved" : "closed without approval"}` });
  }

  private async lockOpenRow(
    tx: Tx,
    ctx: CompanyContext,
    approvalId: string,
    allowed: ApprovalStatus[],
  ): Promise<ApprovalRow> {
    const [row] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.id, approvalId)))
      .for("update");
    if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND", "approval not found");
    if (!allowed.includes(row.status as ApprovalStatus)) {
      throw new ApprovalError(
        "APPROVAL_ALREADY_DECIDED",
        `approval is ${row.status}, not ${allowed.join("/")}`,
      );
    }
    return row;
  }
}

export interface SweepResult {
  expired: Array<{ companyId: string; approvalId: string; workflowId: string | null }>;
  reminded: number;
}

/**
 * Expiry + reminder sweep (19 §6). Discovery scans open rows platform-wide
 * (unguarded, like the outbox relay); every mutation goes through the
 * guarded per-company service. Reminders dedupe on an audit_log row per
 * (approval, fraction). The caller signals `expired` into the workflows
 * listed in the result — post-commit, like message delivery.
 */
export async function sweepApprovals(
  db: Db,
  guardedDb: GuardedDb,
  opts: { now?: Date } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const service = new ApprovalsService(guardedDb);
  const open = await db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      createdAt: approvals.createdAt,
      urgency: approvals.urgency,
      deadline: approvals.deadline,
      workflowId: approvals.workflowId,
    })
    .from(approvals)
    .where(inArray(approvals.status, [...OPEN_STATUSES]));

  const result: SweepResult = { expired: [], reminded: 0 };
  for (const row of open) {
    const ctx = companyContext(row.companyId);
    const expiresAt = approvalExpiresAt(row.createdAt, row.urgency as Urgency, row.deadline);
    if (now.getTime() >= expiresAt.getTime()) {
      const { signal } = await service.expire(ctx, row.id);
      result.expired.push({
        companyId: row.companyId,
        approvalId: row.id,
        workflowId: signal?.workflowId ?? null,
      });
      continue;
    }
    for (const fraction of APPROVAL_REMINDER_FRACTIONS) {
      if (now.getTime() < approvalReminderAt(row.createdAt, expiresAt, fraction).getTime()) {
        continue;
      }
      const sent = await guardedDb
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, row.companyId),
            eq(auditLog.action, "approval.reminder.sent"),
            eq(auditLog.targetId, row.id),
            sql`${auditLog.meta}->>'fraction' = ${String(fraction)}`,
          ),
        )
        .limit(1);
      if (sent.length > 0) continue;
      await guardedDb.transaction(async (tx) => {
        await emitDomainEvent(tx, ctx, {
          type: "approval.reminder.sent",
          actor: { kind: "system", id: null },
          payload: { approvalId: row.id },
        });
        await tx.insert(auditLog).values({
          companyId: row.companyId,
          actorKind: "system",
          actorId: null,
          action: "approval.reminder.sent",
          targetKind: "approval",
          targetId: row.id,
          meta: { fraction: String(fraction) },
        });
      });
      result.reminded += 1;
    }
  }
  return result;
}
