// 10.7 Approvals, security, cost, policy (39 types).
import { RISK_CLASSES, TASK_RISKS } from "@acos/domain";
import { defineEvent } from "../define.js";
import { z, u, uReq, s, sReq, int, num, diff, uArr } from "./common.js";

const risk = z.enum(TASK_RISKS).optional();
const riskClass = z.enum(RISK_CLASSES).optional();

export const ApprovalRequestedV1 = defineEvent({
  type: "approval.requested",
  version: 1,
  payload: z.object({
    approvalId: uReq,
    kind: sReq,
    title: sReq,
    brief: diff,
    risk,
    costCents: int,
    urgency: s,
    deadline: s,
  }),
});
defineEvent({
  type: "approval.approved",
  version: 1,
  payload: z.object({ approvalId: uReq, decisionNote: s, decidedBy: s }),
});
defineEvent({
  type: "approval.rejected",
  version: 1,
  payload: z.object({ approvalId: uReq, decisionNote: s, decidedBy: s }),
});
defineEvent({
  type: "approval.needs_review",
  version: 1,
  payload: z.object({ approvalId: uReq, executiveAgentId: u }),
});
defineEvent({ type: "approval.expired", version: 1, payload: z.object({ approvalId: uReq }) });
defineEvent({
  type: "security.alert",
  version: 1,
  payload: z.object({
    severity: s,
    category: z.enum(["injection", "egress", "permission"]).optional(),
    detail: s,
    refs: diff,
  }),
});
defineEvent({
  type: "budget.warning",
  version: 1,
  payload: z.object({ scope: s, budgetId: u, spentCents: int, limitCents: int }),
});
export const BudgetExceededV1 = defineEvent({
  type: "budget.exceeded",
  version: 1,
  payload: z.object({ scope: s, budgetId: uReq, spentCents: int, limitCents: int, pausedAgentIds: uArr }),
});
defineEvent({
  type: "policy.violation.detected",
  version: 1,
  payload: z.object({ ruleId: u, agentId: u, attemptedActionDigest: s }),
});
defineEvent({
  type: "tool.invocation.denied",
  version: 1,
  payload: z.object({ toolName: s, riskClass, reason: s }),
});
defineEvent({
  type: "tool.invocation.completed",
  version: 1,
  payload: z.object({ toolName: s, riskClass, costCents: int, resultDigest: s }),
});
defineEvent({
  type: "tool.invocation.requested",
  version: 1,
  payload: z.object({ invocationId: u, toolName: s, riskClass }),
});
/**
 * İzin verilmiş ama çalışırken patlayan çağrı (2026-08-15, Founder onayıyla
 * 10 §10.1'e eklendi). Öncesinde `requested`/`denied`/`completed` vardı;
 * dispatch'in hata verdiği hâlin karşılığı yoktu, dolayısıyla ajan aynı
 * hatayı tekrarlarken zaman çizelgesinde hiçbir şey görünmüyordu.
 */
defineEvent({
  type: "tool.invocation.failed",
  version: 1,
  payload: z.object({ toolName: s, riskClass, error: s }),
});
defineEvent({
  type: "tool.permission.granted",
  version: 1,
  payload: z.object({ subjectKind: s, subjectId: u, toolName: s, constraints: diff }),
});
defineEvent({
  type: "tool.permission.revoked",
  version: 1,
  payload: z.object({ subjectKind: s, subjectId: u, toolName: s }),
});
defineEvent({
  type: "tool.rate.throttled",
  version: 1,
  payload: z.object({ agentId: u, toolName: s, count: int }),
});
defineEvent({
  type: "tool.output.flagged",
  version: 1,
  payload: z.object({ invocationId: u, pattern: s, sourceDigest: s }),
});
defineEvent({
  type: "approval.endorsed",
  version: 1,
  payload: z.object({ approvalId: uReq, executiveAgentId: u, verdict: s, note: s }),
});
defineEvent({ type: "approval.reminder.sent", version: 1, payload: z.object({ approvalId: uReq }) });
defineEvent({ type: "policy.created", version: 1, payload: z.object({ policyId: uReq, kind: s }) });
defineEvent({ type: "policy.updated", version: 1, payload: z.object({ policyId: uReq, kind: s }) });
defineEvent({ type: "policy.matched", version: 1, payload: z.object({ policyId: u, matchDigest: s }) });
export const PolicyInjectionFlaggedV1 = defineEvent({
  type: "policy.injection.flagged",
  version: 1,
  payload: z.object({ source: sReq, contentDigest: s, triggeredAction: s }),
});
defineEvent({
  type: "budget.created",
  version: 1,
  payload: z.object({ budgetId: uReq, scope: s, limitCents: int }),
});
defineEvent({
  type: "budget.updated",
  version: 1,
  payload: z.object({ budgetId: uReq, scope: s, limitCents: int }),
});
defineEvent({
  type: "budget.forecast_breach",
  version: 1,
  payload: z.object({ budgetId: uReq, projectedPct: num }),
});
defineEvent({ type: "budget.restored", version: 1, payload: z.object({ budgetId: uReq }) });
defineEvent({
  type: "cost.entry.recorded",
  version: 1,
  payload: z.object({ kind: s, amountCents: int, refs: diff }),
});
defineEvent({
  type: "llm.call.completed",
  version: 1,
  payload: z.object({ callId: u, purpose: s, tokens: int, costCents: int }),
});
defineEvent({
  type: "llm.provider.fallback",
  version: 1,
  payload: z.object({ fromProvider: s, toProvider: s, reason: s }),
});
defineEvent({
  type: "event.dead_lettered",
  version: 1,
  payload: z.object({ eventId: u, consumer: s, error: s }),
});
defineEvent({
  type: "system.alert.raised",
  version: 1,
  payload: z.object({ alertName: s, severity: s, detail: s }),
});
for (const t of ["system.llm.unavailable", "system.execution.paused", "system.clock.skew"]) {
  defineEvent({ type: t, version: 1, payload: z.object({ componentDetail: s }) });
}
defineEvent({ type: "notification.read", version: 1, payload: z.object({ notificationId: uReq }) });
for (const t of ["incident.opened", "incident.mitigated", "incident.resolved", "incident.postmortem.published"]) {
  defineEvent({
    type: t,
    version: 1,
    payload: z.object({ incidentId: uReq, number: int, severity: s }),
  });
}
