// T44 — the memory-trigger consumer (12 §5.0, 10 §5): a published terminal
// task event on the T21 durable starts memoryConsolidationWorkflow with the
// deterministic `memory-consolidation-<company>-task-<task>` id; non-task
// trigger kinds are acked without a start; redelivery is dedupe-safe because
// the starter swallows already-started.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type NatsConnection } from "nats";
import { subjectFor } from "@acos/events";
import { provisionJetStream } from "../../src/modules/events/jetstream.js";
import {
  startMemoryTrigger,
  type ConsolidationStartInput,
  type MemoryTriggerHandle,
} from "../../src/modules/memory/trigger.js";
import { startNats } from "./helpers";

const COMPANY = "018f0000-0000-7000-8000-00000000aaaa";
const TASK = "018f0000-0000-7000-8000-00000000bbbb";
const AGENT = "018f0000-0000-7000-8000-00000000cccc";
const EXPERIMENT = "018f0000-0000-7000-8000-00000000eeee";

let natsHandle: Awaited<ReturnType<typeof startNats>>;
let nc: NatsConnection;
let trigger: MemoryTriggerHandle;
const started: ConsolidationStartInput[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}

let seq = 0;
function envelope(
  type: string,
  taskId: string | null,
  extra: { agentId?: string; payload?: Record<string, unknown> } = {},
) {
  // seq is company-monotonic in the real outbox; the consumer's 10 §6.1
  // high-water mark relies on it, so the fixtures honour it too
  seq += 1;
  return JSON.stringify({
    id: crypto.randomUUID(),
    companyId: COMPANY,
    seq,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    actor: { kind: "system", id: null },
    subject: { taskId, projectId: null, agentId: extra.agentId ?? null },
    correlationId: crypto.randomUUID(),
    causationId: null,
    payload: extra.payload ?? {},
  });
}

beforeAll(async () => {
  natsHandle = await startNats();
  nc = await connect({ servers: natsHandle.url });
  await provisionJetStream(nc);
  trigger = await startMemoryTrigger({
    nats: nc,
    start: async (input) => {
      started.push(input);
    },
    // 12 §5.0 row 2 — a small N keeps the fixture readable; production reads
    // company_settings.consolidation_event_threshold
    thresholdFor: async () => 3,
    onError: (err) => console.error("trigger error:", err),
  });
}, 300_000);

afterAll(async () => {
  await trigger?.stop().catch(() => {});
  await nc?.close().catch(() => {});
  await natsHandle?.container.stop();
});

describe("memory-trigger consumer (T44)", { timeout: 30_000 }, () => {
  it("task.completed and task.failed start consolidation; other kinds ack silently", async () => {
    const js = nc.jetstream();
    await js.publish(subjectFor(COMPANY, "task.completed"), envelope("task.completed", TASK));
    await js.publish(subjectFor(COMPANY, "task.failed"), envelope("task.failed", TASK));
    // filtered subject the consumer also sees but must not start from (post-MVP kind)
    await js.publish(subjectFor(COMPANY, "agent.escalated"), envelope("agent.escalated", null));

    await waitFor(() => started.length >= 2);
    // give the escalation message time to be (wrongly) turned into a start —
    // `agent.escalated` only feeds the 12 §5.0 N-significant-events counter,
    // and this one carries no subject agent, so it counts for nobody
    await new Promise((r) => setTimeout(r, 500));
    expect(started).toHaveLength(2);
    expect(started[0]).toEqual({
      companyId: COMPANY,
      taskId: TASK,
      trigger: "task_completed",
      triggerRef: `task-${TASK}`,
    });
    expect(started[1]).toEqual({
      companyId: COMPANY,
      taskId: TASK,
      trigger: "task_failed",
      triggerRef: `task-${TASK}`,
    });
  });

  // M1: proves the WIDENED durable filters actually deliver these subjects —
  // the unit suite covers the branching, this covers the JetStream topology
  it("delivers the remaining 12 §5.0 triggers through the durable's filters", async () => {
    const js = nc.jetstream();
    const before = started.length;

    // row 3 — escalation.resolved (was not in the consumer's filters before M1)
    await js.publish(
      subjectFor(COMPANY, "escalation.resolved"),
      envelope("escalation.resolved", null, {
        agentId: AGENT,
        payload: { escalationRef: "esc-1", resolvedByAgentId: AGENT },
      }),
    );
    // row 4 — experiment.completed (likewise newly filtered in)
    await js.publish(
      subjectFor(COMPANY, "experiment.completed"),
      envelope("experiment.completed", null, {
        agentId: AGENT,
        payload: { experimentId: EXPERIMENT, result: "adopt", confidence: 0.9, decision: "ship" },
      }),
    );
    // row 2 — three significant events of one agent (thresholdFor = 3)
    for (const type of ["task.status.changed", "review.submitted", "workspace.created"]) {
      await js.publish(subjectFor(COMPANY, type), envelope(type, null, { agentId: AGENT }));
    }

    await waitFor(() => started.length >= before + 3);
    const kinds = started.slice(before).map((s) => s.trigger);
    expect(kinds).toContain("escalation_resolved");
    expect(kinds).toContain("experiment_completed");
    expect(kinds).toContain("significant_events");

    const escalation = started.slice(before).find((s) => s.trigger === "escalation_resolved");
    expect(escalation?.triggerRef).toBe("escalation-esc-1");
    expect(escalation?.agentId).toBe(AGENT);

    const experiment = started.slice(before).find((s) => s.trigger === "experiment_completed");
    expect(experiment?.triggerRef).toBe(`experiment-${EXPERIMENT}`);

    const events = started.slice(before).find((s) => s.trigger === "significant_events");
    expect(events?.agentId).toBe(AGENT);
    expect(events?.sourceEventIds).toHaveLength(3);
    expect(events?.triggerRef).toMatch(new RegExp(`^events-${AGENT}-\\d+$`));
  });
});
