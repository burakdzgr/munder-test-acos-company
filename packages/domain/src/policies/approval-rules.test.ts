// T35 acceptance (32 §2): S6 as an exhaustive GENERATED matrix — for every
// combination of the remaining authorize() axes, a Founder-only category
// without the delegated standing-grant band is require_approval(founder).
import { describe, expect, it } from "vitest";
import { authorize, type AuthorizeInput } from "./authorize.js";
import {
  APPROVAL_EXPIRY_HOURS,
  APPROVAL_KINDS,
  APPROVAL_REMINDER_FRACTIONS,
  approvalExpiresAt,
  approvalReminderAt,
  FOUNDER_ONLY_APPROVAL_KINDS,
  FOUNDER_ONLY_CATEGORIES,
  isApprovalKind,
  isFounderOnlyCategory,
} from "./approval-rules.js";
import { AUTONOMY_LEVELS } from "../value-objects/autonomy.js";
import { RISK_CLASSES } from "../value-objects/risk.js";

const SCOPES = ["own_team", "own_department", "company", "external"] as const;
const BOOLS = [false, true] as const;

describe("S6 matrix — Founder-only categories are ALWAYS require_approval(founder)", () => {
  it("holds for every generated combination of the other axes (no samples)", () => {
    let combos = 0;
    for (const autonomyLevel of AUTONOMY_LEVELS) {
      for (const riskClass of RISK_CLASSES) {
        for (const scopeRelation of SCOPES) {
          for (const permissionGranted of BOOLS) {
            for (const constraintsSatisfied of BOOLS) {
              for (const policyDeny of BOOLS) {
                for (const budgetHard of BOOLS) {
                  for (const overBudget of BOOLS) {
                    for (const externallyInfluenced of BOOLS) {
                      const input: AuthorizeInput = {
                        autonomyLevel,
                        riskClass,
                        scopeRelation,
                        founderOnlyCategory: true,
                        hasStandingGrant: false,
                        permissionGranted,
                        constraintsSatisfied,
                        policyDeny,
                        estCostCents: overBudget ? 1000 : 10,
                        budgetRemainingCents: 100,
                        budgetHard,
                        externallyInfluenced,
                      };
                      expect(
                        authorize(input),
                        `L${autonomyLevel}/${riskClass}/${scopeRelation}/grant=${permissionGranted}`,
                      ).toEqual({
                        verdict: "require_approval",
                        approver: "founder",
                        briefRequired: true,
                      });
                      combos += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // 6 levels × 4 risks × 4 scopes × 2^6 boolean axes
    expect(combos).toBe(6 * 4 * 4 * 64);
  });

  it("the ONLY carve-out is the delegated spend band (standing grant, 19 §8)", () => {
    // with a standing grant the S6 short-circuit is skipped and the normal
    // pipeline decides — here everything else is green, so it allows
    expect(
      authorize({
        autonomyLevel: 5,
        riskClass: "R1",
        scopeRelation: "own_team",
        founderOnlyCategory: true,
        hasStandingGrant: true,
        permissionGranted: true,
        constraintsSatisfied: true,
        policyDeny: false,
        estCostCents: 10,
        budgetRemainingCents: 1000,
        budgetHard: true,
        externallyInfluenced: false,
      }),
    ).toEqual({ verdict: "allow" });
  });

  it("hard-codes the platform category list (payments, legal, credentials, destructive_prod)", () => {
    expect([...FOUNDER_ONLY_CATEGORIES]).toEqual([
      "payments",
      "legal",
      "credentials",
      "destructive_prod",
    ]);
    expect(isFounderOnlyCategory("legal")).toBe(true);
    expect(isFounderOnlyCategory("marketing")).toBe(false);
  });

  it("maps the canonical kind enum and its non-delegable subset", () => {
    expect(APPROVAL_KINDS).toHaveLength(8);
    expect(isApprovalKind("vendor")).toBe(true);
    expect(isApprovalKind("spend")).toBe(false); // doc-19 alias, not canonical
    for (const kind of FOUNDER_ONLY_APPROVAL_KINDS) expect(isApprovalKind(kind)).toBe(true);
  });
});

describe("approval expiry derivation (19 §6)", () => {
  const created = new Date("2026-08-11T00:00:00Z");

  it("windows per urgency: 24h/48h/72h/7d", () => {
    expect(APPROVAL_EXPIRY_HOURS).toEqual({ critical: 24, high: 48, normal: 72, low: 168 });
    expect(approvalExpiresAt(created, "normal").toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(approvalExpiresAt(created, "critical").toISOString()).toBe("2026-08-12T00:00:00.000Z");
    expect(approvalExpiresAt(created, "low").toISOString()).toBe("2026-08-18T00:00:00.000Z");
  });

  it("is never later than the business deadline", () => {
    const deadline = new Date("2026-08-12T12:00:00Z");
    expect(approvalExpiresAt(created, "low", deadline).toISOString()).toBe(
      deadline.toISOString(),
    );
    // a deadline after the window does not extend it
    const lateDeadline = new Date("2026-09-01T00:00:00Z");
    expect(approvalExpiresAt(created, "critical", lateDeadline).toISOString()).toBe(
      "2026-08-12T00:00:00.000Z",
    );
  });

  it("reminder points sit at 50% and 85% of the window", () => {
    const expires = approvalExpiresAt(created, "critical"); // 24h window
    expect(APPROVAL_REMINDER_FRACTIONS).toEqual([0.5, 0.85]);
    expect(approvalReminderAt(created, expires, 0.5).toISOString()).toBe(
      "2026-08-11T12:00:00.000Z",
    );
    expect(approvalReminderAt(created, expires, 0.85).toISOString()).toBe(
      "2026-08-11T20:24:00.000Z",
    );
  });
});
