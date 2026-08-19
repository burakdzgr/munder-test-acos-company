// T22 acceptance: (1) producer contract matrix — every event the M1 modules
// emit parses against the @acos/events catalog (emission itself is validated
// by emitDomainEvent, this suite proves it end-to-end over the real stream);
// (2) GET /events timeline with filters + cursor, /events/replay, /events/:id;
// (3) timeline returns the seeded company's events.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type Db,
  type GuardedDb,
} from "@acos/db";
import { events, modelProviders } from "@acos/db/schema";
import { EventEnvelopeSchema, parseEventPayload } from "@acos/events";
import { buildApp, type App } from "../../src/app.js";
import { emitDomainEvent } from "../../src/modules/events/emit.js";
import { ensureSeed, SEED_FOUNDER_EMAIL } from "../../src/seed.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let sessionCookie = "";
let csrfToken = "";
let companyId = "";
let providerId = "";
let managerId = "";
let devId = "";

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

async function api(method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: authHeaders(),
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url} → ${response.body}`).toBeLessThan(300);
  return response.json();
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
  });
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@t22.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }

  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "anthropic", name: "anthropic-main" })
    .returning();
  providerId = provider!.id;

  // ---- exercise every M1 mutation once (the producer matrix) ----
  const company = await api("POST", "/api/v1/companies", {
    name: "Globex",
    slug: "globex",
    currency: "EUR",
  });
  companyId = company.id;
  const base = `/api/v1/companies/${companyId}`;

  await api("PATCH", `${base}/settings`, { timezone: "Europe/Istanbul" });

  const dept = await api("POST", `${base}/org/units`, {
    name: "Engineering",
    slug: "engineering",
    kind: "department",
  });
  await api("POST", `${base}/org/units`, {
    name: "Backend",
    slug: "backend",
    kind: "team",
    parentId: dept.id,
  });
  const office = await api("POST", `${base}/org/units`, {
    name: "HQ",
    slug: "hq",
    kind: "office",
  });
  await api("PATCH", `${base}/org/units/${office.id}`, { parentId: dept.id });

  const position = await api("POST", `${base}/org/positions`, {
    title: "Backend Engineer",
    seniorityTrack: ["junior", "mid", "senior"],
    defaultRole: "member",
  });

  const manager = await api("POST", `${base}/agents`, {
    name: "Mira Manager",
    positionId: position.id,
    orgUnitId: dept.id,
    seniority: "lead",
    autonomyLevel: 2,
    persona: "Engineering manager.",
    activate: true,
  });
  managerId = manager.id;
  const dev = await api("POST", `${base}/agents`, {
    name: "Deniz Dev",
    positionId: position.id,
    orgUnitId: dept.id,
    seniority: "mid",
    autonomyLevel: 2,
    persona: "Backend engineer.",
    managerAgentId: managerId,
    activate: true,
  });
  devId = dev.id;

  await api("POST", `${base}/agents/${devId}/pause`, { reason: "manual" });
  await api("POST", `${base}/agents/${devId}/resume`, { reason: "manual" });
  await api("PATCH", `${base}/agents/${devId}`, { persona: "Senior backend engineer." });
  await api("PUT", `${base}/agents/${devId}/model-bindings`, {
    purpose: "primary",
    providerId,
    model: "claude-fable-5",
  });

  const edge = await api("POST", `${base}/org/edges`, {
    fromAgentId: devId,
    kind: "collaborates_with",
    toAgentId: managerId,
  });
  await api("POST", `${base}/org/edges/${edge.id}/end`);

  const temp = await api("POST", `${base}/agents`, {
    name: "Tolga Temp",
    positionId: position.id,
    orgUnitId: dept.id,
    seniority: "junior",
    autonomyLevel: 1,
    persona: "Contractor.",
    managerAgentId: managerId,
    activate: true,
  });
  await api("POST", `${base}/agents/${temp.id}/offboard`, { reason: "contract ended" });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("producer contract matrix (T22)", () => {
  it("every emitted event parses against the catalog, envelope included", async () => {
    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId}`)
      .orderBy(events.seq);
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      const envelope = {
        id: row.id,
        companyId: row.companyId,
        seq: Number(row.seq),
        type: row.type,
        version: row.version,
        occurredAt: row.occurredAt.toISOString(),
        actor: row.actor,
        subject: { taskId: row.taskId, projectId: row.projectId, agentId: row.agentId },
        correlationId: row.correlationId ?? row.id,
        causationId: row.causationId,
        payload: row.payload,
      };
      expect(() => EventEnvelopeSchema.parse(envelope), `envelope of ${row.type}`).not.toThrow();
      expect(
        () => parseEventPayload(row.type, row.version, row.payload),
        `payload of ${row.type} (seq ${row.seq})`,
      ).not.toThrow();
    }
  });

  it("the emitted type set covers the full M1 producer matrix", async () => {
    const rows = await db
      .select({ type: events.type })
      .from(events)
      .where(sql`${events.companyId} = ${companyId}`);
    const emitted = new Set(rows.map((r) => r.type));
    expect([...emitted].sort()).toEqual(
      [
        "agent.hired",
        "agent.model.binding.changed",
        "channel.created", // team/department channels auto-provision (T33)
        "channel.member.added",
        "agent.offboarded",
        "agent.paused",
        "agent.resumed",
        "agent.started",
        "agent.updated",
        "company.created",
        "company.member.added",
        "company.settings.updated",
        "department.created",
        "org.edge.created",
        "org.edge.ended",
        "org.unit.created",
        "org.unit.updated",
        "position.created",
        "team.created",
      ].sort(),
    );
  });

  it("rejects an uncatalogued type and a payload-schema mismatch, aborting the tx", async () => {
    const ctx = companyContext(companyId);
    await expect(
      guardedDb.transaction((tx) =>
        emitDomainEvent(tx, ctx, {
          type: "totally.unknown.event",
          actor: { kind: "system", id: null },
          payload: {},
        }),
      ),
    ).rejects.toThrow(/unknown event type/);
    await expect(
      guardedDb.transaction((tx) =>
        emitDomainEvent(tx, ctx, {
          type: "agent.hired",
          actor: { kind: "system", id: null },
          payload: { name: "missing required agentId" },
        }),
      ),
    ).rejects.toThrow();
    const [bad] = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'totally.unknown.event'`);
    expect(bad).toBeUndefined();
  });
});

describe("timeline API (21 §3.11)", () => {
  const base = () => `/api/v1/companies/${companyId}/events`;

  it("returns the timeline newest-first and paginates by seq cursor without gaps or dupes", async () => {
    const first = await api("GET", `${base()}?limit=5`);
    expect(first.items).toHaveLength(5);
    const seqs = first.items.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => b - a));

    const all: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = cursor ? `${base()}?limit=5&cursor=${cursor}` : `${base()}?limit=5`;
      const page: { items: Array<{ seq: number }>; nextCursor: string | null } = await api("GET", url);
      all.push(...page.items.map((e) => e.seq));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const total = Number(
      (await db.select({ n: sql<number>`count(*)::int` }).from(events).where(sql`${events.companyId} = ${companyId}`))[0]!.n,
    );
    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total);
    expect(Math.min(...all)).toBe(1);
    expect(Math.max(...all)).toBe(total);
  });

  it("filters by exact types (repeated = OR) and by prefix", async () => {
    const exact = await api("GET", `${base()}?types=department.created&types=team.created`);
    expect(exact.items.map((e: { type: string }) => e.type).sort()).toEqual([
      "department.created",
      "team.created",
    ]);

    const prefixed = await api("GET", `${base()}?types=agent.*&limit=200`);
    expect(prefixed.items.length).toBeGreaterThan(5);
    for (const item of prefixed.items) expect(item.type.startsWith("agent.")).toBe(true);
  });

  it("filters by agentId subject and time window", async () => {
    const byAgent = await api("GET", `${base()}?agentId=${devId}&limit=200`);
    expect(byAgent.items.length).toBeGreaterThan(0);
    for (const item of byAgent.items) expect(item.subject.agentId).toBe(devId);

    const none = await api("GET", `${base()}?from=2099-01-01T00:00:00Z`);
    expect(none.items).toHaveLength(0);
    const upToNow = await api("GET", `${base()}?to=2099-01-01T00:00:00Z&limit=200`);
    expect(upToNow.items.length).toBeGreaterThan(20);
  });

  it("replays ascending, gap-free, resumable via nextSeq", async () => {
    const full = await api("GET", `${base()}/replay?afterSeq=0`);
    const seqs = full.items.map((e: { seq: number }) => e.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1)); // 1..N without gaps
    expect(full.nextSeq).toBe(seqs.length);

    const tail = await api("GET", `${base()}/replay?afterSeq=${seqs.length - 2}`);
    expect(tail.items.map((e: { seq: number }) => e.seq)).toEqual([seqs.length - 1, seqs.length]);

    const empty = await api("GET", `${base()}/replay?afterSeq=${full.nextSeq}`);
    expect(empty.items).toHaveLength(0);
    expect(empty.nextSeq).toBe(full.nextSeq);
  });

  it("fetches a single envelope by id; unknown ids and foreign companies 404", async () => {
    const list = await api("GET", `${base()}?limit=1`);
    const target = list.items[0];
    const fetched = await api("GET", `${base()}/${target.id}`);
    expect(fetched).toEqual(target);

    const missing = await app.inject({
      method: "GET",
      url: `${base()}/018f0000-0000-7000-8000-00000000ffff`,
      headers: authHeaders(),
    });
    expect(missing.statusCode).toBe(404);

    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/companies/018f0000-0000-7000-8000-00000000aaaa/events`,
      headers: authHeaders(),
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe("seeded company timeline (acceptance: timeline returns seeded events)", () => {
  it("seed v1 events are visible through GET /events", async () => {
    const seeded = await ensureSeed(guardedDb);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: SEED_FOUNDER_EMAIL, password: seeded.founderPassword },
    });
    expect(login.statusCode).toBe(200);
    let seedSession = "";
    let seedCsrf = "";
    for (const c of login.cookies) {
      if (c.name === "acos_session") seedSession = c.value;
      if (c.name === "acos_csrf") seedCsrf = c.value;
    }

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${seeded.companyId}/events?limit=200`,
      headers: { cookie: `acos_session=${seedSession}; acos_csrf=${seedCsrf}` },
    });
    expect(timeline.statusCode).toBe(200);
    const body = timeline.json();
    const types = body.items.map((e: { type: string }) => e.type);
    expect(types).toContain("company.created");
    expect(types.filter((t: string) => t === "agent.hired")).toHaveLength(8);
  });
});
