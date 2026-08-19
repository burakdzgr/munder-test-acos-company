// Emergent skill discovery (36 §10 — U12): a COMPUTED read-model over
// existing tables — no schema change. Scans the agent's recent accepted work
// (DONE tasks: repeated title patterns + context.skills tags) for patterns
// that are not yet an agent_skill, and surfaces evidence-backed candidates.
// First sight of a (agentId, skillName) pair emits
// agent.skill.candidate.proposed; Founder promotion routes every cited task
// through the ONE evidence writer (T47 SkillsService.appendEvidenceInTx), so
// the level/confidence stay deterministic — same discipline as T47, no
// gamification.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { SkillsService, type CompanyContext, type GuardedDb } from "@acos/db";
import { agentSkills, agents, events, skills, tasks } from "@acos/db/schema";
import type { PromoteSkillResponse, SkillCandidate } from "@acos/contracts";
import { emitDomainEvent } from "../events/emit.js";
import { ApiError } from "../../app.js";

const MIN_REPEATS = 3;
const WINDOW_DAYS = 90;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "at", "is",
  "this", "that", "with", "into", "from", "über", "bir", "ve", "ile", "için",
]);

/** Normalized title pattern — first 3 significant words. */
export function titleKey(title: string): string | null {
  const words = title
    .toLowerCase()
    .replace(/[^a-zçğıöşüâî\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length < 2) return null;
  return words.slice(0, 3).join(" ");
}

export function skillNameFromKey(key: string): string {
  return key
    .split(" ")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export class EmergentSkillsService {
  constructor(private readonly db: GuardedDb) {}

  /** Compute candidates from repeated accepted work (≥MIN_REPEATS DONE tasks). */
  async discover(ctx: CompanyContext): Promise<SkillCandidate[]> {
    const done = await this.db
      .select({
        id: tasks.id,
        title: tasks.title,
        ownerAgentId: tasks.ownerAgentId,
        context: tasks.context,
        agentName: agents.name,
      })
      .from(tasks)
      .innerJoin(agents, eq(tasks.ownerAgentId, agents.id))
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          eq(tasks.status, "DONE"),
          isNotNull(tasks.ownerAgentId),
          sql`${tasks.closedAt} > now() - interval '${sql.raw(String(WINDOW_DAYS))} days'`,
          sql`${tasks.kind} IN ('task','subtask','epic')`,
        ),
      );

    const existing = await this.db
      .select({ agentId: agentSkills.agentId, name: skills.name })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(agentSkills.companyId, ctx.companyId));
    const owned = new Set(existing.map((r) => `${r.agentId}:${r.name.toLowerCase()}`));

    const groups = new Map<
      string,
      { agentId: string; agentName: string; skillName: string; taskIds: string[]; sample: string; viaTag: boolean }
    >();
    for (const task of done) {
      const agentId = task.ownerAgentId!;
      // signal 1: repeated title patterns
      const key = titleKey(task.title);
      if (key) {
        const skillName = skillNameFromKey(key);
        const groupKey = `${agentId}:${skillName.toLowerCase()}`;
        const group =
          groups.get(groupKey) ??
          { agentId, agentName: task.agentName, skillName, taskIds: [], sample: task.title, viaTag: false };
        group.taskIds.push(task.id);
        groups.set(groupKey, group);
      }
      // signal 2: context.skills tags that never became a skill (hook gap)
      const tags = (task.context as { skills?: unknown } | null)?.skills;
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          if (typeof tag !== "string" || tag.trim() === "") continue;
          const groupKey = `${agentId}:${tag.toLowerCase()}`;
          const group =
            groups.get(groupKey) ??
            { agentId, agentName: task.agentName, skillName: tag, taskIds: [], sample: task.title, viaTag: true };
          group.taskIds.push(task.id);
          groups.set(groupKey, group);
        }
      }
    }

    return [...groups.values()]
      .filter(
        (g) =>
          g.taskIds.length >= MIN_REPEATS &&
          !owned.has(`${g.agentId}:${g.skillName.toLowerCase()}`),
      )
      .map((g) => ({
        agentId: g.agentId,
        agentName: g.agentName,
        skillName: g.skillName,
        reason: g.viaTag
          ? `${g.taskIds.length} tamamlanmış işte context.skills etiketi — henüz beceri değil`
          : `${g.taskIds.length}× benzer iş tamamlandı — örn. “${g.sample}”`,
        score: Math.min(0.95, g.taskIds.length / 6),
        taskCount: g.taskIds.length,
        evidenceTaskIds: g.taskIds.slice(0, 20),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  /** Emit agent.skill.candidate.proposed for pairs never surfaced before. */
  async proposeNew(ctx: CompanyContext, candidates: SkillCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    const prior = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.companyId, ctx.companyId),
          eq(events.type, "agent.skill.candidate.proposed"),
        ),
      );
    const seen = new Set(
      prior.map((row) => {
        const p = row.payload as { agentId?: string; skillName?: string };
        return `${p.agentId}:${(p.skillName ?? "").toLowerCase()}`;
      }),
    );
    const fresh = candidates.filter((c) => !seen.has(`${c.agentId}:${c.skillName.toLowerCase()}`));
    if (fresh.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const candidate of fresh) {
        await emitDomainEvent(tx, ctx, {
          type: "agent.skill.candidate.proposed",
          actor: { kind: "system", id: null },
          agentId: candidate.agentId,
          payload: {
            agentId: candidate.agentId,
            skillName: candidate.skillName,
            score: candidate.score,
            taskCount: candidate.taskCount,
          },
        });
      }
    });
  }

  /** Founder "↑ Terfi Et": cited work becomes real skill_evidence through the
   *  T47 writer; the deterministic recompute sets the starting level. */
  async promote(
    ctx: CompanyContext,
    input: {
      agentId: string;
      skillName: string;
      evidenceTaskIds: string[];
      category?: string | undefined;
    },
  ): Promise<PromoteSkillResponse> {
    const [already] = await this.db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(
        and(
          eq(agentSkills.companyId, ctx.companyId),
          eq(agentSkills.agentId, input.agentId),
          sql`lower(${skills.name}) = ${input.skillName.toLowerCase()}`,
        ),
      );
    if (already) throw new ApiError("conflict", "agent already has this skill");

    const service = new SkillsService(this.db);
    return this.db.transaction(async (tx) => {
      let last: Awaited<ReturnType<SkillsService["appendEvidenceInTx"]>> | null = null;
      for (const taskId of input.evidenceTaskIds) {
        last = await service.appendEvidenceInTx(tx, ctx, {
          agentId: input.agentId,
          skillName: input.skillName,
          category: input.category ?? "emergent",
          kind: "task_success",
          ref: `task:${taskId}`,
          note: "emergent:U12",
        });
      }
      return {
        skillId: last!.skillId,
        agentSkillId: last!.agentSkillId,
        level: last!.level,
        confidence: last!.confidence,
        evidenceCount: last!.evidenceCount,
      };
    });
  }
}
