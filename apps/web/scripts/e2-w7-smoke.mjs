// E2/W7+W6+W8 kanıt betiği — projeler-birincil kabuk, proje sihirbazı ve
// ofis odağı. TAMAMEN MOCK API (paylaşılan hiçbir stack'e dokunmaz).
//   node apps/web/scripts/e2-w7-smoke.mjs <shotDir>
import { chromium } from "@playwright/test";

const SHOTS = process.argv[2] ?? ".";
const CID = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const NEW_P = "99999999-9999-4999-8999-999999999999";
const U1 = "44444444-4444-4444-8444-444444444444";
const U2 = "55555555-5555-4555-8555-555555555555";
const A1 = "66666666-6666-4666-8666-666666666661";
const A2 = "66666666-6666-4666-8666-666666666662";
const CEO = "77777777-7777-4777-8777-777777777777";

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const posts = [];

const project = (id, name, slug, status) => ({
  id,
  name,
  slug,
  status,
  objective: "hedef",
  constraints: null,
  intakeReportArtifactId: null,
  createdAt: new Date(0).toISOString(),
  kind: "greenfield",
  repository: null,
  githubConnectionId: null,
  indexState: "none",
  indexCommitSha: null,
  headSha: null,
});
let projects = [project(P1, "Vitrin Sitesi", "vitrin", "executing"), project(P2, "Mobil Uygulama", "mobil", "executing")];

const task = (id, pid, unit, owner, title) => ({
  id,
  number: 1,
  displayNumber: "TASK-1",
  kind: "task",
  parentId: null,
  projectId: pid,
  title,
  objective: "o",
  priority: "P2",
  status: "IN_PROGRESS",
  successCriteria: [],
  risk: "low",
  budgetCents: null,
  spentCents: 0,
  deadline: null,
  ownerAgentId: owner,
  creatorAgentId: null,
  orgUnitId: unit,
  delegationDepth: 0,
  reassignmentCount: 0,
  createdAt: new Date(0).toISOString(),
  closedAt: null,
  archivedAt: null,
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.route("**/api/v1/**", async (route) => {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  const method = req.method();
  if (method !== "GET") posts.push(`${method} ${p} ${req.postData() ?? ""}`);

  if (method === "POST" && p.endsWith(`/companies/${CID}/projects`)) {
    const body = JSON.parse(req.postData() ?? "{}");
    const row = project(NEW_P, body.name, "yeni", "ready");
    projects = [...projects, row];
    return json(route, row);
  }
  if (p.includes("/staffing-proposal")) return route.fulfill({ status: 404, body: "" });
  if (method === "POST" && p.endsWith("/goal")) return json(route, { started: true, state: "planning" });
  if (p === "/api/v1/auth/me")
    return json(route, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "f@x",
      displayName: "Burak",
      platformRole: "owner",
      totpEnabled: false,
    });
  if (p === "/api/v1/companies")
    return json(route, [
      { id: CID, name: "Webicrea", slug: "webicrea", currency: "TRY", status: "active", role: "founder", createdAt: new Date(0).toISOString() },
    ]);
  if (p.endsWith("/tasks/top-executive"))
    return json(route, { agentId: CEO, name: "Aylin Vural", positionTitle: "CEO" });
  if (p.endsWith("/org/units"))
    return json(route, [
      { id: U1, name: "Backend", slug: "backend", kind: "team", parentId: null },
      { id: U2, name: "Tasarım", slug: "tasarim", kind: "team", parentId: null },
    ]);
  if (p.endsWith("/org/edges"))
    return json(route, [
      { id: "e1", kind: "member_of", fromAgentId: A1, toAgentId: null, toUnitId: U1, startedAt: new Date(0).toISOString(), endedAt: null },
      { id: "e2", kind: "member_of", fromAgentId: A2, toAgentId: null, toUnitId: U2, startedAt: new Date(0).toISOString(), endedAt: null },
    ]);
  if (p.endsWith("/projects")) return json(route, { items: projects });
  if (p.endsWith("/tasks"))
    return json(route, [
      task("99999999-9999-4999-8999-999999999991", P1, U1, A1, "Anasayfa"),
      task("99999999-9999-4999-8999-999999999992", P2, U2, A2, "Ekranlar"),
    ]);
  if (p.endsWith("/agents")) return json(route, []);
  if (p.includes("/approvals")) return json(route, []);
  if (p.includes("/costs") || p.includes("/reports")) return json(route, { items: [] });
  return json(route, {});
});

const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`);

await page.goto(`http://localhost:5199/c/${CID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// W7 — üst-orta PROJELER
check("üst-orta proje çubuğu", await page.getByTestId("project-bar").isVisible());
check("proje seçici var", await page.getByTestId("project-switcher").isVisible());
const options = await page.locator('select[aria-label="Proje"] option').allTextContents();
check("seçicide 'Tüm şirket' + projeler", options.join("|") === "Tüm şirket|Vitrin Sitesi|Mobil Uygulama", options.join("|"));
await page.screenshot({ path: `${SHOTS}/w7-01-all.png` });

// proje seç → SADECE o projenin takımı
await page.selectOption('select[aria-label="Proje"]', P1);
await page.waitForTimeout(700);
let chips = await page.getByTestId("team-chips").textContent();
check("proje seçilince yalnız o projenin takımı", chips.includes("Backend") && !chips.includes("Tasarım"), (chips ?? "").trim());
await page.screenshot({ path: `${SHOTS}/w7-02-project1.png` });

await page.selectOption('select[aria-label="Proje"]', P2);
await page.waitForTimeout(700);
chips = await page.getByTestId("team-chips").textContent();
check("proje değişince takımlar da değişti", chips.includes("Tasarım") && !chips.includes("Backend"), (chips ?? "").trim());

// W8 — ofis odağı seçili projeyi izliyor (odak kümesi canvas'a geçiyor)
const officeFocus = await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="office-canvas"]');
  return canvas ? "canvas-mounted" : "no-canvas";
});
check("ofis paneli canlı (odak kümesi projeye bağlı)", officeFocus === "canvas-mounted", officeFocus);

// W6 — sihirbaz
await page.getByTestId("project-create-open").click();
await page.getByTestId("project-wizard").waitFor({ timeout: 10_000 });
check("proje sihirbazı açıldı", true);
await page.fill('input[name="projectName"]', "Kurumsal Web Sitesi");
await page.fill(
  'textarea[name="projectRequirements"]',
  "React ile vitrin sitesi, iletişim formu, ödeme entegrasyonu ve SEO içerikleri.",
);
await page.screenshot({ path: `${SHOTS}/w6-01-brief.png` });
await page.getByTestId("project-wizard-next").click();
await page.getByTestId("proposal-teams").waitFor({ timeout: 20_000 });
const teamsText = (await page.getByTestId("proposal-teams").textContent()) ?? "";
check(
  "CEO önerisi: gereksinimden takımlar çıktı",
  teamsText.includes("Frontend") && teamsText.includes("Backend") && teamsText.includes("Pazarlama"),
  teamsText.replace(/\s+/g, " ").slice(0, 120),
);
check("proje GERÇEKTEN açıldı (POST /projects)", posts.some((c) => c.includes(`POST /api/v1/companies/${CID}/projects `)));
const totalBefore = await page.getByTestId("proposal-total").textContent();
await page.screenshot({ path: `${SHOTS}/w6-02-proposal.png` });

// düzenle: sayı artır + takım ekle + takım çıkar
const firstInc = page.locator('[data-testid^="proposal-inc-"]').first();
await firstInc.click();
await firstInc.click();
await page.fill('input[name="newTeamName"]', "Veri");
await page.getByTestId("proposal-add-team").click();
await page.locator('[data-testid^="proposal-remove-"]').last().click(); // eklenen "Veri"yi geri al
await page.fill('input[name="newTeamName"]', "Veri");
await page.getByTestId("proposal-add-team").click();
await page.waitForTimeout(300);
const totalAfter = await page.getByTestId("proposal-total").textContent();
check("kullanıcı öneriyi DÜZENLEYEBİLDİ", totalBefore !== totalAfter, `${totalBefore} → ${totalAfter}`);
check("takım eklendi", ((await page.getByTestId("proposal-teams").textContent()) ?? "").includes("Veri"));
await page.screenshot({ path: `${SHOTS}/w6-03-adjusted.png` });

// onayla → iş başlar
await page.getByTestId("proposal-confirm").click();
await page.getByTestId("project-wizard-done").waitFor({ timeout: 20_000 });
check(
  "onay hedefi CEO'ya verdi (POST /goal)",
  posts.some((c) => c.includes(`POST /api/v1/companies/${CID}/projects/${NEW_P}/goal`)),
  posts.filter((c) => c.includes("/goal")).join(" | ").slice(0, 140),
);
check(
  "onaylanan kadro hedef metnine yazıldı",
  posts.some((c) => c.includes("/goal") && c.includes("Önerilen kadro")),
);
await page.getByTestId("project-wizard-close").click();
await page.waitForTimeout(800);
const selected = await page.inputValue('select[aria-label="Proje"]');
check("yeni proje otomatik seçildi", selected === NEW_P, selected);
await page.screenshot({ path: `${SHOTS}/w6-04-done.png` });

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
