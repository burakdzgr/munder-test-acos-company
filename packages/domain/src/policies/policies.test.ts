import { describe, expect, it } from "vitest";
import { authorize, maxRisk, type AuthorizeInput } from "./authorize.js";
import {
  canDelegate,
  canReassign,
  MAX_DELEGATION_DEPTH,
  splitBudgetProRata,
} from "./delegation.js";
import {
  actionHash,
  budgetExhausted,
  deadlinePassed,
  loopDetected,
  nextPingPongCounter,
  pingPongTripped,
  stepCapState,
  type PingPongCounter,
} from "./guards.js";
import {
  IMPORTANCE_DISCARD_THRESHOLD,
  adjustImportance,
  canCreateCompanyScopeMemory,
  canPromoteToCompany,
  canProposeProjectPromotion,
  classifySimilarity,
  computeConsolidationConfidence,
  detectMemoryScope,
  estimateTokens,
  packMemories,
  recencyDecay,
  scoreMemoryRetrieval,
  type PackableMemory,
} from "./memory-rules.js";
import { forecastBreach, projectedSpendCents } from "./cost-rules.js";
import {
  escalationChain,
  hasActiveManager,
  wouldCreateReportsToCycle,
  type ReportsToEdge,
} from "./org-forest.js";
import { AUTONOMY_LEVELS } from "../value-objects/autonomy.js";
import { RISK_CLASSES } from "../value-objects/risk.js";

const SCOPES = ["own_team", "own_department", "company", "external"] as const;

function baseInput(overrides: Partial<AuthorizeInput> = {}): AuthorizeInput {
  return {
    autonomyLevel: 3,
    riskClass: "R1",
    scopeRelation: "own_team",
    founderOnlyCategory: false,
    hasStandingGrant: false,
    permissionGranted: true,
    constraintsSatisfied: true,
    policyDeny: false,
    estCostCents: 10,
    budgetRemainingCents: 1000,
    budgetHard: true,
    externallyInfluenced: false,
    ...overrides,
  };
}

describe("maxRisk matrix (_DECISIONS §12, 06 §1) — exhaustive", () => {
  it("matches the canonical table for every (level, scope) pair", () => {
    const expected: Record<number, Record<(typeof SCOPES)[number], string | null>> = {
      0: { own_team: null, own_department: null, company: null, external: null },
      1: { own_team: "R0", own_department: "R0", company: "R0", external: "R0" },
      2: { own_team: "R1", own_department: "R1", company: "R1", external: "R1" },
      3: { own_team: "R2", own_department: "R1", company: "R1", external: "R1" },
      4: { own_team: "R2", own_department: "R2", company: "R1", external: "R1" },
      5: { own_team: "R2", own_department: "R2", company: "R2", external: "R2" },
    };
    for (const level of AUTONOMY_LEVELS) {
      for (const scope of SCOPES) {
        expect(maxRisk(level, scope), `L${level}/${scope}`).toBe(expected[level]![scope]);
      }
    }
  });
});

describe("authorize (06 §2, steps in order)", () => {
  it("founder-only categories always require Founder approval (S6)", () => {
    expect(authorize(baseInput({ founderOnlyCategory: true }))).toEqual({
      verdict: "require_approval",
      approver: "founder",
      briefRequired: true,
    });
  });

  it("no grant → deny; violated constraints → deny (least privilege)", () => {
    expect(authorize(baseInput({ permissionGranted: false }))).toMatchObject({
      verdict: "deny",
      reason: "NO_PERMISSION_GRANT",
    });
    expect(authorize(baseInput({ constraintsSatisfied: false }))).toMatchObject({
      verdict: "deny",
      reason: "GRANT_CONSTRAINT_VIOLATED",
    });
  });

  it("tenant policy deny wins with its reason", () => {
    expect(
      authorize(baseInput({ policyDeny: true, policyDenyReason: "NO_PROD_ON_FRIDAY" })),
    ).toMatchObject({ verdict: "deny", reason: "NO_PROD_ON_FRIDAY" });
  });

  it("hard budget breach denies; soft breach escalates to manager", () => {
    expect(
      authorize(baseInput({ estCostCents: 5000, budgetRemainingCents: 100, budgetHard: true })),
    ).toMatchObject({ verdict: "deny", reason: "BUDGET_EXCEEDED" });
    expect(
      authorize(baseInput({ estCostCents: 5000, budgetRemainingCents: 100, budgetHard: false })),
    ).toMatchObject({ verdict: "require_approval", approver: "manager" });
  });

  it("L0 denies everything; L1 converts execution to manager approval", () => {
    expect(authorize(baseInput({ autonomyLevel: 0, riskClass: "R0" }))).toMatchObject({
      verdict: "deny",
      reason: "L0_OBSERVE_ONLY",
    });
    expect(authorize(baseInput({ autonomyLevel: 1, riskClass: "R1" }))).toMatchObject({
      verdict: "require_approval",
      approver: "manager",
    });
    // L1 R0 with an explicit grant is allowed
    expect(authorize(baseInput({ autonomyLevel: 1, riskClass: "R0" }))).toEqual({
      verdict: "allow",
    });
  });

  it("over-cap actions escalate by risk and scope", () => {
    // L3 outside own team: R2 → manager approval
    expect(
      authorize(baseInput({ autonomyLevel: 3, riskClass: "R2", scopeRelation: "own_department" })),
    ).toMatchObject({ verdict: "require_approval", approver: "manager" });
    // company-wide over-cap → executive
    expect(
      authorize(baseInput({ autonomyLevel: 3, riskClass: "R2", scopeRelation: "company" })),
    ).toMatchObject({ verdict: "require_approval", approver: "executive" });
    // R3 over cap → founder
    expect(
      authorize(baseInput({ autonomyLevel: 4, riskClass: "R3", scopeRelation: "own_team" })),
    ).toMatchObject({ verdict: "require_approval", approver: "founder" });
  });

  it("R3 within L5 cap still needs a standing grant, else Founder", () => {
    expect(
      authorize(baseInput({ autonomyLevel: 5, riskClass: "R3", hasStandingGrant: false })),
    ).toMatchObject({ verdict: "require_approval", approver: "founder" });
    expect(
      authorize(baseInput({ autonomyLevel: 5, riskClass: "R3", hasStandingGrant: true })),
    ).toEqual({ verdict: "allow" });
  });

  it("externally-influenced R2+ gets elevated review (S5)", () => {
    expect(
      authorize(baseInput({ autonomyLevel: 5, riskClass: "R2", externallyInfluenced: true })),
    ).toMatchObject({ verdict: "require_approval", approver: "manager" });
    expect(
      authorize(baseInput({ riskClass: "R1", externallyInfluenced: true })),
    ).toEqual({ verdict: "allow" });
  });

  it("in-cap, granted, funded actions are allowed for every risk ≤ cap", () => {
    for (const level of [2, 3, 4, 5] as const) {
      for (const risk of RISK_CLASSES) {
        const cap = maxRisk(level, "own_team");
        if (cap !== null && RISK_CLASSES.indexOf(risk) <= RISK_CLASSES.indexOf(cap) && risk !== "R3") {
          expect(
            authorize(baseInput({ autonomyLevel: level, riskClass: risk })),
            `L${level} ${risk}`,
          ).toEqual({ verdict: "allow" });
        }
      }
    }
  });
});

describe("delegation limits (07 §6–9)", () => {
  it("depth ≤ 5, reassignments < 3", () => {
    expect(canDelegate(MAX_DELEGATION_DEPTH)).toBe(true);
    expect(canDelegate(MAX_DELEGATION_DEPTH + 1)).toBe(false);
    expect(canDelegate(-1)).toBe(false);
    expect(canReassign(2)).toBe(true);
    expect(canReassign(3)).toBe(false);
  });

  it("pro-rata split: floor(B × 0.8 × wi / Σw), remainder reserved at parent", () => {
    const { children, parentReserveCents } = splitBudgetProRata(10_000, [3, 2, 5]);
    expect(children).toEqual([2400, 1600, 4000]);
    expect(parentReserveCents).toBe(2000);
    expect(children.reduce((a, b) => a + b, 0) + parentReserveCents).toBe(10_000);
  });

  it("split conserves total for awkward weights (floor rounding)", () => {
    const { children, parentReserveCents } = splitBudgetProRata(1001, [1, 1, 1]);
    expect(children.every((c) => Number.isInteger(c))).toBe(true);
    expect(children.reduce((a, b) => a + b, 0) + parentReserveCents).toBe(1001);
    expect(parentReserveCents).toBeGreaterThanOrEqual(Math.floor(1001 * 0.2));
  });

  it("rejects invalid budgets and weights", () => {
    expect(() => splitBudgetProRata(-1, [1])).toThrow("non-negative");
    expect(() => splitBudgetProRata(100, [])).toThrow("at least one");
    expect(() => splitBudgetProRata(100, [1, 0])).toThrow("positive");
  });
});

describe("runaway guards (08 §9)", () => {
  it("(a) budget: trips at zero or below the estimated next step", () => {
    expect(budgetExhausted(0, 10)).toBe(true);
    expect(budgetExhausted(5, 10)).toBe(true);
    expect(budgetExhausted(100, 10)).toBe(false);
  });

  it("(b) deadline: trips strictly after the deadline; null never trips", () => {
    const deadline = new Date("2026-08-11T12:00:00Z");
    expect(deadlinePassed(new Date("2026-08-11T12:00:01Z"), deadline)).toBe(true);
    expect(deadlinePassed(deadline, deadline)).toBe(false);
    expect(deadlinePassed(new Date("2027-01-01T00:00:00Z"), null)).toBe(false);
  });

  it("(c) step cap: warn at 40, hard at 50", () => {
    expect(stepCapState(59)).toBe("ok");
    expect(stepCapState(60)).toBe("warn");
    expect(stepCapState(119)).toBe("warn");
    expect(stepCapState(120)).toBe("hard");
  });

  it("(d) loop detector: ≥3 equal hashes within last 6 steps", () => {
    const h = actionHash("use_tool", { tool: "fs.read", path: "/a" });
    const other = actionHash("use_tool", { tool: "fs.read", path: "/b" });
    expect(loopDetected([h, other, h, other, h])).toBe(true);
    expect(loopDetected([h, other, h, other])).toBe(false);
    // outside the 6-step window the early repeats no longer count
    const fillers = ["p1", "p2", "p3", "p4"].map((p) => actionHash("send_message", { body: p }));
    expect(loopDetected([h, h, ...fillers, h])).toBe(false);
  });

  it("(d) normalization: case, timestamps and uuids do not defeat the detector", () => {
    const a = actionHash("use_tool", {
      tool: "FS.READ",
      path: "/Repo/File.TS",
      requestedAt: "2026-08-11T00:00:00Z",
      id: "0198b2c3-aaaa-7bbb-8ccc-1234567890ab",
    });
    const b = actionHash("use_tool", {
      tool: "fs.read",
      path: "/repo/file.ts",
      requestedAt: "2026-08-11T09:09:09Z",
      id: "0198b2c3-ffff-7eee-8ddd-ba0987654321",
    });
    expect(a).toBe(b);
    expect(actionHash("use_tool", { tool: "fs.write" })).not.toBe(
      actionHash("use_tool", { tool: "fs.read" }),
    );
  });

  // Regression: the workflow kept a PRIVATE normalizer that folded every digit
  // to a placeholder ("line numbers, byte counts"). That also folded
  // src/file-1.ts and src/file-2.ts together, so writing a numbered series of
  // files — ordinary productive work — was reported as a loop and the agent
  // was stopped on its 3rd file. Numbered siblings must stay DISTINCT.
  it("(d) normalization: numbered siblings are different actions, not a loop", () => {
    const write = (n: number) =>
      actionHash("use_tool", { tool: "write_file", input: { path: `src/file-${n}.ts` }, reason: `step ${n}` });
    const series = [write(1), write(2), write(3), write(4), write(5), write(6)];
    expect(new Set(series).size).toBe(6);
    expect(loopDetected(series)).toBe(false);
    // …while the SAME file written over and over still trips
    expect(loopDetected([write(1), write(1), write(1)])).toBe(true);
  });

  it("(d) normalization: a uuid or stamp EMBEDDED in a string still collapses", () => {
    const call = (id: string) =>
      actionHash("use_tool", { tool: "run_command", command: `curl /api/v1/tasks/${id}` });
    const a = call("0198b2c3-aaaa-7bbb-8ccc-1234567890ab");
    const b = call("0198b2c3-ffff-7eee-8ddd-ba0987654321");
    expect(a).toBe(b); // a fresh nonce per attempt must not hide the repeat
    expect(loopDetected([a, b, call("0198b2c3-1111-7222-8333-444455556666")])).toBe(true);
    // same for a wall-clock stamp pasted into the argument
    const stamped = (ts: string) => actionHash("send_message", { note: `retry at ${ts}` });
    expect(stamped("2026-08-11T00:00:00Z")).toBe(stamped("2026-08-11T09:09:09Z"));
    // …but a genuinely different command is still a different action
    expect(call("0198b2c3-aaaa-7bbb-8ccc-1234567890ab")).not.toBe(
      actionHash("use_tool", { tool: "run_command", command: "curl /api/v1/agents" }),
    );
  });

  it("(d) normalization: long free text compares by its first 100 chars", () => {
    const base = "x".repeat(100);
    const say = (tail: string) => actionHash("send_message", { body: `${base}${tail}` });
    // a cosmetic late edit must not buy the agent another lap
    expect(say(" ping")).toBe(say(" pong"));
    // divergence INSIDE the compared prefix is still a different message
    expect(say("")).not.toBe(actionHash("send_message", { body: `${"y".repeat(100)}` }));
  });

  it("(d) the same file addressed relatively or under /work is one action", () => {
    const read = (path: string) => actionHash("use_tool", { tool: "fs.read", path });
    expect(read("./src/a.ts")).toBe(read("src/a.ts"));
    expect(read("/work/src/a.ts")).toBe(read("src/a.ts"));
  });

  it("(e) ping-pong: alternation counts, same-sender or new pair resets, >8 trips", () => {
    let counter: PingPongCounter | null = null;
    const msg = (senderId: string, recipientId: string) => ({
      channelId: "ch1",
      senderId,
      recipientId,
    });
    for (let i = 0; i < 9; i++) {
      counter = nextPingPongCounter(counter, i % 2 === 0 ? msg("a", "b") : msg("b", "a"));
    }
    expect(counter!.count).toBe(9);
    expect(pingPongTripped(counter!)).toBe(true);

    // same sender twice does not alternate
    const twice = nextPingPongCounter(counter, msg("a", "b"));
    const twiceAgain = nextPingPongCounter(twice, msg("a", "b"));
    expect(twiceAgain.count).toBe(1);

    // different pair resets
    const otherPair = nextPingPongCounter(counter, msg("a", "c"));
    expect(otherPair.count).toBe(1);
    expect(pingPongTripped(otherPair)).toBe(false);
  });
});

describe("memory rules (_DECISIONS §10)", () => {
  it("weighted retrieval score", () => {
    expect(
      scoreMemoryRetrieval({ cosine: 1, importance: 1, recencyDecay: 1, confidence: 1 }),
    ).toBeCloseTo(1);
    expect(
      scoreMemoryRetrieval({ cosine: 0.8, importance: 0.5, recencyDecay: 0.2, confidence: 0.9 }),
    ).toBeCloseTo(0.55 * 0.8 + 0.2 * 0.5 + 0.15 * 0.2 + 0.1 * 0.9);
    expect(() =>
      scoreMemoryRetrieval({ cosine: 1.2, importance: 0, recencyDecay: 0, confidence: 0 }),
    ).toThrow("[0,1]");
  });

  it("agent→project promotion needs ≥3 evidence across ≥2 tasks", () => {
    expect(canProposeProjectPromotion({ evidenceCount: 3, distinctTaskCount: 2 })).toBe(true);
    expect(canProposeProjectPromotion({ evidenceCount: 2, distinctTaskCount: 2 })).toBe(false);
    expect(canProposeProjectPromotion({ evidenceCount: 5, distinctTaskCount: 1 })).toBe(false);
  });

  it("project→company needs ≥2 projects + manager approval", () => {
    expect(canPromoteToCompany({ distinctProjectCount: 2, managerApproved: true })).toBe(true);
    expect(canPromoteToCompany({ distinctProjectCount: 1, managerApproved: true })).toBe(false);
    expect(canPromoteToCompany({ distinctProjectCount: 3, managerApproved: false })).toBe(false);
  });

  it("a single event never creates company-scope memory", () => {
    expect(canCreateCompanyScopeMemory("event")).toBe(false);
    expect(canCreateCompanyScopeMemory("promotion")).toBe(true);
  });
});

describe("consolidation rules (12 §5)", () => {
  it("importance adjustments: costly trigger, evidence bonus, entity-less episodic penalty", () => {
    const base = { selfScore: 0.5, costlyTrigger: false, evidenceRefCount: 1, type: "failure", hasEntities: true };
    expect(adjustImportance(base)).toBeCloseTo(0.5);
    expect(adjustImportance({ ...base, costlyTrigger: true })).toBeCloseTo(0.6);
    expect(adjustImportance({ ...base, evidenceRefCount: 2 })).toBeCloseTo(0.55);
    expect(
      adjustImportance({ ...base, type: "episodic", hasEntities: false }),
    ).toBeCloseTo(0.4);
    expect(
      adjustImportance({ ...base, selfScore: 0.98, costlyTrigger: true, evidenceRefCount: 3 }),
    ).toBe(1); // clamped
    expect(adjustImportance({ ...base, selfScore: 0.25 })).toBeLessThan(
      IMPORTANCE_DISCARD_THRESHOLD,
    );
  });

  it("scope detection: rules 1–5, company unreachable", () => {
    const base = {
      type: "failure",
      suggestedScope: "project" as const,
      referencesProjectArtifacts: false,
      hasProject: true,
    };
    expect(detectMemoryScope({ ...base, referencesProjectArtifacts: true })).toBe("project"); // rule 1
    expect(detectMemoryScope({ ...base, suggestedScope: "agent" })).toBe("agent"); // rule 2
    expect(detectMemoryScope({ ...base, type: "relationship" })).toBe("agent"); // rule 3
    expect(detectMemoryScope({ ...base, hasProject: false })).toBe("agent"); // rule 4
    expect(detectMemoryScope(base)).toBe("project"); // rule 5 tiebreak
  });

  it("confidence formula: base cap, corroboration, metric bonus, statement penalty", () => {
    const evt = { kind: "event" as const };
    expect(computeConsolidationConfidence(0.9, [evt])).toBeCloseTo(0.75); // base capped at 0.6
    expect(computeConsolidationConfidence(0.6, [evt, evt, evt])).toBeCloseTo(0.9); // +0.30 max
    expect(
      computeConsolidationConfidence(0.6, [evt, { kind: "metric" }]),
    ).toBeCloseTo(1); // 0.6+0.15+0.25
    expect(computeConsolidationConfidence(0.5, [{ kind: "statement" }])).toBeCloseTo(0.3);
    expect(computeConsolidationConfidence(0.1, [{ kind: "statement" }])).toBe(0); // clamped
  });

  it("similarity bands (12 §5.5)", () => {
    expect(classifySimilarity(0.97)).toBe("fast_merge");
    expect(classifySimilarity(0.95)).toBe("fast_merge");
    expect(classifySimilarity(0.9)).toBe("compare_merge");
    expect(classifySimilarity(0.78)).toBe("compare_no_merge");
    expect(classifySimilarity(0.7)).toBe("compare_no_merge");
    expect(classifySimilarity(0.69)).toBe("unrelated");
  });
});

describe("retrieval rules (12 §7)", () => {
  it("recency decay halves at the type's half-life", () => {
    expect(recencyDecay("episodic", 0)).toBeCloseTo(1);
    expect(recencyDecay("episodic", 14)).toBeCloseTo(0.5);
    expect(recencyDecay("failure", 90)).toBeCloseTo(0.5);
    expect(recencyDecay("procedural", 365)).toBeCloseTo(0.5);
    expect(recencyDecay("semantic", 30)).toBeGreaterThan(recencyDecay("episodic", 30));
    expect(recencyDecay("unknown-type", 90)).toBeCloseTo(0.5); // default 90d
  });

  it("token estimate is ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  const row = (
    id: string,
    score: number,
    mustKnow = false,
    contentLen = 400,
  ): PackableMemory => ({
    id,
    title: `Title ${id}`,
    content: "c".repeat(contentLen),
    summary: "short summary",
    type: "failure",
    confidence: 0.8,
    score,
    mustKnow,
  });

  it("packs must-know first, then by score; falls back to summaries; drops the rest", () => {
    // full render ≈ label(≈40)+title+400 chars ⇒ ~115 tokens each
    const rows = [row("a", 0.2, true), row("b", 0.9), row("c", 0.8), row("d", 0.7)];
    const generous = packMemories(rows, 10_000);
    expect(generous.packed.map((p) => p.id)).toEqual(["a", "b", "c", "d"]); // must-know leads
    expect(generous.droppedCount).toBe(0);

    const tight = packMemories(rows, 260); // two full renders, then summaries
    expect(tight.packed[0]!.id).toBe("a");
    expect(tight.packed[1]!.id).toBe("b");
    expect(tight.packed[2]!.rendered).toContain("short summary"); // summary fallback
    expect(tight.tokensUsed).toBeLessThanOrEqual(260);

    const starved = packMemories(rows, 30); // not even one summary? one fits (~17)
    expect(starved.tokensUsed).toBeLessThanOrEqual(30);
    expect(starved.packed.length + starved.droppedCount).toBe(4);
    expect(starved.droppedCount).toBeGreaterThan(0);
  });

  it("labels packed blocks with memory id + confidence for citation (12 §7.3)", () => {
    const result = packMemories([row("mem-1", 0.5)], 1_000);
    expect(result.packed[0]!.rendered).toContain("[memory mem-1 | failure | conf 0.80]");
  });
});

describe("burn forecasting (26 §8)", () => {
  it("projects with the trailing-24h rate once a day of data exists", () => {
    // 2400¢ in the last 24h ⇒ 100¢/h; 10h remaining ⇒ +1000¢
    expect(
      projectedSpendCents({
        spentSoFarCents: 5000,
        trailing24hCents: 2400,
        hoursElapsedInPeriod: 48,
        hoursRemainingInPeriod: 10,
      }),
    ).toBe(6000);
  });

  it("falls back to the period-to-date average under 24h of data", () => {
    // 600¢ over 6h ⇒ 100¢/h; 18h remaining ⇒ +1800¢
    expect(
      projectedSpendCents({
        spentSoFarCents: 600,
        trailing24hCents: 600,
        hoursElapsedInPeriod: 6,
        hoursRemainingInPeriod: 18,
      }),
    ).toBe(2400);
    expect(
      projectedSpendCents({
        spentSoFarCents: 0,
        trailing24hCents: 0,
        hoursElapsedInPeriod: 0,
        hoursRemainingInPeriod: 24,
      }),
    ).toBe(0);
  });

  it("forecast breach only fires with more than 12h left to act", () => {
    expect(
      forecastBreach({ projectedCents: 1100, limitCents: 1000, hoursRemainingInPeriod: 13 }),
    ).toBe(true);
    expect(
      forecastBreach({ projectedCents: 1100, limitCents: 1000, hoursRemainingInPeriod: 12 }),
    ).toBe(false);
    expect(
      forecastBreach({ projectedCents: 900, limitCents: 1000, hoursRemainingInPeriod: 20 }),
    ).toBe(false);
  });
});

describe("org forest (_DECISIONS §5)", () => {
  const edge = (from: string, to: string, ended = false): ReportsToEdge => ({
    fromAgentId: from,
    toAgentId: to,
    endedAt: ended ? new Date() : null,
  });
  // dev → lead → em → cto → ceo
  const chain = [edge("dev", "lead"), edge("lead", "em"), edge("em", "cto"), edge("cto", "ceo")];

  it("walks the escalation chain upward (Founder is virtual, not included)", () => {
    expect(escalationChain(chain, "dev")).toEqual(["lead", "em", "cto", "ceo"]);
    expect(escalationChain(chain, "ceo")).toEqual([]);
  });

  it("detects cycles a new edge would create", () => {
    expect(wouldCreateReportsToCycle(chain, { fromAgentId: "ceo", toAgentId: "dev" })).toBe(true);
    expect(wouldCreateReportsToCycle(chain, { fromAgentId: "ceo", toAgentId: "x" })).toBe(false);
    expect(wouldCreateReportsToCycle(chain, { fromAgentId: "a", toAgentId: "a" })).toBe(true);
  });

  it("ended edges do not count", () => {
    const withEnded = [...chain, edge("ceo", "dev", true)];
    expect(escalationChain(withEnded, "dev")).toEqual(["lead", "em", "cto", "ceo"]);
    expect(hasActiveManager(withEnded, "ceo")).toBe(false);
    expect(hasActiveManager(withEnded, "dev")).toBe(true);
  });

  it("rejects double managers and pre-existing cycles on walk", () => {
    expect(() => escalationChain([...chain, edge("dev", "cto")], "dev")).toThrow(
      "more than one active manager",
    );
    const cyclic = [edge("a", "b"), edge("b", "a")];
    expect(() => escalationChain(cyclic, "a")).toThrow("cycle");
  });
});
