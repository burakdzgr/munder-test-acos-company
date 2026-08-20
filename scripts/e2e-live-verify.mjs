#!/usr/bin/env node
// E4 CANLI WORKLOAD RUN — doğrulama koşumu (Jim, yerleşim; assert kaynakları
// Oscar + Kevin).
//
// "int-green" testlerin yeşil olduğunu söyler; bu script ÇALIŞAN BİR ŞİRKETİN
// gerçekten iş çıkardığını söyler. Dört katman, her biri AYRI bir yüzeyden:
//
//   0. imaj kimliği   — konteyner, test edilen commit'ten mi derlendi?
//   1. kontrol düzlemi — Oscar'ın SQL seti (İDDİA 1-4 + iş durumu özeti)
//   2. runtime izi     — worker stdout (1d) ve sandbox 409 nöbetçisi
//   3. CLI oturumu     — e2e-cli-session-verify.mjs (Decision A iddiaları)
//
// Kullanım (stack AYAKTA olmalı):
//   node scripts/e2e-live-verify.mjs --project acos-e2e-live --company <uuid> \
//                                    [--base-url http://localhost:1XX00]
//
// Çıkış kodları: 0 = hepsi geçti, 2 = en az bir iddia FAIL, 3 = koşulamadı.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const PROJECT = arg("project", process.env.ACOS_E2E_PROJECT ?? "acos-e2e-live");
const COMPANY = arg("company", process.env.ACOS_E2E_COMPANY ?? null);
const COMPOSE = ["compose", "-p", PROJECT, "-f", "infrastructure/docker/compose.yaml"];
const SQL_FILE = join(process.cwd(), "scripts", "live-run-controlplane-asserts.sql");

const results = [];
const record = (verdict, claim, detail) => {
  results.push({ verdict, claim, detail });
  console.log(`  [${verdict}] ${claim}${detail ? ` — ${detail}` : ""}`);
};

const sh = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

function fail(message) {
  console.error(message);
  process.exit(3);
}

// ---------- 0. imaj kimliği ------------------------------------------------
// Sunucunun /api/health'i yalnız "0.0.0" der — taze imajla bayat imajı AYIRT
// EDEMEZ. Bu yüzden imajın İÇİNE damgalanmış commit'e bakıyoruz: bir kanıt
// koşusu, test ettiğini iddia ettiği kodu gerçekten çalıştırdığını gösterebilmeli.
function assertImageIdentity() {
  let head = "";
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    if (dirty) head = `${head}-dirty`;
  } catch {
    head = "unknown";
  }
  // The concurrency ceiling must be the one INSIDE the container. It is easy to
  // export a value in the firing shell, have the harness and the gate both echo
  // it back, and never notice the server is running on its default — the run
  // then "proves" a ceiling that was never in force.
  const capInside = sh("docker", [...COMPOSE, "exec", "-T", "server", "printenv", "MAX_LIVE_SESSIONS_PER_COMPANY"]).trim();
  const capExpected = (process.env.MAX_LIVE_SESSIONS_PER_COMPANY ?? "2").trim();
  record(
    capInside === capExpected ? "PASS" : "FAIL",
    "the session ceiling in force is the one we set",
    capInside === capExpected ? `server sees ${capInside}` : `server sees ${capInside || "nothing (default)"} but the run assumed ${capExpected}`,
  );

  for (const service of ["server", "agent-worker"]) {
    const baked = sh("docker", [...COMPOSE, "exec", "-T", service, "printenv", "ACOS_BUILD_SHA"]).trim();
    if (!baked) {
      record("FAIL", `${service} image carries a build stamp`, "ACOS_BUILD_SHA is absent — image predates the stamp, rebuild before proving anything");
      continue;
    }
    record(
      baked === head ? "PASS" : "FAIL",
      `${service} runs the commit under test`,
      baked === head ? baked : `image=${baked} vs tree=${head}`,
    );
  }
}

// ---------- 1. kontrol düzlemi (Oscar'ın seti) -----------------------------
function runControlPlaneAsserts() {
  if (!existsSync(SQL_FILE)) fail(`assert set missing: ${SQL_FILE}`);
  const out = sh(
    "docker",
    [...COMPOSE, "exec", "-T", "postgres", "psql", "-U", "acos", "-d", "acos", "-At", "-F", "|",
     "-v", "ON_ERROR_STOP=1", "-v", `company='${COMPANY}'`, "-f", "-"],
    readFileSync(SQL_FILE, "utf8"),
  );
  const rows = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .map((line) => line.split("|"));
  if (rows.length === 0) fail(`the assert set returned nothing:\n${out.slice(0, 800)}`);

  const summary = [];
  for (const [id, claim, verdict, ...rest] of rows) {
    const detail = rest.join("|");
    if (id === "SUMMARY") {
      summary.push({ claim, verdict, detail });
      continue;
    }
    // INFO is not a verdict. 5c measures review-start LATENCY and emits one row
    // per review, because SQL cannot see WHO started the turn (run #2's turns
    // were started by hand and these rows would have said "started" there too).
    // Counting it as a failed claim would fail an honest run — the exact way a
    // rotting assert set does damage.
    if (verdict === "INFO") {
      console.log(`  [INFO] ${id} ${claim} — ${detail}`);
      continue;
    }
    record(verdict === "PASS" ? "PASS" : "FAIL", `${id} ${claim}`, detail);
  }
  return summary;
}

// ---------- 2. runtime izi -------------------------------------------------
// 1c "hiçbir yetenek eşleşmedi" der (DB). 1d "kod GERÇEKTEN gevşetilmiş daldan
// geçti" der (log). Farklı iddialar: birincisi durumu, ikincisi yolu kanıtlar.
function assertWorkerTrace() {
  const log = sh("docker", [...COMPOSE, "logs", "--no-color", "--tail", "20000", "agent-worker"]);
  const hits = log
    .split("\n")
    .filter((line) => /no candidate matched requiredCapabilities/i.test(line));
  record(
    hits.length > 0 ? "PASS" : "FAIL",
    "1d the relaxed delegation branch actually ran (worker stdout)",
    hits.length > 0
      ? `${hits.length} line(s), e.g. ${hits[0].slice(-120).trim()}`
      : "no 'no candidate matched requiredCapabilities' line — 1c may be passing for some other reason",
  );

  // 409 bir gürültü DEĞİL: workspace açılmazsa tur sessizce steps yoluna düşer
  // ve "leaf complete_task" iddiası çürür. Görürsek koşu başarısızdır.
  const all = log + sh("docker", [...COMPOSE, "logs", "--no-color", "--tail", "20000", "sandbox-manager"]);
  const conflicts = all.split("\n").filter((line) => /container name .* is already in use/i.test(line));
  record(
    conflicts.length === 0 ? "PASS" : "FAIL",
    "no sandbox container-name conflict during the run",
    conflicts.length === 0
      ? "zero 409s"
      : `${conflicts.length} conflict(s) — a turn may have fallen back instead of running in its workspace`,
  );
}

// ---------- 3. CLI oturumu (Decision A) ------------------------------------
function runCliSessionVerify(baseUrl) {
  const r = spawnSync(
    process.execPath,
    ["scripts/e2e-cli-session-verify.mjs", "--project", PROJECT, "--base-url", baseUrl,
     ...(COMPANY ? ["--company", COMPANY] : [])],
    { encoding: "utf8" },
  );
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(text.split("\n").map((line) => (line ? `    ${line}` : line)).join("\n"));
  if (r.status === 3) {
    record("FAIL", "the agent turn ran as a live CLI session", "verifier reports NOT APPLICABLE — this stack is not the CLI runtime");
    return;
  }
  record(
    r.status === 0 ? "PASS" : "FAIL",
    "the agent turn ran as a live CLI session (Decision A)",
    r.status === 0 ? "all claims proven" : "at least one claim failed (detail above)",
  );
}

// ---------- main -----------------------------------------------------------
if (!COMPANY) fail("--company <uuid> is required (the run's company)");
const baseUrl = arg("base-url", process.env.ACOS_E2E_BASE_URL ?? "http://localhost:13000");
console.log(`live-run verify -> ${PROJECT} · company ${COMPANY}\n`);

console.log("-- image identity");
assertImageIdentity();
console.log("\n-- control plane (Oscar's assert set)");
const summary = runControlPlaneAsserts();
console.log("\n-- runtime trace");
assertWorkerTrace();
console.log("\n-- CLI session (Decision A)");
runCliSessionVerify(baseUrl);

// ZORUNLU: "hata yok" ile "iş ilerledi" aynı şey değildir. DRAFT/WAITING'de
// kalan her görev burada görünür — rapor bunu gizleyemesin diye.
console.log("\n-- work status (mandatory, not a verdict)");
if (summary.length === 0) {
  console.log("  (no tasks in this company — the run produced nothing)");
} else {
  for (const row of summary) console.log(`  ${row.claim.padEnd(10)} ${row.verdict.padEnd(16)} ${row.detail}`);
}

const failed = results.filter((r) => r.verdict === "FAIL");
console.log(
  `\n${results.length - failed.length} proven, ${failed.length} failed · ${summary.length} task(s) in the run`,
);
if (failed.length > 0) {
  console.log("FAILED CLAIMS:");
  for (const f of failed) console.log(`  - ${f.claim}: ${f.detail}`);
}
process.exit(failed.length > 0 ? 2 : 0);
