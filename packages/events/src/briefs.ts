// The structured Founder brief (19 §3 — all 11 fields, normative) and its
// anti-pattern guard (19 §10): NO raw conversation, ever. Canonical schema
// lives here so both enforcement sites can share it inside the dependency
// matrix: @acos/db (the Approval Engine validates at creation) and
// @acos/contracts (the API surface + renderer re-export it).
import { z } from "zod";

/**
 * Heuristic transcript detector (19 §10): ≥3 lines matching a
 * `Speaker: ...` pattern, or agent.message refs — such text is chat, not a
 * brief, and bounces back to the requester.
 */
export function hasTranscriptMarkers(text: string): boolean {
  if (text.includes("agent.message")) return true;
  const speakerLines = text
    .split("\n")
    .filter((line) => /^\s*\w[\w\s]{0,24}:/.test(line));
  return speakerLines.length >= 3;
}

const prose = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasTranscriptMarkers(text), {
      message:
        "field looks like a raw conversation transcript — briefs carry typed fields, never agent chat (19 §10)",
    });

export const ApprovalBriefOptionSchema = z
  .object({
    option: z.string().min(1).max(500),
    pros: z.string().max(500),
    cons: z.string().max(500),
    cost_cents: z.number().int().min(0),
  })
  .strict();

export const ApprovalBriefCostSchema = z
  .object({
    amount_cents: z.number().int().min(0),
    currency: z.string().length(3),
    period: z.string().max(50).optional(),
    budget_line: z.string().max(200).optional(),
    remaining_budget_cents: z.number().int().optional(),
  })
  .strict();

/** All 11 fields required (`deadline` nullable); unknown keys rejected. */
export const ApprovalBriefSchema = z
  .object({
    title: z.string().min(1).max(120), // 1
    request: prose(1200), // 2
    reason: prose(1200), // 3
    attempted: z.array(prose(500)).min(1), // 4
    options: z.array(ApprovalBriefOptionSchema).min(2), // 5
    recommendation: prose(1200), // 6
    risk: prose(500), // 7 — level + concrete downside
    cost: ApprovalBriefCostSchema, // 8
    impact: prose(1200), // 9
    urgency: prose(500).refine((text) => /^(low|normal|high|critical)\b/.test(text), {
      message: "urgency must start with low|normal|high|critical, then the justification",
    }), // 10
    deadline: z.iso.datetime().nullable(), // 11
  })
  .strict();
export type ApprovalBrief = z.infer<typeof ApprovalBriefSchema>;
