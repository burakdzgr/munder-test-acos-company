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
import { mkdirSync, writeFileSync } from "node:fs";
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

  // Oscar §1: cap KADRODAN KÜÇÜK olmalı, yoksa kapı hiç devreye girmez.
  const cap = Number(process.env.MAX_LIVE_SESSIONS_PER_COMPANY ?? "3");
  add(cap === 3, "MAX_LIVE_SESSIONS_PER_COMPANY=3 (smaller than the 4-agent roster, on purpose)", String(cap));

  const kit = process.env.ACOS_CLI_WORKSPACE_IMAGE ?? "";
  add(kit !== "", "ACOS_CLI_WORKSPACE_IMAGE set (workspace image must carry the CLI kit)", kit || "unset");

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
  process.exit(ready ? 0 : 3);
}
if (!ready) die("preflight has blockers — fix them before spending real tokens");

mkdirSync(OUT_DIR, { recursive: true });
const runStart = new Date().toISOString();
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
  const driver = spawn(
    "node",
    ["scripts/e2e-golden-path.mjs", "--json", mapPath],
    { env: { ...stackEnv, ACOS_E2E_BASE_URL: SLOT_SERVER, ACOS_E2E_LANE: "live" }, stdio: "inherit" },
  );
  const driverExit = new Promise((resolve) => driver.on("exit", (code) => resolve(code ?? 1)));

  const companyId = await (async () => {
    for (let i = 0; i < 120; i += 1) {
      try {
        const response = await fetch(`${SLOT_SERVER}/api/v1/companies`);
        const body = await response.json();
        const items = Array.isArray(body) ? body : (body?.items ?? []);
        const fresh = items.find((c) => Date.parse(c.createdAt ?? 0) >= Date.parse(runStart) - 5_000);
        if (fresh?.id) return fresh.id;
      } catch {
        /* server still starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return null;
  })();
  if (!companyId) {
    driver.kill();
    die("no company appeared within 10 minutes — the driver never got started");
  }
  const officeUrl = `http://localhost:${SLOT_WEB}/c/${companyId}/office-window`;
  writeFileSync(join(OUT_DIR, "office-window.txt"), `${officeUrl}\n`);
  log(`\n   company ${companyId}`);
  log(`   FOUNDER WATCHES: ${officeUrl}\n`);

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
