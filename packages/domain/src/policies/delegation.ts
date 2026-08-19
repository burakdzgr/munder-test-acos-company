// Delegation limits + pro-rata budget inheritance (_DECISIONS.md §7, 07 §6–9).
import { DomainError } from "../errors.js";

export const MAX_DELEGATION_DEPTH = 5;
export const MAX_REASSIGNMENTS = 3;

/** depth of the would-be child (goal=0 … subtask≤5). */
export function canDelegate(childDepth: number): boolean {
  return Number.isInteger(childDepth) && childDepth >= 0 && childDepth <= MAX_DELEGATION_DEPTH;
}

/**
 * Reassignment counter increments whenever owner changes after first
 * assignment; the 4th attempt is refused (07 §8).
 */
export function canReassign(reassignmentCount: number): boolean {
  return reassignmentCount < MAX_REASSIGNMENTS;
}

/** 20% stays reserved at the parent for review/coordination/rework (07 §9). */
export const PARENT_BUDGET_RESERVE_RATIO = 0.2;

/**
 * floor(B × 0.8 × wi / Σw) per child; remainder stays at the parent.
 * Returns child budgets in input order plus the parent reserve.
 */
export function splitBudgetProRata(
  parentBudgetCents: number,
  weights: readonly number[],
): { children: number[]; parentReserveCents: number } {
  if (!Number.isInteger(parentBudgetCents) || parentBudgetCents < 0) {
    throw new DomainError(`parent budget must be a non-negative integer, got ${parentBudgetCents}`);
  }
  if (weights.length === 0) throw new DomainError("at least one child weight is required");
  if (weights.some((w) => !Number.isFinite(w) || w <= 0)) {
    throw new DomainError("child weights must be positive numbers");
  }
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const distributable = parentBudgetCents * (1 - PARENT_BUDGET_RESERVE_RATIO);
  const children = weights.map((w) => Math.floor((distributable * w) / totalWeight));
  const parentReserveCents = parentBudgetCents - children.reduce((sum, c) => sum + c, 0);
  return { children, parentReserveCents };
}
