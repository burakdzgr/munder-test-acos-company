// DLQ handler (10 §5): listens to JetStream MAX_DELIVERIES advisories,
// copies the poisoned event into dead_events and raises an operator alert.
// The consumer's cursor moves past the message (max_deliver exhausted), so
// nothing is silently dropped — it lands here, visibly.
import type { NatsConnection, Subscription } from "nats";
import type { Db } from "@acos/db";
import { deadEvents } from "@acos/db/schema";
import { STREAM_NAME } from "./jetstream.js";

interface MaxDeliverAdvisory {
  stream: string;
  consumer: string;
  stream_seq: number;
  deliveries: number;
}

export interface DeadLetter {
  consumer: string;
  eventId: string;
  eventType: string;
  companyId: string;
}

export class DlqHandler {
  private subscription: Subscription | null = null;

  constructor(
    private readonly nats: NatsConnection,
    private readonly db: Db,
    private readonly onDeadLetter?: (detail: DeadLetter) => void,
  ) {}

  async start(): Promise<void> {
    this.subscription = this.nats.subscribe(
      `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${STREAM_NAME}.*`,
    );
    void this.consume();
  }

  private async consume(): Promise<void> {
    for await (const message of this.subscription!) {
      try {
        const advisory = JSON.parse(new TextDecoder().decode(message.data)) as MaxDeliverAdvisory;
        await this.handleAdvisory(advisory);
      } catch {
        // advisory parsing/storage must never kill the watcher
      }
    }
  }

  private async handleAdvisory(advisory: MaxDeliverAdvisory): Promise<void> {
    const jsm = await this.nats.jetstreamManager();
    const stored = await jsm.streams.getMessage(STREAM_NAME, { seq: advisory.stream_seq });
    const envelope = JSON.parse(new TextDecoder().decode(stored.data)) as {
      id: string;
      companyId: string;
      type: string;
    };
    await this.db
      .insert(deadEvents)
      .values({
        companyId: envelope.companyId,
        eventId: envelope.id,
        eventType: envelope.type,
        consumer: advisory.consumer,
        deliveries: advisory.deliveries,
        error: `max deliveries (${advisory.deliveries}) exhausted`,
        payload: JSON.parse(new TextDecoder().decode(stored.data)),
      })
      .onConflictDoNothing();
    this.onDeadLetter?.({
      consumer: advisory.consumer,
      eventId: envelope.id,
      eventType: envelope.type,
      companyId: envelope.companyId,
    });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    this.subscription.unsubscribe();
    this.subscription = null;
  }
}
