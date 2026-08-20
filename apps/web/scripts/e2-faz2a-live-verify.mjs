// E2 FAZ 2A — CANLI (MOCK-FREE) mimari çekirdek doğrulaması.
//
// Dwight'ın e2-w7-smoke.mjs betiği TAMAMEN mock'tur (route.fulfill); bu betik
// onun canlı ikizidir: gerçek stack, gerçek Postgres, gerçek CEO LLM çağrısı.
// Akış tek bir insan yolunu izler — şirket kur → CEO doğsun → proje sihirbazı
// → CEO kadroyu ÖNERSİN → insan düzenlesin → onayla → applyPlan takımları
// kursun ve ajanlar ÇALIŞMAYA başlasın → proje değiştir.
//
//   node apps/web/scripts/e2-faz2a-live-verify.mjs <webUrl> <serverUrl> <shotDir>
import { chromium } from "@playwright/test";

const WEB = process.argv[2] ?? "http://localhost:15873";
const API = process.argv[3] ?? "http://localhost:13700";
const SHOTS = process.argv[4] ?? ".";
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const results = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  const line = `${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`;
  results.push(line);
  console.log(line);
};
const step = (title) => console.log(`\n== ${title}`);

/** Sunucu tarafı gerçeği: UI ne gösterirse göstersin veritabanı ne diyor. */
const api = (page) => ({
  get: async (path) => {
    const response = await page.request.get(`${API}${path}`);
    const text = await response.text();
    return { status: response.status(), body: text ? JSON.parse(text) : null };
  },
  post: async (path, data) => {
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === "acos_csrf")?.value ?? "";
    const response = await page.request.post(`${API}${path}`, {
      data,
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    });
    const text = await response.text();
    return { status: response.status(), body: text ? JSON.parse(text) : null };
  },
});

const until = async (probe, timeoutMs, everyMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const db = api(page);

// ---------------------------------------------------------------- 1. şirket
step("1) şirket kurulumu — modal + Founder-CEO bootstrap");
await page.goto(`${WEB}/`, { waitUntil: "domcontentloaded" });
await page.getByTestId("company-list").waitFor({ timeout: 60_000 });
await page.getByTestId("company-create-open").first().click();
await page.getByTestId("create-company-modal").waitFor({ timeout: 15_000 });
check("şirket kurma modalı açıldı", true);

const companyName = `E2 Canli ${STAMP}`;
await page.getByTestId("company-name").fill(companyName);
await page.getByTestId("company-create-submit").click();
await page.getByTestId("company-created").waitFor({ timeout: 120_000 });
// DİKKAT: company-ceo-name FORMDAKİ girdi alanı; başarı metni değil. CEO'nun
// doğduğunu söyleyen cümle company-created kutusunda.
const createdText = ((await page.getByTestId("company-created").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const ceoName = (/([A-ZÇĞİÖŞÜ][\wçğıöşü]+ [A-ZÇĞİÖŞÜ][\wçğıöşü]+) CEO/.exec(createdText) ?? [])[1] ?? "";
check("şirket kuruldu ve CEO doğdu (UI)", /CEO/.test(createdText), createdText.slice(0, 80));
await page.screenshot({ path: `${SHOTS}/e2live-01-company.png` });

const companies = await db.get("/api/v1/companies");
const companyRow = (Array.isArray(companies.body) ? companies.body : (companies.body?.items ?? [])).find(
  (c) => c.name === companyName,
);
check("şirket API'de görünüyor", Boolean(companyRow), companyRow?.id ?? "yok");
const CID = companyRow?.id;

const agentsAfterCreate = await db.get(`/api/v1/companies/${CID}/agents`);
const agentList = (body) => (Array.isArray(body) ? body : (body?.items ?? []));
const ceoAgent =
  agentList(agentsAfterCreate.body).find((a) => a.name && ceoName.includes(a.name)) ??
  agentList(agentsAfterCreate.body).find((a) => /ceo|executive/i.test(`${a.role ?? ""} ${a.name ?? ""}`)) ??
  agentList(agentsAfterCreate.body)[0];
check("CEO ajanı veritabanında (bootstrap gerçek)", Boolean(ceoAgent), ceoAgent ? `${ceoAgent.name} / ${ceoAgent.role}` : "yok");

await page.getByTestId("company-created-open").click();
await page.getByTestId("me-name").waitFor({ timeout: 60_000 });
// Düğme `disabled={!executive}` — CEO sorgusu ÇÖZÜLENE kadar pasif. Anlık
// okumak yanlış kırmızı verir; etkinleşmesini bekle.
const founderEnabled = await until(async () => (await page.getByTestId("me-name").isEnabled()) || null, 30_000, 1000);
check("Founder düğmesi etkin (CEO'ya görev verilebilir)", Boolean(founderEnabled));

// ------------------------------------------------------------ 2. proje şeridi
step("2) projeler-birincil kabuk");
await page.getByTestId("project-bar").waitFor({ timeout: 30_000 });
check("üst-orta PROJE şeridi görünür", await page.getByTestId("project-bar").isVisible());
check("proje seçici görünür", await page.getByTestId("project-switcher").isVisible());
check("yeni proje düğmesi görünür", await page.getByTestId("project-create-open").isVisible());
await page.screenshot({ path: `${SHOTS}/e2live-02-shell.png` });

// ------------------------------------------------------------- 3. sihirbaz
step("3) proje sihirbazı — CEO kadroyu öneriyor (canlı LLM)");
await page.getByTestId("project-create-open").click();
await page.getByTestId("project-wizard").waitFor({ timeout: 15_000 });
const projectName = `Saglik Servisi ${STAMP}`;
await page.getByTestId("project-name").fill(projectName);
await page.getByTestId("project-requirements").fill(
  "Node.js tabanli bir HTTP servisi kur: /health ucu JSON dondursun, birim testi olsun, " +
    "basit bir React arayuzu durumu gostersin. Backend ve frontend isleri paralel yurusun.",
);
const proposalStarted = Date.now();
await page.getByTestId("project-wizard-next").click();
await page.getByTestId("project-wizard-thinking").waitFor({ timeout: 15_000 }).catch(() => {});
// eeaf24e sonrası sihirbazın üç çıkışı var: öneri listesi, 'öneri yok'
// ekranı (cancelled/applied — hata değil) ya da 60 sn sonra yerel taslak.
// Üçünü de bekle, hangisinin geldiğini RAPORLA — tek birine kilitlenip
// zaman aşımına düşmek yanlış kırmızı verir.
await Promise.race([
  page.getByTestId("proposal-teams").waitFor({ timeout: 420_000 }),
  page.getByTestId("project-wizard-noproposal").waitFor({ timeout: 420_000 }),
  page.getByTestId("project-wizard-error").waitFor({ timeout: 420_000 }),
]).catch(() => {});
const wizardError = ((await page.getByTestId("project-wizard-error").textContent().catch(() => "")) ?? "").trim();
if (wizardError) check("sihirbaz hata gösterdi (KIRIK)", false, wizardError.slice(0, 120));
const proposalSeconds = ((Date.now() - proposalStarted) / 1000).toFixed(1);
const noProposalScreen = (await page.getByTestId("project-wizard-noproposal").count()) > 0;
const proposalShown = (await page.getByTestId("proposal-teams").count()) > 0;
check("sihirbaz bir sonuca ulaştı (öneri ya da 'öneri yok')", proposalShown || noProposalScreen, `${proposalSeconds}s`);
const localDraft = (await page.getByTestId("proposal-draft-note").count()) > 0;
if (noProposalScreen) {
  check("sihirbaz 'öneri yok' ekranıyla temiz kapandı (cancelled/applied — hata değil)", true, `${proposalSeconds}s`);
} else if (proposalShown) {
  check(
    "öneri SUNUCUDAN geldi (yerel taslağa düşmedi)",
    !localDraft,
    localDraft ? `yerel taslak — FE 60s yoklama penceresi canlı LLM için kısa (${proposalSeconds}s)` : `kalıcı CEO önerisi (${proposalSeconds}s)`,
  );
}
await page.screenshot({ path: `${SHOTS}/e2live-03-proposal.png` });

const projects = await db.get(`/api/v1/companies/${CID}/projects`);
const projectRow = agentList(projects.body).find((p) => p.name === projectName);
const PID = projectRow?.id;
check("proje veritabanında", Boolean(PID), PID ?? "yok");

// Oscar'ın d2ef2d9 sonrası durum sözlüğü (T21 uyarısı): 404 = GERÇEK kırık,
// 'draft' + boş teams = CEO çalışıyor (beklenen), 'awaiting_human' = öneri
// hazır, 'cancelled' = önerilecek bir şey yok ve planlama determinist yoldan
// devam etti — bu bir HATA DEĞİL, kırık sayılmamalı.
const firstRead = await db.get(`/api/v1/companies/${CID}/projects/${PID}/staffing-proposal`);
check(
  "staffing-proposal ucu canlı (404 değil)",
  firstRead.status !== 404,
  `HTTP ${firstRead.status} status=${firstRead.body?.status ?? "-"}`,
);
const settled = await until(async () => {
  const row = (await db.get(`/api/v1/companies/${CID}/projects/${PID}/staffing-proposal`)).body;
  return row && ["awaiting_human", "cancelled", "confirmed", "applied"].includes(row.status) ? row : null;
}, 420_000, 3000);
const proposal = settled ?? firstRead.body;
if (proposal?.status === "cancelled") {
  check(
    "öneri 'cancelled' — CEO önerecek bir şey bulmadı, planlama determinist yoldan sürdü (kırık DEĞİL)",
    true,
    "Oscar'ın d2ef2d9 durum sözlüğü",
  );
} else {
  check(
    "staffing_proposals satırı awaiting_human",
    proposal?.status === "awaiting_human",
    `status=${proposal?.status} source=${proposal?.source} v=${proposal?.version}`,
  );
  check("öneri LLM kaynaklı", proposal?.source === "llm", `source=${proposal?.source}`);
  check(
    "planlama iş akışı DURDU — henüz takım kurulmadı",
    proposal?.status === "awaiting_human" && (proposal?.teams?.length ?? 0) > 0,
    `${proposal?.teams?.length ?? 0} takım önerildi: ${(proposal?.teams ?? []).map((t) => `${t.teamName}x${t.headcount}`).join(", ")}`,
  );
}

// ------------------------------------------------------------- 4. düzenleme
step("4) insan düzenlemesi — takım ekle + kadro sayısı değiştir");
const teamCountBefore = proposal?.teams?.length ?? 0;
const versionBefore = proposal?.version ?? 0;
if (noProposalScreen) {
  // Düzenle/onayla iddiası bu yolda KANITLANAMAZ (ortada öneri yok). Sessizce
  // 'geçti' demek yerine burada durur ve eksik kaldığını açıkça söyleriz.
  console.log(`\n=== E2 FAZ 2A CANLI SONUÇ (EKSİK — 'öneri yok' yolu) ===`);
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed}/${results.length} geçti · düzenle/onayla/applyPlan adımları KANITLANMADI`);
  console.log(`web ${WEB} · api ${API} · şirket ${CID} · proje ${PID}`);
  await browser.close();
  process.exit(2);
}
// Kadro sayısı bir number input DEĞİL: her satırda -/+ düğmeleri
// (proposal-inc-<key> / proposal-dec-<key>) ve bir çıkar düğmesi
// (proposal-remove-<key>) var. Üç düzenlemeyi de yaparız çünkü T25'in
// iddiası tam olarak bu üçlü: sayıyı ARTIR, takım EKLE, takım ÇIKAR.
const keys = (proposal?.teams ?? []).map((t) => t.key);
if (keys.length === 0) {
  // 3. adım kırıldıysa burada UI'ya vurmak `proposal-inc-undefined` gibi
  // anlamsız bir zaman aşımıyla patlar ve gerçek nedeni gömer. Temiz dur.
  console.log(`\n=== E2 FAZ 2A CANLI SONUC (EKSIK — oneri ekrani acilmadi) ===`);
  console.log(results.join("\n"));
  console.log(`\n${results.length - failed}/${results.length} gecti · duzenle/onayla/applyPlan KANITLANMADI`);
  console.log(`web ${WEB} · api ${API} · sirket ${CID} · proje ${PID}`);
  await browser.close();
  process.exit(2);
}
const bumpKey = keys[0];
const dropKey = keys[keys.length - 1];
await page.getByTestId(`proposal-inc-${bumpKey}`).click();
await page.waitForTimeout(1200);
await page.getByTestId(`proposal-remove-${dropKey}`).click();
await page.waitForTimeout(1200);
await page.getByTestId("proposal-new-team").fill("Dokumantasyon");
await page.getByTestId("proposal-add-team").click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/e2live-04-edited.png` });

const proposalAfterEdit = (await db.get(`/api/v1/companies/${CID}/projects/${PID}/staffing-proposal`)).body;
const editedNames = (proposalAfterEdit?.teams ?? []).map((t) => t.teamName);
check(
  "PATCH kalıcı — sayı arttı, takım eklendi, takım çıkarıldı",
  (proposalAfterEdit?.teams ?? []).some((t) => /dokumantasyon/i.test(t.teamName)) &&
    !(proposalAfterEdit?.teams ?? []).some((t) => t.key === dropKey),
  `çıkarılan=${dropKey} · kalan: ${editedNames.join(", ")}`,
);
check(
  "iyimser sürüm arttı",
  (proposalAfterEdit?.version ?? 0) > versionBefore,
  `v${versionBefore} -> v${proposalAfterEdit?.version}`,
);
const expectedTeams = (proposalAfterEdit?.teams ?? []).filter((t) => t.headcount > 0);
check(
  "hireCount sunucuda türetildi",
  expectedTeams.every((t) => t.hireCount === Math.max(0, t.headcount - t.existingCount)),
  expectedTeams.map((t) => `${t.teamName}:${t.existingCount}->${t.headcount}`).join(", "),
);

// ----------------------------------------------------------------- 5. onay
step("5) onay — applyPlan takımları + ajanları kuruyor");
const agentsBeforeConfirm = agentList((await db.get(`/api/v1/companies/${CID}/agents`)).body).length;
await page.getByTestId("proposal-confirm").click();
await page.getByTestId("project-wizard-done").waitFor({ timeout: 180_000 });
check("sihirbaz 'tamam' adımına ulaştı", true);
await page.screenshot({ path: `${SHOTS}/e2live-05-done.png` });

const applied = await until(async () => {
  const fresh = (await db.get(`/api/v1/companies/${CID}/projects/${PID}/staffing-proposal`)).body;
  return fresh?.status === "applied" ? fresh : null;
}, 240_000, 3000);
check("öneri durumu applied", Boolean(applied), applied ? `v${applied.version}` : "applied olmadı");

const projectTeams = await db.get(`/api/v1/companies/${CID}/project-teams`);
const group = (projectTeams.body?.groups ?? []).find((g) => g.projectId === PID);
check("GET /project-teams projeyi tanıyor", Boolean(group), group ? `${group.teams.length} takım` : "grup yok");
check(
  "takımlar projeye BAĞLI (source=link → project_team_memberships)",
  group?.source === "link",
  `source=${group?.source}`,
);
const wantedNames = expectedTeams.map((t) => t.teamName.toLowerCase());
const gotNames = (group?.teams ?? []).map((t) => t.name.toLowerCase());
check(
  "kurulan takımlar önerilenlerle örtüşüyor",
  wantedNames.every((w) => gotNames.some((g) => g.includes(w.split(" ")[0]))),
  `istenen: ${wantedNames.join(", ")} | kurulan: ${gotNames.join(", ")}`,
);
// T25'in ASIL iddiası: insanın onayladığı plan kadronun TEMELİDİR — çıkarılan
// takım ikinci bir Founder onayı olarak GERİ GELMEMELİ.
const approvals = agentList((await db.get(`/api/v1/companies/${CID}/approvals`)).body);
const pendingHire = approvals.filter((a) => a.kind === "hire" && a.status === "pending");
check(
  "çıkarılan takım için İKİNCİ kadro onayı YOK (T25)",
  pendingHire.length === 0,
  pendingHire.length === 0
    ? "bekleyen kadro onayı yok"
    : pendingHire.map((a) => a.brief?.request ?? a.title).join(" | ").slice(0, 160),
);
const agentsAfterConfirm = agentList((await db.get(`/api/v1/companies/${CID}/agents`)).body);
const wantedHires = expectedTeams.reduce((sum, t) => sum + t.hireCount, 0);
check(
  "ajanlar işe alındı",
  agentsAfterConfirm.length >= agentsBeforeConfirm + wantedHires,
  `${agentsBeforeConfirm} -> ${agentsAfterConfirm.length} (beklenen +${wantedHires})`,
);

// ------------------------------------------------------------- 6. çalışma
step("6) ajanlar ÇALIŞMAYA başlıyor (canlı döngü)");
const working = await until(async () => {
  const tasks = agentList((await db.get(`/api/v1/companies/${CID}/tasks`)).body);
  const active = tasks.filter((t) => ["IN_PROGRESS", "ASSIGNED", "REVIEW"].includes(t.status));
  return active.length > 0 ? active : null;
}, 300_000, 5000);
check(
  "görevler ajanlara dağıldı ve ilerliyor",
  Boolean(working),
  working ? working.map((t) => `TASK-${t.number}:${t.status}`).join(" ") : "hiç aktif görev yok",
);
const sessions = await until(async () => {
  const rows = agentList((await db.get(`/api/v1/companies/${CID}/agent-sessions`)).body);
  return rows.length > 0 ? rows : null;
}, 300_000, 5000);
check(
  "canlı ajan oturumu açıldı",
  Boolean(sessions),
  sessions ? sessions.map((s) => s.status).join(",") : "oturum yok",
);
await page.screenshot({ path: `${SHOTS}/e2live-06-working.png` });

// -------------------------------------------------------- 7. proje değiştir
step("7) proje değiştir — takımlar ve ofis odağı yeniden hedefleniyor");
const second = await db.post(`/api/v1/companies/${CID}/projects`, {
  name: `Ikinci Proje ${STAMP}`,
  objective: "Odak degisimini kanitlamak icin ikinci proje.",
});
check("ikinci proje oluştu", second.status < 400, `HTTP ${second.status}`);
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByTestId("project-bar").waitFor({ timeout: 30_000 });
const chipsBefore = ((await page.getByTestId("team-chips").textContent().catch(() => "")) ?? "").trim();
const selector = page.getByTestId("project-switcher").locator("select");
const options = await selector.locator("option").allTextContents();
check("seçicide iki proje var", options.length >= 2, options.join(" | ").slice(0, 120));
await selector.selectOption({ index: Math.max(0, options.findIndex((o) => o.includes("Ikinci"))) });
await page.waitForTimeout(3000);
const chipsAfter = ((await page.getByTestId("team-chips").textContent().catch(() => "")) ?? "").trim();
check(
  "takım şeridi projeye göre yeniden hedeflendi",
  chipsBefore !== chipsAfter,
  `${chipsBefore.slice(0, 40)} -> ${chipsAfter.slice(0, 40)}`,
);
await page.screenshot({ path: `${SHOTS}/e2live-07-switched.png` });

console.log(`\n=== E2 FAZ 2A CANLI SONUÇ ===`);
console.log(results.join("\n"));
console.log(`\n${results.length - failed}/${results.length} geçti · şirket ${CID} · proje ${PID}`);
console.log(`web ${WEB} · api ${API}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
