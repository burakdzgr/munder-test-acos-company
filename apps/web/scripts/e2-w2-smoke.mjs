// E2/W2 kanıt betiği — "Yeni şirket aç" akışı (TAMAMEN MOCK API).
// Gerçek arayüz dev sunucusundan yüklenir; /api çağrıları burada karşılanır,
// böylece paylaşılan hiçbir stack'e dokunulmaz.
//   node apps/web/scripts/e2-w2-smoke.mjs <shotDir>
import { chromium } from "@playwright/test";

const SHOTS = process.argv[2] ?? ".";
const CID = "11111111-1111-4111-8111-111111111111";
const NEW_CID = "22222222-2222-4222-8222-222222222222";
const UNIT = "33333333-3333-4333-8333-333333333333";
const POS = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const calls = [];
const company = (id, name, slug) => ({
  id,
  name,
  slug,
  currency: "TRY",
  status: "active",
  role: "founder",
  createdAt: new Date(0).toISOString(),
});
let companies = [company(CID, "Webicrea", "webicrea")];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.route("**/api/v1/**", async (route) => {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  const method = req.method();
  if (method === "POST") calls.push(`${p} ${req.postData() ?? ""}`);

  if (method === "POST" && p === "/api/v1/companies") {
    const body = JSON.parse(req.postData() ?? "{}");
    const row = company(NEW_CID, body.name, body.slug);
    companies = [...companies, row];
    return json(route, row);
  }
  if (method === "POST" && p.endsWith("/org/units"))
    return json(route, { id: UNIT, name: "Yönetim", slug: "yonetim", kind: "department", parentId: null });
  if (method === "POST" && p.endsWith("/org/positions"))
    return json(route, {
      id: POS,
      title: "CEO",
      seniorityTrack: ["expert"],
      defaultRole: "executive",
      description: null,
    });
  if (method === "POST" && p.endsWith("/agents")) {
    const body = JSON.parse(req.postData() ?? "{}");
    return json(route, {
      id: AGENT,
      employeeNumber: 1,
      displayNumber: "EMP-001",
      name: body.name,
      avatarUrl: null,
      status: "active",
      positionId: POS,
      orgUnitId: UNIT,
      seniority: "expert",
      autonomyLevel: 3,
      persona: "x",
      createdAt: new Date(0).toISOString(),
    });
  }
  if (p === "/api/v1/auth/me")
    return json(route, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "f@x",
      displayName: "Burak",
      platformRole: "owner",
      totpEnabled: false,
    });
  if (p === "/api/v1/companies") return json(route, companies);
  if (p.endsWith("/tasks/top-executive"))
    return json(route, { agentId: AGENT, name: "Aylin Vural", positionTitle: "CEO" });
  if (p.endsWith("/org/units")) return json(route, []);
  if (p.endsWith("/org/edges")) return json(route, []);
  if (p.endsWith("/projects")) return json(route, { items: [] });
  if (p.endsWith("/tasks")) return json(route, []);
  if (p.endsWith("/agents")) return json(route, []);
  if (p.includes("/approvals")) return json(route, []);
  if (p.includes("/costs") || p.includes("/reports")) return json(route, { items: [] });
  return json(route, {});
});

const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`);

await page.goto(`http://localhost:5199/c/${CID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

check("şirket seçicide 'yeni şirket' girişi var", await page.getByTestId("company-create-open").isVisible());
await page.getByTestId("company-create-open").click();
await page.getByTestId("create-company-modal").waitFor({ timeout: 10_000 });
check("modal açıldı", true);

await page.fill('input[name="companyName"]', "Şahin Teknoloji A.Ş.");
await page.waitForTimeout(200);
const slug = await page.inputValue('input[name="companySlug"]');
check("ad → slug otomatik (Türkçe harfler dahil)", slug === "sahin-teknoloji-a-s", slug);
await page.selectOption('select[name="companyCurrency"]', "TRY");
check("kurucu CEO varsayılan olarak açık", await page.getByTestId("company-with-ceo").isChecked());
await page.fill('input[name="companyCeoName"]', "Aylin Vural");
await page.screenshot({ path: `${SHOTS}/w2-01-form.png` });

await page.getByTestId("company-create-submit").click();
await page.getByTestId("company-created").waitFor({ timeout: 20_000 });
const okText = (await page.getByTestId("company-created").textContent()) ?? "";
check("şirket açıldı onayı", okText.includes("Şahin Teknoloji"), okText.replace(/\s+/g, " ").slice(0, 110));
check("POST /api/v1/companies gitti", calls.some((c) => c.startsWith("/api/v1/companies ")), calls[0] ?? "");
check(
  "kurucu CEO açılışı: org birimi + pozisyon + ajan",
  calls.some((c) => c.includes("/org/units")) &&
    calls.some((c) => c.includes("/org/positions") && c.includes("executive")) &&
    calls.some((c) => c.includes(`/companies/${NEW_CID}/agents`) && c.includes("Aylin Vural")),
  calls.filter((c) => !c.startsWith("/api/v1/companies ")).map((c) => c.split(" ")[0]).join(" · "),
);
check("CEO işe alındı mesajı", okText.includes("CEO olarak işe alındı"));
await page.screenshot({ path: `${SHOTS}/w2-02-created.png` });

await page.getByTestId("company-created-open").click();
await page.waitForTimeout(1200);
check(
  "yeni şirkete geçildi",
  new URL(page.url()).pathname === `/c/${NEW_CID}`,
  new URL(page.url()).pathname,
);
const switcher = (await page.getByTestId("company-switcher").textContent()) ?? "";
check("üst çubuk yeni şirketi gösteriyor", switcher.includes("Şahin Teknoloji"), switcher.trim());
check(
  "yeni şirkette Founder düğmesi ETKİN (CEO var)",
  await page.getByTestId("me-name").isEnabled(),
);
await page.screenshot({ path: `${SHOTS}/w2-03-new-company.png` });

// --- Açılış sayfası da AYNI modali kullanıyor (E2/W2 ikinci kapı) ---
// 1) hiç şirket yokken: karşılama ekranı → modal → kurucu CEO
companies = [];
calls.length = 0;
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.getByTestId("company-wizard").waitFor({ timeout: 15_000 });
check("boş kurulum ekranı tek eyleme indi", await page.getByTestId("company-create-open").isVisible());
await page.getByTestId("company-create-open").click();
await page.getByTestId("create-company-modal").waitFor({ timeout: 10_000 });
await page.fill('input[name="companyName"]', "İlk Şirket");
await page.fill('input[name="companyCeoName"]', "Aylin Vural");
await page.getByTestId("company-create-submit").click();
await page.getByTestId("company-created").waitFor({ timeout: 20_000 });
check(
  "açılış sayfasından açılan şirket de CEO'lu doğdu",
  calls.some((c) => c.includes("/org/positions") && c.includes("executive")) &&
    calls.some((c) => c.includes(`/companies/${NEW_CID}/agents`)),
  calls.map((c) => c.split(" ")[0].replace("/api/v1", "")).join(" · "),
);
await page.screenshot({ path: `${SHOTS}/w2-04-landing-empty.png` });

// 2) şirket listesi varken: "Yeni şirket ekle" de aynı modali açıyor
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.getByTestId("company-list").waitFor({ timeout: 15_000 });
await page.getByTestId("company-create-open").click();
check(
  "liste ekranındaki 'Yeni şirket ekle' de aynı modali açıyor",
  await page.getByTestId("company-with-ceo").isVisible(),
);
await page.screenshot({ path: `${SHOTS}/w2-05-landing-list.png` });

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
