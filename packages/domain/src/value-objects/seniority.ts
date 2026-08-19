// Evidence-driven career position (_DECISIONS.md §6).
export const SENIORITIES = ["junior", "mid", "senior", "staff", "lead", "expert"] as const;
export type Seniority = (typeof SENIORITIES)[number];

export function isSeniority(value: string): value is Seniority {
  return (SENIORITIES as readonly string[]).includes(value);
}

export function compareSeniority(a: Seniority, b: Seniority): -1 | 0 | 1 {
  const diff = SENIORITIES.indexOf(a) - SENIORITIES.indexOf(b);
  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return 0;
}

/** senior+ levels require a manager promotion_review artifact (_DECISIONS.md §11). */
export function requiresPromotionReview(target: Seniority): boolean {
  return compareSeniority(target, "senior") >= 0;
}
