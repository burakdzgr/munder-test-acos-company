// T21 acceptance — the outbox suite of 32 §2: commit ⇒ exactly-once publish
// to co.<companyId>.<type>; relay crash between publish and mark ⇒ harmless
// republish; two relays → one leader; consumer idempotency HWM.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { connect, type NatsConnection } from "nats";
import { eq, sql } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  withOutbox,
  type CompanyContext,
  type Db,
} from "@acos/db";
import { companies, events, users } from "@acos/db/schema";
import { EventEnvelopeSchema } from "@acos/events";
import { OutboxRelay } from "../../src/modules/events/relay.js";
import { ensureStream, STREAM_NAME } from "../../src/modules/events/jetstream.js";
import { withSeqDedupe } from "../../src/modules/events/idempotency.js";
import { startNats, startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let pgContainer: StartedPostgreSqlContainer;
let natsHandle: Awaited<ReturnType<typeof startNats>>;
let pool: Pool;
let db: Db;
let nc: NatsConnection;
let relay: OutboxRelay;
let ctx: CompanyContext;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}

async function streamMessages(subjectFilter: string): Promise<string[]> {
  const jsm = await nc.jetstreamManager();
  const seen: string[] = [];
  let seq = 0;
  for (;;) {
    try {
      const message = await jsm.streams.getMessage(STREAM_NAME, {
        next_by_subj: subjectFilter,
        seq: seq + 1,
      });
      seq = message.seq;
      seen.push(new TextDecoder().decode(message.data));
    } catch {
      return seen;
    }
  }
}

beforeAll(async () => {
  [pgContainer, natsHandle] = await Promise.all([startPostgres(), startNats()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  nc = await connect({ servers: natsHandle.url });
  await ensureStream(await nc.jetstreamManager());

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@x.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "Acme", slug: "acme", createdByUserId: founder!.id })
    .returning();
  ctx = companyContext(company!.id);

  relay = new OutboxRelay({
    connectionString: pgContainer.getConnectionUri(),
    nats: nc,
    leaderRetryMs: 300,
    pollMs: 300,
    onError: (err) => console.error("relay error:", err),
  });
  await relay.start();
  await waitFor(async () => relay.isLeader);
}, 300_000);

afterAll(async () => {
  await relay?.stop();
  await nc?.close().catch(() => {});
  await pool?.end();
  await natsHandle?.container.stop();
  await pgContainer?.stop();
});

const guarded = () => createGuardedDb(pool);

describe("outbox relay (10 §4)", { timeout: 30_000 }, () => {
  it("commit ⇒ exactly one publish to co.<companyId>.<type>, published_at set", async () => {
    await guarded().transaction((tx) =>
      withOutbox(tx, ctx, {
        type: "agent.hired",
        actor: { kind: "system", id: null },
        payload: { agentId: "018f0000-0000-7000-8000-000000000005", employeeNumber: 1, name: "A" },
      }),
    );

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(events)
        .where(sql`${events.companyId} = ${ctx.companyId} AND ${events.publishedAt} IS NOT NULL`);
      return rows.length === 1;
    });

    const messages = await streamMessages(`co.${ctx.companyId}.agent.hired`);
    expect(messages).toHaveLength(1);
    const envelope = EventEnvelopeSchema.parse(JSON.parse(messages[0]!));
    expect(envelope.type).toBe("agent.hired");
    expect(envelope.seq).toBe(1);
    expect(envelope.correlationId).toBe(envelope.id); // root events self-correlate
  });

  it("crash between publish and mark ⇒ republish is deduped by Nats-Msg-Id", async () => {
    // simulate: reset published_at on the already-published event
    await db
      .update(events)
      .set({ publishedAt: null })
      .where(eq(events.companyId, ctx.companyId));

    await waitFor(async () => {
      const rows = await db
        .select()
        .from(events)
        .where(sql`${events.companyId} = ${ctx.companyId} AND ${events.publishedAt} IS NOT NULL`);
      return rows.length === 1;
    });

    // broker-side duplicate window keeps the stream at exactly one message
    const messages = await streamMessages(`co.${ctx.companyId}.agent.hired`);
    expect(messages).toHaveLength(1);
  });

  it("publishes in per-company seq order", async () => {
    await guarded().transaction(async (tx) => {
      for (const n of [2, 3, 4]) {
        await withOutbox(tx, ctx, {
          type: "task.created",
          actor: { kind: "system", id: null },
          payload: { number: n, kind: "task", title: `T${n}` },
        });
      }
    });
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(events)
        .where(sql`${events.companyId} = ${ctx.companyId} AND ${events.publishedAt} IS NULL`);
      return rows.length === 0;
    });
    const messages = await streamMessages(`co.${ctx.companyId}.task.created`);
    const seqs = messages.map((m) => (JSON.parse(m) as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("two relays → exactly one leader; follower takes over on leader stop", async () => {
    const follower = new OutboxRelay({
      connectionString: pgContainer.getConnectionUri(),
      nats: nc,
      leaderRetryMs: 200,
      pollMs: 300,
    });
    await follower.start();
    await new Promise((r) => setTimeout(r, 800));
    expect(relay.isLeader).toBe(true);
    expect(follower.isLeader).toBe(false);

    await relay.stop(); // leader dies → advisory lock released
    await waitFor(async () => follower.isLeader, 15_000);

    // the new leader still publishes
    await guarded().transaction((tx) =>
      withOutbox(tx, ctx, {
        type: "task.updated",
        actor: { kind: "system", id: null },
        payload: {},
      }),
    );
    await waitFor(async () => {
      const rows = await db
        .select()
        .from(events)
        .where(sql`${events.companyId} = ${ctx.companyId} AND ${events.publishedAt} IS NULL`);
      return rows.length === 0;
    });
    await follower.stop();

    // restart the primary relay for any later suites
    relay = new OutboxRelay({
      connectionString: pgContainer.getConnectionUri(),
      nats: nc,
      leaderRetryMs: 200,
      pollMs: 300,
    });
    await relay.start();
    await waitFor(async () => relay.isLeader, 15_000);
  });
});

describe("consumer idempotency HWM (10 §6)", { timeout: 30_000 }, () => {
  it("processes ascending seqs once and skips redeliveries", async () => {
    const applied: number[] = [];
    const handler = async () => {
      applied.push(1);
    };
    expect(await withSeqDedupe(db, "test-consumer", { companyId: ctx.companyId, seq: 1 }, handler)).toBe(
      "processed",
    );
    expect(await withSeqDedupe(db, "test-consumer", { companyId: ctx.companyId, seq: 2 }, handler)).toBe(
      "processed",
    );
    // redelivery of seq 1 and 2 → skipped, handler not re-run
    expect(await withSeqDedupe(db, "test-consumer", { companyId: ctx.companyId, seq: 1 }, handler)).toBe(
      "skipped",
    );
    expect(await withSeqDedupe(db, "test-consumer", { companyId: ctx.companyId, seq: 2 }, handler)).toBe(
      "skipped",
    );
    expect(applied).toHaveLength(2);

    // a different consumer has its own cursor
    expect(await withSeqDedupe(db, "other-consumer", { companyId: ctx.companyId, seq: 1 }, handler)).toBe(
      "processed",
    );
  });
});
