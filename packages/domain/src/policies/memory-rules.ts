// Memory retrieval scoring + promotion rules (_DECISIONS.md §10).
import { DomainError } from "../errors.js";

export const RETRIEVAL_WEIGHTS = {
  cosine: 0.55,
  importance: 0.2,
  recency: 0.15,
  confidence: 0.1,
} as const;

export interface RetrievalSignals {
  readonly cosine: number;
  readonly importance: number;
  readonly recencyDecay: number;
  readonly confidence: number;
}

/** score = 0.55·cosine + 0.2·importance + 0.15·recency_decay + 0.1·confidence */
export function scoreMemoryRetrieval(signals: RetrievalSignals): number {
  for (const [name, value] of Object.entries(signals)) {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
      throw new DomainError(`retrieval signal ${name} must be within [0,1], got ${value}`);
    }
  }
  return (
    RETRIEVAL_WEIGHTS.cosine * signals.cosine +
    RETRIEVAL_WEIGHTS.importance * signals.importance +
    RETRIEVAL_WEIGHTS.recency * signals.recencyDecay +
    RETRIEVAL_WEIGHTS.confidence * signals.confidence
  );
}

/** failure memory: ≥3 supporting evidence rows across ≥2 distinct tasks → propose project-scope copy. */
export const AGENT_TO_PROJECT_RULE = { minEvidence: 3, minDistinctTasks: 2 } as const;

export function canProposeProjectPromotion(input: {
  evidenceCount: number;
  distinctTaskCount: number;
}): boolean {
  return (
    input.evidenceCount >= AGENT_TO_PROJECT_RULE.minEvidence &&
    input.distinctTaskCount >= AGENT_TO_PROJECT_RULE.minDistinctTasks
  );
}

/** project → company requires ≥2 projects + manager-agent approval. */
export const PROJECT_TO_COMPANY_RULE = { minDistinctProjects: 2 } as const;

/** Evidence rows count toward promotion only at weight ≥ 0.6 (12 §6.2). */
export const PROMOTION_EVIDENCE_WEIGHT_FLOOR = 0.6;

/** The binding seeded promotion rules (12 §6.2, _DECISIONS §10) — stored as
 *  `policies` rows (kind=memory_promotion) at company creation. */
export const DEFAULT_PROMOTION_RULES = [
  {
    name: "memory-promotion:agent-project:failure",
    fromScope: "agent",
    toScope: "project",
    memoryType: "failure",
    minEvidence: 3,
    minDistinctTasks: 2,
    minDistinctProjects: null,
    minConfidence: 0.5,
    approver: "lead",
  },
  {
    name: "memory-promotion:agent-project:any",
    fromScope: "agent",
    toScope: "project",
    memoryType: null, // any type
    minEvidence: 3,
    minDistinctTasks: 2,
    minDistinctProjects: null,
    minConfidence: 0.5,
    approver: "lead",
  },
  {
    name: "memory-promotion:project-company:any",
    fromScope: "project",
    toScope: "company",
    memoryType: null,
    minEvidence: 4, // WRITER-DECISION (12 §6.2)
    minDistinctTasks: null,
    minDistinctProjects: 2,
    minConfidence: 0.5,
    approver: "manager",
  },
] as const;
export type PromotionRule = (typeof DEFAULT_PROMOTION_RULES)[number];

export function canPromoteToCompany(input: {
  distinctProjectCount: number;
  managerApproved: boolean;
}): boolean {
  return (
    input.distinctProjectCount >= PROJECT_TO_COMPANY_RULE.minDistinctProjects &&
    input.managerApproved
  );
}

/**
 * Overlearning prevention: a single event can never directly create a
 * company-scope memory — only the promotion pipeline can (03 §3.4).
 */
export function canCreateCompanyScopeMemory(origin: "event" | "promotion"): boolean {
  return origin === "promotion";
}

// ---------------------------------------------------------------------------
// Consolidation pipeline rules (12 §5) — deterministic stages of
// memoryConsolidationWorkflow. Pure functions so the Temporal workflow can
// call them directly and the thresholds stay unit-testable.

/** Adjusted importance below this is dropped before persisting (12 §5.2). */
export const IMPORTANCE_DISCARD_THRESHOLD = 0.3;
/** Persist boundary: ≥ 0.45 → status `active`, else `candidate` (12 §5.9). */
export const IMPORTANCE_ACTIVE_THRESHOLD = 0.45;
/** Contradicting candidates persist with confidence capped here (12 §5.6). */
export const CONTRADICTION_CONFIDENCE_CAP = 0.6;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface ImportanceSignals {
  readonly selfScore: number; // the LLM's 0–1 self-assessment
  /** costly signals bump importance: escalation trigger or FAILED terminal task */
  readonly costlyTrigger: boolean;
  readonly evidenceRefCount: number;
  readonly type: string;
  readonly hasEntities: boolean;
}

/** 12 §5.2: +0.1 costly trigger, +0.05 ≥2 evidence refs, −0.1 entity-less episodic. */
export function adjustImportance(signals: ImportanceSignals): number {
  let score = signals.selfScore;
  if (signals.costlyTrigger) score += 0.1;
  if (signals.evidenceRefCount >= 2) score += 0.05;
  if (signals.type === "episodic" && !signals.hasEntities) score -= 0.1;
  return clamp01(score);
}

export interface ScopeSignals {
  readonly type: string;
  readonly suggestedScope: "agent" | "project";
  /** entities.files / entities.components non-empty (rule 1) */
  readonly referencesProjectArtifacts: boolean;
  /** the trigger task carries a project (rule 4 guards the org-task case) */
  readonly hasProject: boolean;
}

/**
 * 12 §5.3 rules 1–5, deterministic. Company scope is unreachable by
 * construction; ties resolve to `project` (contained blast radius).
 */
export function detectMemoryScope(signals: ScopeSignals): MemoryScopeDecision {
  if (signals.type === "relationship") return "agent"; // rule 3: perspectives, not facts
  if (!signals.hasProject) return "agent"; // rule 4: org-level task
  if (signals.referencesProjectArtifacts) return "project"; // rule 1
  if (signals.suggestedScope === "agent") return "agent"; // rule 2 proxy
  return "project"; // rule 5 tiebreak default
}
export type MemoryScopeDecision = "agent" | "project";

export interface ConfidenceEvidence {
  readonly kind: "event" | "artifact" | "review" | "metric" | "statement" | "incident";
}

/**
 * 12 §5.8: confidence = clamp01( base(cap 0.6) + 0.15·count(event∨review)
 * (max +0.30) + 0.25·has(metric) − 0.20·only-statement ).
 */
export function computeConsolidationConfidence(
  base: number,
  evidence: readonly ConfidenceEvidence[],
): number {
  const corroborating = evidence.filter((e) => e.kind === "event" || e.kind === "review").length;
  const hasMetric = evidence.some((e) => e.kind === "metric");
  const onlyStatements = evidence.length > 0 && evidence.every((e) => e.kind === "statement");
  return clamp01(
    Math.min(base, 0.6) +
      Math.min(0.15 * corroborating, 0.3) +
      (hasMetric ? 0.25 : 0) -
      (onlyStatements ? 0.2 : 0),
  );
}

// ---------------------------------------------------------------------------
// Retrieval rules (12 §7, T45) — pure pieces of the Working-Set builder.

/** Per-type recency half-lives in days (12 §7.2 WRITER-DECISION). */
export const RECENCY_HALF_LIFE_DAYS: Record<string, number> = {
  episodic: 14,
  experiment: 45,
  relationship: 60,
  failure: 90,
  artifact: 120,
  decision: 180,
  procedural: 365,
  semantic: 365,
};

/** recency_decay = exp(−ln2 · age_days / half_life(type)), clamped to [0,1]. */
export function recencyDecay(type: string, ageDays: number): number {
  const halfLife = RECENCY_HALF_LIFE_DAYS[type] ?? 90;
  return Math.min(1, Math.max(0, Math.exp((-Math.LN2 * Math.max(0, ageDays)) / halfLife)));
}

/** Per-scope token budgets (binding defaults, _DECISIONS §10 / 12 §7.3). */
export const MEMORY_TOKEN_BUDGETS = { agent: 1500, project: 2500, company: 1000 } as const;

/** Cheap model-agnostic token estimate: ceil(chars / 4) (12 §7.3). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface PackableMemory {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly type: string;
  readonly confidence: number;
  readonly score: number;
  /** SQL-lane rows: packed first — the "must know" set (12 §7.3). */
  readonly mustKnow: boolean;
}

export interface PackedMemory {
  readonly id: string;
  readonly rendered: string;
  readonly tokens: number;
}

export interface PackResult {
  readonly packed: PackedMemory[];
  readonly tokensUsed: number;
  /** scored rows that did not fit at all (budget starvation, 12 §7.5b) */
  readonly droppedCount: number;
}

/**
 * 12 §7.3 packing: must-know (SQL-lane) rows first, then by score desc;
 * title+content while it fits, fall back to title+summary on overflow, stop
 * when even the summary does not fit. Each block is labeled with memory id,
 * type and confidence so actions can cite ids (feeds last_verified_at, §6.4).
 */
export function packMemories(rows: readonly PackableMemory[], budgetTokens: number): PackResult {
  const ordered = [...rows].sort((a, b) =>
    a.mustKnow !== b.mustKnow ? (a.mustKnow ? -1 : 1) : b.score - a.score,
  );
  const packed: PackedMemory[] = [];
  let tokensUsed = 0;
  let droppedCount = 0;
  for (const row of ordered) {
    const label = `[memory ${row.id} | ${row.type} | conf ${row.confidence.toFixed(2)}]`;
    const full = `${label} ${row.title}\n${row.content}`;
    const short = `${label} ${row.title} — ${row.summary}`;
    const fullTokens = estimateTokens(full);
    const shortTokens = estimateTokens(short);
    if (tokensUsed + fullTokens <= budgetTokens) {
      packed.push({ id: row.id, rendered: full, tokens: fullTokens });
      tokensUsed += fullTokens;
    } else if (tokensUsed + shortTokens <= budgetTokens) {
      packed.push({ id: row.id, rendered: short, tokens: shortTokens });
      tokensUsed += shortTokens;
    } else {
      droppedCount += 1;
    }
  }
  return { packed, tokensUsed, droppedCount };
}

/** Similarity bands of 12 §5.5 (cosine thresholds are WRITER-DECISIONs). */
export const SIMILARITY_BANDS = {
  fastMerge: 0.95,
  compareMerge: 0.86,
  compareNoMerge: 0.7,
} as const;

export type SimilarityBand = "fast_merge" | "compare_merge" | "compare_no_merge" | "unrelated";

export function classifySimilarity(cosine: number): SimilarityBand {
  if (cosine >= SIMILARITY_BANDS.fastMerge) return "fast_merge";
  if (cosine >= SIMILARITY_BANDS.compareMerge) return "compare_merge";
  if (cosine >= SIMILARITY_BANDS.compareNoMerge) return "compare_no_merge";
  return "unrelated";
}
