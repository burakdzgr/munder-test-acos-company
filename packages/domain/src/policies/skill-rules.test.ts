// T47 acceptance (13 §3–4): golden numeric cases — including the §4.3 worked
// example digit-for-digit — plus monotonicity properties of the deterministic
// level formula.
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WEIGHTS,
  SKILL_LEVEL_THRESHOLDS,
  clampEvidenceWeight,
  computeSkillLevel,
  decayedSkillScore,
  promotionNeedsFounder,
  type SkillEvidenceItem,
} from "./skill-rules.js";

const e = (
  kind: SkillEvidenceItem["kind"],
  ageDays: number,
  weight?: number,
  isPromotionReview?: boolean,
): SkillEvidenceItem => ({
  kind,
  weight: weight ?? EVIDENCE_WEIGHTS[kind],
  ageDays,
  ...(isPromotionReview !== undefined && { isPromotionReview }),
});

/** The 13 §4.3 worked example — Alex's code-review trail on 2026-08-10. */
const ALEX_ROWS_1_TO_8: SkillEvidenceItem[] = [
  e("task_success", 300, 0.3),
  e("review_accepted", 200, 0.5),
  e("failure", 150, -0.4),
  e("failure_resolved", 145, 0.6),
  e("review_accepted", 90, 0.5),
  e("peer_eval", 60, 0.4),
  e("review_accepted", 30, 0.5),
  e("task_success", 20, 0.3),
];
const ALEX_ROW_9 = e("manager_eval", 5, 0.6);

describe("golden numeric cases (13 §4.3)", () => {
  it("reproduces every per-row contribution of the worked example", () => {
    const expected = [0.094, 0.232, -0.224, 0.343, 0.354, 0.318, 0.445, 0.278, 0.589];
    [...ALEX_ROWS_1_TO_8, ALEX_ROW_9].forEach((row, i) => {
      expect(decayedSkillScore([row])).toBeCloseTo(expected[i]!, 2);
    });
  });

  it("S = 1.840 before row 9 and 2.429 after — still level 2 (hysteresis holds)", () => {
    expect(decayedSkillScore(ALEX_ROWS_1_TO_8)).toBeCloseTo(1.84, 2);
    const after = computeSkillLevel([...ALEX_ROWS_1_TO_8, ALEX_ROW_9], 2);
    expect(after.score).toBeCloseTo(2.429, 2);
    // S=2.429 < threshold(2)=3.0, but ≥ 3.0−1.0 hysteresis ⇒ level 2 holds
    expect(after.level).toBe(2);
    expect(after.direction).toBe("none");
    // anti-gamification: nine mostly-positive rows over ten months stay far
    // below the level-3 threshold — volume alone cannot reach level 3
    expect(after.score).toBeLessThan(SKILL_LEVEL_THRESHOLDS[3]);
  });

  it("sustained recent high-value evidence crosses into level 3 (the §4.3 continuation)", () => {
    const aged = [...ALEX_ROWS_1_TO_8, ALEX_ROW_9].map((row) => ({
      ...row,
      ageDays: row.ageDays + 90, // one quarter passes
    }));
    // volume alone stalled at 2.4; a sustained streak of recent high-value
    // signals (reviews + production results) is what crosses the threshold
    const fresh = [
      ...Array.from({ length: 10 }, (_, i) => e("review_accepted", i * 7, 0.5)),
      e("production_result", 5, 0.7),
      e("production_result", 20, 0.7),
      e("production_result", 40, 0.7),
    ];
    const result = computeSkillLevel([...aged, ...fresh], 2);
    expect(result.score).toBeGreaterThanOrEqual(8.0);
    expect(result.level).toBe(3); // distinct kinds ✓, acceptance signal ✓
    expect(result.direction).toBe("up");
  });

  it("levels 4–5 are artifact-gated: score alone never suffices (senior+ rule, _DECISIONS §11)", () => {
    // 40 fresh review_accepted rows ⇒ S ≈ 20 ≥ 16, gates 2–3 pass
    const bulk = Array.from({ length: 40 }, (_, i) => e("review_accepted", i % 7, 0.5));
    const noArtifact = computeSkillLevel([...bulk, e("production_result", 3, 0.7)], 3);
    expect(noArtifact.score).toBeGreaterThanOrEqual(16);
    expect(noArtifact.level).toBe(3); // blocked without promotion_review

    const oneReview = computeSkillLevel(
      [...bulk, e("production_result", 3, 0.7), e("manager_eval", 2, 0.6, true)],
      3,
    );
    expect(oneReview.level).toBe(4);

    // level 5: S ≥ 28 + positive production_result + a SECOND promotion_review
    const heavy = Array.from({ length: 60 }, (_, i) => e("review_accepted", i % 5, 0.5));
    const one = computeSkillLevel(
      [...heavy, e("production_result", 3, 0.7), e("manager_eval", 2, 0.6, true)],
      4,
    );
    expect(one.score).toBeGreaterThanOrEqual(28);
    expect(one.level).toBe(4); // one artifact is not enough
    const two = computeSkillLevel(
      [
        ...heavy,
        e("production_result", 3, 0.7),
        e("manager_eval", 2, 0.6, true),
        e("manager_eval", 1, 0.6, true),
      ],
      4,
    );
    expect(two.level).toBe(5);
  });

  it("downward moves are automatic below threshold − hysteresis; no artifact needed", () => {
    // a level-3 agent whose evidence has decayed to S ≈ 6.5: 8.0−1.0=7.0 > 6.5 ⇒ down
    const faded = Array.from({ length: 20 }, () => e("review_accepted", 500, 0.5));
    const result = computeSkillLevel(faded, 3);
    expect(result.score).toBeLessThan(7.0);
    expect(result.level).toBeLessThan(3);
    expect(result.direction).toBe("down");
  });

  it("clamps proposed weights into each kind's band", () => {
    expect(clampEvidenceWeight("review_accepted")).toBe(0.5);
    expect(clampEvidenceWeight("review_accepted", 0.9)).toBe(0.6);
    expect(clampEvidenceWeight("failure", -0.95)).toBe(-0.8);
    expect(clampEvidenceWeight("failure", 0.5)).toBe(-0.2); // failures stay negative
    expect(clampEvidenceWeight("production_result", -0.7)).toBe(-0.7); // signed kind
  });

  it("founder gate applies to lead+ target seniorities only", () => {
    expect(promotionNeedsFounder("lead")).toBe(true);
    expect(promotionNeedsFounder("expert")).toBe(true);
    expect(promotionNeedsFounder("senior")).toBe(false);
    expect(promotionNeedsFounder("mid")).toBe(false);
  });
});

describe("monotonicity properties", () => {
  const base = [...ALEX_ROWS_1_TO_8, ALEX_ROW_9];

  it("adding positive evidence never lowers the score or the level", () => {
    for (const kind of ["task_success", "review_accepted", "production_result"] as const) {
      const before = computeSkillLevel(base, 2);
      const after = computeSkillLevel([...base, e(kind, 0)], 2);
      expect(after.score).toBeGreaterThan(before.score);
      expect(after.level).toBeGreaterThanOrEqual(before.level);
    }
  });

  it("aging every row never raises the score", () => {
    for (const extraAge of [30, 90, 365, 1000]) {
      const aged = base.map((row) => ({ ...row, ageDays: row.ageDays + extraAge }));
      expect(decayedSkillScore(aged)).toBeLessThanOrEqual(decayedSkillScore(base));
    }
  });

  it("negative evidence never raises the level and always lowers the score", () => {
    const before = computeSkillLevel(base, 2);
    const after = computeSkillLevel([...base, e("failure", 0, -0.4)], 2);
    expect(after.score).toBeLessThan(before.score);
    expect(after.level).toBeLessThanOrEqual(before.level);
  });

  it("the failure + failure_resolved pair nets positive but below a clean review_accepted (13 §5.5)", () => {
    const pair = decayedSkillScore([e("failure", 10, -0.4), e("failure_resolved", 5, 0.6)]);
    expect(pair).toBeGreaterThan(0);
    expect(pair).toBeLessThan(decayedSkillScore([e("review_accepted", 5, 0.5)]));
  });

  it("levels stay within 1–5 and hysteresis only ever holds, never lifts", () => {
    for (const current of [1, 2, 3, 4, 5]) {
      const result = computeSkillLevel(base, current);
      expect(result.level).toBeGreaterThanOrEqual(1);
      expect(result.level).toBeLessThanOrEqual(5);
      // holding via hysteresis can keep `current`, but never exceed what the
      // gates would qualify upward from below
      if (result.level > current) {
        expect(computeSkillLevel(base, 1).level).toBeGreaterThanOrEqual(result.level);
      }
    }
  });
});
