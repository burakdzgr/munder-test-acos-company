// pnpm --filter @acos/db db:migrate — applies all migrations to DATABASE_URL.
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:migrate: DATABASE_URL is required");
  process.exit(1);
}
runMigrations(url)
  .then(() => {
    console.log("db:migrate: schema is up to date");
  })
  .catch((err) => {
    console.error("db:migrate failed:", err);
    process.exit(1);
  });
