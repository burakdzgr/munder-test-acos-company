// 10.1 Company & organization (16 types).
import { defineEvent } from "../define.js";
import { z, u, uReq, s, sReq, diff, uArr } from "./common.js";

export const CompanyCreatedV1 = defineEvent({
  type: "company.created",
  version: 1,
  payload: z.object({ name: sReq, currency: s, settings: diff }),
});
defineEvent({ type: "company.updated", version: 1, payload: z.object({ diff }) });
defineEvent({
  type: "department.created",
  version: 1,
  payload: z.object({ orgUnitId: uReq, name: s, parentUnitId: u }),
});
defineEvent({
  type: "team.created",
  version: 1,
  payload: z.object({ orgUnitId: uReq, name: s, departmentId: u }),
});
defineEvent({ type: "org.unit.updated", version: 1, payload: z.object({ orgUnitId: u, diff }) });
defineEvent({
  type: "position.created",
  version: 1,
  payload: z.object({ positionId: uReq, title: s, seniorityTrack: z.array(z.string()).optional(), wipLimit: z.number().int().optional() }),
});
defineEvent({
  type: "org.edge.created",
  version: 1,
  payload: z.object({ edgeId: uReq, kind: s, fromAgentId: u, toAgentId: u, toUnitId: u }),
});
defineEvent({
  type: "org.edge.ended",
  version: 1,
  payload: z.object({ edgeId: uReq, endedAt: s, reason: s }),
});
defineEvent({ type: "company.settings.updated", version: 1, payload: z.object({ diff }) });
defineEvent({ type: "company.member.added", version: 1, payload: z.object({ userId: u, role: s }) });
defineEvent({ type: "company.archived", version: 1, payload: z.object({ reason: s }) });
defineEvent({
  type: "org.unit.created",
  version: 1,
  payload: z.object({ orgUnitId: uReq, kind: s, name: s }),
});
defineEvent({ type: "org.unit.archived", version: 1, payload: z.object({ orgUnitId: u, archivedAt: s }) });
defineEvent({
  type: "org.reorg.applied",
  version: 1,
  payload: z.object({ operation: s, movedIds: uArr, initiator: s }),
});
defineEvent({
  type: "org.relationship.recomputed",
  version: 1,
  payload: z.object({ created: z.number().int().optional(), updated: z.number().int().optional(), ended: z.number().int().optional() }),
});
defineEvent({ type: "position.updated", version: 1, payload: z.object({ positionId: u, diff }) });
