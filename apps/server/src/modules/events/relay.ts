// Outbox relay (10 §4, _DECISIONS §9): leader-elected via
// pg_try_advisory_lock(hashtext('acos:outbox-relay')); exactly one instance
// publishes, followers retry every 5s. Wake-up: LISTEN acos_outbox with a 1s
// polling fallback (polling remains the correctness mechanism).
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import type { NatsConnection } from "nats";
import { subjectFor } from "@acos/events";

const LEADER_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('acos:outbox-relay')) AS ok";

interface OutboxRow {
  id: string;
  company_id: string;
  seq: string | number;
  type: string;
  version: number;
  occurred_at: Date;
  actor: unknown;
  task_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  payload: unknown;
}

export interface RelayOptions {
  connectionString: string;
  nats: NatsConnection;
  batchSize?: number;
  leaderRetryMs?: number;
  pollMs?: number;
  onError?: (err: unknown) => void;
}

export class OutboxRelay {
  private client: Client | null = null;
  private running = false;
  private leader = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly options: RelayOptions) {}

  get isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        // dedicated session — the advisory lock lives on this connection
        this.client = new Client({ connectionString: this.options.connectionString });
        await this.client.connect();

        while (this.running && !this.leader) {
          const result = await this.client.query(LEADER_LOCK_SQL);
          if (result.rows[0]?.ok === true) {
            this.leader = true;
            break;
          }
          await sleep(this.options.leaderRetryMs ?? 5_000);
        }
        if (!this.running) break;

        await this.client.query("LISTEN acos_outbox");
        this.client.on("notification", () => this.wake?.());

        while (this.running) {
          const published = await this.publishBatch();
          if (published === 0) {
            await new Promise<void>((resolve) => {
              this.wake = resolve;
              void sleep(this.options.pollMs ?? 1_000).then(resolve);
            });
            this.wake = null;
          }
        }
      } catch (err) {
        this.options.onError?.(err);
        this.leader = false;
        try {
          await this.client?.end();
        } catch {
          /* session gone */
        }
        if (this.running) await sleep(this.options.leaderRetryMs ?? 5_000);
      }
    }
    await this.client?.end().catch(() => {});
  }

  /** SELECT unpublished ordered by (company_id, seq) → publish → mark. */
  private async publishBatch(): Promise<number> {
    const client = this.client!;
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, company_id, seq, type, version, occurred_at, actor,
              task_id, project_id, agent_id, correlation_id, causation_id, payload
       FROM events WHERE published_at IS NULL
       ORDER BY company_id, seq
       LIMIT $1`,
      [this.options.batchSize ?? 500],
    );
    const js = this.options.nats.jetstream();
    // O6: the mark used to be one UPDATE per row — 500 round-trips for a
    // 500-event batch, on the hot path of every commit in the system. Publish
    // first, then mark what actually went out in a single statement. A crash
    // between the two republishes those events, which the broker's msgID
    // dedupe already makes harmless (same reason the per-row version was
    // safe); `finally` keeps the marks for events published before a failure.
    const published: string[] = [];
    try {
      for (const row of rows) {
        const envelope = {
          id: row.id,
          companyId: row.company_id,
          seq: Number(row.seq),
          type: row.type,
          version: row.version,
          occurredAt: row.occurred_at.toISOString(),
          actor: row.actor,
          subject: { taskId: row.task_id, projectId: row.project_id, agentId: row.agent_id },
          correlationId: row.correlation_id ?? row.id, // root events correlate to themselves
          causationId: row.causation_id,
          payload: row.payload,
        };
        await js.publish(subjectFor(row.company_id, row.type), JSON.stringify(envelope), {
          msgID: row.id, // broker-side dedupe (2m window) makes republish harmless
        });
        published.push(row.id);
      }
    } finally {
      // by id only: a JS Date round-trip truncates timestamptz microseconds,
      // so an occurred_at equality predicate would never match. UUIDv7 ids are
      // unique; the partition scan is cheap at outbox batch sizes.
      if (published.length > 0) {
        await client.query("UPDATE events SET published_at = now() WHERE id = ANY($1::uuid[])", [
          published,
        ]);
      }
    }
    return rows.length;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.leader = false;
    this.wake?.();
    await this.loop?.catch(() => {});
    await this.client?.end().catch(() => {});
    this.client = null;
  }
}
