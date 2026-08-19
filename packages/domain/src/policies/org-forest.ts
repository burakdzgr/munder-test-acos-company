// reports_to forest invariant + escalation-chain walk (_DECISIONS.md §5,
// 04-ORGANIZATION-ENGINE.md). Pure, in-memory edge list; the DB-level
// recursive-CTE check lands with T18.
import { DomainError } from "../errors.js";

export interface ReportsToEdge {
  readonly fromAgentId: string; // report
  readonly toAgentId: string; // manager
  readonly endedAt: Date | null;
}

const active = (edges: readonly ReportsToEdge[]): ReportsToEdge[] =>
  edges.filter((e) => e.endedAt === null);

/** ≤1 active manager per agent (forest property). */
export function hasActiveManager(edges: readonly ReportsToEdge[], agentId: string): boolean {
  return active(edges).some((e) => e.fromAgentId === agentId);
}

/**
 * Would adding `candidate` create a reports_to cycle? Walks the manager chain
 * upward from the candidate's manager; a path back to the report = cycle.
 */
export function wouldCreateReportsToCycle(
  edges: readonly ReportsToEdge[],
  candidate: { fromAgentId: string; toAgentId: string },
): boolean {
  if (candidate.fromAgentId === candidate.toAgentId) return true;
  const managerOf = new Map<string, string>();
  for (const e of active(edges)) managerOf.set(e.fromAgentId, e.toAgentId);

  let current: string | undefined = candidate.toAgentId;
  const visited = new Set<string>();
  while (current !== undefined) {
    if (current === candidate.fromAgentId) return true;
    if (visited.has(current)) return false; // pre-existing cycle elsewhere; not ours
    visited.add(current);
    current = managerOf.get(current);
  }
  return false;
}

/**
 * Escalation chain: walk reports_to upward. The Founder is a virtual node at
 * the end of every chain and is NOT included in the returned agent ids.
 */
export function escalationChain(edges: readonly ReportsToEdge[], agentId: string): string[] {
  const managerOf = new Map<string, string>();
  for (const e of active(edges)) {
    if (managerOf.has(e.fromAgentId)) {
      throw new DomainError(`agent ${e.fromAgentId} has more than one active manager`);
    }
    managerOf.set(e.fromAgentId, e.toAgentId);
  }
  const chain: string[] = [];
  const visited = new Set<string>([agentId]);
  let current = managerOf.get(agentId);
  while (current !== undefined) {
    if (visited.has(current)) {
      throw new DomainError("reports_to graph contains a cycle");
    }
    chain.push(current);
    visited.add(current);
    current = managerOf.get(current);
  }
  return chain;
}
