// P0-A (UI/UX review): e2e runs on an EPHEMERAL stack — `pnpm e2e`.
// A second compose project (acos-e2e) with offset host ports, its own
// throwaway data dir and its own workspace network/subnet spins up beside
// the dev stack; Playwright targets it via env; teardown wipes everything.
// The dev volume is NEVER touched by tests again.
//
//   node scripts/e2e-stack.mjs run    up → playwright → down + wipe (default)
//   node scripts/e2e-stack.mjs up     leave the e2e stack running (debug)
//   node scripts/e2e-stack.mjs down   tear down + wipe
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const PROJECT = "acos-e2e";
const DATA_DIR = "./data-e2e"; // relative to the compose file directory
const dataDirAbs = join(process.cwd(), "infrastructure", "docker", "data-e2e");

const stackEnv = {
  ...process.env,
  DATA_DIR,
  PG_PORT: "15432",
  NATS_PORT: "14222",
  TEMPORAL_PORT: "17233",
  TEMPORAL_UI_PORT: "18080",
  SERVER_PORT: "13000",
  WEB_PORT: "15173",
  WORKSPACE_NET_NAME: "acos-e2e-workspaces",
  WORKSPACE_SUBNET: "172.31.0.0/16",
  SEED_FOUNDER_PASSWORD: process.env.SEED_FOUNDER_PASSWORD ?? "founder-dev-password",
  // e2e senaryoları demo şirketin kadrosuna ("Acme Technologies", Kerem
  // Yıldız, Backend takımı…) dayanır. SEED_DEMO'nun varsayılanı false
  // olduğundan burada AÇIKÇA açılır — 12 e2e dosyası bu fikstüre bağlı ve
  // bağımlılığın örtük bir varsayılana yaslanması onu görünmez kılıyordu.
  SEED_DEMO: "true",
  // 32 §6: e2e is DETERMINISTIC — the scripted ModelRouter, never live LLM.
  // (An env-less shell would otherwise flip the worker to live mode and the
  // cascade/consolidation specs stall — found the hard way.)
  LLM_MODE: process.env.LLM_MODE ?? "scripted",
};

const COMPOSE = `docker compose -p ${PROJECT} -f infrastructure/docker/compose.yaml`;

function run(command, env = stackEnv, ignoreFailure = false) {
  console.log(`\n$ ${command}`);
  try {
    execSync(command, { stdio: "inherit", env });
    return true;
  } catch (error) {
    if (!ignoreFailure) throw error;
    return false;
  }
}

function up() {
  run(`${COMPOSE} up -d --wait --build`);
}

function down() {
  // workspace containers are spawned by sandbox-manager OUTSIDE compose —
  // remove them first or the workspace network stays "in use"
  try {
    const ids = execSync(
      `docker ps -aq --filter network=${stackEnv.WORKSPACE_NET_NAME}`,
      { encoding: "utf8" },
    )
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length > 0) run(`docker rm -f ${ids.join(" ")}`, stackEnv, true);
  } catch {
    /* network may not exist yet */
  }
  run(`${COMPOSE} down --volumes --remove-orphans`, stackEnv, true);
  run(`docker network rm ${stackEnv.WORKSPACE_NET_NAME}`, stackEnv, true);
  if (existsSync(dataDirAbs)) {
    console.log(`wiping ${dataDirAbs}`);
    rmSync(dataDirAbs, { recursive: true, force: true });
  }
}

function playwright() {
  return run(`pnpm --filter @acos/web e2e`, {
    ...stackEnv,
    ACOS_WEB_URL: "http://localhost:15173",
    ACOS_SERVER_URL: "http://localhost:13000",
    ACOS_PG_URL: "postgres://acos:acos@localhost:15432/acos",
    ACOS_WORKER_CONTAINER: `${PROJECT}-agent-worker-1`,
  }, true);
}

const mode = process.argv[2] ?? "run";
if (mode === "up") {
  up();
} else if (mode === "down") {
  down();
} else {
  down(); // stale leftovers from an aborted run
  up();
  const passed = playwright();
  down();
  if (!passed) process.exit(1);
  console.log("\ne2e green on the ephemeral stack — dev data untouched.");
}
