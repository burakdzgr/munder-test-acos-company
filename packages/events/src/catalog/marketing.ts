// 10.9 Marketing & experiments (21 types) — Phase 2 features, schema in MVP.
import { defineEvent } from "../define.js";
import { z, u, uReq, s, int, num, diff, uArr } from "./common.js";

defineEvent({
  type: "marketing.content.planned",
  version: 1,
  payload: z.object({ contentId: uReq, platform: s, conceptRef: s }),
});
defineEvent({
  type: "marketing.content.drafted",
  version: 1,
  payload: z.object({ contentId: uReq, stage: s, artifactIds: uArr }),
});
defineEvent({
  type: "marketing.content.published",
  version: 1,
  payload: z.object({ contentId: uReq, platform: s, externalRef: s }),
});
defineEvent({
  type: "marketing.analytics.received",
  version: 1,
  payload: z.object({ contentId: uReq, metrics: diff, window: s }),
});
defineEvent({
  type: "experiment.started",
  version: 1,
  payload: z.object({ experimentId: uReq, hypothesis: s, metrics: diff, sampleSize: int }),
});
defineEvent({
  type: "experiment.completed",
  version: 1,
  payload: z.object({ experimentId: uReq, result: s, confidence: num, decision: s }),
});
defineEvent({
  type: "marketing.content.status.changed",
  version: 1,
  payload: z.object({ contentId: uReq, from: s, to: s }),
});
defineEvent({
  type: "marketing.content.publish.scheduled",
  version: 1,
  payload: z.object({ contentId: uReq, scheduledAt: s }),
});
defineEvent({
  type: "marketing.content.publish.failed",
  version: 1,
  payload: z.object({ contentId: uReq, error: s }),
});
defineEvent({
  type: "pipeline.stage.completed",
  version: 1,
  payload: z.object({ pipelineRunId: s, stage: s }),
});
defineEvent({
  type: "pipeline.stage.failed",
  version: 1,
  payload: z.object({ pipelineRunId: s, stage: s, error: s }),
});
defineEvent({
  type: "analytics.metric.updated",
  version: 1,
  payload: z.object({ contentId: uReq, metricKey: s, value: num, window: s }),
});
defineEvent({
  type: "experiment.status.changed",
  version: 1,
  payload: z.object({ experimentId: uReq, from: s, to: s }),
});
defineEvent({
  type: "experiment.result.recorded",
  version: 1,
  payload: z.object({ experimentId: uReq, metricKey: s, value: num }),
});
defineEvent({
  type: "experiment.adopted",
  version: 1,
  payload: z.object({ experimentId: uReq, decisionNote: s }),
});
defineEvent({ type: "asset.created", version: 1, payload: z.object({ assetId: uReq, kind: s }) });
defineEvent({ type: "asset.archived", version: 1, payload: z.object({ assetId: uReq, reason: s }) });
defineEvent({
  type: "asset.rights.expired",
  version: 1,
  payload: z.object({ assetId: uReq, expiredAt: s }),
});
defineEvent({
  type: "campaign.spend.recorded",
  version: 1,
  payload: z.object({ campaignRef: s, amountCents: int }),
});
defineEvent({
  type: "integration.connected",
  version: 1,
  payload: z.object({ connectionId: u, platform: s }),
});
defineEvent({
  type: "integration.call.failed",
  version: 1,
  payload: z.object({ connectionId: u, platform: s, error: s }),
});
