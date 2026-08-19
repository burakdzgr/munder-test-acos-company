// Approvals API surface (19 §11–12, 21 §3.10, T35). The 11-field brief
// contract itself is canonical in @acos/events (shared with the engine in
// @acos/db inside the dependency matrix) — re-exported here for the SDK and
// the Approval Center renderer, which consumes ONLY these typed fields.
import { z } from "zod";
import { ApprovalBriefSchema } from "@acos/events";

export { ApprovalBriefSchema };
export type { ApprovalBrief } from "@acos/events";

/** Canonical kind enum (20 §12.5 CHECK). */
export const ApprovalKindSchema = z.enum([
  "tool_execution",
  "budget_increase",
  "hire",
  "promotion",
  "deployment",
  "vendor",
  "legal_financial",
  "other",
]);

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "needs_review",
  "expired",
]);

export const ApprovalUrgencySchema = z.enum(["low", "normal", "high", "critical"]);
export const ApprovalRiskSchema = z.enum(["low", "medium", "high", "critical"]);

/** Executive endorsement chain entry (19 §5). */
export const ApprovalChainEntrySchema = z.object({
  agentId: z.uuid().nullable(),
  verdict: z.enum(["requested", "endorsed", "objected", "revised"]),
  note: z.string().nullable(),
  at: z.iso.datetime(),
});

export const ApprovalSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  kind: ApprovalKindSchema,
  title: z.string(),
  brief: ApprovalBriefSchema,
  requestedByAgentId: z.uuid(),
  requesterName: z.string().nullable(),
  chain: z.array(ApprovalChainEntrySchema),
  status: ApprovalStatusSchema,
  risk: ApprovalRiskSchema,
  costCents: z.number().int().nullable(),
  urgency: ApprovalUrgencySchema,
  deadline: z.iso.datetime().nullable(),
  /** Derived engine expiry (19 §6) — not a stored column. */
  expiresAt: z.iso.datetime(),
  taskId: z.uuid().nullable(),
  decidedByUserId: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalDetailSchema = ApprovalSchema.extend({
  task: z
    .object({ id: z.uuid(), number: z.number().int(), title: z.string(), status: z.string() })
    .nullable(),
});
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;

export const ApprovalListQuerySchema = z.object({
  status: ApprovalStatusSchema.optional(),
  kind: ApprovalKindSchema.optional(),
  urgency: ApprovalUrgencySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** One-click verdicts (19 §11): note required unless approving. */
export const ApprovalVerdictRequestSchema = z
  .object({
    verdict: z.enum(["approved", "rejected", "needs_review"]),
    note: z.string().max(2000).optional(),
  })
  .refine((v) => v.verdict === "approved" || (v.note?.trim().length ?? 0) > 0, {
    message: "REJECT and REQUEST EXECUTIVE REVIEW require a decision note",
    path: ["note"],
  });
export type ApprovalVerdictRequest = z.infer<typeof ApprovalVerdictRequestSchema>;
