// Persistent AI employee — identity is model-independent (sacred invariant,
// 03 §2): no model/provider fields anywhere on this entity.
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { isAutonomyLevel, type AutonomyLevel } from "../value-objects/autonomy.js";
import { isSeniority, type Seniority } from "../value-objects/seniority.js";
import type { FactoryDeps } from "./company.js";

export const AGENT_STATUSES = ["draft", "active", "paused", "offboarded"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Derived presence status — stored only on agent_sessions, never on agents (03 §3.2). */
export const RUNTIME_ACTIVITIES = [
  "IDLE",
  "THINKING",
  "WORKING",
  "WAITING",
  "COMMUNICATING",
  "REVIEWING",
  "TESTING",
  "LEARNING",
  "BLOCKED",
  "ESCALATING",
  "OFFLINE",
] as const;
export type RuntimeActivity = (typeof RUNTIME_ACTIVITIES)[number];

export interface EmploymentInfo {
  readonly hiredAt: string; // ISO date — descriptive HR metadata (JSONB, 03 §7)
  readonly offboardedAt?: string;
  readonly notes?: string;
}

export interface Agent {
  readonly id: string;
  readonly companyId: string;
  readonly employeeNumber: number; // per-company sequence, e.g. 7 → "EMP-007"
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly status: AgentStatus;
  readonly positionId: string;
  readonly orgUnitId: string; // primary team
  readonly seniority: Seniority;
  readonly autonomyLevel: AutonomyLevel;
  readonly employment: EmploymentInfo;
  readonly persona: string; // short professional bio used in prompts
  readonly createdAt: Date;
}

export interface CreateAgentInput {
  companyId: string;
  employeeNumber: number;
  name: string;
  positionId: string;
  orgUnitId: string;
  seniority: Seniority;
  autonomyLevel: AutonomyLevel;
  persona: string;
  avatarUrl?: string | null;
  employment?: EmploymentInfo;
}

export function createAgent(input: CreateAgentInput, deps: FactoryDeps = {}): Agent {
  if (input.name.trim() === "") throw new DomainError("agent name must not be empty");
  if (!Number.isInteger(input.employeeNumber) || input.employeeNumber < 1) {
    throw new DomainError(`employee number must be a positive integer, got ${input.employeeNumber}`);
  }
  if (!isSeniority(input.seniority)) {
    throw new DomainError(`unknown seniority "${input.seniority}"`);
  }
  if (!isAutonomyLevel(input.autonomyLevel)) {
    throw new DomainError(`autonomy level must be 0–5, got ${input.autonomyLevel}`);
  }
  if (input.persona.trim() === "") throw new DomainError("agent persona must not be empty");

  const now = deps.now ?? new Date();
  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    employeeNumber: input.employeeNumber,
    name: input.name,
    avatarUrl: input.avatarUrl ?? null,
    status: "draft", // lifecycle: draft → active ⇄ paused → offboarded (T10)
    positionId: input.positionId,
    orgUnitId: input.orgUnitId,
    seniority: input.seniority,
    autonomyLevel: input.autonomyLevel,
    employment: input.employment ?? { hiredAt: now.toISOString() },
    persona: input.persona,
    createdAt: now,
  };
}

/** "EMP-007"-style display number (03 §6). */
export function formatEmployeeNumber(employeeNumber: number): string {
  return `EMP-${String(employeeNumber).padStart(3, "0")}`;
}
