// E1 FAZ-1 CANLI doğrulama (Founder devri öncesi): gerçek stack'e karşı
// tek ekran akışını uçtan uca yürütür — mock yok.
//   node apps/web/scripts/e1-live-verify.mjs <webUrl> <shotDir>
import { chromium } from "@playwright/test";

const WEB = process.argv[2] ?? "http://localhost:16773";
const SHOTS = process.argv[3] ?? ".";
const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(`${WEB}/`, { waitUntil: "domcontentloaded" });
await page.getByTestId("company-list").waitFor({ timeout: 30_000 });
await page.getByTestId("company-list").locator("button, a, li, div").first().click().catch(() => {});
await page.getByTestId("me-name").waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);

check("tek ekran açıldı (me-name görünür)", true);
check("üst nav sekme satırı yok", (await page.locator('nav[aria-label="Ana gezinme"]').count()) === 0);
check("komuta merkezi görünür", await page.getByTestId("command-center").isVisible());
check("şirket seçici duruyor", await page.getByTestId("company-switcher").isVisible());
const teamsVisible = await page.getByTestId("team-chips").isVisible().catch(() => false);
check("proje bazlı takım şeridi", teamsVisible, (await page.getByTestId("team-chips").textContent().catch(() => "") ?? "").trim().slice(0, 80));
await page.screenshot({ path: `${SHOTS}/live-01-shell.png` });

// Founder ikonu → CEO görev diyaloğu
const me = page.getByTestId("me-name");
check("Founder düğmesi etkin (CEO var)", await me.isEnabled());
check("düğme CEO'yu adıyla söylüyor", /görevi ver/.test((await me.getAttribute("title")) ?? ""), (await me.getAttribute("title")) ?? "");
await me.click();
await page.getByTestId("directive-submit").waitFor({ timeout: 15_000 });
check("CEO görev diyaloğu açıldı", true);
await page.screenshot({ path: `${SHOTS}/live-02-dialog.png` });

const stamp = process.argv[4] ?? "E1";
await page.fill('input[name="directiveTitle"]', `E1 doğrulama ${stamp}`);
await page.fill(
  'textarea[name="directiveObjective"]',
  "E1 tek ekran doğrulaması: bu hedef üst çubuktaki Founder ikonundan verildi.",
);
await page.selectOption('select[name="directivePriority"]', "P3");
await page.getByTestId("directive-submit").click();
const created = page.getByTestId("directive-created");
await created.waitFor({ timeout: 60_000 });
const createdText = (await created.textContent()) ?? "";
check("POST /directives başarılı — hedef CEO'ya atandı", /ASSIGNED|oluşturuldu/i.test(createdText), createdText.replace(/\s+/g, " ").trim().slice(0, 140));
await page.screenshot({ path: `${SHOTS}/live-03-created.png` });

await page.getByTestId("directive-close").click().catch(() => {});
// görev panosunda görünüyor mu
await page.getByTestId("panel-launcher").click();
await page.getByTestId("nav-tasks").click();
await page.waitForTimeout(2500);
const boardText = (await page.getByTestId("command-center").textContent()) ?? "";
check("görev panosunda görünüyor", boardText.includes(`E1 doğrulama ${stamp}`));
await page.screenshot({ path: `${SHOTS}/live-04-board.png` });

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
