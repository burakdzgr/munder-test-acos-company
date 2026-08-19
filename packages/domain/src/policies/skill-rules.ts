// Skill evidence weights + the deterministic level formula (13 §3–4,
// _DECISIONS §11). Levels are NEVER LLM-set: `computeSkillLevel` is a pure
// function over the evidence trail — exhaustively unit-tested, called from
// the SkillsService recompute.

export const SKILL_EVIDENCE_KINDS = [
  "task_success",
  "review_accepted",
  "production_result",
  "peer_eval",
  "manager_eval",
  "experiment",
  "failure",
  "failure_resolved",
] as const;
export type SkillEvidenceKind = (typeof SKILL_EVIDENCE_KINDS)[number];

/** Default weights + allowed bands per kind (13 §3 — WRITER-DECISION table). */
export const EVIDENCE_WEIGHTS: Record<SkillEvidenceKind, number> = {
  task_success: 0.3,
  review_accepted: 0.5,
  production_result: 0.7, // signed by outcome — negative on breach
  peer_eval: 0.4,
  manager_eval: 0.6,
  experiment: 0.5,
  failure: -0.4,
  failure_resolved: 0.6,
};

export const EVIDENCE_BANDS: Record<SkillEvidenceKind, { min: number; max: number }> = {
  task_success: { min: 0.1, max: 0.4 },
  review_accepted: { min: 0.3, max: 0.6 },
  production_result: { min: -0.9, max: 0.9 },
  peer_eval: { min: -0.5, max: 0.5 },
  manager_eval: { min: -0.7, max: 0.7 },
  experiment: { min: -0.6, max: 0.6 },
  failure: { min: -0.8, max: -0.2 },
  failure_resolved: { min: 0.4, max: 0.8 },
};

/** Clamp a proposed weight into its kind's band (13 §3). */
export function clampEvidenceWeight(kind: SkillEvidenceKind, weight?: number): number {
  const band = EVIDENCE_BANDS[kind];
  const value = weight ?? EVIDENCE_WEIGHTS[kind];
  return Math.min(band.max, Math.max(band.min, value));
}

/** Evidence half-life: contributions halve every 180 days (13 §4.1). */
export const SKILL_DECAY_HALF_LIFE_DAYS = 180;

/** Downward hysteresis margin below the current level's threshold (13 §4.2). */
export const SKILL_LEVEL_HYSTERESIS = 1.0;

/** S ≥ threshold to hold each level (13 §4.2 — WRITER-DECISION values). */
export const SKILL_LEVEL_THRESHOLDS: Record<2 | 3 | 4 | 5, number> = {
  2: 3.0,
  3: 8.0,
  4: 16.0,
  5: 28.0,
};

export interface SkillEvidenceItem {
  readonly kind: SkillEvidenceKind;
  readonly weight: number;
  readonly ageDays: number;
  /** manager_eval rows backed by an accepted promotion_review artifact (13 §4.2 L4–5 gate) */
  readonly isPromotionReview?: boolean;
}

/** S(as,t) = Σ weight · 2^(−age/H) (13 §4.1). */
export function decayedSkillScore(
  evidence: readonly SkillEvidenceItem[],
  halfLifeDays: number = SKILL_DECAY_HALF_LIFE_DAYS,
): number {
  return evidence.reduce(
    (sum, e) => sum + e.weight * Math.pow(2, -Math.max(0, e.ageDays) / halfLifeDays),
    0,
  );
}

export interface SkillLevelResult {
  readonly score: number;
  readonly level: 1 | 2 | 3 | 4 | 5;
  readonly direction: "up" | "down" | "none";
  /** MVP confidence: progress toward the next threshold + trail depth (recorded) */
  readonly confidence: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The deterministic level recompute (13 §4.2): thresholds + gates upward,
 * automatic downward moves with a 1.0 hysteresis margin (no artifact needed
 * to go down). Levels 4–5 require accepted promotion_review manager
 * artifacts; level 5 additionally a positive production_result.
 */
export function computeSkillLevel(
  evidence: readonly SkillEvidenceItem[],
  currentLevel: number,
): SkillLevelResult {
  const score = decayedSkillScore(evidence);
  const positiveKinds = new Set(evidence.filter((e) => e.weight > 0).map((e) => e.kind));
  const hasAcceptanceSignal = evidence.some(
    (e) => (e.kind === "review_accepted" || e.kind === "production_result") && e.weight > 0,
  );
  const hasPositiveProduction = evidence.some(
    (e) => e.kind === "production_result" && e.weight > 0,
  );
  const promotionReviews = evidence.filter(
    (e) => e.kind === "manager_eval" && e.isPromotionReview === true && e.weight > 0,
  ).length;

  const gate2 = score >= SKILL_LEVEL_THRESHOLDS[2] && evidence.length >= 5;
  const gate3 = score >= SKILL_LEVEL_THRESHOLDS[3] && positiveKinds.size >= 2 && hasAcceptanceSignal;
  const gate4 = gate3 && score >= SKILL_LEVEL_THRESHOLDS[4] && promotionReviews >= 1;
  const gate5 = gate4 && score >= SKILL_LEVEL_THRESHOLDS[5] && hasPositiveProduction && promotionReviews >= 2;
  const qualified: 1 | 2 | 3 | 4 | 5 = gate5 ? 5 : gate4 ? 4 : gate3 ? 3 : gate2 ? 2 : 1;

  const current = Math.min(5, Math.max(1, Math.round(currentLevel))) as 1 | 2 | 3 | 4 | 5;
  let level: 1 | 2 | 3 | 4 | 5 = qualified;
  if (qualified < current) {
    // hold the current level unless S fell below its threshold minus the margin
    const holdThreshold =
      current >= 2 ? SKILL_LEVEL_THRESHOLDS[current as 2 | 3 | 4 | 5] - SKILL_LEVEL_HYSTERESIS : 0;
    level = score >= holdThreshold ? current : qualified;
  }

  const nextThreshold = level >= 5 ? SKILL_LEVEL_THRESHOLDS[5] : SKILL_LEVEL_THRESHOLDS[(level + 1) as 2 | 3 | 4 | 5];
  const confidence = clamp01(
    0.2 + 0.6 * clamp01(score / nextThreshold) + 0.02 * Math.min(evidence.length, 10),
  );

  return {
    score,
    level,
    direction: level > current ? "up" : level < current ? "down" : "none",
    confidence,
  };
}

/** Seniority → default autonomy level (13 §6.2 — WRITER-DECISION mapping). */
export const SENIORITY_DEFAULT_AUTONOMY: Record<string, number> = {
  junior: 1,
  mid: 2,
  senior: 3,
  staff: 3,
  lead: 4,
  expert: 4,
};

/** Founder approval is required for target seniority lead+ (13 §6.1 step 4). */
export const FOUNDER_GATED_SENIORITIES = ["lead", "expert"] as const;
export function promotionNeedsFounder(targetSeniority: string): boolean {
  return (FOUNDER_GATED_SENIORITIES as readonly string[]).includes(targetSeniority);
}
