// 10.3 Tasks (15 types).
import { PRIORITIES, TASK_KINDS, TASK_RISKS, TASK_STATUSES } from "@acos/domain";
import { defineEvent } from "../define.js";
import { z, u, uReq, s, sReq, int, diff, strArr, uArr, ts } from "./common.js";

const TaskStatus = z.enum(TASK_STATUSES);
const byActor = z.object({
  kind: z.enum(["agent", "founder", "system"]),
  id: z.uuid().nullable(),
});

export const TaskCreatedV1 = defineEvent({
  type: "task.created",
  version: 1,
  payload: z.object({
    number: z.number().int(),
    kind: z.enum(TASK_KINDS),
    title: sReq,
    parentTaskId: u,
    priority: z.enum(PRIORITIES).optional(),
    risk: z.enum(TASK_RISKS).optional(),
    budgetCents: int,
    successCriteria: strArr,
    delegationDepth: int,
  }),
});

/** Canonical pattern of 10 §8.2 — required from/to/byActor. */
export const TaskStatusChangedV1 = defineEvent({
  type: "task.status.changed",
  version: 1,
  payload: z.object({
    from: TaskStatus,
    to: TaskStatus,
    byActor,
    note: z.string().max(1000).optional(),
    guardFlag: z.enum(["budget", "deadline", "step_cap", "loop", "ping_pong", "depth"]).optional(),
  }),
});

defineEvent({
  type: "agent.task.assigned",
  version: 1,
  payload: z.object({ taskId: uReq, agentId: uReq, byAgentId: u, reassignmentCount: int }),
});
defineEvent({
  type: "agent.task.started",
  version: 1,
  payload: z.object({ taskId: u, agentId: u, sessionId: u, attempt: int }),
});
defineEvent({
  type: "task.completed",
  version: 1,
  payload: z.object({ resultSummary: s, criteria: strArr, artifactIds: uArr, costCents: int }),
});
defineEvent({ type: "task.failed", version: 1, payload: z.object({ reason: s, decidedBy: s }) });
defineEvent({ type: "task.cancelled", version: 1, payload: z.object({ reason: s, decidedBy: s }) });
defineEvent({
  type: "task.reassigned",
  version: 1,
  payload: z.object({ fromAgentId: u, toAgentId: u, reassignmentCount: int }),
});
defineEvent({ type: "task.dependency.added", version: 1, payload: z.object({ dependsOnTaskId: uReq }) });
defineEvent({
  type: "task.dependency.resolved",
  version: 1,
  payload: z.object({ dependsOnTaskId: uReq, result: s }),
});
defineEvent({
  type: "task.blocked",
  version: 1,
  payload: z.object({ blockedReason: z.object({ kind: s, ref: s, note: s }).optional() }),
});
defineEvent({ type: "task.unblocked", version: 1, payload: z.object({ note: s }) });
defineEvent({
  type: "task.deadline.missed",
  version: 1,
  payload: z.object({ deadline: ts, statusAtMiss: z.enum(TASK_STATUSES).optional() }),
});
defineEvent({ type: "task.updated", version: 1, payload: z.object({ diff }) });
defineEvent({ type: "task.wait_cycle.detected", version: 1, payload: z.object({ cycleTaskIds: uArr }) });
