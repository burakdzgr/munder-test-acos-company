// A4 (AGENT-BRIEF.md §4 Faz A) — devre kesicinin UÇTAN UCA kanıtı.
//
// Neden bu test var: B1 (LLM maliyeti hep 0) tip sistemine görünmeyen bir
// WIRING kusuruydu; geri geldiğinde hiçbir birim testi kırılmazdı. Buradaki
// zincirin her halkası GERÇEK — gerçek Postgres, gerçek Temporal worker'ı,
// gerçek `agentTaskWorkflow`, gerçek aktiviteler, gerçek `ModelRouter`
// fiyatlama matematiği. Sahte olan tek şey sağlayıcı transport'u: adapter
// çağrı başına 100k girdi token'ı bildirir ve `model_providers.pricing`
// (26 §3.1 şekli) bunu 40¢'e fiyatlar.
//
// Kanıtlanan zincir (26 §2, §5; 08 §9a):
//   callModelActivity → llm_calls (cost_cents > 0)
//   → persistStepActivity → CostService.recordCostInTx (AYNI tx, 26 §2)
//   → cost_entries + tasks.spent_cents artışı
//   → şirket günlük HARD bütçesi aşıldı → budget.exceeded + tripBreaker
//   → non-critical ajanlar `paused`, employment.paused_by_breaker = "true"
//     (executive/lead track ve REVIEW/QA/APPROVAL sahibi ajanlar ayakta, 26 §5)
//   → görev bütçesi tükendi → workflow guard (a) adımı BAŞLATMADAN durdurdu
//     → agent.guard.triggered{guard:"budget"} + görev WAITING + guard_stopped
//   → CostService.restoreBudget → budget.restored + agent.resumed,
//     paused_by_breaker temizlendi, ajanlar `active`.
//
// Kapsam notu (raporlanan sapma): doküman 26 §5 devre kesiciyi "policy engine
// consumer" + `managerDirective(pause)` sinyali olarak tarif ediyor; kodda
// duraklatma CostService.tripBreaker içinde SENKRON ve yalnız DB seviyesinde.
// Test kodda gerçekte var olanı doğrular; sinyal yarısı raporda açık bırakıldı.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  CostService,
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  budgets,
  companies,
  costEntries,
  events,
  llmCalls,
  modelProviders,
  orgEdges,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { ModelRouter, type ProviderAdapter } from "@acos/llm";
import { TASK_QUEUES } from "@acos/config";
// test-only relative imports across packages (tsc yalnız src'yi derler; runtime
// bağımlılık matrisi harness'ları değil üretim kodunu bağlar — review-flow
// int testi de aynı kalıbı kullanıyor)
import { createAgentTaskActivities } from "../../../../workers/agent-worker/src/activities/agent-task.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../../../workers/agent-worker/src/workflows/index.ts");

let dockerUp = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

// ---- fiyatlama aritmetiği (gerçek computeCostCents üzerinden) ----
// 100_000 girdi token × 400¢/Mtok = 40¢ / çağrı.
const TOKENS_PER_CALL = 100_000;
const INPUT_PER_MTOK_CENTS = 400;
const CENTS_PER_STEP = 40;
// Görev bütçesi 200¢ ⇒ guard (a) beklenen kesme noktası:
//   adım 1: kalan 200, tahmin 0   → geç  (harcanan 40)
//   adım 2: kalan 160, tahmin 60  → geç  (harcanan 80)
//   adım 3: kalan 120, tahmin 60  → geç  (harcanan 120 — ŞİRKET bütçesi aşıldı)
//   adım 4: kalan  80, tahmin 60  → geç  (harcanan 160)
//   adım 5: kalan  40, tahmin 60  → 40 ≤ 60 ⇒ DUR
const TASK_BUDGET_CENTS = 200;
const COMPANY_DAILY_CENTS = 100; // "küçük bir günlük bütçe"
/** Ücreti ödenen (kalıcılaşan) adım sayısı. */
const EXPECTED_STEPS = 4;
/** `stepNo` guard kontrolünden ÖNCE artar → durduran 5. tur workflow'a sayılır. */
const EXPECTED_STEP_NO = EXPECTED_STEPS + 1;

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let costs: CostService;
let nativeConnection: NativeConnection;
let clientConnection: Connection;
let client: Client;
let worker: Worker;
let workerRun: Promise<void>;

let companyId = "";
let taskId = "";
let modelCalls = 0;
const agentId: Record<string, string> = {};

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.companyId, companyId), eq(events.type, type)))
    .orderBy(events.seq);
}

async function agentRow(id: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, id)));
  return row!;
}

async function taskRow() {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)));
  return row!;
}

beforeAll(async () => {
  if (!dockerUp) return;
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown yarışı: container dururken idle client FATAL
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  costs = new CostService(guardedDb);

  // ---- seed: bir şirket, dört ajan (biri executive, biri REVIEW sahibi) ----
  const [founder] = await db
    .insert(users)
    .values({ email: "founder@a4.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "BreakerCo", slug: "breakerco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);

  const [eng] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Engineering", slug: "eng" })
    .returning();

  const positionId: Record<string, string> = {};
  for (const [title, track, role] of [
    ["CEO", ["executive"], "executive"],
    ["Backend Engineer", ["junior", "mid"], "member"],
    ["QA Reviewer", ["mid"], "reviewer"],
  ] as const) {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title, seniorityTrack: [...track], defaultRole: role })
      .returning();
    positionId[title] = position!.id;
  }

  const hire = async (name: string, employeeNumber: number, title: string) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber,
          name,
          status: "active",
          positionId: positionId[title]!,
          orgUnitId: eng!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: `${name}.`,
        })
        .returning()
    )[0]!.id;

  agentId.CEO = await hire("Cem CEO", 1, "CEO"); // executive track → kritik
  agentId.SPENDER = await hire("Sena Spender", 2, "Backend Engineer"); // pahalı görevin sahibi
  agentId.PEER = await hire("Pelin Peer", 3, "Backend Engineer"); // boşta, kritik değil
  agentId.GOVERNOR = await hire("Gökhan Governor", 4, "QA Reviewer"); // REVIEW sahibi → kritik
  await db.insert(orgEdges).values([
    { companyId, fromAgentId: agentId.SPENDER!, kind: "reports_to", toAgentId: agentId.CEO! },
    { companyId, fromAgentId: agentId.PEER!, kind: "reports_to", toAgentId: agentId.CEO! },
    { companyId, fromAgentId: agentId.GOVERNOR!, kind: "reports_to", toAgentId: agentId.CEO! },
  ]);

  const tasksService = new TasksService(guardedDb);
  const taskState = new TaskStateService(guardedDb);
  const drive = async (id: string, ownerAgentId: string, to: "IN_PROGRESS" | "REVIEW") => {
    await taskState.transition(ctx, id, "BACKLOG", { kind: "founder" });
    await taskState.transition(ctx, id, "PLANNED", { kind: "founder" });
    await taskState.assign(ctx, id, { agentId: ownerAgentId }, { kind: "founder" });
    await taskState.transition(ctx, id, "IN_PROGRESS", { kind: "agent", agentId: ownerAgentId });
    if (to === "REVIEW") {
      await taskState.transition(ctx, id, "REVIEW", { kind: "agent", agentId: ownerAgentId });
    }
  };

  const burner = await tasksService.create(
    ctx,
    {
      kind: "task",
      title: "Pahalı analiz",
      objective: "Bütçeyi yakan sahte iş.",
      budgetCents: TASK_BUDGET_CENTS,
    },
    { kind: "founder" },
  );
  taskId = burner.id;
  await drive(taskId, agentId.SPENDER!, "IN_PROGRESS");

  // 26 §5(b): REVIEW/QA/APPROVAL sahibi ajan devre kesiciden muaf
  const governance = await tasksService.create(
    ctx,
    { kind: "task", title: "Yönetişim görevi", objective: "İnceleme bekliyor." },
    { kind: "founder" },
  );
  await drive(governance.id, agentId.GOVERNOR!, "REVIEW");

  // ---- küçük bir günlük ŞİRKET bütçesi (hard) ----
  await costs.setBudget(ctx, {
    scopeKind: "company",
    period: "daily",
    limitCents: COMPANY_DAILY_CENTS,
    kind: "hard",
  });

  // ---- sahte PAHALI sağlayıcı: gerçek fiyat tablosu, sahte transport ----
  const [provider] = await db
    .insert(modelProviders)
    .values({
      kind: "anthropic",
      name: "expensive-fake",
      // 26 §3.1 şekliyle kayıt; router'a geçen tablo aşağıda camelCase
      pricing: {
        models: { "expensive-model": { in_per_mtok_cents: INPUT_PER_MTOK_CENTS } },
        updated_at: "2026-08-15",
        source: "manual",
      },
    })
    .returning();
  const providerId = provider!.id;

  const adapter: ProviderAdapter = {
    providerId,
    // Her çağrı geçerli bir AgentAction döndürür; `thought` her adımda FARKLI
    // olmalı, aksi halde guard (d) (loop detector) 3. tekrarda önce tetiklenir
    // ve bu test bütçe guard'ını değil döngü guard'ını ölçerdi.
    async complete() {
      modelCalls += 1;
      return {
        text: JSON.stringify({
          type: "think",
          thought: `pahalı düşünme adımı #${modelCalls} — ${TOKENS_PER_CALL} token`,
        }),
        usage: { inputTokens: TOKENS_PER_CALL, outputTokens: 0, cachedInputTokens: 0 },
        finishReason: "stop" as const,
      };
    },
    async embed() {
      // gömme hedefi yok → anlamsal şerit atlanır (12 §7.5c); ek maliyet üretmez
      throw new Error("no embedding target in this fixture");
    },
  };

  const router = new ModelRouter({
    providers: new Map([[providerId, adapter]]),
    pricing: new Map([
      [
        providerId,
        {
          models: {
            "expensive-model": {
              inputPerMTokCents: INPUT_PER_MTOK_CENTS,
              outputPerMTokCents: 0,
              cachedInputPerMTokCents: 0,
            },
          },
        },
      ],
    ]),
    logCall: () => {}, // llm_calls satırını callModelActivity yazar
  });

  nativeConnection = await NativeConnection.connect({ address: temporal.address });
  clientConnection = await Connection.connect({ address: temporal.address });
  client = new Client({ connection: clientConnection, namespace: "acos" });

  const activities = createAgentTaskActivities({
    guardedDb,
    router,
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "reasoning", providerId, model: "expensive-model" }],
    }),
    // invokeTool / signalPort yok: senaryo yalnız `think` üretir, araç yolu
    // bu testin konusu değil (tool maliyeti tool-gateway int testinde).
  });

  worker = await Worker.create({
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
  });
  workerRun = worker.run();
}, 600_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await clientConnection?.close();
  await nativeConnection?.close();
  await pool?.end();
  await pgContainer?.stop();
  await temporal?.container.stop();
});

describe.skipIf(!dockerUp)("A4 — devre kesici uçtan uca (26 §2/§5, 08 §9a)", () => {
  it("pahalı LLM adımları defteri yazar, görev harcamasını büyütür, guard (a) durdurur, kesici duraklatır, bütçe yükselince devam eder", async () => {
    const result = (await client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${taskId}.${agentId.SPENDER}`,
      args: [
        {
          companyId,
          agentId: agentId.SPENDER,
          taskId,
          sessionId: uuidv7(),
          attempt: 1,
        },
      ],
      workflowExecutionTimeout: "5m",
    })) as { outcome: string; steps: number };

    // ---------- 1) guard (a) döngüyü durdurdu ----------
    expect(result.outcome).toBe("guard_stopped");
    expect(result.steps).toBe(EXPECTED_STEP_NO);

    const guardEvents = await eventsOfType("agent.guard.triggered");
    const budgetGuards = guardEvents.filter(
      (e) => (e.payload as { guard: string }).guard === "budget",
    );
    expect(budgetGuards).toHaveLength(1);
    // guard SADECE bütçeden tetiklenmiş olmalı — döngü/adım-tavanı değil
    expect(guardEvents.map((e) => (e.payload as { guard: string }).guard)).toEqual(["budget"]);
    expect((await eventsOfType("agent.escalated")).length).toBeGreaterThanOrEqual(1);
    // 08 §9a: bütçe guard'ı görevi park eder
    expect((await taskRow()).status).toBe("WAITING");

    // ---------- 2) llm_calls gerçekten fiyatlandı (B1 nöbetçisi) ----------
    const calls = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.companyId, companyId));
    expect(calls).toHaveLength(EXPECTED_STEPS);
    expect(calls.every((c) => c.costCents === CENTS_PER_STEP)).toBe(true);
    expect(calls.every((c) => c.tokensIn === TOKENS_PER_CALL)).toBe(true);

    // ---------- 3) cost_entries satırları yazıldı (26 §2) ----------
    const ledger = await db
      .select()
      .from(costEntries)
      .where(and(eq(costEntries.companyId, companyId), eq(costEntries.kind, "llm")));
    expect(ledger).toHaveLength(EXPECTED_STEPS);
    const ledgerTotal = ledger.reduce((sum, row) => sum + row.amountCents, 0);
    expect(ledgerTotal).toBe(EXPECTED_STEPS * CENTS_PER_STEP);
    expect(ledger.every((row) => row.taskId === taskId)).toBe(true);
    expect(ledger.every((row) => row.agentId === agentId.SPENDER)).toBe(true);
    expect((await eventsOfType("cost.entry.recorded"))).toHaveLength(EXPECTED_STEPS);

    // ---------- 4) tasks.spent_cents arttı ve defterle BİREBİR uyuşuyor ----------
    const burner = await taskRow();
    expect(burner.spentCents).toBe(ledgerTotal);
    expect(burner.spentCents).toBeGreaterThan(0);
    expect(burner.budgetCents).toBe(TASK_BUDGET_CENTS);
    // kalan bütçe, guard'ın bir sonraki adımı ödeyemeyeceği noktada
    expect(TASK_BUDGET_CENTS - burner.spentCents).toBeLessThan(CENTS_PER_STEP * 1.5);

    // ---------- 5) şirket devre kesicisi (26 §5) ----------
    const exceeded = await eventsOfType("budget.exceeded");
    const companyBreach = exceeded.filter(
      (e) => (e.payload as { scope: string }).scope === "company",
    );
    expect(companyBreach).toHaveLength(1); // eşiği GEÇEN yazımda bir kez
    const breachPayload = companyBreach[0]!.payload as {
      spentCents: number;
      limitCents: number;
      pausedAgentIds: string[];
    };
    expect(breachPayload.limitCents).toBe(COMPANY_DAILY_CENTS);
    expect(breachPayload.spentCents).toBeGreaterThanOrEqual(COMPANY_DAILY_CENTS);

    // kritik olmayanlar duraklar; executive track ve REVIEW sahibi ayakta kalır
    expect(breachPayload.pausedAgentIds.sort()).toEqual(
      [agentId.SPENDER!, agentId.PEER!].sort(),
    );
    const spender = await agentRow(agentId.SPENDER!);
    const peer = await agentRow(agentId.PEER!);
    expect(spender.status).toBe("paused");
    expect(peer.status).toBe("paused");
    // A4'ün istediği tam işaret: employment.paused_by_breaker
    expect((spender.employment as Record<string, unknown>).paused_by_breaker).toBe("true");
    expect((peer.employment as Record<string, unknown>).paused_by_breaker).toBe("true");
    expect((await agentRow(agentId.CEO!)).status).toBe("active");
    expect((await agentRow(agentId.GOVERNOR!)).status).toBe("active");
    expect(
      (await agentRow(agentId.CEO!)).employment as Record<string, unknown>,
    ).not.toHaveProperty("paused_by_breaker");

    // ---------- 6) bütçe yükseltilince otomatik devam ----------
    const [companyBudget] = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.companyId, companyId), eq(budgets.scopeKind, "company")));
    await costs.restoreBudget(ctx, companyBudget!.id, 100_000);

    expect(await eventsOfType("budget.restored")).toHaveLength(1);
    const resumed = await eventsOfType("agent.resumed");
    expect(resumed.map((e) => e.agentId).sort()).toEqual(
      [agentId.SPENDER!, agentId.PEER!].sort(),
    );
    for (const id of [agentId.SPENDER!, agentId.PEER!]) {
      const row = await agentRow(id);
      expect(row.status).toBe("active");
      expect(row.employment as Record<string, unknown>).not.toHaveProperty("paused_by_breaker");
    }

    // bütçe yükseldikten sonra guard (a) artık geçirir: aynı görev için
    // anlık görüntü yeniden ölçülür (08 §9a "her adımdan önce")
    const [remaining] = (
      await db.execute(sql`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS spent FROM cost_entries
        WHERE company_id = ${companyId}
      `)
    ).rows as [{ spent: string | number }];
    expect(Number(remaining.spent)).toBeLessThan(100_000);
    const status = await costs.status(ctx, "company");
    expect(status).toHaveLength(1);
    expect(status[0]!.breached).toBe(false);
    expect(status[0]!.remainingCents).toBe(100_000 - ledgerTotal);
  }, 600_000);
});
