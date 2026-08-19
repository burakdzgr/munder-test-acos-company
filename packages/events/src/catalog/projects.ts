// 10.6 Projects, engineering, workspaces (49 types; includes the single
// ephemeral event workspace.terminal.output).
import { ISOLATION_LEVELS, PROJECT_STATUSES, WORKSPACE_STATUSES } from "@acos/domain";
import { defineEvent } from "../define.js";
import { z, u, uReq, s, sReq, int, num, strArr, uArr, actorRef } from "./common.js";

const projectStatus = z.enum(PROJECT_STATUSES).optional();
const workspaceStatus = z.enum(WORKSPACE_STATUSES).optional();

defineEvent({
  type: "project.created",
  version: 1,
  payload: z.object({ projectId: uReq, name: s, objective: s }),
});
defineEvent({
  type: "project.imported",
  version: 1,
  payload: z.object({ projectId: uReq, sourceRef: s, repoPath: s }),
});
defineEvent({
  type: "project.intake.started",
  version: 1,
  payload: z.object({ projectId: u, analysisPlan: strArr }),
});
defineEvent({
  type: "project.analysis.completed",
  version: 1,
  payload: z.object({ intakeReportArtifactId: u, findingsSummary: s, routedTaskIds: uArr }),
});
defineEvent({
  type: "project.build.failed",
  version: 1,
  payload: z.object({ taskId: u, workspaceId: u, artifactId: u, exitCode: int, summary: s }),
});
defineEvent({
  type: "project.tests.failed",
  version: 1,
  payload: z.object({ taskId: u, workspaceId: u, failed: int, passed: int, reportArtifactId: u }),
});
defineEvent({
  type: "project.tests.passed",
  version: 1,
  payload: z.object({ taskId: u, workspaceId: u, passed: int, coverage: num }),
});
for (const t of ["project.deployment.started", "project.deployment.completed", "project.deployment.failed"]) {
  defineEvent({
    type: t,
    version: 1,
    payload: z.object({ deploymentId: u, environment: s, ref: s, statusDetail: s }),
  });
}
defineEvent({
  type: "project.completed",
  version: 1,
  payload: z.object({ outcomeSummary: s, reportArtifactId: u }),
});
defineEvent({ type: "project.archived", version: 1, payload: z.object({ reason: s }) });
defineEvent({
  type: "review.requested",
  version: 1,
  payload: z.object({ reviewId: uReq, taskId: u, artifactId: u, reviewerAgentId: u }),
});
defineEvent({
  type: "review.started",
  version: 1,
  payload: z.object({ reviewId: uReq, reviewerAgentId: u }),
});
defineEvent({
  type: "review.completed",
  version: 1,
  payload: z.object({ reviewId: uReq, verdict: s, notes: s, durationMs: int }),
});
defineEvent({
  // TASK 17: sandbox'ta dinleyen port keşfedildi — Preview Gateway standardı
  type: "workspace.port.opened",
  version: 1,
  payload: z.object({ workspaceId: uReq, port: z.number().int(), previewUrl: s }),
});
defineEvent({
  type: "workspace.provisioned",
  version: 1,
  payload: z.object({ workspaceId: uReq, taskId: u, image: s, isolationLevel: z.enum(ISOLATION_LEVELS).optional() }),
});
defineEvent({
  type: "workspace.destroyed",
  version: 1,
  payload: z.object({ workspaceId: uReq, reason: s }),
});
defineEvent({
  type: "workspace.merged",
  version: 1,
  payload: z.object({ workspaceId: uReq, branch: s, mergeCommit: s }),
});
defineEvent({
  type: "workspace.failed",
  version: 1,
  payload: z.object({ workspaceId: uReq, reason: s }),
});
/** THE single ephemeral event — NATS only, never the events table (_DECISIONS §9). */
export const WorkspaceTerminalOutputV1 = defineEvent({
  type: "workspace.terminal.output",
  version: 1,
  ephemeral: true,
  payload: z.object({ sessionId: uReq, frame: sReq, ts: z.number() }),
});
defineEvent({
  type: "project.status.changed",
  version: 1,
  payload: z.object({ from: projectStatus, to: projectStatus, byActor: actorRef }),
});
for (const t of ["project.activated", "project.paused", "project.resumed", "project.cancelled"]) {
  defineEvent({ type: t, version: 1, payload: z.object({ projectId: u, byActor: actorRef }) });
}
defineEvent({
  type: "project.repo.ingested",
  version: 1,
  payload: z.object({ repoPath: s, sizeBytes: int, branches: strArr }),
});
defineEvent({
  type: "project.intake.step.completed",
  version: 1,
  payload: z.object({ step: s, artifactRef: s }),
});
defineEvent({ type: "project.member.added", version: 1, payload: z.object({ agentId: u, role: s }) });
defineEvent({ type: "project.member.removed", version: 1, payload: z.object({ agentId: u, role: s }) });
defineEvent({ type: "environment.configured", version: 1, payload: z.object({ name: s, baseUrl: s }) });
defineEvent({
  type: "repo.sync.diverged",
  version: 1,
  payload: z.object({ branch: s, ahead: int, behind: int }),
});
defineEvent({
  type: "artifact.created",
  version: 1,
  payload: z.object({ artifactId: uReq, kind: s, taskId: u }),
});
defineEvent({
  type: "decision.recorded",
  version: 1,
  payload: z.object({ decisionId: uReq, number: int, status: s }),
});
defineEvent({
  type: "decision.status.changed",
  version: 1,
  payload: z.object({ decisionId: uReq, from: s, to: s }),
});
defineEvent({
  type: "workspace.status.changed",
  version: 1,
  payload: z.object({ workspaceId: uReq, from: workspaceStatus, to: workspaceStatus }),
});
for (const t of ["workspace.lock.acquired", "workspace.lock.conflict", "workspace.lock.released"]) {
  defineEvent({ type: t, version: 1, payload: z.object({ lockId: u, paths: strArr, taskIds: uArr }) });
}
defineEvent({
  type: "workspace.build.started",
  version: 1,
  payload: z.object({ taskId: u, workspaceId: u }),
});
defineEvent({
  type: "workspace.terminal.opened",
  version: 1,
  payload: z.object({ sessionId: uReq, workspaceId: u }),
});
defineEvent({
  type: "workspace.terminal.closed",
  version: 1,
  payload: z.object({ sessionId: uReq, workspaceId: u }),
});
defineEvent({
  type: "workspace.creation.deferred",
  version: 1,
  payload: z.object({ reason: s, requestedTaskId: u }),
});
export const WorkspaceEgressDeniedV1 = defineEvent({
  type: "workspace.egress.denied",
  version: 1,
  payload: z.object({ workspaceId: u, domain: sReq, count: int }),
});
for (const t of ["ci.run.started", "ci.run.finished", "ci.gate.failed"]) {
  defineEvent({ type: t, version: 1, payload: z.object({ runId: s, taskId: u, gates: strArr }) });
}
defineEvent({
  type: "guardian.finding.created",
  version: 1,
  payload: z.object({ findingId: u, fingerprint: s, severity: s }),
});
defineEvent({ type: "guardian.task.filed", version: 1, payload: z.object({ taskId: u, fingerprint: s }) });
defineEvent({ type: "report.published", version: 1, payload: z.object({ artifactId: u, period: s }) });
