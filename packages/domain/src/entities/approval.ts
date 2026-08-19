// Governance aggregate routed to the Founder (_DECISIONS.md §15, 03 §3.9, §4).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { isTaskRisk, type TaskRisk } from "../value-objects/risk.js";
import type { FactoryDeps } from "./company.js";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "needs_review", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const URGENCIES = ["low", "normal", "high", "critical"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Ordered executive-endorsement log (JSONB, append-only — 03 §7). */
export type EndorsementChain = ReadonlyArray<{
  readonly agentId: string;
  readonly verdict: "endorse" | "flag";
  readonly note?: string;
  readonly at: string; // ISO timestamp
}>;

export interface Approval {
  readonly id: string;
  readonly companyId: string;
  readonly kind: string; // e.g. 'vendor_signup', 'production_destructive'
  readonly title: string;
  readonly requestMd: string; // rendered structured EscalationBrief — never raw chat
  readonly requestedBy: string; // agent_id
  readonly chain: EndorsementChain;
  readonly status: ApprovalStatus;
  readonly risk: TaskRisk;
  readonly costCents: number | null;
  readonly urgency: Urgency;
  readonly deadline: Date | null;
  readonly decidedBy: string | null; // user_id — humans decide approvals
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
}

export interface CreateApprovalInput {
  companyId: string;
  kind: string;
  title: string;
  requestMd: string;
  requestedBy: string;
  risk: TaskRisk;
  urgency?: Urgency;
  costCents?: number | null;
  deadline?: Date | null;
  chain?: EndorsementChain;
}

export function createApproval(input: CreateApprovalInput, deps: FactoryDeps = {}): Approval {
  if (input.title.trim() === "") throw new DomainError("approval title must not be empty");
  if (input.kind.trim() === "") throw new DomainError("approval kind must not be empty");
  if (input.requestMd.trim() === "") {
    throw new DomainError("approval requires a structured brief (requestMd)");
  }
  if (!isTaskRisk(input.risk)) throw new DomainError(`unknown risk "${input.risk}"`);
  const urgency = input.urgency ?? "normal";
  if (!(URGENCIES as readonly string[]).includes(urgency)) {
    throw new DomainError(`unknown urgency "${urgency}"`);
  }
  const costCents = input.costCents ?? null;
  if (costCents !== null && (!Number.isInteger(costCents) || costCents < 0)) {
    throw new DomainError(`approval cost must be a non-negative integer, got ${costCents}`);
  }

  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    kind: input.kind,
    title: input.title,
    requestMd: input.requestMd,
    requestedBy: input.requestedBy,
    chain: input.chain ?? [],
    status: "pending",
    risk: input.risk,
    costCents,
    urgency,
    deadline: input.deadline ?? null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  };
}
