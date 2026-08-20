// E1 FAZ-1 kanıt betiği — TAMAMEN MOCK API (Jim'in acos-e2e stack'ine
// dokunulmaz): dev sunucusundaki gerçek arayüz yüklenir, tüm /api çağrıları
// burada karşılanır. Ekran akışını uçtan uca doğrular.
import { chromium } from "@playwright/test";

const CID = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const U1 = "44444444-4444-4444-8444-444444444444";
const U2 = "55555555-5555-4555-8555-555555555555";
const A1 = "66666666-6666-4666-8666-666666666666";
const CEO = "77777777-7777-4777-8777-777777777777";

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const directivePosts = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text().slice(0, 300)); });

await page.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  if (route.request().method() === "POST" && p.endsWith("/directives")) {
    directivePosts.push(JSON.parse(route.request().postData() ?? "{}"));
    return json(route, {
      id: "88888888-8888-4888-8888-888888888888", number: 1, displayNumber: "TASK-1",
      kind: "goal", parentId: null, projectId: P1, title: "x", objective: "y",
      priority: "P1", status: "ASSIGNED", successCriteria: [], risk: "low",
      budgetCents: null, spentCents: 0, deadline: null, ownerAgentId: CEO,
      creatorAgentId: null, orgUnitId: null, delegationDepth: 0, reassignmentCount: 0,
      createdAt: new Date(0).toISOString(), closedAt: null, archivedAt: null,
    });
  }
  if (p === "/api/v1/auth/me") return json(route, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "f@x", displayName: "Burak", platformRole: "owner", totpEnabled: false });
  if (p === "/api/v1/companies") return json(route, [{ id: CID, name: "Webicrea", slug: "webicrea", currency: "TRY", status: "active", role: "founder", createdAt: new Date(0).toISOString() }]);
  if (p.endsWith("/tasks/top-executive")) return json(route, { agentId: CEO, name: "Aylin Vural", positionTitle: "CEO" });
  if (p.endsWith("/org/units")) return json(route, [
    { id: U1, name: "Backend", slug: "backend", kind: "team", parentId: null },
    { id: U2, name: "Tasarım", slug: "tasarim", kind: "team", parentId: null },
  ]);
  if (p.endsWith("/org/edges")) return json(route, []);
  const project = (id, name, slug, status) => ({
    id, name, slug, status, objective: "hedef", constraints: null,
    intakeReportArtifactId: null, createdAt: new Date(0).toISOString(),
    kind: "greenfield", repository: null, githubConnectionId: null,
    indexState: "none", indexCommitSha: null, headSha: null,
  });
  if (p.endsWith("/projects")) return json(route, {
    items: [project(P1, "Vitrin Sitesi", "vitrin", "executing"), project(P2, "Mobil Uygulama", "mobil", "ready")],
  });
  if (p.endsWith("/tasks")) return json(route, [
    { id: "99999999-9999-4999-8999-999999999991", number: 1, displayNumber: "TASK-1", kind: "epic", parentId: null, projectId: P1,
      title: "Anasayfa", objective: "o", priority: "P1", status: "IN_PROGRESS", successCriteria: [],
      risk: "low", budgetCents: null, spentCents: 0, deadline: null, ownerAgentId: A1,
      creatorAgentId: null, orgUnitId: U1, delegationDepth: 0, reassignmentCount: 0,
      createdAt: new Date(0).toISOString(), closedAt: null, archivedAt: null },
    { id: "99999999-9999-4999-8999-999999999992", number: 2, displayNumber: "TASK-2", kind: "task", parentId: null, projectId: P2,
      title: "Ekranlar", objective: "o", priority: "P2", status: "PLANNED", successCriteria: [],
      risk: "low", budgetCents: null, spentCents: 0, deadline: null, ownerAgentId: A1,
      creatorAgentId: null, orgUnitId: U2, delegationDepth: 0, reassignmentCount: 0,
      createdAt: new Date(0).toISOString(), closedAt: null, archivedAt: null },
  ]);
  if (p.endsWith("/agents")) return json(route, []);
  if (p.includes("/approvals")) return json(route, []);
  if (p.includes("/costs") || p.includes("/reports")) return json(route, { items: [] });
  return json(route, {});
});

const results = [];
const check = (name, ok, extra = "") => { results.push(`${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`); };

await page.goto(`http://localhost:5199/c/${CID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// (2) nav sekme satırı GİTTİ
const navRow = await page.locator('nav[aria-label="Ana gezinme"]').count();
check("üst nav sekme satırı yok", navRow === 0, `nav sayısı=${navRow}`);

// (1)+(8) tek ekran: komuta merkezi var
check("komuta merkezi tek ekran", await page.getByTestId("command-center").isVisible());

// (3) şirket satırı duruyor
check("şirket seçici duruyor", await page.getByTestId("company-switcher").isVisible());

// (4) takımlar proje bazında + ortada
const g1 = await page.getByTestId(`project-teams-${P1}`).textContent();
const g2 = await page.getByTestId(`project-teams-${P2}`).textContent();
check("takımlar proje bazında gruplu", !!g1?.includes("Vitrin") && !!g1?.includes("Backend") && !!g2?.includes("Mobil") && !!g2?.includes("Tasarım"), `${g1?.trim()} | ${g2?.trim()}`);

// (2b) nav testid'leri panel açıcıya taşındı ve panel AÇIYOR
await page.getByTestId("panel-launcher").click();
await page.getByTestId("nav-tasks").click();
await page.waitForTimeout(600);
const tabs = await page.locator(".dv-tab").allTextContents();
check("panel açıcı 'Görevler' panelini öne getirdi", tabs.some((t) => t.includes("Görevler")), tabs.join(","));

// tek ekran: URL değişmedi
check("rota değişmedi (tek ekran)", new URL(page.url()).pathname === `/c/${CID}`, page.url());

// (5)+(7) user icon → CEO'ya görev
await page.screenshot({ path: process.argv[2] + "/e1-01-shell.png" });
await page.getByTestId("me-name").click();
await page.waitForTimeout(400);
const dialogVisible = await page.getByTestId("directive-submit").isVisible();
check("Founder ikonu CEO görev diyaloğunu açtı", dialogVisible);
await page.screenshot({ path: process.argv[2] + "/e1-02-directive.png" });
await page.fill('textarea[name="directiveObjective"]', "Vitrin sitesine iletişim formu ekle.");
await page.fill('input[name="directiveTitle"]', "İletişim formu");
await page.getByTestId("directive-submit").click();
await page.waitForTimeout(700);
check("POST /directives gitti", directivePosts.length === 1, JSON.stringify(directivePosts[0] ?? {}));
check("görev verildi onayı göründü", await page.getByTestId("directive-created").isVisible());
await page.screenshot({ path: process.argv[2] + "/e1-03-created.png" });

// derin bağlantı tek ekrana katlanıyor
await page.goto(`http://localhost:5199/c/${CID}/office`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
check("derin bağlantı /office tek ekrana katlandı", new URL(page.url()).pathname === `/c/${CID}`, page.url());
const tabs2 = await page.locator(".dv-tab").allTextContents();
check("…ve Ofis paneli öne geldi", tabs2.some((t) => t.includes("Ofis")), tabs2.join(","));

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
