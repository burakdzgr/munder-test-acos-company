// The canonical autonomy × risk × scope decision function (_DECISIONS.md §12,
// 06-AUTONOMY-AND-ESCALATION.md §1–2). Pure: all IO results (grants, policy
// rows, budgets) are evaluated by the caller and passed in. The Tool Gateway
// (T39) and agent-worker action dispatch both call this single implementation.
import type { AutonomyLevel } from "../value-objects/autonomy.js";
import { RISK_CLASSES, type RiskClass } from "../value-objects/risk.js";

export type ScopeRelation = "own_team" | "own_department" | "company" | "external";

export type EscalationTarget = "manager" | "executive" | "founder";

export type Decision =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string; redirect?: EscalationTarget }
  | { verdict: "require_approval"; approver: EscalationTarget; briefRequired: true };

/**
 * maxRisk per autonomy level and resource-scope relation (06 §1).
 * null = no execution cap reached (L0 observe-only denies everything;
 * L1 executes only explicitly granted R0 reads).
 */
export function maxRisk(level: AutonomyLevel, scope: ScopeRelation): RiskClass | null {
  switch (level) {
    case 0:
      return null;
    case 1:
      return "R0";
    case 2:
      return "R1";
    case 3:
      return scope === "own_team" ? "R2" : "R1";
    case 4:
      return scope === "own_team" || scope === "own_department" ? "R2" : "R1";
    case 5:
      return "R2"; // R3 only via standing policy grants (checked in authorize)
  }
}

function rank(risk: RiskClass | null): number {
  return risk === null ? -1 : RISK_CLASSES.indexOf(risk);
}

export interface AuthorizeInput {
  readonly autonomyLevel: AutonomyLevel;
  readonly riskClass: RiskClass;
  readonly scopeRelation: ScopeRelation;
  /** Founder-only category (payments, legal, credentials, destructive prod) — S6. */
  readonly founderOnlyCategory: boolean;
  /** Standing policy grant covering this exact action (narrow L5 R3 lines). */
  readonly hasStandingGrant: boolean;
  /** A tool_permissions grant exists for this agent/action. */
  readonly permissionGranted: boolean;
  /** The grant's constraints (path prefix, repo list, spend cap) hold. */
  readonly constraintsSatisfied: boolean;
  /** A tenant policy rule denies this action. */
  readonly policyDeny: boolean;
  readonly policyDenyReason?: string;
  readonly estCostCents: number;
  /** Remaining budget on the tightest applicable scope. */
  readonly budgetRemainingCents: number;
  /** Whether that tightest budget is a hard limit. */
  readonly budgetHard: boolean;
  /** S5 provenance flag: action was influenced by external content. */
  readonly externallyInfluenced: boolean;
}

/** Steps 1–8 of 06 §2, in order. First matching rule wins. */
export function authorize(input: AuthorizeInput): Decision {
  // 1. Hard platform policy — Founder-only categories are not tenant-editable (S6).
  if (input.founderOnlyCategory && !input.hasStandingGrant) {
    return { verdict: "require_approval", approver: "founder", briefRequired: true };
  }

  // 3. Least privilege: no grant → deny; violated constraints → deny.
  if (!input.permissionGranted) {
    return { verdict: "deny", reason: "NO_PERMISSION_GRANT" };
  }
  if (!input.constraintsSatisfied) {
    return { verdict: "deny", reason: "GRANT_CONSTRAINT_VIOLATED" };
  }

  // 4. Tenant policy rules — first matching deny wins.
  if (input.policyDeny) {
    return { verdict: "deny", reason: input.policyDenyReason ?? "POLICY_DENY" };
  }

  // 5. Budget on the tightest applicable scope.
  if (input.estCostCents > input.budgetRemainingCents) {
    return input.budgetHard
      ? { verdict: "deny", reason: "BUDGET_EXCEEDED", redirect: "manager" }
      : { verdict: "require_approval", approver: "manager", briefRequired: true };
  }

  // 6. Autonomy × risk × scope cap. L5's "limited R3" (06 §1) is exactly a
  // standing policy grant: with one, R3 bypasses the over-cap escalation and
  // is settled by step 7.
  const cap = maxRisk(input.autonomyLevel, input.scopeRelation);
  const l5GrantedR3 =
    input.riskClass === "R3" && input.autonomyLevel === 5 && input.hasStandingGrant;
  if (rank(input.riskClass) > rank(cap) && !l5GrantedR3) {
    if (input.autonomyLevel === 0) {
      return { verdict: "deny", reason: "L0_OBSERVE_ONLY", redirect: "manager" };
    }
    if (input.autonomyLevel === 1) {
      return { verdict: "require_approval", approver: "manager", briefRequired: true };
    }
    return {
      verdict: "require_approval",
      approver:
        input.riskClass === "R3"
          ? "founder"
          : input.scopeRelation === "company"
            ? "executive"
            : "manager",
      briefRequired: true,
    };
  }

  // 7. R3 default: even within cap, R3 needs a standing grant or the Founder.
  if (input.riskClass === "R3" && !input.hasStandingGrant) {
    return { verdict: "require_approval", approver: "founder", briefRequired: true };
  }

  // 8. Prompt-injection defense (S5): externally-influenced R2+ gets elevated review.
  if (input.externallyInfluenced && rank(input.riskClass) >= rank("R2")) {
    return { verdict: "require_approval", approver: "manager", briefRequired: true };
  }

  return { verdict: "allow" };
}
