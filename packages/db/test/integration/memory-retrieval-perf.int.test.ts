// T45 nightly perf gate (32 §perf, 12 §7): working-set retrieval p95 < 250ms
// against 100k seeded memories (768d random vectors through the HNSW partial
// index). Heavy — runs only with RUN_PERF=1 (the nightly lane); the regular
// battery skips it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import {
  MemoryRetrievalService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
} from "../../src/index.js";
import { users } from "../../src/schema/identity.js";
import { agents } from "../../src/schema/agents.js";
import { orgUnits, positions } from "../../src/schema/org.js";
import { projects } from "../../src/schema/projects.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const RUN = process.env.RUN_PERF === "1";
const DIM = 768;
const TOTAL = 100_000;
const BATCH = 5_000;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let ctx: CompanyContext;
let service: MemoryRetrievalService;
let companyId = "";
let agentId = "";
let projectId = "";

function randomUnit(): number[] {
  const v = Array.from({ length: DIM }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe.skipIf(!RUN)("retrieval perf @100k (nightly)", () => {
  beforeAll(async () => {
    container = await startPostgres();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    pool.on("error", () => {});
    db = createDb(pool);
    service = new MemoryRetrievalService(createGuardedDb(pool));

    const [founder] = await db
      .insert(users)
      .values({ email: "perf@t45.local", passwordHash: "x", displayName: "P" })
      .returning();
    const { companies } = await import("../../src/schema/companies.js");
    const [company] = await db
      .insert(companies)
      .values({ name: "PerfCo", slug: "perfco", createdByUserId: founder!.id })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    const [unitRow] = await db
      .insert(orgUnits)
      .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
      .returning();
    const [position] = await db
      .insert(positions)
      .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber: 1,
        name: "Perf",
        status: "active",
        positionId: position!.id,
        orgUnitId: unitRow!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: "Fast.",
      })
      .returning();
    agentId = agent!.id;
    projectId = uuidv7();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Perf",
      slug: "perf",
      objectiveMd: "x",
      status: "active",
      createdByUserId: founder!.id,
    });

    // 100k rows in 5k batches — per-row random vectors generated server-side
    // (a correlated LATERAL forces re-evaluation per row); scope mix ~60%
    // project / 25% agent / 15% company, all active + typed.
    for (let offset = 0; offset < TOTAL; offset += BATCH) {
      await db.execute(sql`
        INSERT INTO memories (
          id, company_id, scope, scope_ref, type, title, content, summary,
          entities, importance, confidence, status, embedding, embedding_model,
          embedding_dim
        )
        SELECT
          gen_random_uuid(),
          ${companyId}::uuid,
          CASE WHEN gs.i % 20 < 12 THEN 'project' WHEN gs.i % 20 < 17 THEN 'agent' ELSE 'company' END,
          CASE WHEN gs.i % 20 < 12 THEN ${projectId}::uuid WHEN gs.i % 20 < 17 THEN ${agentId}::uuid ELSE NULL END,
          (ARRAY['semantic','episodic','procedural','decision','failure'])[1 + gs.i % 5],
          'perf memory ' || gs.i,
          'content for perf memory ' || gs.i || ' — retrieval latency benchmark row.',
          'summary ' || gs.i,
          '{}'::jsonb,
          0.3 + (gs.i % 7)::real / 10,
          0.5 + (gs.i % 5)::real / 10,
          'active',
          v.vec::vector,
          'pseudo-768',
          768
        FROM generate_series(${offset}::int, ${offset + BATCH - 1}::int) AS gs(i)
        CROSS JOIN LATERAL (
          SELECT '[' || string_agg(((hashint4(gs.i * 1000 + d.d)::float8 / 2147483647))::text, ',') || ']' AS vec
          FROM generate_series(1, ${sql.raw(String(DIM))}) AS d(d)
        ) v
      `);
    }
  }, 1_800_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("p95 retrieval latency < 250ms over 20 builds", async () => {
    const [{ count }] = (
      await db.execute(sql`SELECT count(*)::int AS count FROM memories WHERE company_id = ${companyId}`)
    ).rows as Array<{ count: number }>;
    expect(count).toBeGreaterThanOrEqual(TOTAL);

    // warm-up (plan + buffer cache)
    await service.retrieveForWorkingSet(ctx, {
      agentId,
      taskId: null,
      projectId,
      queryEmbedding: randomUnit(),
    });

    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await service.retrieveForWorkingSet(ctx, {
        agentId,
        taskId: null,
        projectId,
        queryEmbedding: randomUnit(),
      });
      latencies.push(result.durationMs);
      expect(result.flags.empty).toBe(false);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
    console.log(`retrieval latencies ms: ${latencies.join(", ")} — p95=${p95}`);
    expect(p95).toBeLessThan(250);
  }, 300_000);
});
