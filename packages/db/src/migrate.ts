// Migration runner (20 §19): drizzle-orm migrator guarded by a Postgres
// advisory lock so concurrent boots race safely — one migrates, the rest
// wait and see an up-to-date schema.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/** Single cluster-wide key for schema migration ("ACOS"). */
export const MIGRATION_LOCK_KEY = 0x41434f53;

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  } finally {
    await pool.end();
  }
}
