// T36 — PLANLAMA YOLUNUN HARCAMASI DA DEFTERE DÜŞER.
//
// Gözlenen boşluk: `llm_calls` tablosuna yalnız ajan döngüsünün
// `callModelActivity`'si yazıyordu. Intake raporu sentezi, gereksinim analizi
// ve sihirbazın kadro önerisi — hepsi gerçek model çağrısı, hepsi para — hiç
// satır bırakmıyordu. Founder'ın maliyet ekranında "sıfır" ile "ölçülmemiş"
// aynı görünüyordu; ajan turu bir CLI oturumuna dönüşünce (E4) bu boşluk
// kozmetik olmaktan çıktı.
//
// Sözleşme (bu test): (1) gereksinim analizi bir satır yazar ve satır gerçek
// sağlayıcıyı/maliyeti taşır, (2) aktivite yeniden denendiğinde İKİNCİ satır
// yazılmaz — yeniden deneme maliyeti ikiye katlamaz, (3) aynı projeye İKİNCİ
// bir hedef verilirse o analiz AYRI bir satırdır (ilkinin üstüne düşmez),
// (4) sihirbazın kadro önerisi de kendi satırını yazar (hedef görevi varsa
// satır ona bağlanır; burada FK'sız kurulumda görev yok, defter yine yazılır).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import { companies, llmCalls, modelProviders, projects, users } from "@acos/db/schema";
import type { ModelRouter } from "@acos/llm";
import { createIntakeControlActivities } from "../../src/intake/activities.js";
import { startPostgres } from "./helpers";

describe("planlama yolunun LLM defteri (T36)", { timeout: 300_000 }, () => {
  let pgContainer: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let pool: Pool | undefined;
  let db: Db;
  let guardedDb: GuardedDb;
  let ctx: CompanyContext;
  let companyId = "";
  let projectId = "";
  let providerId = "";
  let completions = 0;
  let activities: ReturnType<typeof createIntakeControlActivities>;

  // Planlama satırlarının ajan turundan ayırt edicisi: agent_session_id NULL.
  // `purpose` kanonik CHECK ile sabit (reasoning|coding|fast|embedding|vision),
  // yani "hangi planlama adımı" bilgisini TAŞIMAZ ve taşıyormuş gibi
  // davranılmamalı.
  const ledgerRows = async () =>
    db
      .select({
        id: llmCalls.id,
        purpose: llmCalls.purpose,
        model: llmCalls.model,
        providerId: llmCalls.providerId,
        costCents: llmCalls.costCents,
        tokensIn: llmCalls.tokensIn,
        taskId: llmCalls.taskId,
        agentSessionId: llmCalls.agentSessionId,
      })
      .from(llmCalls)
      .where(eq(llmCalls.companyId, companyId))
      // sıra deterministik olmalı: aşağıdaki iddialar satır sırasına bakıyor
      .orderBy(llmCalls.createdAt, llmCalls.id);

  beforeAll(async () => {
    pgContainer = await startPostgres();
    await runMigrations(pgContainer.getConnectionUri());
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on("error", () => {});
    db = createDb(pool);
    guardedDb = createGuardedDb(pool);

    const [founder] = await db
      .insert(users)
      .values({ email: "founder@ledger.local", passwordHash: "x", displayName: "F" })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: "LedgerCo", slug: "ledgerco", createdByUserId: founder!.id })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        slug: "ledgerp",
        name: "LedgerP",
        objectiveMd: "bir HTTP saglik ucu",
        status: "ready",
        createdByUserId: founder!.id,
      })
      .returning();
    projectId = project!.id;
    const [provider] = await db
      .insert(modelProviders)
      .values({ kind: "ollama", name: "stub" })
      .returning();
    providerId = provider!.id;

    // Sahte router: gerçek bir sağlayıcı satırına, gerçek bir maliyete ve
    // sayılabilir bir çağrı adedine sahip — defterin ne yazdığını ölçebilelim.
    const router = {
      complete: async () => {
        completions += 1;
        return {
          text: JSON.stringify({
            goal: "saglik ucu",
            required_capabilities: ["backend x2"],
            teams: [{ capability: "backend", headcount: 2, rationale: "api" }],
            rationale: "kucuk ekip yeter",
          }),
          usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 0 },
          model: "stub-model",
          providerId,
          costCents: 7,
          latencyMs: 42,
        };
      },
    } as unknown as ModelRouter;

    activities = createIntakeControlActivities({
      guardedDb,
      router,
      routingFor: async () => ({
        bindings: [],
        profiles: [{ purpose: "reasoning", providerId, model: "stub-model" }],
      }),
      proposeStaffing: async () => ({ id: "proposal-1", status: "awaiting_human", teams: [] }),
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  it("gereksinim analizi deftere GERÇEK sağlayıcı ve maliyetle düşer", async () => {
    const before = completions;
    const result = await activities.analyzeRequirementsActivity({
      companyId,
      projectId,
      projectName: "LedgerP",
      objective: "saglik ucu ekle",
      constraints: null,
    });
    expect(result?.requiredCapabilities).toEqual(["backend x2"]);
    expect(completions).toBe(before + 1);

    const rows = await ledgerRows();
    // ÖNCEDEN: bu tablo bu yolda TAMAMEN boştu
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "reasoning",
      model: "stub-model",
      providerId,
      costCents: 7,
      tokensIn: 120,
    });
    // ajan turu DEĞİL: oturumu yok — maliyet ekranında planlama harcaması
    // böyle ayrışır
    expect(rows[0]!.agentSessionId).toBeNull();
  });

  it("aktivite yeniden denenirse maliyet İKİYE KATLANMAZ", async () => {
    const before = (await ledgerRows()).length;
    // Temporal aynı aktiviteyi aynı girdiyle yeniden çalıştırır
    await activities.analyzeRequirementsActivity({
      companyId,
      projectId,
      projectName: "LedgerP",
      objective: "saglik ucu ekle",
      constraints: null,
    });
    expect(await ledgerRows()).toHaveLength(before);
  });

  it("aynı projeye İKİNCİ hedef verilirse o analiz AYRI satırdır", async () => {
    await activities.analyzeRequirementsActivity({
      companyId,
      projectId,
      projectName: "LedgerP",
      objective: "ikinci hedef: metrik ucu ekle",
      constraints: null,
    });
    expect(await ledgerRows()).toHaveLength(2);
  });

  it("sihirbazın kadro önerisi de kendi satırını yazar", async () => {
    const goalTaskId = "018f0000-0000-7000-8000-0000000009a1";
    await activities.proposeStaffingActivity({
      companyId,
      projectId,
      projectName: "LedgerP",
      objective: "saglik ucu ekle",
      requiredCapabilities: ["backend x2"],
      goalTaskId: null, // FK'sız test: görev satırı yok, defter yine yazılmalı
      workflowId: "goal-wf-1",
    } as never);
    // üçüncü satır sihirbazın kendi çağrısıdır
    const rows = await ledgerRows();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ providerId, costCents: 7, agentSessionId: null });
    expect(goalTaskId).toBeTruthy();
  });
});
