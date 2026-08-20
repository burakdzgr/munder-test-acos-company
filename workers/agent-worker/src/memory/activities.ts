// memoryConsolidationWorkflow activities (T44; 12 §5). All IO stages of the
// pipeline: window loading, LLM extraction, embedding, pgvector similarity,
// compare verdicts and the transactional persist/merge — each idempotent, all
// persistence through the ONE MemoryConsolidationService implementation.
//
// Scripted mode (32 §6): extraction comes from the canned consolidation
// fixtures and embeddings from the fixed-seed pseudo-embedding — the pipeline
// is fully deterministic without a model. Recorded MVP narrowing (like the
// T43 review verdict policy): the §5.6 compare verdict is a deterministic
// band policy in BOTH modes — `compare_merge` ⇒ duplicate, `compare_no_merge`
// ⇒ contradiction when type matches and content differs, else unrelated. The
// live-LLM compare joins the nightly lane.
import {
  MemoryConsolidationService,
  MemoryPromotionService,
  companyContext,
  type CompanyContext,
  type EvidenceInput,
  type GuardedDb,
  type SimilarMemory,
  type TriggerWindow,
  recordLlmCall,
} from "@acos/db";
import { uuidv5 } from "@acos/domain";
import type { SimilarityBand } from "@acos/domain";
import { companySettings } from "@acos/db/schema";
import { eq } from "drizzle-orm";
import {
  outputLanguageDirective,
  parseMemoryCandidates,
  type MemoryCandidate,
  type ModelRouter,
  type RoutingContext,
} from "@acos/llm";
import { cannedConsolidation, pseudoEmbedding } from "@acos/llm/testing";
import { startTemporalHeartbeat } from "../activities/agent-task.js";

export interface MemoryActivityDeps {
  guardedDb: GuardedDb;
  /** live mode: extraction (purpose fast) + embeddings ride the router */
  router?: ModelRouter | undefined;
  routingFor?: ((ctx: CompanyContext, agentId: string) => Promise<RoutingContext>) | undefined;
  /** scripted mode (32 §6): canned extraction + pseudo-embeddings */
  scripted?: boolean | undefined;
  /** pseudo-embedding dimension for scripted mode (768 default; tests run both) */
  scriptedDim?: number | undefined;
  /** test seam: force embedding failures (12 §5.4 NULL-embedding path) */
  embedOverride?: ((text: string) => Promise<{ embedding: number[]; model: string }>) | undefined;
}

/**
 * 12 §5.1 window digest. Exported because a single omission here silently
 * empties the whole memory subsystem, and only a test on the rendered text
 * can catch it.
 *
 * 2026-08-15 live finding: the digest used to render `- [time] type: summary`
 * with NO id. §5.1 requires every candidate to "cite at least one concrete
 * evidence ref FROM THE WINDOW", and §5.7 drops a candidate whose refs all
 * fail to resolve — so a live model, having never been shown a single real
 * id, invented UUIDs, every ref failed, and EVERY candidate was discarded as
 * hallucinated evidence. On the live company that read as "consolidation ran,
 * 7 candidates, 0 persisted" over and over with an empty memory panel. The
 * scripted path never hit it because the canned fixtures take their refs
 * straight from `window.events[].id`.
 */
export function renderWindowDigest(window: TriggerWindow): string {
  return window.events
    .map((e) => `- id=${e.id} [${e.occurredAt}] ${e.type}: ${e.payloadSummary}`)
    .join("\n");
}

const CANNED_KIND_TO_TYPE: Record<string, MemoryCandidate["type"]> = {
  procedure: "procedural",
  fact: "semantic",
  decision: "decision",
  lesson: "failure",
};

export function createMemoryActivities(deps: MemoryActivityDeps) {
  const service = new MemoryConsolidationService(deps.guardedDb);

  return {
    /** 12 §5.0: the task-completion trigger window (task + significant events). */
    async loadTriggerWindowActivity(input: {
      companyId: string;
      taskId: string;
    }): Promise<TriggerWindow> {
      return service.loadTaskWindow(companyContext(input.companyId), input.taskId);
    },

    /**
     * 12 §5.0 rows 2–4 (M1): the agent-anchored trigger window — N significant
     * events, escalation resolved, experiment concluded. Same TriggerWindow
     * shape with `task: null` and the acting agent as the anchor.
     */
    async loadAgentWindowActivity(input: {
      companyId: string;
      agentId: string;
      eventIds?: string[];
    }): Promise<TriggerWindow> {
      return service.loadAgentWindow(companyContext(input.companyId), {
        agentId: input.agentId,
        ...(input.eventIds ? { eventIds: input.eventIds } : {}),
      });
    },

    /**
     * 12 §5.1: extract 0–8 MemoryCandidates from the window digest.
     * Scripted: fixture-keyed canned extractions with evidence refs taken
     * from the real window events (fabricated refs when the window is empty —
     * exercising the §5.7 hallucination discard).
     */
    async extractCandidatesActivity(input: {
      companyId: string;
      window: TriggerWindow;
    }): Promise<MemoryCandidate[]> {
      const { window } = input;
      // 12 §5.0: the window is anchored either on a task (row 1) or on the
      // acting agent (rows 2–4, M1). Neither ⇒ nothing to extract from.
      const anchor = window.task
        ? {
            headline: `Task "${window.task.title}" reached ${window.task.status}.`,
            agentId: window.task.ownerAgentId,
            fixtureKey: window.task.fixtureKey,
          }
        : window.agent
          ? {
              headline:
                `Agent "${window.agent.name}" produced ${window.events.length} significant events.`,
              agentId: window.agent.id,
              fixtureKey: null,
            }
          : null;
      if (!anchor) return [];

      if (deps.scripted || !deps.router || !deps.routingFor) {
        const canned = cannedConsolidation(anchor.fixtureKey ?? "none");
        const eventRefs = window.events.slice(0, 2).map((e) => ({
          kind: "event" as const,
          ref: e.id,
        }));
        return canned.memories.map((memory) => ({
          type: CANNED_KIND_TO_TYPE[memory.kind] ?? "semantic",
          title: memory.title,
          content: memory.content,
          summary: memory.content.slice(0, 320),
          entities: memory.files?.length ? { files: memory.files } : {},
          suggested_scope: memory.files?.length ? ("project" as const) : ("agent" as const),
          scope_rationale: "canned fixture",
          importance: memory.importance,
          importance_rationale: "canned fixture",
          confidence: memory.confidence,
          confidence_rationale: "canned fixture",
          evidence_refs: eventRefs.length
            ? eventRefs
            : [{ kind: "event" as const, ref: "00000000-0000-7000-8000-000000000000" }],
        }));
      }

      const ctx = companyContext(input.companyId);
      const routing = await deps.routingFor(ctx, anchor.agentId ?? "");
      // Anı başlıkları/özetleri Founder'ın Hafıza Gözlemevi'nde okuduğu
      // metinlerdir — şirketin çıktı diline (A5) uymaları gerekir.
      const [settingsRow] = await deps.guardedDb
        .select({ outputLanguage: companySettings.outputLanguage })
        .from(companySettings)
        .where(eq(companySettings.companyId, ctx.companyId));
      const languageDirective = outputLanguageDirective(settingsRow?.outputLanguage ?? "en");
      const prompt =
        `${anchor.headline} ` +
        `Extract 0-8 memory candidates as a JSON array matching the MemoryCandidate contract ` +
        `(type, title, content, summary, entities, suggested_scope agent|project, ` +
        `scope_rationale, importance 0-1, importance_rationale, confidence 0-1, ` +
        `confidence_rationale, evidence_refs [{kind,ref}] citing the window). ` +
        `Every candidate MUST cite at least one evidence ref of the form ` +
        `{"kind":"event","ref":"<the id= UUID copied VERBATIM from a Window line>"}. ` +
        `Only those ids exist; a ref you did not copy from the window is rejected ` +
        `and the whole candidate is thrown away. ` +
        `Extract only knowledge with future utility; never invent evidence.\n\n` +
        (languageDirective ? `${languageDirective}\n\n` : "") +
        `Window:\n${renderWindowDigest(window)}`;
      // 08 §12 LLM sınıfı: iki router çağrısı (ilk + onarım) köprüde dakikalar
      // sürebilir — canlılık Temporal heartbeat'iyle kanıtlanır (workflow
      // tarafı heartbeatTimeout 60s).
      const stopBeat = startTemporalHeartbeat("memory:extract-candidates");
      // T36: bu pencerenin defter kimliği — çapa (görev ya da ajan) + penceredeki
      // SON olay. Aktivite yeniden denendiğinde aynı satır, yeni bir pencere
      // için ise yeni satır; onarım turu kendi satırını yazar (ikinci bir
      // model çağrısıdır, ayrı maliyettir).
      const ledgerAnchor =
        window.task?.id ?? window.agent?.id ?? "00000000-0000-7000-8000-000000000000";
      const windowKey = window.events[window.events.length - 1]?.id ?? "empty";
      const ledger = async (
        attempt: "extract" | "repair",
        result: { providerId: string; model: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }; costCents: number; latencyMs: number },
      ) => {
        await recordLlmCall(deps.guardedDb, ctx, {
          id: uuidv5(`memory-${attempt}:${windowKey}`, ledgerAnchor),
          // routing purpose "fast" ile aynı (llm_calls_purpose_check kanonik)
          purpose: "fast",
          providerId: result.providerId,
          model: result.model,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
          tokensCached: result.usage.cachedInputTokens ?? 0,
          costCents: result.costCents,
          latencyMs: result.latencyMs,
          ...(anchor.agentId && { agentId: anchor.agentId }),
          ...(window.task?.id && { taskId: window.task.id }),
        });
      };
      try {
        const first = await deps.router.complete(
          { purpose: "fast", messages: [{ role: "user", content: prompt }] },
          routing,
        );
        await ledger("extract", first);
        try {
          return parseMemoryCandidates(first.text);
        } catch (err) {
          // one repair retry (12 §5.1), then fail the activity
          const repair = await deps.router.complete(
            {
              purpose: "fast",
              messages: [
                { role: "user", content: prompt },
                { role: "assistant", content: first.text },
                { role: "user", content: `Response failed validation (${String(err)}). Reply with ONLY the corrected JSON array.` },
              ],
            },
            routing,
          );
          await ledger("repair", repair);
          return parseMemoryCandidates(repair.text);
        }
      } finally {
        stopBeat();
      }
    },

    /**
     * 12 §5.4: embed title+summary+content. Failure returns ok:false — the
     * workflow persists with a NULL embedding + memory.embedding.failed.
     */
    async embedCandidateActivity(input: {
      companyId: string;
      agentId: string | null;
      text: string;
    }): Promise<
      | { ok: true; embedding: number[]; model: string; dim: number }
      | { ok: false; model: string; error: string }
    > {
      if (deps.embedOverride) {
        try {
          const result = await deps.embedOverride(input.text);
          return { ok: true, embedding: result.embedding, model: result.model, dim: result.embedding.length };
        } catch (err) {
          return { ok: false, model: "override", error: String(err) };
        }
      }
      if (deps.scripted || !deps.router || !deps.routingFor) {
        const dim = deps.scriptedDim ?? 768;
        return {
          ok: true,
          embedding: pseudoEmbedding(input.text, dim),
          model: `pseudo-${dim}`,
          dim,
        };
      }
      try {
        const ctx = companyContext(input.companyId);
        const routing = await deps.routingFor(ctx, input.agentId ?? "");
        const result = await deps.router.embed({ text: input.text }, routing);
        return { ok: true, embedding: result.embedding, model: result.model, dim: result.dimension };
      } catch (err) {
        return { ok: false, model: "unknown", error: String(err) };
      }
    },

    /** P1-B: deterministic exact-title duplicate probe — runs before the
     *  embed spend so fast-merge also works in the offline/scripted profile. */
    async findExactActivity(input: {
      companyId: string;
      scope: string;
      scopeRef: string | null;
      title: string;
    }): Promise<{ id: string } | null> {
      return service.findExactActive(companyContext(input.companyId), {
        scope: input.scope,
        scopeRef: input.scopeRef,
        title: input.title,
      });
    },

    /** 12 §5.5: pgvector cosine top-k within the exact scope, same dimension. */
    async findSimilarActivity(input: {
      companyId: string;
      scope: string;
      scopeRef: string;
      embedding: number[];
      dim: number;
    }): Promise<SimilarMemory[]> {
      return service.similarTopK(companyContext(input.companyId), {
        scope: input.scope,
        scopeRef: input.scopeRef,
        embedding: input.embedding,
        dim: input.dim,
      });
    },

    /**
     * 12 §5.6 verdict per (candidate, neighbor). Deterministic band policy
     * (recorded MVP narrowing — see the module header).
     */
    async compareMemoriesActivity(input: {
      companyId: string;
      candidate: { type: string; content: string };
      neighbor: { id: string; type: string; content: string };
      band: SimilarityBand;
    }): Promise<{ verdict: "duplicate" | "refinement" | "contradiction" | "unrelated" }> {
      if (input.band === "compare_merge") return { verdict: "duplicate" };
      if (input.band === "compare_no_merge") {
        const sameType = input.candidate.type === input.neighbor.type;
        const differs = input.candidate.content.trim() !== input.neighbor.content.trim();
        return { verdict: sameType && differs ? "contradiction" : "unrelated" };
      }
      return { verdict: "unrelated" };
    },

    /** 12 §5.7: anti-hallucination evidence resolution. */
    async resolveEvidenceActivity(input: {
      companyId: string;
      refs: EvidenceInput[];
    }): Promise<{ resolved: Required<EvidenceInput>[]; dropped: number; allFailed: boolean }> {
      return service.resolveEvidence(companyContext(input.companyId), input.refs);
    },

    /** 12 §5.9 persist path (single tx: rows + version 1 + evidence + relations + events). */
    async persistCandidateActivity(input: {
      companyId: string;
      candidate: {
        scope: "agent" | "project";
        scopeRef: string;
        type: string;
        title: string;
        content: string;
        summary: string;
        entities: Record<string, unknown>;
        importance: number;
        confidence: number;
      };
      sourceEventId: string | null;
      createdByAgentId: string | null;
      embedding: number[] | null;
      embeddingModel: string | null;
      embedFailedError?: string | undefined;
      evidence: EvidenceInput[];
      relations: { toMemoryId: string; kind: "supports" | "contradicts" | "supersedes" }[];
    }): Promise<{ memoryId: string; status: "active" | "candidate"; confidence: number }> {
      return new MemoryConsolidationService(deps.guardedDb).persistCandidate(
        companyContext(input.companyId),
        {
          ...input.candidate,
          sourceEventId: input.sourceEventId,
          createdByAgentId: input.createdByAgentId,
          embedding: input.embedding,
          embeddingModel: input.embeddingModel,
          embedFailedError: input.embedFailedError,
          evidence: input.evidence,
          relations: input.relations,
        },
      );
    },

    /** 12 §5.5 fast path / §5.6 duplicate verdict: merge into the neighbor. */
    async mergeIntoExistingActivity(input: {
      companyId: string;
      memoryId: string;
      evidence: EvidenceInput[];
    }): Promise<{ versionNo: number }> {
      return service.mergeIntoExisting(companyContext(input.companyId), {
        memoryId: input.memoryId,
        evidence: input.evidence,
      });
    },

    /**
     * 12 §6.2 (T46): promotion evaluation — runs immediately after any
     * consolidation that persisted or merged (evidence may have crossed a
     * rule threshold); the same activity backs the nightly per-company lane.
     */
    async evaluatePromotionsActivity(input: {
      companyId: string;
    }): Promise<{ proposed: number }> {
      return new MemoryPromotionService(deps.guardedDb).evaluateCompany(
        companyContext(input.companyId),
      );
    },

    /** 12 §5.10 run report event. */
    async completeConsolidationActivity(input: {
      companyId: string;
      batchId: string;
      taskId?: string | undefined;
      extracted: number;
      persisted: number;
      merged: number;
      discarded: number;
    }): Promise<void> {
      await service.completeRun(companyContext(input.companyId), input);
    },
  };
}

export type MemoryActivities = ReturnType<typeof createMemoryActivities>;
