// Unit of work — one shape for goal/initiative/epic/task/subtask
// (_DECISIONS.md §7, 03 §3.3, §4).
import { DomainError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { isTaskRisk, type TaskRisk } from "../value-objects/risk.js";
import type { FactoryDeps } from "./company.js";

export const TASK_KINDS = ["goal", "initiative", "epic", "task", "subtask"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Canonical task states (_DECISIONS.md §7); transition table lands in T10. */
export const TASK_STATUSES = [
  "DRAFT",
  "BACKLOG",
  "PLANNED",
  "ASSIGNED",
  "IN_PROGRESS",
  "WAITING",
  "BLOCKED",
  "REVIEW",
  "CHANGES_REQUESTED",
  "QA",
  "QA_FAILED",
  "APPROVAL",
  "REJECTED",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Free-form briefing payload handed down at delegation (JSONB, 03 §7). */
export type TaskContext = Readonly<Record<string, unknown>>;
/** Outcome narrative + artifact refs (JSONB, 03 §7). */
export type TaskResult = Readonly<Record<string, unknown>>;

export interface Task {
  readonly id: string;
  readonly companyId: string;
  readonly projectId: string | null;
  readonly number: number; // per-company seq → "TASK-81"
  readonly kind: TaskKind;
  readonly parentId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly context: TaskContext;
  readonly creatorAgentId: string | null; // null → Founder
  readonly ownerAgentId: string | null;
  readonly orgUnitId: string | null;
  readonly priority: Priority;
  readonly status: TaskStatus;
  readonly successCriteria: readonly string[];
  readonly risk: TaskRisk;
  readonly budgetCents: number | null;
  readonly deadline: Date | null;
  readonly approvalPolicyId: string | null;
  readonly result: TaskResult | null;
  readonly createdAt: Date;
}

export interface CreateTaskInput {
  companyId: string;
  number: number;
  kind: TaskKind;
  title: string;
  objective: string;
  priority: Priority;
  risk: TaskRisk;
  projectId?: string | null;
  parentId?: string | null;
  context?: TaskContext;
  creatorAgentId?: string | null;
  ownerAgentId?: string | null;
  orgUnitId?: string | null;
  successCriteria?: readonly string[];
  budgetCents?: number | null;
  deadline?: Date | null;
  approvalPolicyId?: string | null;
}

export function createTask(input: CreateTaskInput, deps: FactoryDeps = {}): Task {
  if (input.title.trim() === "") throw new DomainError("task title must not be empty");
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new DomainError(`task number must be a positive integer, got ${input.number}`);
  }
  if (!(TASK_KINDS as readonly string[]).includes(input.kind)) {
    throw new DomainError(`unknown task kind "${input.kind}"`);
  }
  if (!(PRIORITIES as readonly string[]).includes(input.priority)) {
    throw new DomainError(`unknown priority "${input.priority}"`);
  }
  if (!isTaskRisk(input.risk)) {
    throw new DomainError(`unknown task risk "${input.risk}"`);
  }
  const budgetCents = input.budgetCents ?? null;
  if (budgetCents !== null && (!Number.isInteger(budgetCents) || budgetCents < 0)) {
    throw new DomainError(`task budget must be a non-negative integer, got ${budgetCents}`);
  }
  return {
    id: deps.id ?? uuidv7(),
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    number: input.number,
    kind: input.kind,
    parentId: input.parentId ?? null,
    title: input.title,
    objective: input.objective,
    context: input.context ?? {},
    creatorAgentId: input.creatorAgentId ?? null,
    ownerAgentId: input.ownerAgentId ?? null,
    orgUnitId: input.orgUnitId ?? null,
    priority: input.priority,
    status: "DRAFT",
    successCriteria: input.successCriteria ?? [],
    risk: input.risk,
    budgetCents,
    deadline: input.deadline ?? null,
    approvalPolicyId: input.approvalPolicyId ?? null,
    result: null,
    createdAt: deps.now ?? new Date(),
  };
}

/** "TASK-81"-style display number (_DECISIONS.md §4). */
export function formatTaskNumber(taskNumber: number): string {
  return `TASK-${taskNumber}`;
}
