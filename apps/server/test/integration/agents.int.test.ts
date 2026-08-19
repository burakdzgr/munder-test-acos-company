// T19 acceptance: hire the 8 seed agents; binding never leaks into identity;
// demo step 4 API-level; lifecycle + offboard re-pointing + binding hot-swap.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { createDb, createGuardedDb, runMigrations, type Db, type GuardedDb } from "@acos/db";
import { events, modelProviders } from "@acos/db/schema";
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
let companyId = "";
let sessionCookie = "";
let csrfToken = "";
let providerId = "";

const byName: Record<string, { id: string; employeeNumber: number }> = {};

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});
const api = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: authHeaders(), ...(payload !== undefined && { payload }) });

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

  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "anthropic", name: "anthropic-main" })
    .returning();
  providerId = provider!.id;

  // the full seed (Founder + Acme + org + 8 agents)
  const seeded = await ensureSeed(guardedDb);
  companyId = seeded.companyId;

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: SEED_FOUNDER_EMAIL, password: seeded.founderPassword },
  });
  for (const c of login.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("seed hires the 8 agents (demo step 4)", () => {
  it("lists 8 active agents with gap-free employee numbers and EMP display", async () => {
    const list = await api("GET", `/api/v1/companies/${companyId}/agents`);
    expect(list.statusCode).toBe(200);
    const agentsJson = list.json();
    expect(agentsJson).toHaveLength(8);
    expect(agentsJson.map((a: { employeeNumber: number }) => a.employeeNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(agentsJson[0].displayNumber).toBe("EMP-001");
    expect(agentsJson.every((a: { status: string }) => a.status === "active")).toBe(true);
    for (const a of agentsJson) byName[a.name] = { id: a.id, employeeNumber: a.employeeNumber };
  });

  it("agent.hired emitted for all 8; API agent shape carries no model fields", async () => {
    const rows = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.hired'`);
    expect(rows).toHaveLength(8);

    const one = await api(
      "GET",
      `/api/v1/companies/${companyId}/agents/${byName["Alex Demir"]!.id}`,
    );
    const keys = Object.keys(one.json()).join(",");
    expect(keys).not.toMatch(/model|provider/i);
  });

  it("escalation chain for a backend dev = Lead→EM→CTO→CEO→Founder (M1 DoD)", async () => {
    const chain = await api(
      "GET",
      `/api/v1/companies/${companyId}/org/agents/${byName["Alex Demir"]!.id}/chain`,
    );
    expect(chain.json().map((h: { kind: string; name?: string }) => h.name ?? "FOUNDER")).toEqual([
      "Kerem Yıldız",
      "Selin Koç",
      "Mert Aksoy",
      "Aylin Vural",
      "FOUNDER",
    ]);
  });
});

describe("lifecycle (05 §1, §3)", () => {
  it("pause ⇄ resume with events; illegal transition is a 412", async () => {
    const agentId = byName["Deniz Kaya"]!.id;
    const paused = await api("POST", `/api/v1/companies/${companyId}/agents/${agentId}/pause`, {
      reason: "manual",
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe("paused");

    const doublePause = await api(
      "POST",
      `/api/v1/companies/${companyId}/agents/${agentId}/pause`,
      {},
    );
    expect(doublePause.statusCode).toBe(412);

    const resumed = await api(
      "POST",
      `/api/v1/companies/${companyId}/agents/${agentId}/resume`,
      {},
    );
    expect(resumed.json().status).toBe("active");
  });

  it("offboarding ends all edges and re-points direct reports (05 §3.3)", async () => {
    const leadId = byName["Kerem Yıldız"]!.id;
    const emId = byName["Selin Koç"]!.id;
    const devId = byName["Alex Demir"]!.id;

    const offboarded = await api(
      "POST",
      `/api/v1/companies/${companyId}/agents/${leadId}/offboard`,
      { reason: "restructuring" },
    );
    expect(offboarded.statusCode).toBe(200);
    expect(offboarded.json().status).toBe("offboarded");

    // dev now reports to the lead's former manager (EM)
    const chain = await api(
      "GET",
      `/api/v1/companies/${companyId}/org/agents/${devId}/chain`,
    );
    expect(chain.json()[0]).toMatchObject({ agentId: emId, name: "Selin Koç" });

    // no active edges touch the offboarded agent
    const edges = await api("GET", `/api/v1/companies/${companyId}/org/edges`);
    const touching = edges
      .json()
      .filter(
        (e: { fromAgentId: string; toAgentId: string | null }) =>
          e.fromAgentId === leadId || e.toAgentId === leadId,
      );
    expect(touching).toHaveLength(0);
  });
});

describe("model bindings (05 §7 — identity untouched)", () => {
  it("hot-swaps the primary binding; agents row unchanged; event emitted", async () => {
    const agentId = byName["Alex Demir"]!.id;
    const before = await api("GET", `/api/v1/companies/${companyId}/agents/${agentId}`);

    const put = await api(
      "PUT",
      `/api/v1/companies/${companyId}/agents/${agentId}/model-bindings`,
      { purpose: "primary", providerId, model: "claude-fable-5" },
    );
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ purpose: "primary", model: "claude-fable-5" });

    const bindings = await api(
      "GET",
      `/api/v1/companies/${companyId}/agents/${agentId}/model-bindings`,
    );
    expect(bindings.json().some((b: { model: string }) => b.model === "claude-fable-5")).toBe(true);

    const after = await api("GET", `/api/v1/companies/${companyId}/agents/${agentId}`);
    expect(after.json()).toEqual(before.json()); // identity untouched

    const rows = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.model.binding.changed'`,
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("sessions read API answers (empty until T31)", async () => {
    const sessions = await api(
      "GET",
      `/api/v1/companies/${companyId}/agents/${byName["Alex Demir"]!.id}/sessions`,
    );
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual([]);
  });
});
