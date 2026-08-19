// T14 acceptance: every catalog entry has a schema + ≥1 fixture parsing
// green; registry keys match doc 10 §10's table exactly (191 durable + 1
// ephemeral — U12 added agent.skill.candidate.proposed, 36 §10;
// 2026-08-15 added tool.invocation.failed, Founder onayıyla 10 §10.1'e).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getEventDefinition,
  knownDurableEventTypes,
  knownEphemeralEventTypes,
  knownEventTypes,
  parseEventPayload,
} from "../define.js";
import "../index.js"; // register the full catalog

const DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/architecture/docs/10-EVENT-ARCHITECTURE.md",
);

function typesFromDoc(): string[] {
  const doc = readFileSync(DOC, "utf8");
  const section = doc.slice(doc.indexOf("### 10.1"), doc.indexOf("Catalog count:"));
  const types: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const firstCell = line.split("|")[1]!;
    for (const match of firstCell.matchAll(/`([a-z0-9_.]+)`/g)) types.push(match[1]!);
  }
  return [...new Set(types)].sort();
}

const UUID = "018f0000-0000-7000-8000-000000000001";

/** Rich fixtures for events with required payload fields. */
const FIXTURES: Record<string, unknown> = {
  "company.created": { name: "Acme Technologies", currency: "USD" },
  "department.created": { orgUnitId: UUID, name: "Engineering" },
  "team.created": { orgUnitId: UUID, name: "Backend" },
  "position.created": { positionId: UUID, title: "Backend Engineer" },
  "org.edge.created": { edgeId: UUID, kind: "reports_to", fromAgentId: UUID, toAgentId: UUID },
  "org.edge.ended": { edgeId: UUID },
  "org.unit.created": { orgUnitId: UUID, kind: "team", name: "Backend" },
  "agent.hired": { agentId: UUID, employeeNumber: 7, name: "Alex Demir", seniority: "senior" },
  "agent.created": { agentId: UUID, name: "Alex Demir" },
  "agent.session.started": { sessionId: UUID, workflowId: "agent-task.x.y" },
  "agent.session.ended": { sessionId: UUID, status: "completed", costCents: 12 },
  "agent.guard.triggered": { guard: "loop" },
  "task.created": { number: 81, kind: "task", title: "Implement login" },
  "task.status.changed": {
    from: "IN_PROGRESS",
    to: "REVIEW",
    byActor: { kind: "agent", id: UUID },
  },
  "agent.task.assigned": { taskId: UUID, agentId: UUID },
  "task.dependency.added": { dependsOnTaskId: UUID },
  "task.dependency.resolved": { dependsOnTaskId: UUID },
  "channel.created": { channelId: UUID, kind: "task_thread" },
  "channel.member.added": { channelId: UUID, agentId: UUID },
  "channel.member.removed": { channelId: UUID, agentId: UUID },
  "channel.archived": { channelId: UUID },
  "agent.message.sent": { messageId: UUID, channelId: UUID, kind: "text" },
  "memory.created": { memoryId: UUID, scope: "agent", scopeRef: UUID, type: "failure" },
  "memory.updated": { memoryId: UUID, versionNo: 2 },
  "memory.superseded": { memoryId: UUID },
  "memory.archived": { memoryId: UUID },
  "memory.contradiction.detected": { memoryIdA: UUID, memoryIdB: UUID },
  "skill.created": { skillId: UUID, name: "TypeScript" },
  "project.created": { projectId: UUID, name: "Storefront" },
  "project.imported": { projectId: UUID },
  "review.requested": { reviewId: UUID, reviewerAgentId: UUID },
  "review.started": { reviewId: UUID },
  "review.completed": { reviewId: UUID, verdict: "approved" },
  "workspace.port.opened": { workspaceId: UUID, port: 3000, previewUrl: "http://localhost:3000/preview/x" },
  "workspace.provisioned": { workspaceId: UUID, isolationLevel: "coding" },
  "workspace.destroyed": { workspaceId: UUID },
  "workspace.merged": { workspaceId: UUID, branch: "task/81-implement-login" },
  "workspace.failed": { workspaceId: UUID },
  "workspace.status.changed": { workspaceId: UUID, from: "ready", to: "in_use" },
  "workspace.terminal.output": { sessionId: UUID, frame: "YmFzZTY0", ts: 1786400000000 },
  "workspace.terminal.opened": { sessionId: UUID },
  "workspace.terminal.closed": { sessionId: UUID },
  "workspace.egress.denied": { workspaceId: UUID, domain: "example.com", count: 3 },
  "artifact.created": { artifactId: UUID, kind: "intake_report" },
  "decision.recorded": { decisionId: UUID, number: 1 },
  "decision.status.changed": { decisionId: UUID, from: "proposed", to: "accepted" },
  "approval.requested": { approvalId: UUID, kind: "vendor", title: "Sign up for Sentry" },
  "approval.approved": { approvalId: UUID },
  "approval.rejected": { approvalId: UUID },
  "approval.needs_review": { approvalId: UUID },
  "approval.expired": { approvalId: UUID },
  "approval.endorsed": { approvalId: UUID, verdict: "endorse" },
  "approval.reminder.sent": { approvalId: UUID },
  "budget.exceeded": { budgetId: UUID, spentCents: 5100, limitCents: 5000 },
  "budget.created": { budgetId: UUID },
  "budget.updated": { budgetId: UUID },
  "budget.forecast_breach": { budgetId: UUID, projectedPct: 1.15 },
  "budget.restored": { budgetId: UUID },
  "policy.created": { policyId: UUID },
  "policy.updated": { policyId: UUID },
  "policy.injection.flagged": { source: "repo:readme" },
  "notification.read": { notificationId: UUID },
  "incident.opened": { incidentId: UUID, severity: "sev2" },
  "incident.mitigated": { incidentId: UUID },
  "incident.resolved": { incidentId: UUID },
  "incident.postmortem.published": { incidentId: UUID },
  "office.avatar.moved": { agentId: UUID, toZone: "desk-7", reason: UUID },
  "office.interaction.started": { interactionId: UUID, kind: "review" },
  "office.interaction.ended": { interactionId: UUID, durationMs: 4000 },
  "office.status.changed": { agentId: UUID, badge: "WORKING", causeEventId: UUID },
  "marketing.content.planned": { contentId: UUID },
  "marketing.content.drafted": { contentId: UUID },
  "marketing.content.published": { contentId: UUID },
  "marketing.analytics.received": { contentId: UUID },
  "marketing.content.status.changed": { contentId: UUID, from: "idea", to: "concept" },
  "marketing.content.publish.scheduled": { contentId: UUID },
  "marketing.content.publish.failed": { contentId: UUID },
  "analytics.metric.updated": { contentId: UUID, metricKey: "ctr", value: 0.05 },
  "experiment.started": { experimentId: UUID },
  "experiment.completed": { experimentId: UUID },
  "experiment.status.changed": { experimentId: UUID },
  "experiment.result.recorded": { experimentId: UUID },
  "experiment.adopted": { experimentId: UUID },
  "asset.created": { assetId: UUID },
  "asset.archived": { assetId: UUID },
  "asset.rights.expired": { assetId: UUID },
};

describe("event catalog ↔ doc 10 §10 (CI consistency check)", () => {
  it("registry keys match the doc table exactly", () => {
    expect(knownEventTypes()).toEqual(typesFromDoc());
  });

  it("counts 191 durable + 1 ephemeral (workspace.terminal.output)", () => {
    expect(knownDurableEventTypes()).toHaveLength(192);
    expect(knownEphemeralEventTypes()).toEqual(["workspace.terminal.output"]);
  });
});

describe("every catalog entry parses a fixture (T14 acceptance)", () => {
  for (const type of knownEventTypes()) {
    it(`${type} v1`, () => {
      const definition = getEventDefinition(type, 1);
      expect(definition).toBeDefined();
      const fixture = FIXTURES[type] ?? {};
      expect(() => definition!.payload.parse(fixture)).not.toThrow();
    });
  }
});

describe("payload typing rejects wrong shapes", () => {
  it("task.status.changed refuses an unknown state and a missing actor", () => {
    expect(() =>
      parseEventPayload("task.status.changed", 1, {
        from: "IN_PROGRESS",
        to: "NOT_A_STATE",
        byActor: { kind: "agent", id: UUID },
      }),
    ).toThrow();
    expect(() =>
      parseEventPayload("task.status.changed", 1, { from: "IN_PROGRESS", to: "REVIEW" }),
    ).toThrow();
  });

  it("office.avatar.moved requires the causing event id (INV-12)", () => {
    expect(() =>
      parseEventPayload("office.avatar.moved", 1, { agentId: UUID, toZone: "desk-7" }),
    ).toThrow();
  });

  it("agent.hired requires identity fields", () => {
    expect(() => parseEventPayload("agent.hired", 1, { name: "Alex" })).toThrow();
  });
});
