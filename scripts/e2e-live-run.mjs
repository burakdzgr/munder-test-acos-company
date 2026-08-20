#!/usr/bin/env node
// E4 CANLI WORKLOAD RUN — tek komut (Jim).
//
// "int-green" testlerin yeşil olduğunu söyler. Bu koşu, GERÇEK bir şirketin
// gerçek CLI ajanlarıyla iş çıkardığını söyler — ya da çıkarmadığını. İkisi de
// kabul edilebilir sonuçtur; kabul edilemez olan, hangisi olduğunu bilmemektir.
//
// Sıra: ön koşullar -> stack up -> senaryo sürücüsü -> (watch koşarken) ->
//       runtime raporu -> dört katmanlı doğrulama -> iş durumu -> teardown.
//
//   node scripts/e2e-live-run.mjs --go        # gerçekten ateşler (Founder GO gerekir)
//   node scripts/e2e-live-run.mjs --dry       # ateşlemez: ön koşulları ve dizilimi gösterir
//
// ATEŞLEME PAHALIDIR: 4 canlı CLI ajanı = gerçek abonelik tüketimi + host yükü.
// --go bayrağı olmadan hiçbir şey başlamaz.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FLAG = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const PROJECT = arg("project", "acos-e2e-live");
const OUT_DIR = arg("out", join(process.cwd(), `live-run-${PROJECT}`));
const SLOT_WEB = arg("web-port", "16373");
const SLOT_SERVER = arg("server-url", "http://localhost:14200");

// Oscar'ın planı §1: 2+ yaprağa doğal bölünen, teslimatı dosyada doğrulanabilen
// ve TEK bir karar boşluğu taşıyan hedef. Boşluk kasıtlı: reklam yuvasının
// boyutunu/sağlayıcısını yönetici belirler — brief'te "yardım iste" YAZMAZ,
// yoksa iddia "ajan söyleneni yaptı"ya iner.
const GOAL =
  "Statik landing page'e bir reklam yuvasi ekle; /health ucu 200 ve {status:'ok', version} dondursun; " +
  "ikisinin de birim testi olsun. Reklam yuvasinin boyutunu ve saglayicisini yonetici belirleyecek.";
const PROJECT_OBJECTIVE = "Kucuk bir statik landing page + Node servisi.";

const log = (line) => console.log(line);
const die = (line) => {
  console.error(`\nREFUSING: ${line}`);
  process.exit(3);
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", stdio: "inherit", ...opts });
const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
};

// ---- ön koşullar ----------------------------------------------------------
// Her biri, atlanırsa koşunun SONUCUNU çürütecek bir şeyi kontrol eder.
function preflight() {
  const checks = [];
  const add = (ok, label, detail) => {
    checks.push({ ok, label, detail });
    log(`  [${ok ? "ok" : "NO"}] ${label}${detail ? ` — ${detail}` : ""}`);
  };

  // Kirli ağaçtan kalkan stack'in imaj damgası "-dirty" olur; o zaman kanıt
  // COMMIT'LENMİŞ koda karşı olmaz ve "hangi kod kanıtlandı" cevapsız kalır.
  const dirty = capture("git", ["status", "--porcelain"]);
  add(dirty === "", "working tree is clean (the image stamp must name a real commit)",
      dirty === "" ? capture("git", ["rev-parse", "--short", "HEAD"]) : `${dirty.split("\n").length} uncommitted path(s)`);

  // Yanlış projeye ateşlemek Founder'ın ortamını (jim2) ya da dev yığınını yakar.
  add(/^acos-e2e-/.test(PROJECT) && PROJECT !== "acos-e2e-jim2",
      "target project is an isolated live slot", PROJECT);

  // CLI runtime kapalıysa bu koşu E4 hakkında HİÇBİR ŞEY kanıtlamaz.
  add(process.env.ACOS_AGENT_RUNTIME === "cli",
      "ACOS_AGENT_RUNTIME=cli (Decision A: turns must BE CLI sessions)",
      process.env.ACOS_AGENT_RUNTIME ?? "unset");

  // Broker olmadan ajanlar model çağıramaz; secret'ı YAZDIRMIYORUZ.
  add(Boolean(process.env.ACOS_BROKER_SECRET), "ACOS_BROKER_SECRET present (value never printed)");
  add(Boolean(process.env.IDENTITY_BROKER_URL), "IDENTITY_BROKER_URL set", process.env.IDENTITY_BROKER_URL ?? "unset");

  // The cap is an INVARIANT, not a number: it must be smaller than the roster
  // the CEO ends up hiring, or the concurrency gate never engages and T38's
  // "a task at the ceiling WAITS, it is not dropped" sub-claim cannot be shown.
  // The roster is unknown until staffing runs, so presence is all we can check
  // here; Oscar's gate (P3) checks cap < roster against the real headcount.
  const cap = process.env.MAX_LIVE_SESSIONS_PER_COMPANY ?? "";
  add(cap !== "", "MAX_LIVE_SESSIONS_PER_COMPANY set (gate P3 checks cap < roster once staffed)", cap || "unset");

  // The workspace image must carry the CLI kit (/opt/acos/cli). A kit-less image
  // starts, the session opens, and the turn quietly falls back — the run then
  // "passes" while proving nothing about Decision A. Kevin builds and verifies
  // the tag; naming the expected one here makes a stale value visible.
  const kit = process.env.ACOS_CLI_WORKSPACE_IMAGE ?? "";
  add(kit !== "", "ACOS_CLI_WORKSPACE_IMAGE set (expected acos/workspace-node:e4-live)", kit || "unset");

  return checks.every((c) => c.ok);
}

// ---- ana akış -------------------------------------------------------------
const stackEnv = {
  ...process.env,
  ACOS_E2E_PROJECT: PROJECT,
  LLM_MODE: "live",
  ACOS_E2E_GOAL: GOAL,
  ACOS_E2E_PROJECT_OBJECTIVE: PROJECT_OBJECTIVE,
};

log(`E4 live workload run · project ${PROJECT} · web http://localhost:${SLOT_WEB}\n`);
log("-- preflight");
const ready = preflight();

if (!FLAG("go")) {
  log(`\nDRY RUN — nothing started. ${ready ? "Preflight is green; add --go to fire." : "Preflight has blockers (above)."}`);
  log("\nSequence that --go would run:");
  log("  1. e2e-stack.mjs up            (images stamped with ACOS_BUILD_SHA)");
  log("  2. e2e-golden-path.mjs --json  (live lane; drives company -> CEO -> project -> goal -> staffing)");
  log("  3. live-run-runtime-evidence.sh watch   (background, while agents are alive)");
  log("  4. live-run-runtime-evidence.sh report  (4a/4b/4d/4e + INV-2 scan)");
  log("  5. e2e-live-verify.mjs         (image identity + Oscar's control plane + 1d/409 + CLI session)");
  log("  6. e2e-stack.mjs down          (always, pass or fail)");
  // The shape gate needs a STAFFED company, which only exists once a run is
  // under way — so a dry run can only exercise it against an existing one.
  // Pass --company to do that; otherwise say plainly where it does run, rather
  // than printing a green that means nothing.
  const dryCompany = arg("company", null);
  if (dryCompany) {
    log("\n-- precondition gate against the given company");
    const gateSql = readFileSync(join(process.cwd(), "scripts", "live-run-precondition-gate.sql"), "utf8");
    const out = spawnSync(
      "docker",
      ["compose", "-p", PROJECT, "-f", "infrastructure/docker/compose.yaml", "exec", "-T", "postgres",
       "psql", "-U", "acos", "-d", "acos", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1",
       "-v", `company='${dryCompany}'`, "-v", `cap=${process.env.MAX_LIVE_SESSIONS_PER_COMPANY ?? "2"}`, "-f", "-"],
      { encoding: "utf8", input: gateSql },
    );
    for (const line of `${out.stdout ?? ""}${out.stderr ?? ""}`.trim().split("\n")) log(`   ${line}`);
  } else {
    log("\n   (shape gate P1-P3 not run here: it needs a staffed company. In --go it runs the");
    log("    moment staffing lands and stops the driver on FAIL, before the expensive phase.)");
  }
  process.exit(ready ? 0 : 3);
}
if (!ready) die("preflight has blockers — fix them before spending real tokens");

mkdirSync(OUT_DIR, { recursive: true });
const runStart = new Date().toISOString();
// This run's company slug, handed to the driver and used to adopt the company
// by identity rather than by "newest".
const RUN_SLUG = `gp-live-${runStart.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
let watcher = null;
let exitCode = 2;

try {
  log("\n-- 1. stack up");
  if (run("node", ["scripts/e2e-stack.mjs", "up"], { env: stackEnv }).status !== 0) {
    die("stack failed to come up");
  }

  log("\n-- 2. scenario driver (live lane) + evidence watch");
  // The driver runs in the BACKGROUND and the watcher starts as soon as the
  // company exists. Running the watcher only after the driver finished would
  // collect nothing: 4b's transcript and 4e's environ live on the session's
  // tmpfs and vanish when the container is reaped. Evidence has to be taken
  // while the agents are alive, or the report says SKIP and we learn nothing.
  const mapPath = join(OUT_DIR, "golden-path.json");
  // Both env names, on purpose: the driver reads ACOS_E2E_BASE_URL first and
  // ACOS_SERVER_URL second, and setting only one of them is what sent a
  // Founder-witnessed run to the default port and produced nothing.
  const driver = spawn(
    "node",
    ["scripts/e2e-golden-path.mjs", "--json", mapPath],
    {
      env: {
        ...stackEnv,
        ACOS_E2E_BASE_URL: SLOT_SERVER,
        ACOS_SERVER_URL: SLOT_SERVER,
        ACOS_E2E_COMPANY_SLUG: RUN_SLUG,
        ACOS_E2E_LANE: "live",
      },
      stdio: "inherit",
    },
  );
  let driverCode = null;
  const driverExit = new Promise((resolve) => driver.on("exit", (code) => resolve(code ?? 1)));
  driverExit.then((code) => { driverCode = code; });

  // Adopt the company by the slug WE handed the driver. "Newest company" is not
  // identity: stack up seeds the demo org after runStart, so that heuristic
  // adopts a fully-staffed fixture when the driver is already dead — the run
  // then measures the seed and reports shape gates green with zero agent turns.
  const companyId = await (async () => {
    for (let i = 0; i < 120; i += 1) {
      try {
        const response = await fetch(`${SLOT_SERVER}/api/v1/companies`);
        const body = await response.json();
        const items = Array.isArray(body) ? body : (body?.items ?? []);
        const mine = items.find((c) => c.slug === RUN_SLUG);
        if (mine?.id) return mine.id;
      } catch {
        /* server still starting */
      }
      // A driver that has exited without creating its company is a dead run.
      // Waiting out the full budget only delays the same verdict.
      if (driverCode !== null) return null;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return null;
  })();
  if (!companyId) {
    driver.kill();
    die(
      driverCode === null
        ? `no company with slug ${RUN_SLUG} appeared within 10 minutes — the driver never got started`
        : `the driver exited (code ${driverCode}) without creating company ${RUN_SLUG} — nothing ran, see its output above`,
    );
  }
  const officeUrl = `http://localhost:${SLOT_WEB}/c/${companyId}/office-window`;
  writeFileSync(join(OUT_DIR, "office-window.txt"), `${officeUrl}\n`);
  log(`\n   company ${companyId}`);
  log(`   FOUNDER WATCHES: ${officeUrl}\n`);

  // Oscar's precondition gate: a run can only prove what its SHAPE allows.
  // P1 lead + active report (else claim 1 is untestable), P2 matching surface
  // populated while agent_skills stays empty (else 1c passes for the wrong
  // reason), P3 cap < roster (else the concurrency gate never engages). Run it
  // as soon as staffing has materialised, so a doomed run dies in minutes
  // instead of burning a whole execution phase first.
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${SLOT_SERVER}/api/v1/companies/${companyId}/agents`);
      const body = await response.json();
      const items = Array.isArray(body) ? body : (body?.items ?? []);
      if (items.length >= 2) break;
    } catch {
      /* staffing has not landed yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  const gateSql = readFileSync(join(process.cwd(), "scripts", "live-run-precondition-gate.sql"), "utf8");
  const gateOut = spawnSync(
    "docker",
    ["compose", "-p", PROJECT, "-f", "infrastructure/docker/compose.yaml", "exec", "-T", "postgres",
     "psql", "-U", "acos", "-d", "acos", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1",
     "-v", `company='${companyId}'`, "-v", `cap=${process.env.MAX_LIVE_SESSIONS_PER_COMPANY ?? "2"}`, "-f", "-"],
    { encoding: "utf8", input: gateSql },
  );
  const gateText = `${gateOut.stdout ?? ""}${gateOut.stderr ?? ""}`.trim();
  log("\n-- 2b. precondition gate (Oscar)");
  for (const line of gateText.split("\n")) log(`   ${line}`);
  if (gateText.includes("|FAIL|")) {
    log("\n   GATE FAILED — this run cannot prove what it set out to prove; stopping early.");
    driver.kill();
  }


  watcher = spawn("sh", ["scripts/live-run-runtime-evidence.sh", "watch"], {
    env: { ...stackEnv, COMPANY_ID: companyId, RUN_START: runStart, OUT: join(OUT_DIR, "evidence") },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const driverStatus = await driverExit;
  log(`\n   driver exit ${driverStatus}`);

  log("\n-- 3. stop the watch, keep what it captured");
  watcher.kill();
  watcher = null;

  log("\n-- 4. runtime evidence report");
  run("sh", ["scripts/live-run-runtime-evidence.sh", "report"], {
    env: { ...stackEnv, COMPANY_ID: companyId, RUN_START: runStart, OUT: join(OUT_DIR, "evidence") },
  });

  log("\n-- 5. four-layer verification");
  const verify = run(
    "node",
    ["scripts/e2e-live-verify.mjs", "--project", PROJECT, "--company", companyId, "--base-url", SLOT_SERVER],
    { env: stackEnv },
  );
  exitCode = verify.status ?? 2;
  log(`\nrun artifacts: ${OUT_DIR}`);
  log(`office window: ${officeUrl}`);
} finally {
  if (watcher) watcher.kill();
  // Teardown ALWAYS — a live slot left running keeps burning host resources and
  // blocks the next run's port allocation. Evidence is already on disk.
  log("\n-- 6. teardown");
  run("node", ["scripts/e2e-stack.mjs", "down"], { env: stackEnv });
}

process.exit(exitCode);
