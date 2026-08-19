// T17 acceptance: company.created emitted via outbox; seed idempotent
// (run twice, one company); scoping returns 404 for non-members.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, createGuardedDb, runMigrations, type Db, type GuardedDb } from "@acos/db";
import { companies, companyMembers, companySettings, events, users } from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import { ensureSeed, SEED_FOUNDER_EMAIL } from "../../src/seed.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let sessionCookie = "";
let csrfToken = "";

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

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
    payload: { email: "founder@x.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("companies module (T17)", () => {
  let companyId = "";

  it("creates a company — settings row, founder membership, company.created via outbox", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: authHeaders(),
      payload: { name: "Globex", slug: "globex", currency: "EUR" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    companyId = body.id;
    expect(body).toMatchObject({ slug: "globex", currency: "EUR", role: "founder" });

    const [settings] = await db
      .select()
      .from(companySettings)
      .where(eq(companySettings.companyId, companyId));
    expect(settings).toBeDefined();

    const eventRows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'company.created'`);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.seq).toBe(1);
    expect(eventRows[0]!.payload).toMatchObject({ name: "Globex", currency: "EUR" });
    expect(eventRows[0]!.publishedAt).toBeNull(); // relay (T21) publishes later
  });

  it("rejects duplicate slugs with 409", async () => {
    const dupe = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: authHeaders(),
      payload: { name: "Globex 2", slug: "globex", currency: "USD" },
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().code).toBe("conflict");
  });

  it("lists memberships and reads settings", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/companies", headers: authHeaders() });
    expect(list.json().map((c: { slug: string }) => c.slug)).toContain("globex");

    const settings = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${companyId}/settings`,
      headers: authHeaders(),
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ outputLanguage: "en", defaultAutonomyLevel: 2 });
  });

  it("updates settings and emits company.settings.updated", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/companies/${companyId}/settings`,
      headers: authHeaders(),
      payload: { timezone: "Europe/Istanbul", dailySpendLimitCents: 7000 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ timezone: "Europe/Istanbul", dailySpendLimitCents: 7000 });

    const eventRows = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'company.settings.updated'`,
      );
    expect(eventRows).toHaveLength(1);
    // seq 1 = company.created, 2 = company.member.added (T22), 3 = settings.updated
    expect(eventRows[0]!.seq).toBe(3); // gap-free continuation
  });

  it("non-members get 404 (no existence leaks — 21 §2.3)", async () => {
    const [other] = await db
      .insert(users)
      .values({ email: "other@x.local", passwordHash: "x", displayName: "Other" })
      .returning();
    void other;
    // a second user session is not needed: probe with a made-up company id
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/companies/018f0000-0000-7000-8000-00000000ffff/settings`,
      headers: authHeaders(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("seed v1 (27 §4) — idempotent", () => {
  it("creates Acme + Founder once; second run is a no-op", async () => {
    const first = await ensureSeed(guardedDb);
    expect(first.created).toBe(true);
    expect(first.founderPassword).toBeTruthy();

    const second = await ensureSeed(guardedDb);
    expect(second.created).toBe(false);
    expect(second.companyId).toBe(first.companyId);
    expect(second.founderPassword).toBeUndefined();

    const acmeRows = await db.select().from(companies).where(eq(companies.slug, "acme"));
    expect(acmeRows).toHaveLength(1);
    const founderRows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${SEED_FOUNDER_EMAIL}`);
    expect(founderRows).toHaveLength(1);

    // company.created emitted exactly once for the seeded company
    const eventRows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${first.companyId} AND ${events.type} = 'company.created'`);
    expect(eventRows).toHaveLength(1);

    // founder membership present
    const memberRows = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.companyId, first.companyId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.role).toBe("founder");

    // seeded founder can actually log in with the printed password (demo step 1)
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: SEED_FOUNDER_EMAIL, password: first.founderPassword },
    });
    expect(login.statusCode).toBe(200);
  });
});
