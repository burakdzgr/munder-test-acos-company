// 10.4 Communication (7 types).
import { defineEvent } from "../define.js";
import { z, u, uReq, s, int, diff, strArr } from "./common.js";

defineEvent({
  type: "channel.created",
  version: 1,
  payload: z.object({ channelId: uReq, kind: s, name: s, refs: diff }),
});
defineEvent({
  type: "channel.member.added",
  version: 1,
  payload: z.object({ channelId: uReq, agentId: u, founder: z.boolean().optional() }),
});
export const AgentMessageSentV1 = defineEvent({
  type: "agent.message.sent",
  version: 1,
  payload: z.object({
    messageId: uReq,
    channelId: uReq,
    senderAgentId: u,
    kind: s,
    mentions: strArr,
    refs: diff,
    pingPongCount: int,
  }),
});
defineEvent({
  type: "agent.help.requested",
  version: 1,
  payload: z.object({ messageId: u, topic: s, audience: s, targetAgentId: u }),
});
defineEvent({
  type: "agent.help.resolved",
  version: 1,
  payload: z.object({ requestMessageId: u, resolvedByAgentId: u, resolutionMessageId: u }),
});
defineEvent({
  type: "channel.member.removed",
  version: 1,
  payload: z.object({ channelId: uReq, agentId: u }),
});
defineEvent({ type: "channel.archived", version: 1, payload: z.object({ channelId: uReq }) });
