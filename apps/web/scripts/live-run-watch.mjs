// CANLI KOŞUM İZLEYİCİ (2026-08-21) — MOCK YOK. Çalışan bir slot'a bakar ve
// Founder'ın gördüğü şeyi ÖLÇER. Koşum sırasında istediğin kadar çalıştır;
// her koşuş bir "an" fotoğrafıdır (durum + ekran görüntüsü + PASS/FAIL).
//
//   node apps/web/scripts/live-run-watch.mjs --base=http://localhost:16373 \
//        --company=<uuid> [--shots=<dizin>] [--tag=t1]
//
// Ölçtüğü şeyler (god'un canlı koşum soruları):
//   * kaç ajan katta oturuyor / kaç canlı oturum hücresi var
//   * canlı oturum TAVANI dolduğunda sıradaki ajan ekranda duruyor mu
//   * rozet dağılımı (WORKING/WAITING/BLOCKED/IDLE) — park anı görünüyor mu
//   * hücrelerin durum satırı ("⏸ Bekliyor: reply" gibi) ve son adımlar
//   * yakalanmamış sayfa hatası
//
// KURAL: hiçbir şeyi mock'lamaz, hiçbir şey yazmaz — yalnız BAKAR.
import { chromium } from "@playwright/test";

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg("base", "http://localhost:16373").replace(/\/$/, "");
const CID = arg("company");
const SHOTS = arg("shots", ".");
const TAG = arg("tag", "an");

if (!CID) {
  console.error("--company=<uuid> zorunlu (koşum başlayınca Jim veriyor)");
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`);

// --- 1) Komuta merkezi: canlı hücreler + sıradakiler + rozetler -----------
await page.goto(`${BASE}/c/${CID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const liveCells = await page.getByTestId("session-feed").count();
const queued = await page.getByTestId("pending-cell-queued").count();
const parked = await page.getByTestId("pending-cell-parked").count();
const detached = await page.getByTestId("pending-cell-detached").count();
const header = (await page.locator('[data-testid="terminal-grid"]').first().isVisible().catch(() => false))
  ? ((await page.getByTestId("pending-count").textContent().catch(() => "")) ?? "")
  : "";

const badges = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid^="roster-row-"]')].map((row) => {
    const name = row.querySelector("span > span")?.textContent?.trim() ?? "?";
    const badge = row.querySelector("span[style]")?.textContent?.trim() ?? "?";
    return `${name}:${badge}`;
  }),
);
const cursors = await page.getByTestId("session-live-cursor").allTextContents();
const ops = await page.getByTestId("active-operation").allTextContents();

// Beklentiyi UYDURMUYORUZ: açık işi olan ajanların sayısını sunucudan
// okuyoruz (salt GET). Boştaki bir şirkette "hücre yok" doğru cevaptır;
// asıl soru, işi OLAN ajanın ekranda karşılığı var mı.
const OPEN_STATUS = new Set(["ASSIGNED", "PLANNED", "IN_PROGRESS", "WAITING", "BLOCKED", "APPROVAL"]);
let openOwners = [];
try {
  const res = await page.request.get(`${BASE}/api/v1/companies/${CID}/tasks`);
  const tasks = res.ok() ? await res.json() : [];
  openOwners = [
    ...new Set(
      (Array.isArray(tasks) ? tasks : (tasks.items ?? []))
        .filter((t) => t.ownerAgentId && OPEN_STATUS.has(t.status))
        .map((t) => t.ownerAgentId),
    ),
  ];
} catch {
  /* uç kapalıysa bu kontrol atlanır — izleyici yine de bakar */
}
const accounted = liveCells + queued + parked + detached;

check("ajan kadrosu görünüyor", badges.length > 0, `${badges.length} satır`);
check(
  "açık işi olan HER ajanın ekranda bir karşılığı var (canlı ya da hayalet hücre)",
  openOwners.length === 0 || accounted >= openOwners.length,
  `işi olan ${openOwners.length} · ekranda ${accounted} (canlı ${liveCells} · sırada ${queued} · beklemede ${parked} · kopuk ${detached})`,
);
check(
  "canlı oturum sayısı tavanı aşmıyor (cap 3)",
  liveCells <= 3,
  `canlı hücre: ${liveCells}`,
);
check("yakalanmamış sayfa hatası yok", pageErrors.length === 0, pageErrors.slice(0, 2).join("; "));

await page.screenshot({ path: `${SHOTS}/watch-${TAG}-komuta.png` });

// --- 2) Ofis penceresi: kat + oturma + bekleme balonu ---------------------
await page.goto(`${BASE}/c/${CID}/office-window`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 30_000 });
await page.waitForTimeout(5000);
const office = await page.evaluate(() => ({
  agents: window.__acosOffice?.agentCount ?? 0,
  seats: window.__acosOffice?.floorSeats ?? 0,
  snapshots: window.__acosOffice?.snapshotCount ?? 0,
  filtered: window.__acosOffice?.floorFiltered ?? null,
}));
const count = (await page.getByTestId("office-window-count").textContent().catch(() => "")) ?? "";
check("ofis kadroyu düşürdü", office.agents > 0 && office.snapshots > 0, JSON.stringify(office));
check("katta oturan sayısı = sahadaki ajan sayısı", office.seats === office.agents, JSON.stringify(office));
await page.screenshot({ path: `${SHOTS}/watch-${TAG}-ofis.png` });

console.log(
  [
    `— AN: ${TAG} · ${BASE} · ${CID}`,
    `rozetler: ${badges.join(" | ") || "—"}`,
    `işi olan ajan (sunucu): ${openOwners.length}`,
    `hücreler: canlı ${liveCells} · sırada ${queued} · beklemede ${parked} · kopuk ${detached} ${header.trim()}`,
    `durum satırları: ${cursors.join(" | ") || "—"}`,
    ops.length ? `aktif işlem: ${ops.join(" | ")}` : "",
    `ofis: ${count.trim()} ${JSON.stringify(office)}`,
    "",
    ...results,
  ]
    .filter(Boolean)
    .join("\n"),
);
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
