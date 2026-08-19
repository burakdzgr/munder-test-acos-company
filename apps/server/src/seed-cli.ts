// pnpm seed — idempotent demo seed against DATABASE_URL (27 §4).
import { Pool } from "pg";
import { loadConfigOrExit } from "@acos/config";
import { createGuardedDb, runMigrations } from "@acos/db";
import { ensureSeed, SEED_FOUNDER_EMAIL } from "./seed.js";

const config = loadConfigOrExit(process.env);
await runMigrations(config.database.url);
const pool = new Pool({ connectionString: config.database.url });
const result = await ensureSeed(createGuardedDb(pool));
if (result.created && result.founderPassword) {
  console.log(`ACOS seed — ${SEED_FOUNDER_EMAIL} / ${result.founderPassword}`);
} else {
  console.log("ACOS seed — already present (idempotent, no changes)");
}
await pool.end();
