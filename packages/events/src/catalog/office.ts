// 10.8 Office projection (4 types) — every instruction carries the causing
// event id; the renderer never animates without one (INV-12).
import { defineEvent } from "../define.js";
import { z, u, uReq, s, sReq, int, uArr } from "./common.js";

export const OfficeAvatarMovedV1 = defineEvent({
  type: "office.avatar.moved",
  version: 1,
  payload: z.object({
    agentId: uReq,
    fromZone: s,
    toZone: sReq,
    path: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
    reason: uReq, // causeEventId
  }),
});
defineEvent({
  type: "office.interaction.started",
  version: 1,
  payload: z.object({ interactionId: uReq, agentIds: uArr, kind: s, zone: s, causeEventId: u }),
});
defineEvent({
  type: "office.interaction.ended",
  version: 1,
  payload: z.object({ interactionId: uReq, durationMs: int, causeEventId: u }),
});
defineEvent({
  type: "office.status.changed",
  version: 1,
  payload: z.object({ agentId: uReq, badge: s, causeEventId: uReq }),
});
