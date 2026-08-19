// Agent autonomy level 0–5 (_DECISIONS.md §6, §12; semantics in 06-AUTONOMY).
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export function isAutonomyLevel(value: number): value is AutonomyLevel {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}
