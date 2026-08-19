// 10.2 Agents & careers (20 types).
import { SENIORITIES } from "@acos/domain";
import { defineEvent } from "../define.js";
import { z, u, uReq, s, sReq, int, diff, strArr, ts } from "./common.js";

const seniority = z.enum(SENIORITIES).optional();
const runtimeActivity = s; // IDLE..OFFLINE — derived presence

export const AgentHiredV1 = defineEvent({
  type: "agent.hired",
  version: 1,
  payload: z.object({
    agentId: uReq,
    employeeNumber: z.number().int(),
    name: sReq,
    positionId: u,
    orgUnitId: u,
    seniority,
  }),
});
defineEvent({ type: "agent.updated", version: 1, payload: z.object({ diff }) });
defineEvent({ type: "agent.started", version: 1, payload: z.object({ agentId: u }) });
defineEvent({ type: "agent.paused", version: 1, payload: z.object({ reason: s }) });
defineEvent({ type: "agent.resumed", version: 1, payload: z.object({ reason: s }) });
defineEvent({
  type: "agent.offboarded",
  version: 1,
  payload: z.object({ reason: s, memoryDisposition: s }),
});
defineEvent({
  type: "agent.status.changed",
  version: 1,
  payload: z.object({ sessionId: u, from: runtimeActivity, to: runtimeActivity }),
});
defineEvent({
  type: "agent.session.started",
  version: 1,
  payload: z.object({ sessionId: uReq, workflowId: s, taskId: u, model: s }),
});
defineEvent({
  type: "agent.session.ended",
  version: 1,
  payload: z.object({ sessionId: uReq, status: s, steps: int, tokens: int, costCents: int }),
});
defineEvent({
  type: "agent.escalated",
  version: 1,
  payload: z.object({
    toAgentId: u,
    toFounder: z.boolean().optional(),
    reason: s,
    attempted: strArr,
    recommendation: s,
    guardFlag: s,
  }),
});
defineEvent({
  type: "agent.promotion.recommended",
  version: 1,
  payload: z.object({ agentId: u, fromSeniority: seniority, toSeniority: seniority, evidenceRefs: strArr, reviewArtifactId: u }),
});
defineEvent({
  type: "agent.promoted",
  version: 1,
  payload: z.object({ agentId: u, toSeniority: seniority, approvalId: u }),
});
defineEvent({
  type: "agent.created",
  version: 1,
  payload: z.object({ agentId: uReq, name: s, positionId: u }),
});
defineEvent({ type: "agent.model.binding.changed", version: 1, payload: z.object({ agentId: u, diff }) });
defineEvent({
  type: "agent.step.started",
  version: 1,
  payload: z.object({ sessionId: u, stepNo: int, actionType: s }),
});
defineEvent({
  type: "agent.step.recorded",
  version: 1,
  payload: z.object({ sessionId: u, stepNo: int, actionType: s }),
});
defineEvent({
  type: "agent.session.stalled",
  version: 1,
  payload: z.object({ sessionId: u, lastStepAt: ts }),
});
defineEvent({
  type: "agent.guard.triggered",
  version: 1,
  payload: z.object({
    guard: z.enum(["budget", "deadline", "step_cap", "loop", "ping_pong", "depth"]),
    context: diff,
  }),
});
defineEvent({
  type: "agent.demotion.recommended",
  version: 1,
  payload: z.object({ agentId: u, fromSeniority: seniority, toSeniority: seniority, evidenceRefs: strArr }),
});
defineEvent({
  type: "escalation.resolved",
  version: 1,
  payload: z.object({ escalationRef: s, resolvedByAgentId: u }),
});
