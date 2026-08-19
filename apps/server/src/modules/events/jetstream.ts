// JetStream topology (10 §5): ACOS_EVENTS stream + durable pull consumers.
import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
  type JetStreamManager,
  type NatsConnection,
} from "nats";
import { MEMORY_SIGNIFICANT_SUBJECT_FILTERS } from "@acos/events";

export const STREAM_NAME = "ACOS_EVENTS";
const HOUR_NS = 3_600_000_000_000;
const SECOND_NS = 1_000_000_000;

export const DURABLE_CONSUMERS: Array<{ name: string; filters: string[] }> = [
  { name: "office-projector", filters: ["co.*.agent.>", "co.*.task.>", "co.*.approval.>"] },
  {
    // 10 §5 memory-trigger row: the terminal-task subjects PLUS "significance
    // counters on the rest" — the 12 §5.0 N-significant-events trigger can only
    // count what the consumer actually receives, so the significant subset
    // (@acos/events) is subscribed wholesale. `co.*.task.>` subsumes
    // task.completed/failed and `co.*.review.>` subsumes review.completed;
    // JetStream rejects OVERLAPPING filter_subjects, so they are not repeated.
    name: "memory-trigger",
    filters: [
      ...MEMORY_SIGNIFICANT_SUBJECT_FILTERS,
      "co.*.escalation.resolved", // 12 §5.0 row 3
      "co.*.experiment.completed", // 12 §5.0 row 4
    ],
  },
  { name: "cost-aggregator", filters: ["co.*.task.>", "co.*.budget.>"] },
  // A4 (07 §3): the dependency bridge needs its OWN cursor. Durables may
  // overlap with each other (only filters within one consumer may not), and
  // sharing `cost-aggregator` would make the two handlers compete for the
  // same messages — each event is delivered to a durable once.
  { name: "workflow-signals", filters: ["co.*.task.dependency.resolved"] },
  {
    name: "notification",
    filters: [
      "co.*.approval.>",
      "co.*.agent.escalated",
      "co.*.security.alert",
      "co.*.budget.exceeded",
      "co.*.task.deadline.missed",
    ],
  },
];

export async function ensureStream(jsm: JetStreamManager): Promise<void> {
  const config = {
    name: STREAM_NAME,
    subjects: ["co.*.>"],
    storage: StorageType.File,
    num_replicas: 1,
    retention: RetentionPolicy.Limits,
    max_age: 72 * HOUR_NS, // working retention; replay truth is the events table
    discard: DiscardPolicy.Old,
    duplicate_window: 120 * SECOND_NS, // Nats-Msg-Id = event id
  };
  try {
    await jsm.streams.info(STREAM_NAME);
    await jsm.streams.update(STREAM_NAME, config);
  } catch {
    await jsm.streams.add(config);
  }
}

export async function ensureDurableConsumers(
  jsm: JetStreamManager,
  overrides?: { ackWaitNs?: number; maxDeliver?: number },
): Promise<void> {
  for (const consumer of DURABLE_CONSUMERS) {
    const config = {
      durable_name: consumer.name,
      ack_policy: AckPolicy.Explicit,
      ack_wait: overrides?.ackWaitNs ?? 30 * SECOND_NS,
      max_deliver: overrides?.maxDeliver ?? 5,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: consumer.filters,
    };
    let existing;
    try {
      existing = await jsm.consumers.info(STREAM_NAME, consumer.name);
    } catch {
      await jsm.consumers.add(STREAM_NAME, config);
      continue;
    }
    // An already-provisioned durable keeps its ORIGINAL filters, so a widened
    // filter list (M1: the 12 §5.0 significance counters) would never reach the
    // consumer on an existing deployment. Reconcile in place — durable state
    // (ack floor, pending) survives an update, unlike a delete+add.
    const current = existing.config.filter_subjects ??
      (existing.config.filter_subject ? [existing.config.filter_subject] : []);
    const drifted =
      current.length !== consumer.filters.length ||
      consumer.filters.some((subject) => !current.includes(subject));
    if (drifted) {
      await jsm.consumers.update(STREAM_NAME, consumer.name, {
        // `filter_subject` and `filter_subjects` are mutually exclusive server
        // side, and update() merges into the CURRENT config — clear the
        // singular form so a legacy single-filter durable can be widened
        filter_subject: "",
        filter_subjects: consumer.filters,
      });
    }
  }
}

export async function provisionJetStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await ensureStream(jsm);
  await ensureDurableConsumers(jsm);
}
