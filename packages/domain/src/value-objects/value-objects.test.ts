import { describe, expect, it } from "vitest";
import { addMoney, compareMoney, money, subtractMoney } from "./money.js";
import {
  compareTaskRisk,
  isRiskClass,
  isTaskRisk,
  riskAtMost,
  RESOURCE_SCOPES,
} from "./risk.js";
import { AUTONOMY_LEVELS, isAutonomyLevel } from "./autonomy.js";
import { compareSeniority, isSeniority, requiresPromotionReview } from "./seniority.js";

describe("Money", () => {
  it("holds integer minor units with a 3-letter currency", () => {
    expect(money(1500, "USD")).toEqual({ amountCents: 1500, currency: "USD" });
  });

  it("rejects fractional amounts and malformed currencies", () => {
    expect(() => money(10.5, "USD")).toThrow("integer minor units");
    expect(() => money(10, "usd")).toThrow("3-letter uppercase");
    expect(() => money(10, "DOLLARS")).toThrow("3-letter uppercase");
  });

  it("adds, subtracts and compares within one currency", () => {
    const a = money(100, "TRY");
    const b = money(40, "TRY");
    expect(addMoney(a, b).amountCents).toBe(140);
    expect(subtractMoney(a, b).amountCents).toBe(60);
    expect(compareMoney(a, b)).toBe(1);
    expect(compareMoney(b, a)).toBe(-1);
    expect(compareMoney(a, money(100, "TRY"))).toBe(0);
  });

  it("refuses cross-currency arithmetic", () => {
    expect(() => addMoney(money(1, "USD"), money(1, "TRY"))).toThrow("cannot add");
    expect(() => subtractMoney(money(1, "USD"), money(1, "TRY"))).toThrow("cannot subtract");
    expect(() => compareMoney(money(1, "USD"), money(1, "TRY"))).toThrow("cannot compare");
  });
});

describe("RiskClass / TaskRisk", () => {
  it("orders risk classes R0 ≤ R1 ≤ R2 ≤ R3", () => {
    expect(riskAtMost("R0", "R2")).toBe(true);
    expect(riskAtMost("R2", "R2")).toBe(true);
    expect(riskAtMost("R3", "R2")).toBe(false);
  });

  it("guards membership", () => {
    expect(isRiskClass("R1")).toBe(true);
    expect(isRiskClass("R9")).toBe(false);
    expect(isTaskRisk("critical")).toBe(true);
    expect(isTaskRisk("extreme")).toBe(false);
  });

  it("orders task risks", () => {
    expect(compareTaskRisk("low", "high")).toBe(-1);
    expect(compareTaskRisk("critical", "medium")).toBe(1);
    expect(compareTaskRisk("high", "high")).toBe(0);
  });

  it("resource scopes are the canonical six", () => {
    expect(RESOURCE_SCOPES).toEqual(["fs", "git", "network", "db", "money", "publish"]);
  });
});

describe("AutonomyLevel", () => {
  it("accepts 0–5, rejects outside and fractional", () => {
    for (const level of AUTONOMY_LEVELS) expect(isAutonomyLevel(level)).toBe(true);
    expect(isAutonomyLevel(6)).toBe(false);
    expect(isAutonomyLevel(-1)).toBe(false);
    expect(isAutonomyLevel(2.5)).toBe(false);
  });
});

describe("Seniority", () => {
  it("orders junior → expert", () => {
    expect(compareSeniority("junior", "expert")).toBe(-1);
    expect(compareSeniority("lead", "mid")).toBe(1);
    expect(compareSeniority("staff", "staff")).toBe(0);
  });

  it("guards membership", () => {
    expect(isSeniority("staff")).toBe(true);
    expect(isSeniority("intern")).toBe(false);
  });

  it("senior+ requires a promotion review artifact (_DECISIONS §11)", () => {
    expect(requiresPromotionReview("mid")).toBe(false);
    expect(requiresPromotionReview("senior")).toBe(true);
    expect(requiresPromotionReview("expert")).toBe(true);
  });
});
