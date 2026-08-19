// T18 acceptance: cycle write rejected; escalation chain Dev→EM→CTO→CEO→
// Founder(virtual); demo steps 3 & 5 at API level.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { createDb, createGuardedDb, runMigrations, type Db } from "@acos/db";
import { agents, events } from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let app: App;
let companyId = "";
let sessionCookie = "";
let csrfToken = "";

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: authHeaders(), ...(payload !== undefined && { payload }) });

async function insertAgent(name: string, employeeNumber: number, positionId: string, unitId: string) {
  const [row] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber,
      name,
      positionId,
      orgUnitId: unitId,
      persona: `${name} persona`,
      status: "active",
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb: createGuardedDb(pool),
    masterKey: MASTER_KEY,
  });
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@acme.local", password: "correct-horse-battery", displayName: "Founder" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const company = await api("POST", "/api/v1/companies", {
    name: "Acme Technologies",
    slug: "acme",
    currency: "USD",
  });
  companyId = company.json().id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("org units & positions (demo step 3)", () => {
  let engineeringId = "";

  it("creates a department and a child team with kind-specific events", async () => {
    const dept = await api("POST", `/api/v1/companies/${companyId}/org/units`, {
      name: "Engineering",
      slug: "engineering",
      kind: "department",
    });
    expect(dept.statusCode).toBe(201);
    engineeringId = dept.json().id;

    const team = await api("POST", `/api/v1/companies/${companyId}/org/units`, {
      name: "Backend",
      slug: "backend",
      kind: "team",
      parentId: engineeringId,
    });
    expect(team.statusCode).toBe(201);
    expect(team.json().parentId).toBe(engineeringId);

    const rows = await db
      .select({ type: events.type })
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} IN ('department.created','team.created')`);
    expect(rows.map((r) => r.type).sort()).toEqual(["department.created", "team.created"]);
  });

  it("rejects a unit-tree cycle (child becomes parent of its ancestor)", async () => {
    const teamB = await api("POST", `/api/v1/companies/${companyId}/org/units`, {
      name: "Frontend",
      slug: "frontend",
      kind: "team",
      parentId: engineeringId,
    });
    const frontendId = teamB.json().id;
    const cyclic = await api(
      "PATCH",
      `/api/v1/companies/${companyId}/org/units/${engineeringId}`,
      { parentId: frontendId },
    );
    expect(cyclic.statusCode).toBe(409);
    expect(cyclic.json().code).toBe("org_cycle_detected");
  });

  it("creates positions", async () => {
    const position = await api("POST", `/api/v1/companies/${companyId}/org/positions`, {
      title: "Backend Engineer",
      seniorityTrack: ["junior", "mid", "senior"],
      defaultRole: "member",
    });
    expect(position.statusCode).toBe(201);
  });
});

describe("org edges + escalation chain (demo step 5, M1 DoD)", () => {
  let unitId = "";
  let positionId = "";
  const ids: Record<string, string> = {};

  it("builds the reporting forest Dev→EM→CTO→CEO with inverse manages edges", async () => {
    const units = await api("GET", `/api/v1/companies/${companyId}/org/units`);
    unitId = units.json().find((u: { slug: string }) => u.slug === "backend").id;
    const positionsRes = await api("GET", `/api/v1/companies/${companyId}/org/positions`);
    positionId = positionsRes.json()[0].id;

    ids.dev = await insertAgent("Dev", 1, positionId, unitId);
    ids.em = await insertAgent("EM", 2, positionId, unitId);
    ids.cto = await insertAgent("CTO", 3, positionId, unitId);
    ids.ceo = await insertAgent("CEO", 4, positionId, unitId);

    for (const [from, to] of [
      [ids.dev, ids.em],
      [ids.em, ids.cto],
      [ids.cto, ids.ceo],
    ] as const) {
      const edge = await api("POST", `/api/v1/companies/${companyId}/org/edges`, {
        fromAgentId: from,
        kind: "reports_to",
        toAgentId: to,
      });
      expect(edge.statusCode).toBe(201);
    }

    const edges = await api("GET", `/api/v1/companies/${companyId}/org/edges`);
    const kinds = edges.json().map((e: { kind: string }) => e.kind);
    expect(kinds.filter((k: string) => k === "reports_to")).toHaveLength(3);
    expect(kinds.filter((k: string) => k === "manages")).toHaveLength(3); // inverse pairs
  });

  it("REJECTS a cyclic reports_to write (T18 acceptance)", async () => {
    const cyclic = await api("POST", `/api/v1/companies/${companyId}/org/edges`, {
      fromAgentId: ids.ceo,
      kind: "reports_to",
      toAgentId: ids.dev,
    });
    expect(cyclic.statusCode).toBe(409);
    expect(cyclic.json().code).toBe("org_cycle_detected");
  });

  it("rejects a second active manager", async () => {
    const second = await api("POST", `/api/v1/companies/${companyId}/org/edges`, {
      fromAgentId: ids.dev,
      kind: "reports_to",
      toAgentId: ids.cto,
    });
    expect(second.statusCode).toBe(409);
  });

  it("escalation chain = Dev→EM→CTO→CEO→Founder(virtual)", async () => {
    const chain = await api(
      "GET",
      `/api/v1/companies/${companyId}/org/agents/${ids.dev}/chain`,
    );
    expect(chain.statusCode).toBe(200);
    expect(chain.json()).toEqual([
      { kind: "agent", agentId: ids.em, name: "EM" },
      { kind: "agent", agentId: ids.cto, name: "CTO" },
      { kind: "agent", agentId: ids.ceo, name: "CEO" },
      { kind: "founder" },
    ]);
    // roots report to the Founder directly
    const ceoChain = await api(
      "GET",
      `/api/v1/companies/${companyId}/org/agents/${ids.ceo}/chain`,
    );
    expect(ceoChain.json()).toEqual([{ kind: "founder" }]);
  });

  it("team roster orders leads first (04 §4 read model)", async () => {
    for (const agentId of [ids.dev, ids.em]) {
      await api("POST", `/api/v1/companies/${companyId}/org/edges`, {
        fromAgentId: agentId,
        kind: "member_of",
        toUnitId: unitId,
      });
    }
    await api("POST", `/api/v1/companies/${companyId}/org/edges`, {
      fromAgentId: ids.em,
      kind: "leads",
      toUnitId: unitId,
    });

    const roster = await api(
      "GET",
      `/api/v1/companies/${companyId}/org/units/${unitId}/roster`,
    );
    expect(roster.statusCode).toBe(200);
    const entries = roster.json();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: "EM", isLead: true });
    expect(entries[1]).toMatchObject({ name: "Dev", isLead: false });
  });
});
