// Task state machine + transition-permission matrix (_DECISIONS.md §7,
// 07-TASK-ENGINE.md §4–5). TaskStateService (apps/server, T27) is the only
// status writer; it calls these pure functions.
import type { TaskStatus } from "../entities/task.js";
import { defineStateMachine } from "./machine.js";

export const taskMachine = defineStateMachine<TaskStatus>("task", {
  DRAFT: ["BACKLOG", "CANCELLED"],
  BACKLOG: ["PLANNED", "CANCELLED"],
  PLANNED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["WAITING", "BLOCKED", "REVIEW", "CANCELLED", "FAILED"],
  WAITING: ["IN_PROGRESS", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "CANCELLED", "FAILED"],
  REVIEW: ["CHANGES_REQUESTED", "QA", "CANCELLED"],
  CHANGES_REQUESTED: ["IN_PROGRESS"],
  QA: ["QA_FAILED", "APPROVAL", "DONE", "CANCELLED"],
  QA_FAILED: ["IN_PROGRESS", "FAILED"],
  APPROVAL: ["DONE", "REJECTED"],
  REJECTED: ["IN_PROGRESS", "FAILED"],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
});

/** Actor classes of 07 §5. */
export const TASK_ACTOR_KINDS = [
  "owner",
  "creator",
  "reviewer",
  "qa",
  "manager",
  "approval_engine",
  "founder",
  "system",
] as const;
export type TaskActorKind = (typeof TASK_ACTOR_KINDS)[number];

export interface TaskActor {
  readonly kind: TaskActorKind;
  /** Agent id for agent actors; null for founder/system/approval_engine. */
  readonly agentId: string | null;
}

export interface TaskTransitionContext {
  readonly ownerAgentId: string | null;
}

interface PermissionRule {
  readonly kinds: readonly TaskActorKind[];
  /** Actor's agentId must differ from the task owner (reviewer independence). */
  readonly requireDistinctFromOwner?: boolean;
}

const CANCEL_OR_FAIL: PermissionRule = { kinds: ["manager", "founder"] };

/** 07 §5, row by row. Key: `${from}→${to}`. */
const PERMISSIONS: Readonly<Record<string, PermissionRule>> = {
  "DRAFT→BACKLOG": { kinds: ["creator", "manager", "founder"] },
  "BACKLOG→PLANNED": { kinds: ["manager", "founder"] },
  "PLANNED→ASSIGNED": { kinds: ["manager", "founder"] },
  "ASSIGNED→IN_PROGRESS": { kinds: ["owner", "system"] },
  "IN_PROGRESS→WAITING": { kinds: ["owner", "system"] },
  "WAITING→IN_PROGRESS": { kinds: ["owner", "system"] },
  "IN_PROGRESS→BLOCKED": { kinds: ["owner", "manager", "system"] },
  "BLOCKED→IN_PROGRESS": { kinds: ["owner", "manager", "system"] },
  "IN_PROGRESS→REVIEW": { kinds: ["owner"] },
  "REVIEW→CHANGES_REQUESTED": { kinds: ["reviewer"], requireDistinctFromOwner: true },
  "REVIEW→QA": { kinds: ["reviewer"], requireDistinctFromOwner: true },
  "QA→QA_FAILED": { kinds: ["qa", "system"], requireDistinctFromOwner: true },
  "QA→APPROVAL": { kinds: ["qa", "system"], requireDistinctFromOwner: true },
  "QA→DONE": { kinds: ["qa", "system"], requireDistinctFromOwner: true },
  "QA_FAILED→IN_PROGRESS": { kinds: ["owner", "manager"] },
  "CHANGES_REQUESTED→IN_PROGRESS": { kinds: ["owner", "manager"] },
  "APPROVAL→DONE": { kinds: ["approval_engine"] },
  "APPROVAL→REJECTED": { kinds: ["approval_engine"] },
  "REJECTED→IN_PROGRESS": { kinds: ["owner", "manager"] },
};

export type TaskTransitionVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Combined machine-validity + permission check. "No developer approves their
 * own work" is structural: REVIEW→* / QA→* refuse actor === owner (07 §5).
 */
export function authorizeTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  actor: TaskActor,
  task: TaskTransitionContext,
): TaskTransitionVerdict {
  if (!taskMachine.canTransition(from, to)) {
    return { allowed: false, reason: `illegal transition ${from} → ${to}` };
  }
  const rule = to === "CANCELLED" || to === "FAILED" ? CANCEL_OR_FAIL : PERMISSIONS[`${from}→${to}`];
  if (!rule) {
    return { allowed: false, reason: `no permission rule for ${from} → ${to}` };
  }
  if (!rule.kinds.includes(actor.kind)) {
    return { allowed: false, reason: `${actor.kind} may not perform ${from} → ${to}` };
  }
  if (
    rule.requireDistinctFromOwner &&
    actor.agentId !== null &&
    task.ownerAgentId !== null &&
    actor.agentId === task.ownerAgentId
  ) {
    return { allowed: false, reason: "author may not review/approve their own work" };
  }
  return { allowed: true };
}
