// P0-A (UI/UX review): e2e runs on an EPHEMERAL stack — `pnpm e2e`.
// A second compose project (acos-e2e) with offset host ports, its own
// throwaway data dir and its own workspace network/subnet spins up beside
// the dev stack; Playwright targets it via env; teardown wipes everything.
// The dev volume is NEVER touched by tests again.
//
//   node scripts/e2e-stack.mjs run    up → playwright → down + wipe (default)
//   node scripts/e2e-stack.mjs up     leave the e2e stack running (debug)
//   node scripts/e2e-stack.mjs down   tear down + wipe
//
// ISOLATION (2026-08-19). The stack used to be ONE hard-coded compose project,
// so two people running e2e at once silently shared a database: the second
// `up` recreated postgres and server under the first one's feet and its rows
// vanished mid-run (a real gate run died exactly this way — stage 03 started
// answering 404 for a company created seconds earlier). Set ACOS_E2E_PROJECT
// to get a fully isolated stack — own compose project, own host ports, own
// data dir, own workspace network:
//
//   ACOS_E2E_PROJECT=acos-e2e-jim node scripts/e2e-stack.mjs up
//
// Ports shift by slot*100 from the e2e base, where the slot is derived from
// the project name (stable across runs, so URLs don't move between `up` and
// `down`). The script prints the resolved URLs on every command.
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const PROJECT = process.env.ACOS_E2E_PROJECT ?? "acos-e2e";
/**
 * Port slot: 0 for the default project (its published ports are exactly what
 * they always were — existing docs, Playwright config and muscle memory keep
 * working), otherwise a stable 1..19 derived from the name. An explicit
 * ACOS_E2E_SLOT wins when someone needs to pin it.
 */
const SLOT = Number(
  process.env.ACOS_E2E_SLOT ??
    (PROJECT === "acos-e2e"
      ? 0
      : ([...PROJECT].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 19, 7) + 1)),
);
const port = (base) => String(base + SLOT * 100);
const DATA_DIR = `./data-${PROJECT}`; // relative to the compose file directory
const dataDirAbs = join(process.cwd(), "infrastructure", "docker", `data-${PROJECT}`);

/** `git rev-parse HEAD`, suffixed when the tree has uncommitted changes. */
function buildSha() {
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const stackEnv = {
  ...process.env,
  DATA_DIR,
  PG_PORT: port(15432),
  NATS_PORT: port(14222),
  TEMPORAL_PORT: port(17233),
  TEMPORAL_UI_PORT: port(18080),
  SERVER_PORT: port(13000),
  WEB_PORT: port(15173),
  // Ollama publishes a host port too (compose.yaml §ollama). Without an offset
  // the e2e stack collides with a running dev stack on 11434 and the WHOLE
  // `up` aborts ("port is already allocated") — the offset list must cover
  // EVERY published port in compose.yaml, not just the famous four.
  OLLAMA_PORT: port(21434),
  // OLLAMA LANDMINE (2026-08-20). seed.ts registers reasoning/coding/fast
  // profiles for llama3.2:3b whenever OLLAMA_BASE_URL is set — but nothing
  // ever PULLS that model, and the ollama volume lives under DATA_DIR, which
  // teardown wipes. So the bottom of the live fallback chain was a guaranteed
  // hard crash: the first call that fell through tier 1 (bridge 503 under
  // load) died with `model 'llama3.2:3b' not found` and took the rework turn
  // with it. An empty value (compose uses `${VAR-default}`, not `${VAR:-…}`)
  // removes the tier entirely: scripted never calls a provider, and the live
  // lane must run on the Claude bridge or fail LOUDLY — silently degrading a
  // proof run to a 3B model is worse than not running it.
  OLLAMA_BASE_URL: "",
  // EMPTY-STRING LANDMINE, second of its family (2026-08-20). compose passes
  // `CLAUDE_CLI_BRIDGE_URL: ${CLAUDE_CLI_BRIDGE_URL:-}`, so an unset variable
  // does not arrive ABSENT — it arrives as "". The schema is
  // `z.string().url().optional()`, and `.optional()` does not save a value that
  // is present-but-empty: `.url()` rejects it and the SERVER REFUSES TO BOOT.
  // Same shape as the OLLAMA_BASE_URL trap above, opposite direction: there an
  // empty value had to be forced, here it has to be prevented. Always hand the
  // stack a real URL — the scripted lane never calls it, and the live lane
  // needs exactly this one.
  CLAUDE_CLI_BRIDGE_URL:
    process.env.CLAUDE_CLI_BRIDGE_URL || "http://host.docker.internal:3777",
  // Anti-fake-green: the commit the images are built FROM, baked into every
  // node image (Dockerfile.node) so a run can prove the container carries the
  // code under test. A stack built from a dirty tree gets "<sha>-dirty" — a
  // live proof run must not be able to claim a clean commit it did not build.
  ACOS_BUILD_SHA: buildSha(),
  WORKSPACE_NET_NAME: `${PROJECT}-workspaces`,
  // Slot 0 keeps the historical subnet; isolated stacks move into 10.x so they
  // never overlap it or each other (172.16-172.31 has no room above 172.31).
  WORKSPACE_SUBNET: SLOT === 0 ? "172.31.0.0/16" : `10.${200 + SLOT}.0.0/16`,
  // Tek kullanicili, tek kullanimlik yigin: AUTH_AUTOLOGIN acik ve NODE_ENV
  // production oldugundan sunucu guvenlik kapisina takilip HIC ACILMIYOR
  // ("refusing to boot an unauthenticated production server"). Bu sadece
  // gelistirici makinesindeki infrastructure/docker/.env dosyasi bunu
  // ayarladigi icin gorunmuyordu — WORKTREE'de .env yok, bu yuzden e2e
  // yigini bir worktree'den kaldirildiginda sunucu sessizce cikiyordu.
  // Yigin izole ve gecici oldugundan bilincli olarak burada aciyoruz.
  AUTH_AUTOLOGIN_ALLOW_PRODUCTION: "true",
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
const SERVER_URL = `http://localhost:${stackEnv.SERVER_PORT}`;

console.log(
  `e2e stack "${PROJECT}" (slot ${SLOT}) — server ${SERVER_URL} · web http://localhost:${stackEnv.WEB_PORT} · pg ${stackEnv.PG_PORT} · temporal-ui ${stackEnv.TEMPORAL_UI_PORT}`,
);

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
    ACOS_WEB_URL: `http://localhost:${stackEnv.WEB_PORT}`,
    ACOS_SERVER_URL: SERVER_URL,
    ACOS_PG_URL: `postgres://acos:acos@localhost:${stackEnv.PG_PORT}/acos`,
    ACOS_WORKER_CONTAINER: `${PROJECT}-agent-worker-1`,
  }, true);
}

// No bare default. `run` is down -> up -> playwright -> down, so invoking the
// script with no argument USED to wipe and rebuild whatever stack the current
// ACOS_E2E_PROJECT names — a "let me just check this file" command that starts
// by destroying volumes. (Found the hard way: a syntax check ran the whole
// cycle.) `pnpm e2e` still passes `run` explicitly; a bare call now prints
// usage, like every other mode typo already did.
const mode = process.argv[2];
if (!mode) {
  console.error("usage: node scripts/e2e-stack.mjs <run|up|down|config>");
  console.error("  run    down -> up -> playwright -> down  (DESTRUCTIVE: wipes the project's volumes)");
  console.error("  up     start the stack and leave it running");
  console.error("  down   stop the stack and remove its volumes");
  console.error("  config print the resolved project/ports and touch nothing");
  process.exit(2);
}
if (mode === "up") {
  up();
} else if (mode === "down") {
  down();
} else if (mode === "config") {
  // Print the resolved stack (the banner above) and touch NOTHING — the only
  // way to see which project/ports you would get without side effects.
} else if (mode === "run") {
  down(); // stale leftovers from an aborted run
  up();
  const passed = playwright();
  down();
  if (!passed) process.exit(1);
  console.log("\ne2e green on the ephemeral stack — dev data untouched.");
} else {
  // An unrecognised mode used to fall through to `run`, so a typo tore the
  // stack down (down → up → down) instead of printing usage. Cost me a live
  // stack once; it fails loudly now.
  console.error(`unknown mode "${mode}" — expected: run | up | down | config`);
  process.exit(2);
}
