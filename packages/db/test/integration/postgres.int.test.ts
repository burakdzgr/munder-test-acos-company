import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let client: Client;

beforeAll(async () => {
  container = await startPostgres();
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe("postgres testcontainer (T07 harness smoke)", () => {
  it("boots PostgreSQL 16", async () => {
    const { rows } = await client.query("SELECT version()");
    expect(rows[0].version).toContain("PostgreSQL 16");
  });

  it("installs pgvector and answers a similarity query", async () => {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query("CREATE TABLE embeddings (id int PRIMARY KEY, e vector(3))");
    await client.query(
      "INSERT INTO embeddings VALUES (1, '[1,1,1]'), (2, '[10,10,10]'), (3, '[-1,-1,-1]')",
    );
    const { rows } = await client.query(
      "SELECT id FROM embeddings ORDER BY e <-> '[0.9,1.1,1]' LIMIT 1",
    );
    expect(rows[0].id).toBe(1);
  });
});
