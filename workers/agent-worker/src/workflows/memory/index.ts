// memoryConsolidationWorkflow (T44; 12 §5, 09 §2). One execution per trigger
// occurrence — workflow id `memory-consolidation-<company_id>-<trigger_ref>`
// deduplicates. Pure orchestration: the deterministic stages (§5.2 importance,
// §5.3 scope, §5.5 bands, §5.8 confidence) run as pure @acos/domain functions
// inside the workflow; every IO stage is an idempotent activity.
import { proxyActivities } from "@temporalio/workflow";
import {
  IMPORTANCE_DISCARD_THRESHOLD,
  adjustImportance,
  classifySimilarity,
  computeConsolidationConfidence,
  detectMemoryScope,
} from "@acos/domain";
import type { MemoryActivities } from "../../memory/activities.js";

const activities = proxyActivities<MemoryActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

/**
 * LLM sınıfı (08 §12 satır 1) — canlı bulgu (2026-08-19, runtime):
 * extractCandidatesActivity en kötü durumda İKİ router çağrısı yapar (ilk +
 * onarım) ve claude-cli-bridge tek çağrıda 180 sn bütçeli/kuyruklu. 2 dk'lık
 * genel tavan canlıda StartToClose timeout'la memoryConsolidationWorkflow'u
 * öldürdü. Aktivite 10 sn'de bir Temporal heartbeat basar; ölü worker
 * heartbeatTimeout'ta yakalanır, yavaş-ama-canlı çağrı kesilmez.
 */
const llmActivities = proxyActivities<Pick<MemoryActivities, "extractCandidatesActivity">>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "60s",
  retry: { maximumAttempts: 3 },
});

/** 12 §5.0 trigger table. */
export type MemoryConsolidationTrigger =
  | "task_completed"
  | "task_failed"
  | "significant_events"
  | "escalation_resolved"
  | "experiment_completed";

export interface MemoryConsolidationInput {
  companyId: string;
  /**
   * Task-completion window (12 §5.0 row 1). Additive M1 change: OPTIONAL now —
   * rows 2–4 of the trigger table (N significant events / escalation resolved /
   * experiment concluded) have no owning task and anchor on `agentId` instead.
   */
  taskId?: string;
  /** Agent-anchored window (12 §5.0 rows 2–4). */
  agentId?: string;
  /** The exact events forming the window ("the N events since last run", §5.0). */
  sourceEventIds?: string[];
  /** completed | failed — FAILED is a costly signal (12 §5.2) */
  trigger: MemoryConsolidationTrigger;
}

/** Run report (12 §5.10). */
export interface ConsolidationReport {
  extracted: number;
  persisted: number;
  merged: number;
  contradictions: number;
  discarded: number;
  hallucinatedEvidence: number;
}

export async function memoryConsolidationWorkflow(
  input: MemoryConsolidationInput,
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    extracted: 0,
    persisted: 0,
    merged: 0,
    contradictions: 0,
    discarded: 0,
    hallucinatedEvidence: 0,
  };
  const batchId = input.taskId ? `task-${input.taskId}` : `agent-${input.agentId ?? "unknown"}`;

  // 12 §5.0: row 1 loads the task window; rows 2–4 have no task and load the
  // acting agent's window instead (same TriggerWindow shape, `task: null`).
  const window = input.taskId
    ? await activities.loadTriggerWindowActivity({
        companyId: input.companyId,
        taskId: input.taskId,
      })
    : input.agentId
      ? await activities.loadAgentWindowActivity({
          companyId: input.companyId,
          agentId: input.agentId,
          ...(input.sourceEventIds ? { eventIds: input.sourceEventIds } : {}),
        })
      : { task: null, events: [], agent: null };

  // the window's anchor: the task, or the agent for the task-less triggers
  const anchor = window.task
    ? {
        projectId: window.task.projectId,
        ownerAgentId: window.task.ownerAgentId,
      }
    : window.agent
      ? { projectId: window.agent.projectId, ownerAgentId: window.agent.id }
      : null;
  if (!anchor) return report;

  const candidates = await llmActivities.extractCandidatesActivity({
    companyId: input.companyId,
    window,
  });
  report.extracted = candidates.length;

  for (const candidate of candidates) {
    // §5.2 deterministic importance adjustment + discard threshold
    const entities = candidate.entities as Record<string, unknown>;
    const hasEntities = Object.values(entities).some(
      (v) => Array.isArray(v) && v.length > 0,
    );
    const importance = adjustImportance({
      selfScore: candidate.importance,
      // 12 §5.2: "+0.1 if trigger was an escalation or a FAILED terminal task"
      costlyTrigger: input.trigger === "task_failed" || input.trigger === "escalation_resolved",
      evidenceRefCount: candidate.evidence_refs.length,
      type: candidate.type,
      hasEntities,
    });
    if (importance < IMPORTANCE_DISCARD_THRESHOLD) {
      report.discarded += 1;
      continue;
    }

    // §5.3 scope rules (LLM tiebreak narrowed to the deterministic default)
    const files = Array.isArray(entities.files) ? entities.files : [];
    const components = Array.isArray(entities.components) ? entities.components : [];
    const scope = detectMemoryScope({
      type: candidate.type,
      suggestedScope: candidate.suggested_scope,
      referencesProjectArtifacts: files.length > 0 || components.length > 0,
      hasProject: anchor.projectId !== null,
    });
    const scopeRef = scope === "project" ? anchor.projectId! : anchor.ownerAgentId;
    if (!scopeRef) {
      report.discarded += 1; // orphan task without owner — nothing to anchor to
      continue;
    }

    // §5.7 evidence analysis (before the embed spend): all-refs-unresolvable
    // ⇒ hallucinated_evidence discard
    const evidence = await activities.resolveEvidenceActivity({
      companyId: input.companyId,
      refs: candidate.evidence_refs,
    });
    if (evidence.allFailed) {
      report.hallucinatedEvidence += 1;
      continue;
    }

    // §5.8 confidence over the RESOLVED evidence
    const confidence = computeConsolidationConfidence(candidate.confidence, evidence.resolved);

    // §5.4 embedding — failure persists with NULL + memory.embedding.failed
    const text = `${candidate.title}\n${candidate.summary}\n${candidate.content}`;
    const embedded = await activities.embedCandidateActivity({
      companyId: input.companyId,
      agentId: anchor.ownerAgentId,
      text,
    });
    if (!embedded.ok) {
      // P1-B (UI/UX review): with NO embedding the §5.5 similarity pass is
      // impossible — the old flow persisted blindly and stacked duplicates
      // in the offline/scripted profile. Deterministic exact-title fast-merge
      // fills exactly that gap; the ONLINE path below keeps the doc-12 §5.5
      // vector + verdict semantics untouched.
      const exact = await activities.findExactActivity({
        companyId: input.companyId,
        scope,
        scopeRef,
        title: candidate.title,
      });
      if (exact) {
        await activities.mergeIntoExistingActivity({
          companyId: input.companyId,
          memoryId: exact.id,
          evidence: evidence.resolved,
        });
        report.merged += 1;
        continue;
      }
      await activities.persistCandidateActivity({
        companyId: input.companyId,
        candidate: {
          scope,
          scopeRef,
          type: candidate.type,
          title: candidate.title,
          content: candidate.content,
          summary: candidate.summary,
          entities,
          importance,
          confidence,
        },
        sourceEventId: window.events[0]?.id ?? null,
        createdByAgentId: anchor.ownerAgentId,
        embedding: null,
        embeddingModel: embedded.model,
        embedFailedError: embedded.error,
        evidence: evidence.resolved,
        relations: [],
      });
      report.persisted += 1;
      continue;
    }

    // §5.5 similarity within the exact scope, same dimension
    const neighbors = await activities.findSimilarActivity({
      companyId: input.companyId,
      scope,
      scopeRef,
      embedding: embedded.embedding,
      dim: embedded.dim,
    });

    const top = neighbors[0];
    if (top && classifySimilarity(top.cosine) === "fast_merge") {
      // near-duplicate fast path: no LLM, evidence appended, done (§5.5)
      await activities.mergeIntoExistingActivity({
        companyId: input.companyId,
        memoryId: top.id,
        evidence: evidence.resolved,
      });
      report.merged += 1;
      continue;
    }

    // §5.6 compare loop over the banded neighbors
    const relations: { toMemoryId: string; kind: "supports" | "contradicts" | "supersedes" }[] = [];
    let mergedAway = false;
    for (const neighbor of neighbors) {
      const band = classifySimilarity(neighbor.cosine);
      if (band === "unrelated" || band === "fast_merge") continue;
      const compared = await activities.compareMemoriesActivity({
        companyId: input.companyId,
        candidate: { type: candidate.type, content: candidate.content },
        neighbor: { id: neighbor.id, type: neighbor.type, content: neighbor.content },
        band,
      });
      if (compared.verdict === "duplicate" && band === "compare_merge") {
        await activities.mergeIntoExistingActivity({
          companyId: input.companyId,
          memoryId: neighbor.id,
          evidence: evidence.resolved,
        });
        report.merged += 1;
        mergedAway = true;
        break;
      }
      if (compared.verdict === "refinement") relations.push({ toMemoryId: neighbor.id, kind: "supports" });
      if (compared.verdict === "contradiction") relations.push({ toMemoryId: neighbor.id, kind: "contradicts" });
    }
    if (mergedAway) continue;

    // §5.9 persist (contradiction cap applied inside the one service impl)
    await activities.persistCandidateActivity({
      companyId: input.companyId,
      candidate: {
        scope,
        scopeRef,
        type: candidate.type,
        title: candidate.title,
        content: candidate.content,
        summary: candidate.summary,
        entities,
        importance,
        confidence,
      },
      sourceEventId: window.events[0]?.id ?? null,
      createdByAgentId: anchor.ownerAgentId,
      embedding: embedded.embedding,
      embeddingModel: embedded.model,
      evidence: evidence.resolved,
      relations,
    });
    report.persisted += 1;
    report.contradictions += relations.filter((r) => r.kind === "contradicts").length;
  }

  await activities.completeConsolidationActivity({
    companyId: input.companyId,
    batchId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    extracted: report.extracted,
    persisted: report.persisted,
    merged: report.merged,
    discarded: report.discarded + report.hallucinatedEvidence,
  });

  // 12 §6.2 (T46): promotion evaluation fires immediately after any run that
  // added or merged evidence — thresholds may have just been crossed
  if (report.persisted + report.merged > 0) {
    await activities.evaluatePromotionsActivity({ companyId: input.companyId });
  }
  return report;
}
