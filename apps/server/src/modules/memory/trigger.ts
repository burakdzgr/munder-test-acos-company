// memory-trigger consumer (T44/M1; 10 §5, 12 §5.0). Drains the T21 durable
// JetStream consumer and starts one memoryConsolidationWorkflow per trigger
// occurrence. Workflow id `memory-consolidation-<company_id>-<trigger_ref>`
// (12 §5) is what makes redelivery and double-publish harmless, so every
// trigger below picks a triggerRef that is DERIVABLE FROM THE EVENT ITSELF —
// never from wall-clock time or from a counter that a restart would rewind.
//
// 12 §5.0 trigger table, and how each row lands here:
//
//   | Task completion      | task.completed / task.failed | task-<taskId>            |
//   | N significant events | per-agent counter, N =                                  |
//   |                      | company_settings.consolidation_event_threshold           |
//   |                      | (20 §, default 25)           | events-<agentId>-<seq>   |
//   | Escalation resolved  | escalation.resolved          | escalation-<ref>         |
//   | Experiment concluded | experiment.completed         | experiment-<id>          |
//   | Reflection submission| reflection ACTIVITY output (13 §7) — not an event; the   |
//   |                      | reflection lane starts consolidation itself, so there is |
//   |                      | nothing for this consumer to observe.                    |
//   | Founder manual       | Observatory "Add memory" — a REST write, likewise not    |
//   |                      | a NATS trigger.                                          |
//
// Idempotency: per-company seq high-water mark (10 §6.1 — "per-consumer
// last_seq per company; events arrive in per-company order on one consumer").
// The mark advances only AFTER the message is handled, so a nak'd message is
// still reprocessed on redelivery.
import type { NatsConnection } from "nats";
import { isMemorySignificant } from "@acos/events";
import { STREAM_NAME } from "../events/jetstream.js";

/** 12 §5.0 trigger kinds this consumer can raise. */
export type ConsolidationTrigger =
  | "task_completed"
  | "task_failed"
  | "significant_events"
  | "escalation_resolved"
  | "experiment_completed";

export interface ConsolidationStartInput {
  companyId: string;
  /**
   * Task-completion window (12 §5.0 row 1). Absent for the agent-anchored
   * triggers — those carry `agentId` + `sourceEventIds` instead.
   */
  taskId?: string;
  /** Agent-anchored window (12 §5.0 rows 2–4). */
  agentId?: string;
  /** The exact events the window is made of (12 §5.0 "the N events since last run"). */
  sourceEventIds?: string[];
  trigger: ConsolidationTrigger;
  /**
   * Deterministic dedupe key for `memory-consolidation-<companyId>-<triggerRef>`
   * (12 §5). Reproducible from the triggering event alone.
   */
  triggerRef: string;
}

/** Doc default for `company_settings.consolidation_event_threshold` (12 §5.0, 20 §). */
export const DEFAULT_CONSOLIDATION_EVENT_THRESHOLD = 25;

export interface MemoryTriggerOptions {
  nats: NatsConnection;
  /** starts memoryConsolidationWorkflow; must swallow already-started */
  start: (input: ConsolidationStartInput) => Promise<void>;
  /** T49: project-completion check + executive report on terminal tasks */
  onTaskTerminal?: ((input: { companyId: string; taskId: string }) => Promise<void>) | undefined;
  /**
   * 12 §5.0 row 2: N comes from `company_settings.consolidation_event_threshold`
   * — no new setting is invented. Resolution failures fall back to the doc
   * default rather than stalling the counter.
   */
  thresholdFor?: ((companyId: string) => Promise<number>) | undefined;
  onError: (err: unknown) => void;
}

interface TriggerEnvelope {
  id?: string;
  companyId?: string;
  seq?: number;
  type?: string;
  actor?: { kind?: string; id?: string | null };
  subject?: { taskId?: string | null; projectId?: string | null; agentId?: string | null };
  payload?: Record<string, unknown>;
}

export interface MemoryTriggerHandle {
  stop: () => Promise<void>;
}

interface CompanyState {
  /** 10 §6.1 high-water mark — events at or below this seq were already handled */
  lastSeq: number;
  /** N-significant-events counter per agent (12 §5.0 row 2: "counts per agent") */
  counts: Map<string, string[]>;
  threshold: number | null;
}

/**
 * Workflow ids must survive a round-trip through Temporal and a log line, so
 * a triggerRef taken from an event PAYLOAD (escalationRef is free-form text)
 * is normalised. Empty results fall back to the caller's default.
 */
function safeRef(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

export async function startMemoryTrigger(options: MemoryTriggerOptions): Promise<MemoryTriggerHandle> {
  const js = options.nats.jetstream();
  const consumer = await js.consumers.get(STREAM_NAME, "memory-trigger");
  const messages = await consumer.consume();
  const state = new Map<string, CompanyState>();

  function stateFor(companyId: string): CompanyState {
    let existing = state.get(companyId);
    if (!existing) {
      existing = { lastSeq: 0, counts: new Map(), threshold: null };
      state.set(companyId, existing);
    }
    return existing;
  }

  async function thresholdFor(companyId: string, company: CompanyState): Promise<number> {
    if (company.threshold !== null) return company.threshold;
    let resolved = DEFAULT_CONSOLIDATION_EVENT_THRESHOLD;
    if (options.thresholdFor) {
      try {
        const value = await options.thresholdFor(companyId);
        if (Number.isInteger(value) && value > 0) resolved = value;
      } catch (err) {
        // a settings read failure must not stall the counter (12 §5.0)
        options.onError(err);
      }
    }
    company.threshold = resolved;
    return resolved;
  }

  /**
   * 12 §5.0 row 2. Counts significant events per agent; on the Nth one the
   * window is exactly the ids counted since the previous run for that agent.
   * triggerRef = `events-<agentId>-<seq of the tripping event>`: reproducible
   * from that event, and monotonically fresh across restarts (a restarted
   * counter trips on a LATER event, hence a later seq — it can never collide
   * with an id already used).
   */
  async function countSignificant(
    envelope: TriggerEnvelope,
    company: CompanyState,
  ): Promise<void> {
    const companyId = envelope.companyId!;
    const agentId = envelope.subject?.agentId ?? null;
    const eventId = envelope.id;
    // events with no acting agent cannot be attributed to a per-agent counter
    if (!agentId || !eventId || !envelope.type || !isMemorySignificant(envelope.type)) return;

    const bucket = company.counts.get(agentId) ?? [];
    bucket.push(eventId);
    company.counts.set(agentId, bucket);

    const threshold = await thresholdFor(companyId, company);
    if (bucket.length < threshold) return;

    company.counts.set(agentId, []);
    await options.start({
      companyId,
      agentId,
      sourceEventIds: bucket,
      trigger: "significant_events",
      triggerRef: `events-${agentId}-${envelope.seq ?? 0}`,
    });
  }

  async function handle(envelope: TriggerEnvelope, company: CompanyState): Promise<void> {
    const companyId = envelope.companyId;
    const type = envelope.type;
    if (!companyId || !type) return;
    const taskId = envelope.subject?.taskId ?? undefined;
    // the acting agent: escalations/experiments are raised BY someone
    const agentId =
      envelope.subject?.agentId ??
      (envelope.actor?.kind === "agent" ? (envelope.actor.id ?? null) : null) ??
      undefined;

    // 12 §5.0 row 1 — terminal task; unchanged `task-<taskId>` ref keeps the
    // ids of already-running consolidations stable
    if ((type === "task.completed" || type === "task.failed") && taskId) {
      await options.start({
        companyId,
        taskId,
        trigger: type === "task.failed" ? "task_failed" : "task_completed",
        triggerRef: `task-${taskId}`,
      });
      // demo 23–24 (T49): the same terminal signal drives the
      // project-completion check + the CEO's executive report
      await options.onTaskTerminal?.({ companyId, taskId });
    }

    // 12 §5.0 row 3 — escalation resolved: window is the escalation thread +
    // its resolution. `escalationRef` is the payload's stable identity
    // (10 §, escalation.resolved: escalationRef, resolvedByAgentId).
    if (type === "escalation.resolved") {
      const resolvedBy = envelope.payload?.["resolvedByAgentId"];
      const anchorAgent = taskId
        ? undefined
        : ((typeof resolvedBy === "string" ? resolvedBy : undefined) ?? agentId);
      if (taskId || anchorAgent) {
        await options.start({
          companyId,
          ...(taskId ? { taskId } : {}),
          ...(anchorAgent ? { agentId: anchorAgent } : {}),
          ...(envelope.id ? { sourceEventIds: [envelope.id] } : {}),
          trigger: "escalation_resolved",
          triggerRef: `escalation-${safeRef(envelope.payload?.["escalationRef"], envelope.id ?? "unknown")}`,
        });
      }
    }

    // 12 §5.0 row 4 — experiment concluded: window is the experiment row +
    // its result payload; `experimentId` is the stable identity.
    if (type === "experiment.completed") {
      const experimentId = envelope.payload?.["experimentId"];
      // a task window supersedes the agent window (12 §5.0 row 1 is richer)
      const anchorAgent = taskId ? undefined : agentId;
      if (taskId || anchorAgent) {
        await options.start({
          companyId,
          ...(taskId ? { taskId } : {}),
          ...(anchorAgent ? { agentId: anchorAgent } : {}),
          ...(envelope.id ? { sourceEventIds: [envelope.id] } : {}),
          trigger: "experiment_completed",
          triggerRef: `experiment-${safeRef(experimentId, envelope.id ?? "unknown")}`,
        });
      }
    }

    // 12 §5.0 row 2 — every significant event also feeds the per-agent counter
    await countSignificant(envelope, company);
  }

  const loop = (async () => {
    for await (const msg of messages) {
      try {
        const envelope = JSON.parse(msg.string()) as TriggerEnvelope;
        const companyId = envelope.companyId;
        if (companyId) {
          const company = stateFor(companyId);
          const seq = typeof envelope.seq === "number" ? envelope.seq : 0;
          // 10 §6.1: already counted/handled in this process — ack, don't
          // double-count the N-significant-events window
          if (seq === 0 || seq > company.lastSeq) {
            await handle(envelope, company);
            if (seq > company.lastSeq) company.lastSeq = seq;
          }
        }
        msg.ack(); // unattributable envelopes ack too — nothing to retry
      } catch (err) {
        options.onError(err);
        msg.nak(5_000); // redeliver; max_deliver 5 → DLQ (T21)
      }
    }
  })().catch((err) => options.onError(err));

  return {
    stop: async () => {
      messages.stop();
      await loop;
    },
  };
}
