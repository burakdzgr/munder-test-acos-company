// 10.5 Memory & skills (20 types).
import { MEMORY_SCOPES, MEMORY_TYPES } from "@acos/domain";
import { defineEvent } from "../define.js";
import { z, u, uReq, s, int, num, diff, uArr, strArr, ts } from "./common.js";

const scope = z.enum(MEMORY_SCOPES).optional();

export const MemoryCreatedV1 = defineEvent({
  type: "memory.created",
  version: 1,
  payload: z.object({
    memoryId: uReq,
    scope: z.enum(MEMORY_SCOPES),
    scopeRef: u,
    type: z.enum(MEMORY_TYPES),
    importance: num,
    confidence: num,
    sourceEventId: u,
  }),
});
defineEvent({
  type: "memory.updated",
  version: 1,
  payload: z.object({ memoryId: uReq, versionNo: int, diff }),
});
defineEvent({
  type: "memory.superseded",
  version: 1,
  payload: z.object({ memoryId: uReq, byMemoryId: u, reason: s }),
});
defineEvent({
  type: "memory.archived",
  version: 1,
  payload: z.object({ memoryId: uReq, reason: s }),
});
defineEvent({
  type: "memory.promoted",
  version: 1,
  payload: z.object({ fromMemoryId: u, toScope: scope, newMemoryId: u, approvedByAgentId: u }),
});
defineEvent({
  type: "memory.contradiction.detected",
  version: 1,
  payload: z.object({ memoryIdA: u, memoryIdB: u, relationId: u }),
});
defineEvent({
  type: "memory.consolidation.completed",
  version: 1,
  payload: z.object({ batchId: s, candidates: int, persisted: int, merged: int, discarded: int }),
});
defineEvent({
  type: "skill.created",
  version: 1,
  payload: z.object({ skillId: uReq, name: s, category: s }),
});
defineEvent({
  type: "skill.evidence.recorded",
  version: 1,
  payload: z.object({ agentSkillId: u, kind: s, weight: num, ref: s }),
});
defineEvent({
  type: "agent.skill.updated",
  version: 1,
  payload: z.object({ agentId: u, skillId: u, fromLevel: int, toLevel: int, confidence: num, evidenceCount: int }),
});
// U12 (36 §10): emergent-discovery read-model surfaces a candidate for the
// first time — evidence-based (≥N repeated accepted works, not yet a skill).
defineEvent({
  type: "agent.skill.candidate.proposed",
  version: 1,
  payload: z.object({ agentId: u, skillName: s, score: num, taskCount: int }),
});
defineEvent({
  type: "memory.relation.created",
  version: 1,
  payload: z.object({ relationId: u, fromMemoryId: u, toMemoryId: u, kind: s }),
});
defineEvent({
  type: "memory.promotion.proposed",
  version: 1,
  payload: z.object({ promotionId: u, sourceMemoryId: u, targetScope: scope }),
});
defineEvent({
  type: "memory.evidence.added",
  version: 1,
  payload: z.object({ memoryId: u, evidenceId: u, kind: s, weight: num }),
});
defineEvent({
  type: "memory.retrieved",
  version: 1,
  payload: z.object({ memoryIds: uArr, lane: s }),
});
defineEvent({
  type: "memory.confidence.decayed",
  version: 1,
  payload: z.object({ memoryId: u, from: num, to: num }),
});
defineEvent({
  type: "memory.embedding.failed",
  version: 1,
  payload: z.object({ memoryId: u, model: s, error: s }),
});
defineEvent({
  type: "development.objective.created",
  version: 1,
  payload: z.object({ objectiveId: u, agentId: u, skillId: u, targetLevel: int }),
});
defineEvent({
  type: "development.objective.met",
  version: 1,
  payload: z.object({ objectiveId: u, agentId: u, skillId: u, targetLevel: int }),
});
defineEvent({
  type: "performance.snapshot.created",
  version: 1,
  payload: z.object({ agentId: u, periodStart: ts, periodEnd: ts, refs: strArr }),
});
