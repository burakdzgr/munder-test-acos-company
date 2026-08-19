// Tool risk classes and task risk levels (_DECISIONS.md §12, §7).

/** Tool risk class: R0 read / R1 reversible write / R2 costly / R3 irreversible-or-external. */
export const RISK_CLASSES = ["R0", "R1", "R2", "R3"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(value: string): value is RiskClass {
  return (RISK_CLASSES as readonly string[]).includes(value);
}

/** true when `risk` is at most `ceiling` (R0 ≤ R1 ≤ R2 ≤ R3). */
export function riskAtMost(risk: RiskClass, ceiling: RiskClass): boolean {
  return RISK_CLASSES.indexOf(risk) <= RISK_CLASSES.indexOf(ceiling);
}

/** Task/approval risk level (_DECISIONS.md §7). */
export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

export function isTaskRisk(value: string): value is TaskRisk {
  return (TASK_RISKS as readonly string[]).includes(value);
}

export function compareTaskRisk(a: TaskRisk, b: TaskRisk): -1 | 0 | 1 {
  const diff = TASK_RISKS.indexOf(a) - TASK_RISKS.indexOf(b);
  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return 0;
}

/** What a tool touches (_DECISIONS.md §12). */
export const RESOURCE_SCOPES = ["fs", "git", "network", "db", "money", "publish"] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];
