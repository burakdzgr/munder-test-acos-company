// Brief contract guards (19 §3, §10): the fully rendered CMO ad-budget
// example parses; unknown keys, oversize fields and transcript-looking
// text bounce.
import { describe, expect, it } from "vitest";
import { ApprovalBriefSchema, hasTranscriptMarkers } from "./briefs.js";

const CMO_BRIEF = {
  title: "Approve 1,500 USD/month Instagram ads budget for Q4 launch campaign",
  request:
    "Authorize a recurring monthly ad spend of 1,500 USD on Instagram (Meta Ads) for the 'Atlas' product launch campaign, starting 2026-10-01, reviewed monthly.",
  reason:
    "Organic reach has plateaued at ~2.1% while the Q4 launch goal requires 40k qualified visitors. Paid amplification is the only channel projected to close the gap in time.",
  attempted: [
    "6 weeks of organic Reels optimization — reach +18%, insufficient trajectory for the Q4 target",
    "Cross-posting partnerships with 3 accounts — +4k followers, CAC-equivalent too high to scale",
  ],
  options: [
    {
      option: "1,500 USD/mo Instagram ads (recommended)",
      pros: "reaches target with 20% margin per media plan",
      cons: "recurring commitment; creative fatigue risk",
      cost_cents: 150000,
    },
    {
      option: "No paid spend, extend organic",
      pros: "zero cost",
      cons: "Q4 launch traffic goal missed with ~90% probability",
      cost_cents: 0,
    },
  ],
  recommendation:
    "Option 1. The media plan shows 1,500 USD/mo achieving the visitor target with margin.",
  risk: "medium — spend is capped monthly and cancellable within 24h; downside bounded at one month of budget.",
  cost: {
    amount_cents: 150000,
    currency: "USD",
    period: "monthly",
    budget_line: "marketing/paid-social",
    remaining_budget_cents: 0,
  },
  impact:
    "Approved: projected 42k qualified visitors for Q4 launch. Rejected: launch proceeds organic-only, Q4 revenue goal at risk.",
  urgency: "high — creative production needs a 2-week lead; decision needed by 2026-09-15.",
  deadline: "2026-09-15T17:00:00Z",
};

describe("ApprovalBriefSchema (19 §3)", () => {
  it("parses the canonical CMO ad-budget example", () => {
    expect(ApprovalBriefSchema.parse(CMO_BRIEF)).toMatchObject({ deadline: CMO_BRIEF.deadline });
  });

  it("rejects unknown keys (.strict) and missing required fields", () => {
    expect(ApprovalBriefSchema.safeParse({ ...CMO_BRIEF, raw_md: "# hi" }).success).toBe(false);
    const missing: Partial<typeof CMO_BRIEF> = { ...CMO_BRIEF };
    delete missing.impact;
    expect(ApprovalBriefSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects oversize fields and fewer than 2 options", () => {
    expect(
      ApprovalBriefSchema.safeParse({ ...CMO_BRIEF, request: "x".repeat(1201) }).success,
    ).toBe(false);
    expect(
      ApprovalBriefSchema.safeParse({ ...CMO_BRIEF, options: [CMO_BRIEF.options[0]] }).success,
    ).toBe(false);
  });

  it("bounces transcript-looking text (19 §10 heuristic)", () => {
    const chat = "CMO: we need budget\nCEO: agreed\nFounder: how much?\nCMO: 1500";
    expect(hasTranscriptMarkers(chat)).toBe(true);
    expect(hasTranscriptMarkers(CMO_BRIEF.reason)).toBe(false);
    expect(ApprovalBriefSchema.safeParse({ ...CMO_BRIEF, reason: chat }).success).toBe(false);
    expect(
      ApprovalBriefSchema.safeParse({
        ...CMO_BRIEF,
        request: "see agent.message refs for context",
      }).success,
    ).toBe(false);
  });

  it("requires urgency to lead with its level", () => {
    expect(
      ApprovalBriefSchema.safeParse({ ...CMO_BRIEF, urgency: "very urgent!!" }).success,
    ).toBe(false);
  });
});
