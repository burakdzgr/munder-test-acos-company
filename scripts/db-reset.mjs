// P0-A (UI/UX review): dev-stack factory reset — `pnpm db:reset`.
// down → wipe the bind-mounted data dir (postgres + nats stream + workspace
// volumes; they reference each other, a partial wipe leaves orphans/replays)
// → up --wait (migrations run at server boot, seed = Acme + the 8 canonical
// agents ONLY). Dev data is ephemeral by contract — e2e never writes here
// anymore (scripts/e2e-stack.mjs).
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const COMPOSE = "docker compose -f infrastructure/docker/compose.yaml";
const dataDir = join(process.cwd(), "infrastructure", "docker", "data");

function run(command) {
  console.log(`\n$ ${command}`);
  execSync(command, { stdio: "inherit" });
}

run(`${COMPOSE} down --remove-orphans`);
if (existsSync(dataDir)) {
  console.log(`\nwiping ${dataDir}`);
  rmSync(dataDir, { recursive: true, force: true });
}
run(`${COMPOSE} up -d --wait`);
console.log(
  "\ndb:reset done — clean seed: Acme Technologies + EMP-001..008 (SEED_DEMO). " +
    "Founder auto-login is on; open http://localhost:5173.",
);
