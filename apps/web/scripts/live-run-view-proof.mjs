// CANLI KOŞUM İZLEME KANITI (2026-08-21) — 4 ajanlı uçtan-uca koşumun
// Founder-görünür sahnesi. TAMAMEN MOCK API (paylaşılan hiçbir stack'e
// dokunmaz); yalnız görünürlüğü ölçer.
//
// Senaryo, Oscar'ın koşum planındaki dört rolü taklit eder:
//   CEO      — canlı oturum, çalışıyor
//   Lider    — canlı oturum, PARK ETMİŞ (wait_for → WAITING)
//   Dev A    — canlı oturum, çalışıyor
//   Dev B    — OTURUMU YOK: görevi ASSIGNED, canlı oturum tavanı (3) dolu
//
// Ölçtüğü iki soru:
//   1. Tavan dolduğunda dördüncü ajan ekranda DURUYOR mu? (hayalet hücre)
//   2. Park eden ajan ofiste bekleyen gibi mi görünüyor? (⏸ balonu)
//
// Kullanım: vite dev :5199 ayaktayken
//   node apps/web/scripts/live-run-view-proof.mjs <shotDir>
import { chromium } from "@playwright/test";

const SHOTS = process.argv[2] ?? ".";
const CID = "11111111-1111-4111-8111-111111111111";
const U1 = "44444444-4444-4444-8444-444444444444";
const AG = (i) => `aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbb${String(i).padStart(4, "0")}`;
const POS = (i) => `cccccccc-cccc-4ccc-8ccc-dddddddd${String(i).padStart(4, "0")}`;
const SESS = (i) => `eeeeeeee-eeee-4eee-8eee-ffffffff${String(i).padStart(4, "0")}`;
const TASK = (i) => `99999999-9999-4999-8999-99999999900${i}`;

const CREW = [
  ["CEO", "Aylin Vural"],
  ["Takım Lideri", "Emre Kaya"],
  ["Backend Engineer", "Selin Yıldız"],
  ["Frontend Engineer", "Kaan Demir"],
];

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const agents = CREW.map(([title, name], i) => ({
  id: AG(i),
  employeeNumber: i + 1,
  displayNumber: `EMP-${String(i + 1).padStart(3, "0")}`,
  name,
  avatarUrl: null,
  status: "active",
  positionId: POS(i),
  orgUnitId: U1,
  seniority: "expert",
  autonomyLevel: 3,
  persona: title,
  createdAt: new Date(0).toISOString(),
}));

const positions = CREW.map(([title], i) => ({
  id: POS(i),
  title,
  seniorityTrack: ["expert"],
  defaultRole: i === 0 ? "executive" : "worker",
  description: title,
  orgUnitId: U1,
}));

const task = (i, owner, title, status) => ({
  id: TASK(i),
  number: 10 + i,
  displayNumber: `TASK-${10 + i}`,
  kind: "task",
  parentId: null,
  projectId: null,
  title,
  objective: "reklam yuvası + /health",
  priority: "P2",
  status,
  successCriteria: [],
  risk: "low",
  budgetCents: null,
  spentCents: 0,
  deadline: null,
  ownerAgentId: owner,
  creatorAgentId: null,
  orgUnitId: U1,
  delegationDepth: 0,
  reassignmentCount: 0,
  createdAt: new Date(0).toISOString(),
  closedAt: null,
  archivedAt: null,
});

// Üç canlı oturum = tavan (3). Dördüncü ajanın oturumu YOK.
const session = (i, activity) => ({
  id: SESS(i),
  agentId: AG(i),
  taskId: TASK(i),
  workflowId: `wf-${i}`,
  status: "running",
  currentActivity: activity,
  startedAt: new Date(Date.now() - 400_000).toISOString(),
  endedAt: null,
  stepsCount: 6,
  costCents: 12,
  agentName: CREW[i][1],
  taskNumber: 10 + i,
  taskTitle: `iş ${10 + i}`,
});


// Adım akışı: koşumun anlamlı anları. Lider'in SON adımı wait_for — hücrenin
// "⏸ Bekliyor" satırı bu adımdan doğar (uydurma bir metin değil).
const step = (i, no, kind, action, ago) => ({
  agentSessionId: SESS(i),
  stepNo: no,
  actionKind: kind,
  action,
  observation: null,
  tokensIn: 400,
  tokensOut: 120,
  costCents: 2,
  createdAt: new Date(Date.now() - ago).toISOString(),
});
const STEPS = {
  [AG(0)]: [
    step(0, 1, "record_decision", { decision: "Hedefi ikiye böl" }, 300_000),
    step(0, 2, "create_task", { title: "Landing sayfası iskeleti" }, 240_000),
    step(0, 3, "delegate_task", { toAgentId: AG(3) }, 180_000),
  ],
  [AG(1)]: [
    step(1, 1, "use_tool", { tool: "Read" }, 260_000),
    step(1, 2, "request_help", { audience: "manager", topic: "reklam yuvası ölçüleri" }, 200_000),
    step(1, 3, "wait_for", { what: "reply" }, 150_000),
  ],
  [AG(2)]: [
    step(2, 1, "use_tool", { tool: "Bash" }, 120_000),
    step(2, 2, "use_tool", { tool: "Edit" }, 40_000),
  ],
};

const TASKS = [
  task(0, AG(0), "Hedefi kır ve delege et", "IN_PROGRESS"),
  task(1, AG(1), "Reklam yuvası tasarımı", "WAITING"),
  task(2, AG(2), "/health ucu", "IN_PROGRESS"),
  // Dev B: görev sahibinde ama oturumu açılmadı — tavan dolu
  task(3, AG(3), "Landing sayfası iskeleti", "ASSIGNED"),
];
const SESSIONS = [session(0, "WORKING"), session(1, "WAITING"), session(2, "WORKING")];

// Ofis: aynı dört ajan; Lider PARK ETMİŞ (WAITING), Dev B henüz boşta.
const PRESENCE = {
  layoutVersion: 1,
  snapshotEpoch: 1,
  agents: agents.map((a, i) => ({
    agentId: a.id,
    name: a.name,
    cell: { x: 4 + i * 2, y: 4 },
    badge: ["WORKING", "WAITING", "WORKING", "IDLE"][i],
    deskId: `desk-${i}`,
    sessionId: null,
  })),
  interactions: [],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.routeWebSocket("**/ws", (ws) => {
  ws.onMessage((raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.op === "subscribe") {
      for (const topic of frame.topics ?? []) {
        ws.send(JSON.stringify({ op: "sub_ok", topic, mode: "live" }));
        if (String(topic).startsWith("presence:")) {
          ws.send(JSON.stringify({ op: "snapshot", topic, seq: 1, state: PRESENCE }));
        }
      }
    }
  });
  ws.send(
    JSON.stringify({ op: "hello", connectionId: "c_run", heartbeatSec: 20, maxTopics: 32, version: 1 }),
  );
});

await page.route("**/api/v1/**", async (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p.endsWith("/auth/me"))
    return json(route, {
      id: "11111111-1111-4111-8111-1111111111ff",
      email: "founder@acos.local",
      displayName: "Founder",
      platformRole: "owner",
      totpEnabled: false,
    });
  if (p.endsWith("/steps")) {
    const agentId = p.split("/agents/")[1]?.split("/")[0] ?? "";
    return json(route, [...(STEPS[agentId] ?? [])].reverse());
  }
  if (p.endsWith("/agent-sessions")) return json(route, SESSIONS);
  if (p.endsWith("/terminals")) return json(route, { items: [] });
  if (p.endsWith("/tasks")) return json(route, TASKS);
  if (p.endsWith("/agents")) return json(route, agents);
  if (p.endsWith("/org/positions")) return json(route, positions);
  if (p.endsWith("/tasks/top-executive"))
    return json(route, { agentId: AG(0), name: "Aylin Vural", positionTitle: "CEO" });
  if (p.endsWith("/org/units"))
    return json(route, [{ id: U1, name: "Ürün", slug: "urun", kind: "team", parentId: null }]);
  if (p.endsWith("/org/edges")) return json(route, []);
  if (p.endsWith("/projects")) return json(route, { items: [] });
  if (p.includes("/approvals")) return json(route, []);
  if (p.includes("/costs") || p.includes("/reports")) return json(route, { items: [] });
  return json(route, {});
});

const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} — ${name}${extra ? ` (${extra})` : ""}`);

// --- 1) Komuta merkezi: 3 canlı hücre + 1 hayalet hücre -------------------
await page.goto(`http://localhost:5199/c/${CID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const liveCells = await page.getByTestId("session-feed").count();
check("üç canlı oturum hücresi", liveCells === 3, `hücre: ${liveCells}`);

const queued = page.getByTestId("pending-cell-queued");
check("tavan dolu → dördüncü ajan HAYALET HÜCRE olarak ekranda", (await queued.count()) === 1);
const queuedText = (await queued.count()) ? ((await queued.first().textContent()) ?? "") : "";
check(
  "hayalet hücre kimi/neyi beklediğini yazıyor",
  queuedText.includes("Kaan Demir") && queuedText.includes("TASK-13") && queuedText.includes("sırada"),
  queuedText.replace(/\s+/g, " ").trim().slice(0, 90),
);
check(
  "başlıkta sıradaki sayacı",
  ((await page.getByTestId("pending-count").textContent()) ?? "").includes("1 sırada"),
);
const parkedCell = await page.getByTestId("pending-cell-parked").count();
check("canlı oturumu OLAN park ajanı hayalet listeye düşmez", parkedCell === 0, `parked: ${parkedCell}`);

// park eden ajanın canlı hücresi bekleyişi yazıyor mu (mevcut davranış)
const cursors = await page.getByTestId("session-live-cursor").allTextContents();
check(
  "park eden ajanın hücresi NE beklediğini yazıyor (wait_for adımından)",
  cursors.some((t) => t.includes("⏸ Bekliyor: reply")),
  cursors.join(" | ").slice(0, 150),
);
const feeds = await page.getByTestId("session-feed").allTextContents();
check(
  "delege etme anı akışta görünüyor",
  feeds.some((t) => t.includes("delegate_task") || t.includes("Devret") || t.includes("delege")),
  feeds.join(" | ").slice(0, 120),
);
check(
  "yardım isteme + bekleme anları akışta görünüyor",
  feeds.some((t) => t.includes("yardım istedi")) && feeds.some((t) => t.includes("bekliyor")),
  feeds.join(" | ").slice(0, 140),
);

await page.screenshot({ path: `${SHOTS}/live-run-komuta.png` });

// --- 2) Ofis: park eden ajanın kum saati ---------------------------------
await page.goto(`http://localhost:5199/c/${CID}/office-window`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 20_000 });
await page.waitForTimeout(4000);
const office = await page.evaluate(() => ({
  agents: window.__acosOffice?.agentCount ?? 0,
  seats: window.__acosOffice?.floorSeats ?? 0,
}));
check("dört ajan katta", office.agents === 4 && office.seats === 4, JSON.stringify(office));
await page.screenshot({ path: `${SHOTS}/live-run-ofis.png` });

check("yakalanmamış sayfa hatası yok", pageErrors.length === 0, pageErrors.join("; "));

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
