// Typed, end-dated org-graph edge (_DECISIONS.md §5, 03 §3.1, §4).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import type { FactoryDeps } from "./company.js";

export const EDGE_KINDS = [
  "reports_to",
  "manages",
  "member_of",
  "leads",
  "mentors",
  "collaborates_with",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Edge kinds whose target is an org unit; all others target an agent. */
export const UNIT_EDGE_KINDS: readonly EdgeKind[] = ["member_of", "leads"];

export interface OrgEdge {
  readonly id: string;
  readonly companyId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string | null;
  readonly toUnitId: string | null;
  readonly kind: EdgeKind;
  readonly strength: number | null; // 0–1; recomputed nightly for collaborates_with
  readonly createdAt: Date;
  readonly endedAt: Date | null; // edges are end-dated, never deleted
}

export interface CreateOrgEdgeInput {
  companyId: string;
  fromAgentId: string;
  kind: EdgeKind;
  toAgentId?: string | null;
  toUnitId?: string | null;
  strength?: number | null;
}

export function createOrgEdge(input: CreateOrgEdgeInput, deps: FactoryDeps = {}): OrgEdge {
  const toAgentId = input.toAgentId ?? null;
  const toUnitId = input.toUnitId ?? null;

  if ((toAgentId === null) === (toUnitId === null)) {
    throw new DomainError("org edge must target exactly one of toAgentId/toUnitId");
  }
  const isUnitKind = UNIT_EDGE_KINDS.includes(input.kind);
  if (isUnitKind && toUnitId === null) {
    throw new DomainError(`org edge kind "${input.kind}" must target an org unit`);
  }
  if (!isUnitKind && toAgentId === null) {
    throw new DomainError(`org edge kind "${input.kind}" must target an agent`);
  }
  if (input.kind === "reports_to" && toAgentId === input.fromAgentId) {
    throw new DomainError("an agent cannot report to itself");
  }
  const strength = input.strength ?? null;
  if (strength !== null && (strength < 0 || strength > 1)) {
    throw new DomainError(`edge strength must be within [0,1], got ${strength}`);
  }

  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    fromAgentId: input.fromAgentId,
    toAgentId,
    toUnitId,
    kind: input.kind,
    strength,
    createdAt: deps.now ?? new Date(),
    endedAt: null,
  };
}

/** End-dates an edge; edges are never deleted (03 §3.1). */
export function endOrgEdge(edge: OrgEdge, at: Date): OrgEdge {
  if (edge.endedAt !== null) throw new DomainError("org edge is already ended");
  return { ...edge, endedAt: at };
}
