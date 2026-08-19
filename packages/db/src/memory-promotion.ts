// Promotion engine + contradiction resolution (T46; 12 §6, _DECISIONS §10).
// The invariant: a single failure never becomes company policy — consolidation
// cannot reach company scope structurally (12 §5.3, T44) and this engine is
// the ONLY path there, gated statistically (evidence thresholds) and socially
// (approver verdict). Promotion COPIES, never moves — originals stay active.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_PROMOTION_RULES,
  PROMOTION_EVIDENCE_WEIGHT_FLOOR,
  canCreateCompanyScopeMemory,
} from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import {
  agents,
  artifacts,
  events,
  memories,
  memoryEvidence,
  memoryPromotions,
  memoryRelations,
  memoryVersions,
  orgEdges,
  policies,
  positions,
  reviews,
  tasks,
} from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export class PromotionError extends Error {
  constructor(
    public readonly code:
      | "PROMOTION_NOT_FOUND"
      | "PROMOTION_ALREADY_DECIDED"
      | "PROMOTION_WRONG_APPROVER"
      | "PROMOTION_SCOPE_FORBIDDEN"
      | "CONTRADICTION_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "PromotionError";
  }
}

interface RuleJson {
  fromScope: "agent" | "project";
  toScope: "project" | "company";
  memoryType: string | null;
  minEvidence: number;
  minDistinctTasks: number | null;
  minDistinctProjects: number | null;
  minConfidence: number;
  approver: "lead" | "manager" | "founder";
}

interface EvidenceStats {
  count: number;
  distinctTaskIds: Set<string>;
  distinctProjectIds: Set<string>;
  /** most frequent project among the evidence — the agent→project target */
  dominantProjectId: string | null;
}

/**
 * Seed the three binding default rules (12 §6.2) — tenant-editable `policies`
 * rows, idempotent on the (company, name) unique index. Runs inside company
 * creation and is safe to re-run on existing installs.
 */
export async function seedPromotionPolicies(
  tx: Tx | GuardedDb,
  ctx: CompanyContext,
): Promise<number> {
  let created = 0;
  for (const rule of DEFAULT_PROMOTION_RULES) {
    const inserted = await tx
      .insert(policies)
      .values({
        companyId: ctx.companyId,
        name: rule.name,
        kind: "memory_promotion",
        effect: "require_approval", // proposals always await the approver
        priority: 100,
        rule: {
          fromScope: rule.fromScope,
          toScope: rule.toScope,
          memoryType: rule.memoryType,
          minEvidence: rule.minEvidence,
          minDistinctTasks: rule.minDistinctTasks,
          minDistinctProjects: rule.minDistinctProjects,
          minConfidence: rule.minConfidence,
          approver: rule.approver,
        },
      })
      .onConflictDoNothing()
      .returning({ id: policies.id });
    created += inserted.length;
  }
  return created;
}

export class MemoryPromotionService {
  constructor(private readonly db: GuardedDb) {}

  /**
   * Evidence statistics for one memory (12 §6.2): rows with weight ≥ 0.6;
   * distinct tasks/projects resolved through the refs (event → events row,
   * review → reviews→tasks, artifact → artifacts) — the canonical
   * memory_evidence schema carries no denormalized task/project columns
   * (recorded in T44), so counting joins here.
   */
  private async evidenceStats(ctx: CompanyContext, memoryId: string): Promise<EvidenceStats> {
    const rows = await this.db
      .select({ kind: memoryEvidence.kind, ref: memoryEvidence.ref, weight: memoryEvidence.weight })
      .from(memoryEvidence)
      .where(
        and(eq(memoryEvidence.companyId, ctx.companyId), eq(memoryEvidence.memoryId, memoryId)),
      );
    const counted = rows.filter((r) => r.weight >= PROMOTION_EVIDENCE_WEIGHT_FLOOR);
    const stats: EvidenceStats = {
      count: counted.length,
      distinctTaskIds: new Set(),
      distinctProjectIds: new Set(),
      dominantProjectId: null,
    };
    const projectVotes = new Map<string, number>();
    const eventRefs = counted.filter((r) => r.kind === "event").map((r) => r.ref);
    if (eventRefs.length) {
      const eventRows = await this.db
        .select({ id: events.id, taskId: events.taskId, projectId: events.projectId })
        .from(events)
        .where(and(eq(events.companyId, ctx.companyId), inArray(events.id, eventRefs)));
      for (const row of eventRows) {
        if (row.taskId) stats.distinctTaskIds.add(row.taskId);
        let projectId = row.projectId;
        if (!projectId && row.taskId) {
          const [task] = await this.db
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, row.taskId)));
          projectId = task?.projectId ?? null;
        }
        if (projectId) {
          stats.distinctProjectIds.add(projectId);
          projectVotes.set(projectId, (projectVotes.get(projectId) ?? 0) + 1);
        }
      }
    }
    const reviewRefs = counted.filter((r) => r.kind === "review").map((r) => r.ref);
    if (reviewRefs.length) {
      const reviewRows = await this.db
        .select({ taskId: reviews.taskId, projectId: tasks.projectId })
        .from(reviews)
        .innerJoin(tasks, eq(reviews.taskId, tasks.id))
        .where(and(eq(reviews.companyId, ctx.companyId), inArray(reviews.id, reviewRefs)));
      for (const row of reviewRows) {
        stats.distinctTaskIds.add(row.taskId);
        if (row.projectId) {
          stats.distinctProjectIds.add(row.projectId);
          projectVotes.set(row.projectId, (projectVotes.get(row.projectId) ?? 0) + 1);
        }
      }
    }
    const artifactRefs = counted.filter((r) => r.kind === "artifact").map((r) => r.ref);
    if (artifactRefs.length) {
      const artifactRows = await this.db
        .select({ taskId: artifacts.taskId, projectId: artifacts.projectId })
        .from(artifacts)
        .where(and(eq(artifacts.companyId, ctx.companyId), inArray(artifacts.id, artifactRefs)));
      for (const row of artifactRows) {
        if (row.taskId) stats.distinctTaskIds.add(row.taskId);
        if (row.projectId) {
          stats.distinctProjectIds.add(row.projectId);
          projectVotes.set(row.projectId, (projectVotes.get(row.projectId) ?? 0) + 1);
        }
      }
    }
    for (const [projectId, votes] of projectVotes) {
      if (
        stats.dominantProjectId === null ||
        votes > (projectVotes.get(stats.dominantProjectId) ?? 0)
      ) {
        stats.dominantProjectId = projectId;
      }
    }
    return stats;
  }

  /** rule.approver → an agent id: lead walks the scope agent's reports_to
   *  chain; manager falls back to any manager/executive; founder → null
   *  (the Founder decides from the Observatory). */
  private async resolveApprover(
    ctx: CompanyContext,
    rule: RuleJson,
    sourceScopeRef: string | null,
  ): Promise<string | null> {
    if (rule.approver === "founder") return null;
    if (rule.approver === "lead" && sourceScopeRef) {
      let current = sourceScopeRef;
      for (let hop = 0; hop < 10; hop += 1) {
        const [edge] = await this.db
          .select({ toAgentId: orgEdges.toAgentId })
          .from(orgEdges)
          .where(
            and(
              eq(orgEdges.companyId, ctx.companyId),
              eq(orgEdges.fromAgentId, current),
              eq(orgEdges.kind, "reports_to"),
            ),
          )
          .limit(1);
        if (!edge?.toAgentId) break;
        const [manager] = await this.db
          .select({ id: agents.id, role: positions.defaultRole })
          .from(agents)
          .innerJoin(positions, eq(agents.positionId, positions.id))
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, edge.toAgentId)));
        if (!manager) break;
        if (["lead", "manager", "executive"].includes(manager.role)) return manager.id;
        current = manager.id;
      }
    }
    const roles = rule.approver === "lead" ? ["lead", "manager", "executive"] : ["manager", "executive"];
    const [fallback] = await this.db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(
        and(
          eq(agents.companyId, ctx.companyId),
          eq(agents.status, "active"),
          inArray(positions.defaultRole, roles),
        ),
      )
      .orderBy(agents.employeeNumber)
      .limit(1);
    return fallback?.id ?? null;
  }

  /**
   * The promotion evaluation (12 §6.2): nightly per company AND immediately
   * after any consolidation merge that adds evidence. For each enabled rule ×
   * qualifying active memory, create the higher-scope candidate copy +
   * derived_from edge + memory_promotions row, and emit
   * memory.promotion.proposed. Dedupe: one open/approved proposal per
   * (source, target scope). Content generalization is a verbatim copy in MVP
   * (the LLM rewrite activity joins the nightly live lane — recorded).
   */
  async evaluateCompany(ctx: CompanyContext): Promise<{ proposed: number }> {
    const ruleRows = await this.db
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.companyId, ctx.companyId),
          eq(policies.kind, "memory_promotion"),
          eq(policies.enabled, true),
        ),
      );
    let proposed = 0;
    for (const ruleRow of ruleRows) {
      const rule = ruleRow.rule as unknown as RuleJson;
      const candidates = await this.db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.companyId, ctx.companyId),
            eq(memories.scope, rule.fromScope),
            eq(memories.status, "active"),
            sql`${memories.confidence} >= ${rule.minConfidence}`,
            ...(rule.memoryType ? [eq(memories.type, rule.memoryType)] : []),
          ),
        )
        .limit(200);
      for (const source of candidates) {
        const [existing] = await this.db
          .select({ id: memoryPromotions.id })
          .from(memoryPromotions)
          .where(
            and(
              eq(memoryPromotions.companyId, ctx.companyId),
              eq(memoryPromotions.sourceMemoryId, source.id),
              eq(memoryPromotions.targetScope, rule.toScope),
              inArray(memoryPromotions.status, ["proposed", "approved"]),
            ),
          )
          .limit(1);
        if (existing) continue;

        const stats = await this.evidenceStats(ctx, source.id);
        if (stats.count < rule.minEvidence) continue;
        if (rule.minDistinctTasks !== null && stats.distinctTaskIds.size < rule.minDistinctTasks) {
          continue; // a single incident never generalizes (12 §6.1)
        }
        if (
          rule.minDistinctProjects !== null &&
          stats.distinctProjectIds.size < rule.minDistinctProjects
        ) {
          continue;
        }
        const targetRef = rule.toScope === "project" ? stats.dominantProjectId : null;
        if (rule.toScope === "project" && !targetRef) continue; // nowhere to anchor
        if (rule.toScope === "company" && !canCreateCompanyScopeMemory("promotion")) continue;

        const approverAgentId = await this.resolveApprover(ctx, rule, source.scopeRef);
        await this.db.transaction(async (tx) => {
          const [copy] = await tx
            .insert(memories)
            .values({
              companyId: ctx.companyId,
              scope: rule.toScope,
              scopeRef: targetRef,
              type: source.type,
              title: source.title,
              content: source.content,
              summary: source.summary,
              entities: source.entities as Record<string, unknown>,
              importance: source.importance,
              confidence: source.confidence,
              status: "candidate", // active only after the approver's verdict
              sourceEventId: source.sourceEventId,
              createdByAgentId: null,
              ...(source.embedding && {
                embedding: source.embedding,
                embeddingDim: source.embeddingDim,
              }),
              embeddingModel: source.embeddingModel,
            })
            .returning();
          await tx.insert(memoryVersions).values({
            companyId: ctx.companyId,
            memoryId: copy!.id,
            version: 1,
            title: copy!.title,
            content: copy!.content,
            summary: copy!.summary,
            importance: copy!.importance,
            confidence: copy!.confidence,
            status: "candidate",
            changedBy: "system",
            changeReason: "promotion_proposal",
          });
          const [relation] = await tx
            .insert(memoryRelations)
            .values({
              companyId: ctx.companyId,
              fromMemoryId: copy!.id,
              toMemoryId: source.id,
              kind: "derived_from",
              createdBy: "system",
            })
            .returning({ id: memoryRelations.id });
          const [promotion] = await tx
            .insert(memoryPromotions)
            .values({
              companyId: ctx.companyId,
              sourceMemoryId: source.id,
              targetScope: rule.toScope,
              targetRef,
              targetMemoryId: copy!.id,
              evidenceCount: stats.count,
              distinctTaskCount: stats.distinctTaskIds.size,
              status: "proposed",
              approverAgentId,
              rulePolicyId: ruleRow.id,
            })
            .returning({ id: memoryPromotions.id });
          await emitDomainEvent(tx, ctx, {
            type: "memory.promotion.proposed",
            actor: { kind: "system", id: null },
            payload: {
              promotionId: promotion!.id,
              sourceMemoryId: source.id,
              targetScope: rule.toScope,
            },
          });
          await emitDomainEvent(tx, ctx, {
            type: "memory.relation.created",
            actor: { kind: "system", id: null },
            payload: {
              relationId: relation!.id,
              fromMemoryId: copy!.id,
              toMemoryId: source.id,
              kind: "derived_from",
            },
          });
        });
        proposed += 1;
      }
    }
    return { proposed };
  }

  /**
   * The approver's verdict (12 §6.2): approve → the copy goes active at the
   * new scope + memory.promoted; reject → the copy is rejected with the note
   * in a version row. Originals remain active either way.
   */
  async decide(
    ctx: CompanyContext,
    promotionId: string,
    input: {
      verdict: "approved" | "rejected";
      approverAgentId: string | null; // null = the Founder decides
      note?: string | undefined;
    },
  ): Promise<{ targetMemoryId: string; status: string }> {
    return this.db.transaction(async (tx) => {
      const [promotion] = await tx
        .select()
        .from(memoryPromotions)
        .where(
          and(
            eq(memoryPromotions.companyId, ctx.companyId),
            eq(memoryPromotions.id, promotionId),
          ),
        )
        .for("update");
      if (!promotion) throw new PromotionError("PROMOTION_NOT_FOUND", "promotion not found");
      if (promotion.status !== "proposed") {
        throw new PromotionError("PROMOTION_ALREADY_DECIDED", `promotion is ${promotion.status}`);
      }
      // the designated approver (or the Founder as null-actor) decides
      if (
        promotion.approverAgentId !== null &&
        input.approverAgentId !== null &&
        input.approverAgentId !== promotion.approverAgentId
      ) {
        throw new PromotionError(
          "PROMOTION_WRONG_APPROVER",
          "only the designated approver (or the Founder) may decide this promotion",
        );
      }
      const targetMemoryId = promotion.targetMemoryId!;
      const [target] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, targetMemoryId)))
        .for("update");
      if (!target) throw new PromotionError("PROMOTION_NOT_FOUND", "target memory missing");

      const newStatus = input.verdict === "approved" ? "active" : "rejected";
      const versionNo = target.version + 1;
      await tx
        .update(memories)
        .set({ status: newStatus, version: versionNo, updatedAt: sql`now()` })
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, targetMemoryId)));
      await tx.insert(memoryVersions).values({
        companyId: ctx.companyId,
        memoryId: targetMemoryId,
        version: versionNo,
        title: target.title,
        content: target.content,
        summary: target.summary,
        importance: target.importance,
        confidence: target.confidence,
        status: newStatus,
        changedBy: input.approverAgentId ? "agent" : "founder",
        changedByRef: input.approverAgentId,
        changeReason:
          input.verdict === "approved"
            ? "promotion_approved"
            : `promotion_rejected${input.note ? `: ${input.note.slice(0, 300)}` : ""}`,
      });
      await tx
        .update(memoryPromotions)
        .set({
          status: input.verdict,
          decidedAt: sql`now()`,
          ...(input.approverAgentId && { approverAgentId: input.approverAgentId }),
        })
        .where(and(eq(memoryPromotions.companyId, ctx.companyId), eq(memoryPromotions.id, promotionId)));
      if (input.verdict === "approved") {
        await emitDomainEvent(tx, ctx, {
          type: "memory.promoted",
          actor: input.approverAgentId
            ? { kind: "agent", id: input.approverAgentId }
            : { kind: "founder", id: null },
          payload: {
            fromMemoryId: promotion.sourceMemoryId,
            toScope: promotion.targetScope,
            newMemoryId: targetMemoryId,
            ...(input.approverAgentId && { approvedByAgentId: input.approverAgentId }),
          },
        });
      }
      return { targetMemoryId, status: newStatus };
    });
  }

  /**
   * Contradiction resolution effects (12 §6.4.2): the reviewer picks a
   * winner; the loser → superseded with a supersedes edge from the winner;
   * promoted descendants of the loser (via derived_from) are RETURNED for
   * cascade re-review — never auto-archived.
   */
  async resolveContradiction(
    ctx: CompanyContext,
    input: {
      relationId: string; // the kind=contradicts edge
      winnerMemoryId: string;
      resolvedByAgentId: string | null; // null = Founder
      note?: string | undefined;
    },
  ): Promise<{ loserMemoryId: string; flaggedDescendants: string[] }> {
    return this.db.transaction(async (tx) => {
      const [relation] = await tx
        .select()
        .from(memoryRelations)
        .where(
          and(
            eq(memoryRelations.companyId, ctx.companyId),
            eq(memoryRelations.id, input.relationId),
            eq(memoryRelations.kind, "contradicts"),
          ),
        )
        .for("update");
      if (!relation) {
        throw new PromotionError("CONTRADICTION_NOT_FOUND", "contradicts relation not found");
      }
      const pair = [relation.fromMemoryId, relation.toMemoryId];
      if (!pair.includes(input.winnerMemoryId)) {
        throw new PromotionError(
          "CONTRADICTION_NOT_FOUND",
          "winner is not part of this contradiction",
        );
      }
      const loserMemoryId = pair.find((id) => id !== input.winnerMemoryId)!;

      const [loser] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, loserMemoryId)))
        .for("update");
      if (!loser) throw new PromotionError("CONTRADICTION_NOT_FOUND", "loser memory missing");
      const versionNo = loser.version + 1;
      await tx
        .update(memories)
        .set({ status: "superseded", version: versionNo, updatedAt: sql`now()` })
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, loserMemoryId)));
      await tx.insert(memoryVersions).values({
        companyId: ctx.companyId,
        memoryId: loserMemoryId,
        version: versionNo,
        title: loser.title,
        content: loser.content,
        summary: loser.summary,
        importance: loser.importance,
        confidence: loser.confidence,
        status: "superseded",
        changedBy: input.resolvedByAgentId ? "agent" : "founder",
        changedByRef: input.resolvedByAgentId,
        changeReason: `contradiction_resolved${input.note ? `: ${input.note.slice(0, 300)}` : ""}`,
      });
      await tx
        .insert(memoryRelations)
        .values({
          companyId: ctx.companyId,
          fromMemoryId: input.winnerMemoryId,
          toMemoryId: loserMemoryId,
          kind: "supersedes",
          createdBy: input.resolvedByAgentId ? "agent" : "founder",
        })
        .onConflictDoNothing();
      await emitDomainEvent(tx, ctx, {
        type: "memory.superseded",
        actor: input.resolvedByAgentId
          ? { kind: "agent", id: input.resolvedByAgentId }
          : { kind: "founder", id: null },
        payload: {
          memoryId: loserMemoryId,
          byMemoryId: input.winnerMemoryId,
          reason: "contradiction resolved",
        },
      });

      // descendants promoted FROM the loser (copy derived_from loser) go to
      // the review queue — flagged, never auto-archived (12 §6.4.2)
      const descendants = await tx
        .select({ id: memoryRelations.fromMemoryId })
        .from(memoryRelations)
        .where(
          and(
            eq(memoryRelations.companyId, ctx.companyId),
            eq(memoryRelations.toMemoryId, loserMemoryId),
            eq(memoryRelations.kind, "derived_from"),
          ),
        );
      return { loserMemoryId, flaggedDescendants: descendants.map((d) => d.id) };
    });
  }
}
