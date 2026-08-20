// E2/W7+W6+W8 kanıt betiği — projeler-birincil kabuk, proje sihirbazı, ofis
// odağı. TAMAMEN MOCK API (paylaşılan hiçbir stack'e dokunmaz).
//
// İKİ MOD:
//   node apps/web/scripts/e2-w7-smoke.mjs <shotDir>              → Oscar'ın
//        DONDURULMUŞ uçları (project-teams + staffing-proposal) VARMIŞ gibi:
//        gerçek sözleşme yolu doğrulanır.
//   node apps/web/scripts/e2-w7-smoke.mjs <shotDir> --no-endpoints → uçlar
//        henüz inmemişken: türetilmiş takımlar + yerel taslak öneri yolu.
//   ... --draft-then-ready → GET önce 200 'draft' (CEO çalışıyor, teams:[])
//        döner: sihirbaz BEKLEMELİ, boş listeyle düzenlemeye atlamamalı.
//   ... --draft-hold → GET hep 'draft' döner (CEO bitirmiyor): kullanıcı
//        beklemeyi keser ve SUNUCUDAKİ taslak satırını düzenler (yerel taslak
//        UYDURULMAZ; Oscar'ın "source human'a dönünce LLM üzerine yazmaz"
//        garantisi yalnız o satır için geçerli).
//   ... --indexing → yeni proje 'draft' doğar, GET'lerde repository_setup →
//        indexing → ready ilerler ve READY'den ÖNCE gelen /goal 409 yer
//        (canlı sunucunun davranışı; Jim'in T24 kırılması). Sihirbaz beklemeli,
//        sonra hedefi vermeli.
//   ... --goal-409-once → proje READY görünse de ilk /goal 409 döner (durum
//        okuma ile POST arasındaki yarış): sihirbaz sessizce yeniden denemeli.
//   ... --cancelled → GET 200 'cancelled': önerilecek kadro yok, planlama
//        deterministik sürüyor; sihirbaz temiz biter, sahte taslak üretmez.
//   (Üç durum da Oscar'ın 2026-08-20 teyidinden: 404 / draft / awaiting_human
//    / cancelled ayrımı.)
import { chromium } from "@playwright/test";

const SHOTS = process.argv[2] ?? ".";
const ENDPOINTS = !process.argv.includes("--no-endpoints");
const INDEXING = process.argv.includes("--indexing");
// yarış durumu: proje READY görünüyor ama ilk /goal yine de 409 yiyor
const GOAL_409_ONCE = process.argv.includes("--goal-409-once");
const STATE_MODE = process.argv.includes("--draft-then-ready")
  ? "draft"
  : process.argv.includes("--draft-hold")
    ? "draft-hold"
  : process.argv.includes("--cancelled")
    ? "cancelled"
    : "none";
const CID = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const NEW_P = "99999999-9999-4999-8999-999999999999";
const PROPOSAL = "88888888-8888-4888-8888-888888888888";
const U1 = "44444444-4444-4444-8444-444444444444";
const U2 = "55555555-5555-4555-8555-555555555555";
const A1 = "66666666-6666-4666-8666-666666666661";
const A2 = "66666666-6666-4666-8666-666666666662";
const CEO = "77777777-7777-4777-8777-777777777777";

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const notFound = (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
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
let projects = [
  project(P1, "Vitrin Sitesi", "vitrin", "executing"),
  project(P2, "Mobil Uygulama", "mobil", "executing"),
];

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

// --- Oscar'ın sözleşmesindeki sunucu durumu (mock) ---
const linkTeam = (id, name, slug, agentCount, taskCount) => ({
  orgUnitId: id,
  name,
  slug,
  kind: "team",
  agentCount,
  taskCount,
});
const projectTeams = () => ({
  groups: [
    { projectId: P1, projectName: "Vitrin Sitesi", source: "link", teams: [linkTeam(U1, "Backend", "backend", 3, 4)] },
    { projectId: P2, projectName: "Mobil Uygulama", source: "derived", teams: [linkTeam(U2, "Tasarım", "tasarim", 1, 2)] },
    { projectId: NEW_P, projectName: "Kurumsal Web Sitesi", source: "link", teams: [] },
  ],
  idleTeams: [],
});

let proposal = null;
let proposalGets = 0;
let newProjectStatus = "ready";
let newProjectGets = 0;
let earlyGoal = 0;
/** satır baştan açılır ama CEO henüz düşünüyor: teams BOŞ. */
const draftRow = () => ({
  ...mkProposal(),
  status: "draft",
  version: 0,
  teams: [],
  rationaleMd: "",
});
const mkProposal = () => ({
  id: PROPOSAL,
  projectId: NEW_P,
  goalTaskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  approvalId: null,
  status: "awaiting_human",
  version: 1,
  source: "llm",
  rationaleMd: "Vitrin + ödeme entegrasyonu için arayüz ve servis ekibi; içerik için pazarlama.",
  teams: [
    { key: "frontend", capability: "frontend", teamName: "Frontend", headcount: 2, existingCount: 1, hireCount: 1, rationale: "Sayfa üretimi" },
    { key: "backend", capability: "backend", teamName: "Backend", headcount: 2, existingCount: 0, hireCount: 2, rationale: "Ödeme entegrasyonu" },
    { key: "marketing", capability: "marketing", teamName: "Pazarlama", headcount: 1, existingCount: 0, hireCount: 1, rationale: "SEO içerikleri" },
  ],
  estimatedCostCents: 12_000,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.route("**/api/v1/**", async (route) => {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  const method = req.method();
  if (method !== "GET") posts.push(`${method} ${p} ${req.postData() ?? ""}`);

  // --- sözleşme uçları ---
  if (p.endsWith("/project-teams")) return ENDPOINTS ? json(route, projectTeams()) : notFound(route);
  if (p.endsWith("/staffing-proposal")) {
    if (!ENDPOINTS) return notFound(route);
    proposalGets += 1;
    // 'draft' iki tur sürer, sonra öneri hazırlanır (canlı sağlayıcıdaki
    // iki LLM turunun taklidi).
    if (STATE_MODE === "draft-hold") return json(route, proposal ?? draftRow());
    if (STATE_MODE === "draft" && proposalGets <= 2) return json(route, draftRow());
    if (STATE_MODE === "draft") proposal = mkProposal();
    return proposal ? json(route, proposal) : notFound(route);
  }
  if (p.includes("/staffing-proposals/")) {
    if (!ENDPOINTS) return notFound(route);
    if (p.endsWith("/confirm")) {
      proposal = { ...proposal, status: "applied" };
      return json(route, { ok: true, status: "applied" });
    }
    if (method === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.version !== proposal.version) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "stale_version" }),
        });
      }
      proposal = {
        ...proposal,
        version: proposal.version + 1,
        source: "human",
        teams: body.teams.map((t) => {
          const existingCount = proposal.teams.find((x) => x.key === t.key)?.existingCount ?? 0;
          return { ...t, existingCount, hireCount: Math.max(0, t.headcount - existingCount) };
        }),
      };
      return json(route, proposal);
    }
    return json(route, { ok: true });
  }

  if (method === "POST" && p.endsWith(`/companies/${CID}/projects`)) {
    const body = JSON.parse(req.postData() ?? "{}");
    // canlı sunucu: yeni proje ÖNCE draft doğar, depo kurulur, indekslenir
    const row = project(NEW_P, body.name, "yeni", INDEXING ? "draft" : "ready");
    projects = [...projects, row];
    return json(route, row);
  }
  // tek proje okuması — indeksleme ilerlemesi buradan görünür
  if (INDEXING && method === "GET" && p.endsWith(`/projects/${NEW_P}`)) {
    const seq = ["repository_setup", "indexing", "indexing", "ready"];
    newProjectStatus = seq[Math.min(newProjectGets, seq.length - 1)];
    newProjectGets += 1;
    projects = projects.map((r) => (r.id === NEW_P ? { ...r, status: newProjectStatus } : r));
    return json(route, project(NEW_P, "Kurumsal Web Sitesi", "yeni", newProjectStatus));
  }
  if (method === "POST" && p.endsWith("/goal")) {
    // READY'den önce hedef → sunucu 409 (projects/routes.ts GOAL_ACCEPTING)
    if ((INDEXING && newProjectStatus !== "ready") || (GOAL_409_ONCE && earlyGoal === 0)) {
      earlyGoal += 1;
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://acos.dev/errors/conflict",
          title: "conflict",
          status: 409,
          code: "conflict",
          detail: "proje henüz indekslenmedi — READY olunca hedef verilir",
        }),
      });
    }
    // hedef = CEO'nun öneri adımını tetikler (W4)
    if (ENDPOINTS) {
      proposal =
        STATE_MODE === "draft" || STATE_MODE === "draft-hold"
          ? draftRow()
          : STATE_MODE === "cancelled"
            ? { ...mkProposal(), status: "cancelled", teams: [], rationaleMd: "" }
            : mkProposal();
    }
    return json(route, { started: true, state: "planning" });
  }
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
      {
        id: CID,
        name: "Webicrea",
        slug: "webicrea",
        currency: "TRY",
        status: "active",
        role: "founder",
        createdAt: new Date(0).toISOString(),
      },
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

const mode = ENDPOINTS ? "sözleşme uçları VAR" : "uçlar YOK (yedek yol)";
await page.goto(`http://localhost:5199/c/${CID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// --- W7 ---
check(`[${mode}] üst-orta proje çubuğu`, await page.getByTestId("project-bar").isVisible());
const options = await page.locator('select[aria-label="Proje"] option').allTextContents();
check(
  "seçicide 'Tüm şirket' + projeler",
  options[0] === "Tüm şirket" && options.includes("Vitrin Sitesi") && options.includes("Mobil Uygulama"),
  options.join("|"),
);
await page.screenshot({ path: `${SHOTS}/w7-01-all.png` });

await page.selectOption('select[aria-label="Proje"]', P1);
await page.waitForTimeout(700);
let chips = (await page.getByTestId("team-chips").textContent()) ?? "";
check("proje seçilince yalnız o projenin takımı", chips.includes("Backend") && !chips.includes("Tasarım"), chips.trim());
if (ENDPOINTS) {
  check(
    "kalıcı bağ (source=link) rozetsiz",
    (await page.getByTestId("project-teams-derived").count()) === 0,
  );
  check("takım sayısı uçtan geldi (agentCount=3)", chips.includes("3"), chips.trim());
}
await page.screenshot({ path: `${SHOTS}/w7-02-project1.png` });

await page.selectOption('select[aria-label="Proje"]', P2);
await page.waitForTimeout(700);
chips = (await page.getByTestId("team-chips").textContent()) ?? "";
check("proje değişince takımlar da değişti", chips.includes("Tasarım") && !chips.includes("Backend"), chips.trim());
if (ENDPOINTS) {
  check(
    "kalıcı bağı olmayan proje 'türetilmiş' rozeti alıyor",
    await page.getByTestId("project-teams-derived").isVisible(),
  );
}

// --- W8 ---
check(
  "ofis paneli canlı (odak kümesi seçili projeye bağlı)",
  (await page.locator('[data-testid="office-canvas"]').count()) > 0,
);

// --- W6 ---
await page.getByTestId("project-create-open").click();
await page.getByTestId("project-wizard").waitFor({ timeout: 10_000 });
await page.fill('input[name="projectName"]', "Kurumsal Web Sitesi");
await page.fill(
  'textarea[name="projectRequirements"]',
  "React ile vitrin sitesi, iletişim formu, ödeme entegrasyonu ve SEO içerikleri.",
);
await page.screenshot({ path: `${SHOTS}/w6-01-brief.png` });
await page.getByTestId("project-wizard-next").click();
if (INDEXING) {
  await page.getByTestId("project-wizard-indexing").waitFor({ timeout: 15_000 });
  check(
    "yeni proje READY olmadan hedef VERİLMİYOR — indeksleme ekranı çıktı",
    ((await page.getByTestId("project-wizard-index-status").textContent()) ?? "").length > 0,
    (await page.getByTestId("project-wizard-index-status").textContent()) ?? "",
  );
  check(
    "indeksleme sırasında /goal'a hiç POST atılmadı",
    !posts.some((c) => c.includes(`/projects/${NEW_P}/goal`)),
  );
}
if (!ENDPOINTS) {
  // uç yokken CEO adımı hiç gelmez: kullanıcı beklemeyi kesip taslakla devam eder
  await page.getByTestId("proposal-skip-wait").click({ timeout: 20_000 });
}
if (STATE_MODE === "draft") {
  await page.getByTestId("project-wizard-thinking").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2600); // ilk 'draft' turu geçsin
  const jumped = await page
    .getByTestId("proposal-teams")
    .isVisible()
    .catch(() => false);
  check(
    "'draft' = CEO çalışıyor sayıldı — BOŞ listeyle düzenleme ekranına atlamadı",
    !jumped && (await page.getByTestId("project-wizard-thinking").isVisible()),
  );
  await page.screenshot({ path: `${SHOTS}/w6-01b-draft-bekliyor.png` });
}
if (STATE_MODE === "draft-hold") {
  await page.getByTestId("proposal-skip-wait").click({ timeout: 20_000 });
  // sunucu taslağı henüz BOŞ (CEO bitirmedi) — liste elemanı yok, o yüzden
  // düzenleme ekranının açıldığını sunucu-taslak notundan doğruluyoruz.
  await page.getByTestId("proposal-draft-server-note").waitFor({ timeout: 20_000 });
  check(
    "boş sunucu taslağında 'takım ekle' açık, onay kapalı",
    (await page.getByTestId("proposal-add-team").isVisible()) &&
      (await page.getByTestId("proposal-confirm").isDisabled()),
  );
  check(
    "beklemeyi kesince SUNUCU taslağı düzenleniyor (yerel taslak uydurulmadı)",
    (await page.getByTestId("proposal-draft-server-note").isVisible()) &&
      (await page.getByTestId("proposal-draft-note").count()) === 0,
  );
  await page.fill('input[name="newTeamName"]', "Veri");
  await page.getByTestId("proposal-add-team").click();
  await page.waitForTimeout(700);
  check(
    "düzenleme SUNUCUDAKİ satıra PATCH edildi (aynı id korunuyor)",
    posts.some((c) => c.startsWith("PATCH ") && c.includes(`/staffing-proposals/${PROPOSAL}`)),
    posts.filter((c) => c.startsWith("PATCH")).slice(-1)[0]?.slice(0, 100) ?? "PATCH YOK",
  );
  await page.screenshot({ path: `${SHOTS}/w6-02d-sunucu-taslagi.png` });
  await page.getByTestId("proposal-confirm").click();
  await page.getByTestId("project-wizard-done").waitFor({ timeout: 20_000 });
  check(
    "insan planı onaylandı (POST .../confirm)",
    posts.some((c) => c.includes(`/staffing-proposals/${PROPOSAL}/confirm`)),
  );
  console.log(results.join(String.fromCharCode(10)));
  await browser.close();
  process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
}
if (STATE_MODE === "cancelled") {
  await page.getByTestId("project-wizard-noproposal").waitFor({ timeout: 25_000 });
  check("'cancelled' → sihirbaz temiz bitti (spinner'da asılı kalmadı)", true);
  check(
    "'cancelled' → düzenleme ekranı hiç açılmadı, uydurma taslak yok",
    (await page.getByTestId("proposal-teams").count()) === 0,
  );
  check(
    "'cancelled' hata gibi gösterilmedi",
    (await page.getByTestId("project-wizard-error").count()) === 0,
  );
  await page.screenshot({ path: `${SHOTS}/w6-02c-oneri-yok.png` });
  await page.getByTestId("project-wizard-close").click();
  await page.waitForTimeout(800);
  check(
    "yeni proje yine de seçildi (iş başladı)",
    (await page.inputValue('select[aria-label="Proje"]')) === NEW_P,
  );
  console.log(results.join(String.fromCharCode(10)));
  await browser.close();
  process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
}
await page.getByTestId("proposal-teams").waitFor({ timeout: 40_000 });
const teamsText = (await page.getByTestId("proposal-teams").textContent()) ?? "";
check(
  "sihirbaz: proje açıldı + hedef verildi + kadro önerisi geldi",
  posts.some((c) => c.includes(`POST /api/v1/companies/${CID}/projects `)) &&
    posts.some((c) => c.includes(`/projects/${NEW_P}/goal`)) &&
    teamsText.includes("Frontend") &&
    teamsText.includes("Backend"),
  teamsText.replace(/\s+/g, " ").slice(0, 110),
);
check(
  ENDPOINTS ? "öneri CEO'dan (sunucu) geldi" : "uç yokken taslak öneri ve UYARISI var",
  ENDPOINTS
    ? (await page.getByTestId("proposal-draft-note").count()) === 0
    : await page.getByTestId("proposal-draft-note").isVisible(),
);
if (ENDPOINTS) {
  check(
    "mevcut/yeni ayrımı gösteriliyor (existingCount/hireCount)",
    teamsText.includes("mevcut") && teamsText.includes("yeni"),
  );
}
if (INDEXING) {
  check("READY olunca hedef verildi (409 yenmedi)", earlyGoal === 0, `409 sayısı: ${earlyGoal}`);
  check(
    "indeksleme beklendikten sonra CEO önerisi geldi",
    ((await page.getByTestId("proposal-teams").textContent()) ?? "").includes("Frontend"),
  );
}
if (GOAL_409_ONCE) {
  check("geçici 409 sessizce yeniden denendi (akış kırılmadı)", earlyGoal === 1, `409 sayısı: ${earlyGoal}`);
  check(
    "yeniden denemeden sonra öneri ekranı açıldı",
    ((await page.getByTestId("proposal-teams").textContent()) ?? "").includes("Frontend"),
  );
  check(
    "kullanıcıya hata gösterilmedi",
    (await page.getByTestId("project-wizard-error").count()) === 0,
  );
}
const totalBefore = await page.getByTestId("proposal-total").textContent();
await page.screenshot({ path: `${SHOTS}/w6-02-proposal.png` });

// düzenle: sayı artır, takım ekle
await page.locator('[data-testid^="proposal-inc-"]').first().click();
await page.waitForTimeout(400);
await page.fill('input[name="newTeamName"]', "Veri");
await page.getByTestId("proposal-add-team").click();
await page.waitForTimeout(500);
const totalAfter = await page.getByTestId("proposal-total").textContent();
check("kullanıcı öneriyi DÜZENLEYEBİLDİ", totalBefore !== totalAfter, `${totalBefore} → ${totalAfter}`);
check("takım eklendi", ((await page.getByTestId("proposal-teams").textContent()) ?? "").includes("Veri"));
if (ENDPOINTS) {
  check(
    "düzenleme sözleşmeye göre PATCH edildi (version + TAM liste)",
    posts.some(
      (c) =>
        c.startsWith("PATCH ") &&
        c.includes(`/staffing-proposals/${PROPOSAL}`) &&
        c.includes('"version"') &&
        c.includes('"teams"'),
    ),
    posts.filter((c) => c.startsWith("PATCH")).slice(-1)[0]?.slice(0, 120) ?? "",
  );
  check("PATCH gövdesinde hireCount GÖNDERİLMİYOR (sunucu türetir)", !posts.some((c) => c.startsWith("PATCH ") && c.includes("hireCount")));
}
await page.screenshot({ path: `${SHOTS}/w6-03-adjusted.png` });

await page.getByTestId("proposal-confirm").click();
await page.getByTestId("project-wizard-done").waitFor({ timeout: 20_000 });
if (ENDPOINTS) {
  check(
    "onay duran iş akışını devam ettirdi (POST .../confirm)",
    posts.some((c) => c.includes(`/staffing-proposals/${PROPOSAL}/confirm`)),
  );
}
await page.getByTestId("project-wizard-close").click();
await page.waitForTimeout(800);
check("yeni proje otomatik seçildi", (await page.inputValue('select[aria-label="Proje"]')) === NEW_P);
await page.screenshot({ path: `${SHOTS}/w6-04-done.png` });

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
