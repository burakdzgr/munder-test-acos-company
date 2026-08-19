// Persistent knowledge record with scope, type, provenance (_DECISIONS.md §10,
// 03 §3.4, §4).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import type { FactoryDeps } from "./company.js";

export const MEMORY_SCOPES = ["company", "project", "agent"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TYPES = [
  "semantic",
  "episodic",
  "procedural",
  "decision",
  "failure",
  "experiment",
  "relationship",
  "artifact",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUSES = ["candidate", "active", "superseded", "archived", "rejected"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Extracted entity mentions (JSONB, 03 §7). */
export type MemoryEntities = Readonly<Record<string, unknown>>;

export interface Memory {
  readonly id: string;
  readonly companyId: string;
  readonly scope: MemoryScope;
  readonly scopeRef: string | null; // project_id or agent_id; null for company scope
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string; // markdown
  readonly summary: string;
  readonly entities: MemoryEntities;
  readonly importance: number; // 0–1
  readonly confidence: number; // 0–1
  readonly status: MemoryStatus;
  readonly sourceEventId: string; // provenance is mandatory (03 §3.4)
  readonly createdByAgentId: string | null;
  readonly lastVerifiedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly retrievalCount: number;
  readonly embeddingModel: string; // per-row model+dimension (ADR-020)
  readonly createdAt: Date;
}

export interface CreateMemoryInput {
  companyId: string;
  scope: MemoryScope;
  scopeRef?: string | null;
  type: MemoryType;
  title: string;
  content: string;
  summary: string;
  importance: number;
  confidence: number;
  sourceEventId: string;
  embeddingModel: string;
  entities?: MemoryEntities;
  createdByAgentId?: string | null;
  expiresAt?: Date | null;
}

function assertUnitInterval(name: string, value: number): void {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new DomainError(`${name} must be within [0,1], got ${value}`);
  }
}

export function createMemory(input: CreateMemoryInput, deps: FactoryDeps = {}): Memory {
  if (input.title.trim() === "") throw new DomainError("memory title must not be empty");
  const scopeRef = input.scopeRef ?? null;
  if (input.scope === "company" && scopeRef !== null) {
    throw new DomainError("company-scope memory must not carry a scopeRef");
  }
  if (input.scope !== "company" && scopeRef === null) {
    throw new DomainError(`${input.scope}-scope memory requires a scopeRef`);
  }
  assertUnitInterval("importance", input.importance);
  assertUnitInterval("confidence", input.confidence);
  if (input.sourceEventId.trim() === "") {
    throw new DomainError("memory requires provenance (sourceEventId)");
  }

  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    scope: input.scope,
    scopeRef,
    type: input.type,
    title: input.title,
    content: input.content,
    summary: input.summary,
    entities: input.entities ?? {},
    importance: input.importance,
    confidence: input.confidence,
    status: "candidate", // memory lifecycle starts at candidate (_DECISIONS.md §19)
    sourceEventId: input.sourceEventId,
    createdByAgentId: input.createdByAgentId ?? null,
    lastVerifiedAt: null,
    expiresAt: input.expiresAt ?? null,
    retrievalCount: 0,
    embeddingModel: input.embeddingModel,
    createdAt: deps.now ?? new Date(),
  };
}
