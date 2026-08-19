// Skills & careers core (T47; 13 §2–6, _DECISIONS §11). Levels are NEVER
// LLM-set: every append recomputes through the pure @acos/domain formula from
// the full evidence trail. Lives in @acos/db for the single-implementation
// reason: the task-engine hooks, the reviews hook, the promotion flow and the
// REST surface all write through the SAME rules.
import { and, asc, eq, sql } from "drizzle-orm";
import {
  clampEvidenceWeight,
  computeSkillLevel,
  promotionNeedsFounder,
  SENIORITY_DEFAULT_AUTONOMY,
  type SkillEvidenceItem,
  type SkillEvidenceKind,
} from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { agentSkills, agents, skillEvidence, skills } from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export class SkillsError extends Error {
  constructor(
    public readonly code: "SKILL_AGENT_NOT_FOUND" | "SKILL_INVALID_SENIORITY",
    message: string,
  ) {
    super(message);
    this.name = "SkillsError";
  }
}

/** manager_eval rows backed by an accepted promotion_review artifact carry
 *  this note prefix — the level 4–5 gate reads it (recorded convention; the
 *  canonical skill_evidence schema has no dedicated column). */
export const PROMOTION_REVIEW_NOTE_PREFIX = "promotion_review:";

export interface AppendEvidenceInput {
  agentId: string;
  /** taxonomy name — get-or-create (13 §2.1) */
  skillName: string;
  category?: string | undefined;
  kind: SkillEvidenceKind;
  /** clamped into the kind's band; defaults to the kind's default weight */
  weight?: number | undefined;
  ref: string;
  note?: string | undefined;
}

export interface AppendEvidenceResult {
  agentSkillId: string;
  skillId: string;
  level: number;
  previousLevel: number;
  score: number;
  confidence: number;
  evidenceCount: number;
}

export class SkillsService {
  constructor(private readonly db: GuardedDb) {}

  /** Company-scoped taxonomy get-or-create (+skill.created on first sight). */
  async ensureSkill(
    tx: Tx,
    ctx: CompanyContext,
    name: string,
    category = "engineering",
  ): Promise<string> {
    const [existing] = await tx
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.companyId, ctx.companyId), eq(skills.name, name)));
    if (existing) return existing.id;
    const [created] = await tx
      .insert(skills)
      .values({ companyId: ctx.companyId, name, category })
      .onConflictDoNothing()
      .returning({ id: skills.id });
    if (created) {
      await emitDomainEvent(tx, ctx, {
        type: "skill.created",
        actor: { kind: "system", id: null },
        payload: { skillId: created.id, name, category },
      });
      return created.id;
    }
    const [raced] = await tx
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.companyId, ctx.companyId), eq(skills.name, name)));
    return raced!.id;
  }

  /**
   * The ONE evidence writer (13 §5): ensure taxonomy + agent_skills row
   * (first evidence creates it at level 1), append the clamped evidence row,
   * recompute deterministically from the FULL trail, persist level/confidence
   * and emit skill.evidence.recorded (+agent.skill.updated on level change).
   * Composable into a caller's transaction — the task-engine and reviews
   * hooks ride the same tx as the state change they attribute.
   */
  async appendEvidenceInTx(
    tx: Tx,
    ctx: CompanyContext,
    input: AppendEvidenceInput,
  ): Promise<AppendEvidenceResult> {
    const skillId = await this.ensureSkill(tx, ctx, input.skillName, input.category);
    let [agentSkill] = await tx
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.companyId, ctx.companyId),
          eq(agentSkills.agentId, input.agentId),
          eq(agentSkills.skillId, skillId),
        ),
      )
      .for("update");
    if (!agentSkill) {
      [agentSkill] = await tx
        .insert(agentSkills)
        .values({ companyId: ctx.companyId, agentId: input.agentId, skillId })
        .returning();
    }
    const weight = clampEvidenceWeight(input.kind, input.weight);
    await tx.insert(skillEvidence).values({
      companyId: ctx.companyId,
      agentSkillId: agentSkill!.id,
      kind: input.kind,
      weight,
      ref: input.ref,
      note: input.note ?? null,
    });

    const trail = await tx
      .select({
        kind: skillEvidence.kind,
        weight: skillEvidence.weight,
        createdAt: skillEvidence.createdAt,
        note: skillEvidence.note,
      })
      .from(skillEvidence)
      .where(
        and(
          eq(skillEvidence.companyId, ctx.companyId),
          eq(skillEvidence.agentSkillId, agentSkill!.id),
        ),
      )
      .orderBy(asc(skillEvidence.createdAt));
    const now = Date.now();
    const items: SkillEvidenceItem[] = trail.map((row) => ({
      kind: row.kind as SkillEvidenceKind,
      weight: row.weight,
      ageDays: Math.max(0, (now - row.createdAt.getTime()) / 86_400_000),
      ...(row.kind === "manager_eval" &&
        row.note?.startsWith(PROMOTION_REVIEW_NOTE_PREFIX) && { isPromotionReview: true }),
    }));
    const previousLevel = agentSkill!.level;
    const result = computeSkillLevel(items, previousLevel);

    await tx
      .update(agentSkills)
      .set({
        level: result.level,
        confidence: result.confidence,
        evidenceCount: trail.length,
        lastUsedAt: sql`now()`,
        ...(result.level !== previousLevel && { levelUpdatedAt: sql`now()` }),
      })
      .where(
        and(eq(agentSkills.companyId, ctx.companyId), eq(agentSkills.id, agentSkill!.id)),
      );

    await emitDomainEvent(tx, ctx, {
      type: "skill.evidence.recorded",
      actor: { kind: "system", id: null },
      agentId: input.agentId,
      payload: { agentSkillId: agentSkill!.id, kind: input.kind, weight, ref: input.ref },
    });
    if (result.level !== previousLevel) {
      await emitDomainEvent(tx, ctx, {
        type: "agent.skill.updated",
        actor: { kind: "system", id: null },
        agentId: input.agentId,
        payload: {
          agentId: input.agentId,
          skillId,
          fromLevel: previousLevel,
          toLevel: result.level,
          confidence: result.confidence,
          evidenceCount: trail.length,
        },
      });
    }
    return {
      agentSkillId: agentSkill!.id,
      skillId,
      level: result.level,
      previousLevel,
      score: result.score,
      confidence: result.confidence,
      evidenceCount: trail.length,
    };
  }

  async appendEvidence(
    ctx: CompanyContext,
    input: AppendEvidenceInput,
  ): Promise<AppendEvidenceResult> {
    return this.db.transaction((tx) => this.appendEvidenceInTx(tx, ctx, input));
  }

  /**
   * Task-terminal hook (13 §5, demo 22): DONE → task_success (+0.3),
   * FAILED/QA_FAILED → failure (−0.4) for every skill tag on the task
   * (`context.skills`, set at decomposition). Untagged tasks are a no-op.
   */
  async recordTaskOutcomeInTx(
    tx: Tx,
    ctx: CompanyContext,
    input: {
      taskId: string;
      ownerAgentId: string | null;
      context: unknown;
      outcome: "success" | "failure";
    },
  ): Promise<void> {
    if (!input.ownerAgentId) return;
    const tags = (input.context as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(tags) || tags.length === 0) return;
    for (const tag of tags) {
      if (typeof tag !== "string" || tag.trim() === "") continue;
      await this.appendEvidenceInTx(tx, ctx, {
        agentId: input.ownerAgentId,
        skillName: tag,
        kind: input.outcome === "success" ? "task_success" : "failure",
        ref: `task:${input.taskId}`,
      });
    }
  }

  /** Review-acceptance hook (13 §5.1): REVIEW → QA appends review_accepted
   *  (+0.5) per skill tag, ref = the review id. */
  async recordReviewAcceptedInTx(
    tx: Tx,
    ctx: CompanyContext,
    input: { taskId: string; ownerAgentId: string | null; context: unknown; reviewId: string },
  ): Promise<void> {
    if (!input.ownerAgentId) return;
    const tags = (input.context as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(tags) || tags.length === 0) return;
    for (const tag of tags) {
      if (typeof tag !== "string" || tag.trim() === "") continue;
      await this.appendEvidenceInTx(tx, ctx, {
        agentId: input.ownerAgentId,
        skillName: tag,
        kind: "review_accepted",
        ref: `review:${input.reviewId}`,
      });
    }
  }

  /**
   * 13 §6.1 steps 3–4: the manager's recommendation — emits
   * agent.promotion.recommended; lead+ targets are Founder-gated (the caller
   * creates the Approval Center request from the returned flag), below-lead
   * applies via the manager chain's normal decide call (`applyPromotion`).
   */
  async recommendPromotion(
    ctx: CompanyContext,
    input: {
      agentId: string;
      byAgentId: string;
      toSeniority: string;
      reviewArtifactId?: string | undefined;
      evidenceRefs?: string[] | undefined;
    },
  ): Promise<{ founderGated: boolean; fromSeniority: string }> {
    return this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ seniority: agents.seniority })
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, input.agentId)));
      if (!agent) throw new SkillsError("SKILL_AGENT_NOT_FOUND", "agent not found");
      await emitDomainEvent(tx, ctx, {
        type: "agent.promotion.recommended",
        actor: { kind: "agent", id: input.byAgentId },
        agentId: input.agentId,
        payload: {
          agentId: input.agentId,
          fromSeniority: agent.seniority,
          toSeniority: input.toSeniority,
          ...(input.evidenceRefs && { evidenceRefs: input.evidenceRefs }),
          ...(input.reviewArtifactId && { reviewArtifactId: input.reviewArtifactId }),
        },
      });
      return {
        founderGated: promotionNeedsFounder(input.toSeniority),
        fromSeniority: agent.seniority,
      };
    });
  }

  /** 13 §6.1 step 5: on approval — seniority + default autonomy update,
   *  agent.promoted event. */
  async applyPromotion(
    ctx: CompanyContext,
    input: { agentId: string; toSeniority: string; approvalId?: string | undefined },
  ): Promise<void> {
    const autonomy = SENIORITY_DEFAULT_AUTONOMY[input.toSeniority];
    if (autonomy === undefined) {
      throw new SkillsError("SKILL_INVALID_SENIORITY", `unknown seniority "${input.toSeniority}"`);
    }
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agents)
        .set({ seniority: input.toSeniority, autonomyLevel: autonomy })
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, input.agentId)))
        .returning({ id: agents.id });
      if (!updated) throw new SkillsError("SKILL_AGENT_NOT_FOUND", "agent not found");
      await emitDomainEvent(tx, ctx, {
        type: "agent.promoted",
        actor: { kind: "system", id: null },
        agentId: input.agentId,
        payload: {
          agentId: input.agentId,
          toSeniority: input.toSeniority,
          ...(input.approvalId && { approvalId: input.approvalId }),
        },
      });
    });
  }

  /** Skills matrix (13 §10): agents × skills with levels for the UI. */
  async matrix(ctx: CompanyContext): Promise<
    Array<{
      agentId: string;
      agentName: string;
      skillId: string;
      skillName: string;
      category: string;
      level: number;
      confidence: number;
      evidenceCount: number;
      lastUsedAt: Date | null;
    }>
  > {
    return this.db
      .select({
        agentId: agentSkills.agentId,
        agentName: agents.name,
        skillId: agentSkills.skillId,
        skillName: skills.name,
        category: skills.category,
        level: agentSkills.level,
        confidence: agentSkills.confidence,
        evidenceCount: agentSkills.evidenceCount,
        lastUsedAt: agentSkills.lastUsedAt,
      })
      .from(agentSkills)
      .innerJoin(agents, eq(agentSkills.agentId, agents.id))
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(agentSkills.companyId, ctx.companyId))
      .orderBy(asc(agents.name), asc(skills.name));
  }
}
