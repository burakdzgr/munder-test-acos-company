import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runMigrations } from "../../src/migrate.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

/**
 * Beklenen migration sayısı JOURNAL'DAN okunuyor, elle yazılmıyor.
 *
 * Sabit sayı (13) yazılıydı ve 0014–0016 eklenince bu üç test kırıldı —
 * üstelik sessizce: `test` görevi yalnız birim testlerini koşuyor, entegrasyon
 * suite'i ayrı. Testin asıl iddiası "kaç tane migration var" değil, "hepsi
 * TAM BİR KEZ uygulandı" (eşzamanlı koşuda advisory lock yarışı). Sayıyı
 * kaynaktan türetmek o iddiayı korur ve bir sonraki migration'da yine
 * kırılmaz.
 */
const EXPECTED_MIGRATIONS: number = (() => {
  const journal = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../migrations/meta/_journal.json",
  );
  const parsed = JSON.parse(readFileSync(journal, "utf8")) as { entries: unknown[] };
  return parsed.entries.length;
})();

let container: StartedPostgreSqlContainer;
let client: Client;
let uri: string;

beforeAll(async () => {
  container = await startPostgres();
  uri = container.getConnectionUri();
  // T11 acceptance: the advisory-lock migration race — two concurrent
  // runners on an empty database; exactly one migrates, both succeed.
  await Promise.all([runMigrations(uri), runMigrations(uri)]);
  client = new Client({ connectionString: uri });
  await client.connect();
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe("migrations 0001–0003 on empty PG16 (T11)", () => {
  it("applied every migration exactly once despite the concurrent race", async () => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"');
    expect(rows[0].n).toBe(EXPECTED_MIGRATIONS);
  });

  it("is idempotent: a repeat run applies nothing new", async () => {
    await runMigrations(uri);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"');
    expect(rows[0].n).toBe(EXPECTED_MIGRATIONS);
  });

  it("installs the three extensions (20 §1)", async () => {
    const { rows } = await client.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','btree_gin') ORDER BY extname",
    );
    expect(rows.map((r) => r.extname)).toEqual(["btree_gin", "pg_trgm", "vector"]);
  });

  it("creates every 0001–0003 table", async () => {
    const expected = [
      "agent_model_bindings",
      "agent_sessions",
      "agent_steps",
      "agents",
      "companies",
      "company_members",
      "company_sequences",
      "company_settings",
      "idempotency_keys",
      "model_profiles",
      "model_providers",
      "org_edges",
      "org_units",
      "personal_access_tokens",
      "positions",
      "rate_limits",
      "secrets",
      "sessions",
      "users",
    ];
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
      [expected],
    );
    expect(rows.map((r) => r.tablename)).toEqual(expected);
  });

  it("agent_steps is partitioned with three monthly partitions", async () => {
    const { rows: strategy } = await client.query(
      `SELECT partstrat FROM pg_partitioned_table pt
       JOIN pg_class c ON c.oid = pt.partrelid WHERE c.relname = 'agent_steps'`,
    );
    expect(strategy[0]?.partstrat).toBe("r"); // RANGE
    const { rows: parts } = await client.query(
      `SELECT count(*)::int AS n FROM pg_inherits i
       JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'agent_steps'`,
    );
    expect(parts[0].n).toBe(3);
  });

  it("rate_limits is UNLOGGED", async () => {
    const { rows } = await client.query(
      "SELECT relpersistence FROM pg_class WHERE relname = 'rate_limits'",
    );
    expect(rows[0].relpersistence).toBe("u");
  });

  it("accepts a coherent org insert chain and rejects CHECK violations", async () => {
    const ids = {
      user: "018f0000-0000-7000-8000-000000000001",
      company: "018f0000-0000-7000-8000-000000000002",
      unit: "018f0000-0000-7000-8000-000000000003",
      position: "018f0000-0000-7000-8000-000000000004",
      agent: "018f0000-0000-7000-8000-000000000005",
      agent2: "018f0000-0000-7000-8000-000000000006",
    };
    await client.query(
      `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1,'founder@acme.local','x','Founder')`,
      [ids.user],
    );
    await client.query(
      `INSERT INTO companies (id, name, slug, created_by_user_id) VALUES ($1,'Acme Technologies','acme',$2)`,
      [ids.company, ids.user],
    );
    await client.query(
      `INSERT INTO org_units (id, company_id, kind, name, slug) VALUES ($1,$2,'department','Engineering','engineering')`,
      [ids.unit, ids.company],
    );
    await client.query(
      `INSERT INTO positions (id, company_id, title, seniority_track, default_role)
       VALUES ($1,$2,'Backend Engineer','{junior,mid,senior}','member')`,
      [ids.position, ids.company],
    );
    for (const [agentId, n, name] of [
      [ids.agent, 1, "Alex Demir"],
      [ids.agent2, 2, "Deniz Kaya"],
    ] as const) {
      await client.query(
        `INSERT INTO agents (id, company_id, employee_number, name, position_id, org_unit_id, persona)
         VALUES ($1,$2,$3,$4,$5,$6,'Engineer.')`,
        [agentId, ids.company, n, name, ids.position, ids.unit],
      );
    }
    await client.query(
      `INSERT INTO org_edges (id, company_id, from_agent_id, to_agent_id, kind)
       VALUES ('018f0000-0000-7000-8000-000000000007',$1,$2,$3,'reports_to')`,
      [ids.company, ids.agent, ids.agent2],
    );

    // kind/target mismatch: member_of must target a unit (23514 = check_violation)
    await expect(
      client.query(
        `INSERT INTO org_edges (id, company_id, from_agent_id, to_agent_id, kind)
         VALUES ('018f0000-0000-7000-8000-000000000008',$1,$2,$3,'member_of')`,
        [ids.company, ids.agent, ids.agent2],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // second active manager violates the partial unique index (23505)
    await expect(
      client.query(
        `INSERT INTO org_edges (id, company_id, from_agent_id, to_agent_id, kind)
         VALUES ('018f0000-0000-7000-8000-000000000009',$1,$2,$3,'reports_to')`,
        [ids.company, ids.agent, ids.agent2],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // invalid autonomy level (23514)
    await expect(
      client.query(
        `INSERT INTO agents (id, company_id, employee_number, name, position_id, org_unit_id, persona, autonomy_level)
         VALUES ('018f0000-0000-7000-8000-00000000000a',$1,9,'Bad Agent',$2,$3,'x',9)`,
        [ids.company, ids.position, ids.unit],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // agent_steps insert routes into a partition
    await client.query(
      `INSERT INTO agent_steps (id, company_id, agent_session_id, agent_id, step_no, action_kind, action)
       VALUES ('018f0000-0000-7000-8000-00000000000b',$1,'018f0000-0000-7000-8000-00000000000c',$2,1,'send_message','{}')`,
      [ids.company, ids.agent],
    );
    const { rows } = await client.query(
      `SELECT tableoid::regclass::text AS part FROM agent_steps LIMIT 1`,
    );
    expect(rows[0].part).toMatch(/^agent_steps_\d{6}$/);
  });
});
