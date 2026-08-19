// M1 — the memory-trigger consumer covers the WHOLE 12 §5.0 trigger table, not
// just terminal tasks. Fake NATS messages in, `ConsolidationStartInput`s out:
// each doc row must produce its own trigger kind and a triggerRef that is
// reproducible from the event alone (12 §5 workflow-id dedupe).
//
// Not covered here because they are not NATS triggers (12 §5.0): "Reflection
// submission" (a reflection ACTIVITY output, 13 §7) and "Founder manual"
// (Observatory "Add memory", a REST write).
import { describe, expect, it } from "vitest";
import type { NatsConnection } from "nats";
import {
  DEFAULT_CONSOLIDATION_EVENT_THRESHOLD,
  startMemoryTrigger,
  type ConsolidationStartInput,
} from "./trigger.js";

const COMPANY = "018f0000-0000-7000-8000-00000000aaaa";
const TASK = "018f0000-0000-7000-8000-00000000bbbb";
const AGENT = "018f0000-0000-7000-8000-00000000cccc";
const OTHER_AGENT = "018f0000-0000-7000-8000-00000000dddd";

interface FakeMsg {
  string: () => string;
  ack: () => void;
  nak: (ms?: number) => void;
}

interface Harness {
  push: (payload: string) => void;
  started: ConsolidationStartInput[];
  terminal: Array<{ companyId: string; taskId: string }>;
  errors: unknown[];
  acked: number;
  naked: number;
  settle: () => Promise<void>;
  stop: () => Promise<void>;
}

async function makeHarness(
  opts: { threshold?: number; thresholdThrows?: boolean } = {},
): Promise<Harness> {
  const queue: FakeMsg[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const counters = { acked: 0, naked: 0 };

  const messages = {
    stop() {
      closed = true;
      notify?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }
    },
  };

  const nats = {
    jetstream: () => ({
      consumers: {
        get: async () => ({ consume: async () => messages }),
      },
    }),
  } as unknown as NatsConnection;

  const started: ConsolidationStartInput[] = [];
  const terminal: Array<{ companyId: string; taskId: string }> = [];
  const errors: unknown[] = [];

  const handle = await startMemoryTrigger({
    nats,
    start: async (input) => {
      started.push(input);
    },
    onTaskTerminal: async (input) => {
      terminal.push(input);
    },
    thresholdFor:
      opts.threshold !== undefined || opts.thresholdThrows
        ? async () => {
            if (opts.thresholdThrows) throw new Error("settings unavailable");
            return opts.threshold!;
          }
        : undefined,
    onError: (err) => errors.push(err),
  });

  const harness: Harness = {
    push: (payload) => {
      queue.push({
        string: () => payload,
        ack: () => {
          counters.acked += 1;
        },
        nak: () => {
          counters.naked += 1;
        },
      });
      notify?.();
    },
    started,
    terminal,
    errors,
    get acked() {
      return counters.acked;
    },
    get naked() {
      return counters.naked;
    },
    // the consume loop is microtask-driven; a handful of macrotask ticks
    // drains everything queued so far
    settle: async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    },
    stop: async () => {
      await handle.stop();
    },
  };
  return harness;
}

let seq = 0;
function envelope(
  type: string,
  extra: {
    taskId?: string | null;
    agentId?: string | null;
    actorAgentId?: string | null;
    payload?: Record<string, unknown>;
    seq?: number;
    id?: string;
  } = {},
): string {
  seq += 1;
  return JSON.stringify({
    id: extra.id ?? crypto.randomUUID(),
    companyId: COMPANY,
    seq: extra.seq ?? seq,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    actor: extra.actorAgentId
      ? { kind: "agent", id: extra.actorAgentId }
      : { kind: "system", id: null },
    subject: {
      taskId: extra.taskId ?? null,
      projectId: null,
      agentId: extra.agentId ?? null,
    },
    correlationId: crypto.randomUUID(),
    causationId: null,
    payload: extra.payload ?? {},
  });
}

describe("memory-trigger — 12 §5.0 row 1: task completion", () => {
  it("task.completed / task.failed start with a `task-<taskId>` triggerRef", async () => {
    const h = await makeHarness();
    h.push(envelope("task.completed", { taskId: TASK }));
    h.push(envelope("task.failed", { taskId: TASK }));
    await h.settle();

    expect(h.started).toEqual([
      {
        companyId: COMPANY,
        taskId: TASK,
        trigger: "task_completed",
        triggerRef: `task-${TASK}`,
      },
      {
        companyId: COMPANY,
        taskId: TASK,
        trigger: "task_failed",
        triggerRef: `task-${TASK}`,
      },
    ]);
    // T49 hook still rides the same terminal signal
    expect(h.terminal).toHaveLength(2);
    expect(h.acked).toBe(2);
    await h.stop();
  });

  it("a terminal event without a taskId starts nothing but is acked", async () => {
    const h = await makeHarness();
    h.push(envelope("task.completed", { taskId: null }));
    await h.settle();

    expect(h.started).toHaveLength(0);
    expect(h.acked).toBe(1);
    await h.stop();
  });
});

describe("memory-trigger — 12 §5.0 row 2: N significant events", () => {
  it("fires on the Nth significant event of an agent, carrying exactly those ids", async () => {
    const h = await makeHarness({ threshold: 3 });
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 10 }));
    h.push(envelope("review.submitted", { agentId: AGENT, seq: 11 }));
    await h.settle();
    expect(h.started).toHaveLength(0); // below threshold

    h.push(envelope("tool.invocation.completed", { agentId: AGENT, seq: 12 }));
    await h.settle();

    expect(h.started).toHaveLength(1);
    const start = h.started[0]!;
    expect(start.trigger).toBe("significant_events");
    expect(start.agentId).toBe(AGENT);
    expect(start.taskId).toBeUndefined();
    // triggerRef is derived from the TRIPPING event's seq — reproducible
    expect(start.triggerRef).toBe(`events-${AGENT}-12`);
    expect(start.sourceEventIds).toHaveLength(3);
    await h.stop();
  });

  it("counts per agent (12 §5.0) — a second agent has its own window", async () => {
    const h = await makeHarness({ threshold: 2 });
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 20 }));
    h.push(envelope("task.status.changed", { agentId: OTHER_AGENT, seq: 21 }));
    await h.settle();
    expect(h.started).toHaveLength(0);

    h.push(envelope("task.status.changed", { agentId: OTHER_AGENT, seq: 22 }));
    await h.settle();

    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.agentId).toBe(OTHER_AGENT);
    expect(h.started[0]!.triggerRef).toBe(`events-${OTHER_AGENT}-22`);
    await h.stop();
  });

  it("the counter resets after firing, so the next window is a fresh N", async () => {
    const h = await makeHarness({ threshold: 2 });
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 30 }));
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 31 }));
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 32 }));
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 33 }));
    await h.settle();

    expect(h.started.map((s) => s.triggerRef)).toEqual([
      `events-${AGENT}-31`,
      `events-${AGENT}-33`,
    ]);
    expect(h.started[1]!.sourceEventIds).toHaveLength(2);
    await h.stop();
  });

  it("non-significant events and agent-less events never count", async () => {
    const h = await makeHarness({ threshold: 2 });
    // not in the significant subset (@acos/events)
    h.push(envelope("company.settings.updated", { agentId: AGENT, seq: 40 }));
    h.push(envelope("office.avatar.moved", { agentId: AGENT, seq: 41 }));
    // significant but unattributable — no subject.agentId to count against
    h.push(envelope("task.status.changed", { agentId: null, seq: 42 }));
    h.push(envelope("task.status.changed", { agentId: null, seq: 43 }));
    await h.settle();

    expect(h.started).toHaveLength(0);
    expect(h.acked).toBe(4);
    await h.stop();
  });

  it("uses company_settings.consolidation_event_threshold, and the doc default when unset", async () => {
    // no thresholdFor wired → the 12 §5.0 / 20 § default of 25
    expect(DEFAULT_CONSOLIDATION_EVENT_THRESHOLD).toBe(25);
    const h = await makeHarness();
    for (let i = 0; i < 24; i += 1) {
      h.push(envelope("task.status.changed", { agentId: AGENT, seq: 100 + i }));
    }
    await h.settle();
    expect(h.started).toHaveLength(0);

    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 124 }));
    await h.settle();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.sourceEventIds).toHaveLength(25);
    await h.stop();
  });

  it("a settings read failure falls back to the default instead of stalling", async () => {
    const h = await makeHarness({ thresholdThrows: true });
    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 200 }));
    await h.settle();

    expect(h.errors).toHaveLength(1);
    expect(h.started).toHaveLength(0); // 1 of 25 — counting continues
    await h.stop();
  });
});

describe("memory-trigger — 12 §5.0 rows 3–4: escalation resolved / experiment concluded", () => {
  it("escalation.resolved anchors on the resolving agent with an `escalation-<ref>` triggerRef", async () => {
    const h = await makeHarness();
    h.push(
      envelope("escalation.resolved", {
        agentId: null,
        payload: { escalationRef: "ESC/2026-08 #7", resolvedByAgentId: AGENT },
      }),
    );
    await h.settle();

    expect(h.started).toHaveLength(1);
    const start = h.started[0]!;
    expect(start.trigger).toBe("escalation_resolved");
    expect(start.agentId).toBe(AGENT);
    // payload refs are free-form text — normalised into a safe workflow id
    expect(start.triggerRef).toBe("escalation-ESC-2026-08--7");
    expect(start.sourceEventIds).toHaveLength(1);
    await h.stop();
  });

  it("escalation.resolved on a task uses the task window", async () => {
    const h = await makeHarness();
    h.push(
      envelope("escalation.resolved", {
        taskId: TASK,
        payload: { escalationRef: "abc", resolvedByAgentId: AGENT },
      }),
    );
    await h.settle();

    expect(h.started[0]).toMatchObject({
      taskId: TASK,
      trigger: "escalation_resolved",
      triggerRef: "escalation-abc",
    });
    expect(h.started[0]!.agentId).toBeUndefined();
    await h.stop();
  });

  it("experiment.completed uses an `experiment-<experimentId>` triggerRef", async () => {
    const h = await makeHarness();
    const experimentId = "018f0000-0000-7000-8000-00000000eeee";
    h.push(
      envelope("experiment.completed", {
        actorAgentId: AGENT,
        payload: { experimentId, result: "adopt", confidence: 0.9, decision: "ship" },
      }),
    );
    await h.settle();

    expect(h.started[0]).toMatchObject({
      companyId: COMPANY,
      agentId: AGENT,
      trigger: "experiment_completed",
      triggerRef: `experiment-${experimentId}`,
    });
    await h.stop();
  });
});

describe("memory-trigger — delivery semantics", () => {
  it("redelivery of the same seq neither restarts nor double-counts (10 §6.1)", async () => {
    const h = await makeHarness({ threshold: 2 });
    const first = envelope("task.status.changed", { agentId: AGENT, seq: 300 });
    h.push(first);
    h.push(first); // redelivered before the next event
    await h.settle();
    expect(h.started).toHaveLength(0); // the duplicate did not trip the counter

    h.push(envelope("task.status.changed", { agentId: AGENT, seq: 301 }));
    await h.settle();
    expect(h.started).toHaveLength(1);
    expect(h.acked).toBe(3);
    await h.stop();
  });

  it("a redelivered terminal task keeps the same triggerRef (workflow-id dedupe, 12 §5)", async () => {
    const h = await makeHarness();
    h.push(envelope("task.completed", { taskId: TASK, seq: 400 }));
    await h.settle();
    // a redelivery AFTER a restart-equivalent (fresh seq) still maps to the
    // same workflow id — the id, not the consumer, is the dedupe
    h.push(envelope("task.completed", { taskId: TASK, seq: 401 }));
    await h.settle();

    expect(h.started.map((s) => s.triggerRef)).toEqual([`task-${TASK}`, `task-${TASK}`]);
    await h.stop();
  });

  it("a malformed envelope naks for redelivery and reports the error", async () => {
    const h = await makeHarness();
    h.push("{ not json");
    await h.settle();

    expect(h.errors).toHaveLength(1);
    expect(h.naked).toBe(1);
    expect(h.acked).toBe(0);
    await h.stop();
  });
});
