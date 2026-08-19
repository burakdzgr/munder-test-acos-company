// Seed v1 (27 §4, T17): idempotent (keyed on company slug) — creates the
// Founder user and "Acme Technologies" with default settings. Org, positions
// and the 8 agents extend this in T18/T19.
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { companyContext, CostService, type CompanyContext, type GuardedDb } from "@acos/db";
import { pricingDefaultsFor } from "@acos/llm";
import {
  budgets,
  companies,
  modelProfiles,
  modelProviders,
  orgUnits,
  secrets,
  toolPermissions,
  users,
} from "@acos/db/schema";
import { hashPassword, sealSecret } from "./modules/auth/crypto.js";
import { CompanyService } from "./modules/companies/service.js";
import { OrgService } from "./modules/org/service.js";
import { AgentsService } from "./modules/agents/service.js";

export const SEED_COMPANY_SLUG = "acme";
export const SEED_FOUNDER_EMAIL = "founder@acme.local";

export interface SeedResult {
  created: boolean;
  companyId: string;
  founderUserId: string;
  /** Present only when the user was created this run (printed once, 27 §14). */
  founderPassword?: string;
}

export async function ensureSeed(db: GuardedDb): Promise<SeedResult> {
  const [existingCompany] = await db
    .select()
    .from(companies)
    .where(eq(companies.slug, SEED_COMPANY_SLUG));

  const [existingUser] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${SEED_FOUNDER_EMAIL}`);

  if (existingCompany && existingUser) {
    // live routing rows apply to EXISTING installs too (idempotent) — the
    // nightly live-LLM lane boots the same seed with a provider key present
    await ensureLiveModelRouting(db, existingCompany.id);
    await ensureCompanyDailyBudget(db, existingCompany.id);
    // 2026-08-15: tool grants were reachable only from the org-seeding path,
    // which this early return skips — so a newly wired tool (task.query,
    // memory.search, web.fetch ...) never received a grant on an install that
    // already existed. The permission simply never appeared and the tool
    // failed with NO_PERMISSION_GRANT, looking like a gateway bug. The list is
    // idempotent per (tool, subject), so re-running it on every boot is the
    // whole point of calling it "an additive seed upgrade".
    await seedToolGrants(db, companyContext(existingCompany.id));
    await ensureSearchCredential(db, existingCompany.id, existingUser.id);
    return { created: false, companyId: existingCompany.id, founderUserId: existingUser.id };
  }

  let founderUserId = existingUser?.id;
  let founderPassword: string | undefined;
  if (!founderUserId) {
    founderPassword = process.env.SEED_FOUNDER_PASSWORD || randomBytes(12).toString("base64url");
    const [user] = await db
      .insert(users)
      .values({
        email: SEED_FOUNDER_EMAIL,
        passwordHash: await hashPassword(founderPassword),
        displayName: "Founder",
        platformRole: "owner",
      })
      .returning();
    founderUserId = user!.id;
  }

  let companyId = existingCompany?.id;
  if (!companyId) {
    const service = new CompanyService(db);
    const company = await service.create({
      name: "Acme Technologies",
      slug: SEED_COMPANY_SLUG,
      currency: "USD",
      createdByUserId: founderUserId,
    });
    companyId = company.id;
  }

  await seedOrgAndAgents(db, companyId);
  await ensureLiveModelRouting(db, companyId);
  await ensureCompanyDailyBudget(db, companyId);
  await ensureSearchCredential(db, companyId, founderUserId);

  return {
    created: true,
    companyId,
    founderUserId,
    ...(founderPassword !== undefined && { founderPassword }),
  };
}

/**
 * Default company daily spend cap, in cents. Overridable at seed time with
 * `SEED_DAILY_BUDGET_CENTS`; editable afterwards in Settings → Costs (26 §9).
 */
const DEFAULT_DAILY_BUDGET_CENTS = 50_000;

/**
 * A3 (2026-08-15 code review; 26 §4 + §5.3): every company gets a
 * company-scope daily HARD budget row.
 *
 * Two things depend on the row existing. 26 §5.3 makes it the circuit
 * breaker's trigger — "a daily company-level hard budget breach emits
 * `budget.exceeded {scope: company}`; the policy engine consumer then pauses
 * all non-critical agents" — which can never fire without one. And the Tool
 * Gateway's tightest-budget lookup falls back to `Number.MAX_SAFE_INTEGER`
 * when no budget governs a call, i.e. unlimited spend, defeating 26 §5.2's
 * pre-execution check.
 *
 * Additive and idempotent: written only when absent, so a Founder-edited
 * limit (or a deliberate deletion) survives every later boot.
 */
async function ensureCompanyDailyBudget(db: GuardedDb, companyId: string): Promise<void> {
  const ctx = companyContext(companyId);
  const [existing] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(
        eq(budgets.companyId, companyId),
        eq(budgets.scopeKind, "company"),
        eq(budgets.period, "daily"),
      ),
    )
    .limit(1);
  if (existing) return;
  const limitCents = Number(process.env.SEED_DAILY_BUDGET_CENTS ?? DEFAULT_DAILY_BUDGET_CENTS);
  if (!Number.isFinite(limitCents) || limitCents <= 0) return; // budgets_limit_check
  // through CostService so the `budget.created` event lands on the timeline
  await new CostService(db).setBudget(ctx, {
    scopeKind: "company",
    period: "daily",
    limitCents,
    kind: "hard",
  });
}

/**
 * Live-LLM routing rows (T50; 29 §8.3 nightly lane): when a provider key is
 * present and the stack is NOT scripted, ensure the anthropic
 * model_providers row + the seed company's model_profiles (reasoning /
 * coding / fast). Embedding has no anthropic endpoint — the memory pipeline
 * degrades per 12 §5.4/§7.5c (NULL embeddings + skipped semantic lane) until
 * an embedding provider is configured. Idempotent; a no-op without the key.
 */
/**
 * A1 (26 §3.1): compile-time defaults → the JSONB document shape the column
 * stores (snake_case, model-keyed). One translation point; `loadProviderPricing`
 * translates back on read.
 */
function seedPricingDocument(kind: "anthropic" | "openai"): Record<string, unknown> {
  const table = pricingDefaultsFor(kind);
  if (!table) return {};
  const models: Record<string, Record<string, number>> = {};
  for (const [model, rate] of Object.entries(table.models)) {
    models[model] = {
      in_per_mtok_cents: rate.inputPerMTokCents,
      out_per_mtok_cents: rate.outputPerMTokCents,
      cached_in_per_mtok_cents: rate.cachedInputPerMTokCents,
    };
  }
  return { models, updated_at: new Date().toISOString().slice(0, 10), source: "seed" };
}

async function ensureLiveModelRouting(db: GuardedDb, companyId: string): Promise<void> {
  if (process.env.LLM_MODE === "scripted") return;
  
  // OLLAMA_BASE_URL varsa Ollama provider'ını register et
  if (process.env.OLLAMA_BASE_URL) {
    const [existingOllama] = await db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.name, "ollama"));
    const ollamaProviderId =
      existingOllama?.id ??
      (
        await db
          .insert(modelProviders)
          .values({ kind: "ollama", name: "ollama", enabled: true })
          .onConflictDoNothing()
          .returning({ id: modelProviders.id })
      )[0]?.id;
    if (ollamaProviderId) {
      // Ollama modelleri (docker-compose'ta çalışan) — mistral, llama2, neural-chat
      const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";
      for (const [purpose, model] of [
        ["reasoning", OLLAMA_MODEL],
        ["coding", OLLAMA_MODEL],
        ["fast", OLLAMA_MODEL],
      ] as const) {
        await db
          .insert(modelProfiles)
          .values({ companyId, purpose, providerId: ollamaProviderId, model, priority: 10 })
          .onConflictDoNothing();
      }
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) return;
  const [existingProvider] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(eq(modelProviders.name, "anthropic"));
  const providerId =
    existingProvider?.id ??
    (
      await db
        .insert(modelProviders)
        .values({ kind: "anthropic", name: "anthropic" })
        .onConflictDoNothing()
        .returning({ id: modelProviders.id })
    )[0]?.id;
  if (!providerId) return; // lost a boot race — the winner seeded it

  // A1 (26 §3.1): seed the price list into `model_providers.pricing` in the
  // document shape so Settings → Providers can edit it at runtime. Only
  // written while the column still holds its empty default — an operator's
  // edits are never overwritten on boot.
  await db
    .update(modelProviders)
    .set({ pricing: seedPricingDocument("anthropic") })
    .where(and(eq(modelProviders.id, providerId), sql`${modelProviders.pricing} = '{}'::jsonb`));

  const LIVE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5-20251001";
  for (const [purpose, model] of [
    ["reasoning", LIVE_MODEL],
    ["coding", LIVE_MODEL],
    ["fast", FAST_MODEL],
  ] as const) {
    await db
      .insert(modelProfiles)
      .values({ companyId, purpose, providerId, model, priority: 0 })
      .onConflictDoNothing();
  }

  // Çok sağlayıcılı zincir (Founder kararı, 2026-08-18; REVISION sonrası
  // şirket-kuruluş tohumu 2026-08-19): her YENİ şirket aynı 5 katmanlı
  // düşüş zincirini alır — Anthropic(0) → Claude CLI(1, abonelik) →
  // Gemini(3, ücretsiz) → OpenAI(5) → Ollama(10). Sağlayıcı satırları
  // platformda idempotent, profiller şirket başına.
  const ensureProvider = async (name: string, kind: string): Promise<string | null> => {
    const [existing] = await db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.name, name));
    if (existing) return existing.id;
    const [inserted] = await db
      .insert(modelProviders)
      .values({ kind, name, enabled: true })
      .onConflictDoNothing()
      .returning({ id: modelProviders.id });
    return inserted?.id ?? null;
  };
  const seedTier = async (
    providerName: string,
    kind: string,
    priority: number,
    models: { reasoning: string; coding: string; fast: string },
  ): Promise<void> => {
    const providerId = await ensureProvider(providerName, kind);
    if (!providerId) return;
    for (const purpose of ["reasoning", "coding", "fast"] as const) {
      await db
        .insert(modelProfiles)
        .values({ companyId, purpose, providerId, model: models[purpose], priority })
        .onConflictDoNothing();
    }
  };
  if (process.env.CLAUDE_CLI_BRIDGE_URL) {
    await seedTier("claude-cli", "openai", 1, {
      reasoning: "claude-cli-sonnet",
      coding: "claude-cli-sonnet",
      fast: "claude-cli-haiku",
    });
  }
  if (process.env.GEMINI_API_KEY) {
    await seedTier("gemini", "openai", 3, {
      reasoning: "gemini-3.7-flash",
      coding: "gemini-3.7-flash",
      fast: "gemini-3.7-flash-lite",
    });
  }
  if (process.env.OPENAI_API_KEY) {
    await seedTier("openai", "openai", 5, {
      reasoning: "gpt-5-mini",
      coding: "gpt-5.1",
      fast: "gpt-5-nano",
    });
  }

  // Canlı semantik hafıza (12 §5.4/§7.5): Anthropic embedding sunmadığından
  // OPENAI_API_KEY varsa openai sağlayıcısı + 1536-boyutlu embedding profili
  // kurulur (HNSW 1536 partial index'iyle eşleşir) — yoksa boru hattı belgeli
  // şekilde degrade kalır (NULL embedding + semantik şerit atlanır).
  if (process.env.OPENAI_API_KEY) {
    const [existingOpenAi] = await db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.name, "openai"));
    const openAiId =
      existingOpenAi?.id ??
      (
        await db
          .insert(modelProviders)
          .values({ kind: "openai", name: "openai" })
          .onConflictDoNothing()
          .returning({ id: modelProviders.id })
      )[0]?.id;
    if (openAiId) {
      await db
        .insert(modelProfiles)
        .values({
          companyId,
          purpose: "embedding",
          providerId: openAiId,
          model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
          priority: 0,
        })
        .onConflictDoNothing();
    }
  }
}

/**
 * 27 §4: Engineering dept (Backend + Frontend teams), positions, the 8 agents
 * (CEO, CTO, EM, Backend Lead, 2 Backend Engineers, 1 Frontend Engineer,
 * 1 QA/Reviewer) with the reports_to forest Dev→Lead→EM→CTO→CEO.
 * Idempotent: skipped when the company already has agents.
 */
async function seedOrgAndAgents(db: GuardedDb, companyId: string): Promise<void> {
  const ctx = companyContext(companyId);
  const [{ n }] = (
    await db.execute(
      sql`SELECT count(*)::int AS n FROM agents WHERE company_id = ${companyId}`,
    )
  ).rows as [{ n: number }];
  if (Number(n) > 0) {
    // additive seed upgrades (T41 grants) still apply to existing installs
    await seedToolGrants(db, ctx);
    return;
  }

  const org = new OrgService(db);
  const agentsService = new AgentsService(db, org);

  const engineering = await org.createUnit(ctx, {
    name: "Engineering",
    slug: "engineering",
    kind: "department",
  });
  const backend = await org.createUnit(ctx, {
    name: "Backend",
    slug: "backend",
    kind: "team",
    parentId: engineering.id,
  });
  const frontend = await org.createUnit(ctx, {
    name: "Frontend",
    slug: "frontend",
    kind: "team",
    parentId: engineering.id,
  });

  const positionOf: Record<string, string> = {};
  for (const [title, track, role] of [
    ["CEO", ["expert"], "executive"],
    ["CTO", ["expert"], "executive"],
    ["Engineering Manager", ["lead", "expert"], "manager"],
    ["Backend Lead", ["senior", "staff", "lead"], "lead"],
    ["Backend Engineer", ["junior", "mid", "senior"], "member"],
    ["Frontend Engineer", ["junior", "mid", "senior"], "member"],
    ["QA/Reviewer", ["mid", "senior"], "reviewer"],
  ] as const) {
    const position = await org.createPosition(ctx, {
      title,
      seniorityTrack: [...track],
      defaultRole: role,
    });
    positionOf[title] = position.id;
  }

  const hire = (input: {
    name: string;
    title: string;
    unitId: string;
    seniority: string;
    autonomyLevel: number;
    persona: string;
    managerAgentId?: string;
    leadsUnit?: boolean;
  }) =>
    agentsService.hire(ctx, {
      name: input.name,
      positionId: positionOf[input.title]!,
      orgUnitId: input.unitId,
      seniority: input.seniority,
      autonomyLevel: input.autonomyLevel,
      persona: input.persona,
      ...(input.managerAgentId !== undefined && { managerAgentId: input.managerAgentId }),
      ...(input.leadsUnit !== undefined && { leadsUnit: input.leadsUnit }),
      activate: true,
    });

  const ceo = await hire({
    name: "Aylin Vural",
    title: "CEO",
    unitId: engineering.id,
    seniority: "expert",
    autonomyLevel: 5,
    persona: "Decisive CEO agent; delegates to executives, never to individual contributors.",
  });
  const cto = await hire({
    name: "Mert Aksoy",
    title: "CTO",
    unitId: engineering.id,
    seniority: "expert",
    autonomyLevel: 5,
    persona: "Pragmatic CTO agent; owns technical direction and the engineering org.",
    managerAgentId: ceo.id,
  });
  const em = await hire({
    name: "Selin Koç",
    title: "Engineering Manager",
    unitId: engineering.id,
    seniority: "lead",
    autonomyLevel: 4,
    persona: "Engineering manager; decomposes objectives and balances team load.",
    managerAgentId: cto.id,
  });
  const backendLead = await hire({
    name: "Kerem Yıldız",
    title: "Backend Lead",
    unitId: backend.id,
    seniority: "lead",
    autonomyLevel: 3,
    persona: "Backend lead; reviews and merges, owns the backend services.",
    managerAgentId: em.id,
    leadsUnit: true,
  });
  await hire({
    name: "Alex Demir",
    title: "Backend Engineer",
    unitId: backend.id,
    seniority: "mid",
    autonomyLevel: 2,
    persona: "Backend engineer; pragmatic, test-first.",
    managerAgentId: backendLead.id,
  });
  await hire({
    name: "Deniz Kaya",
    title: "Backend Engineer",
    unitId: backend.id,
    seniority: "junior",
    autonomyLevel: 2,
    persona: "Backend engineer; eager, asks for review early.",
    managerAgentId: backendLead.id,
  });
  await hire({
    name: "Ece Arslan",
    title: "Frontend Engineer",
    unitId: frontend.id,
    seniority: "mid",
    autonomyLevel: 2,
    persona: "Frontend engineer; owns the SPA views.",
    managerAgentId: em.id,
  });
  await hire({
    name: "Baran Çelik",
    title: "QA/Reviewer",
    unitId: engineering.id,
    seniority: "senior",
    autonomyLevel: 3,
    persona: "QA and independent reviewer; never approves own work.",
    managerAgentId: em.id,
  });

  await seedToolGrants(db, ctx);
}

// 2026-08-14 saha bulgusu: Founder org'u yeniden kurunca yeni birimler
// grant'siz kalıyordu (NO_PERMISSION_GRANT). Boot'ta her koşulan bu liste
// mühendislik birim slug'larının güncel kayıtlarına grant basar (idempotent).
// B4 (2026-08-15): grant listesi dispatch'i olan araçları izler. task.query ve
// memory.search B1' ile, web.fetch B2' ile bağlandı. db.inspect grant'i proje
// bazlı verilir (veritabanı tanımı olmayan projede işe yaramaz).
// 2026-08-18: web.search eklendi (AbacusAI API entegrasyonu ile).
const SEED_GRANT_TOOLS = [
  "github.repo.ensure",
  "org.team.create",
  "agent.hire",
  "agent.assign_project",
  "model.bind",
  "fs.*",
  "git.*",
  "terminal.run",
  "task.query",
  "memory.search",
  "web.fetch",
  "web.search",
  "code.search",
  "preview.ports",
  "http.request",
];

/**
 * Engineering-wide tool grants (T41; 17 §4.1 org_unit subject): the coding
 * toolset for every engineer — granted per unit (member_of is direct, no
 * tree inheritance in MVP); the gateway still applies autonomy × risk ×
 * budget per call. Idempotent via the active-grant unique index, and safe
 * to re-run on existing installs (additive seed upgrade).
 */
export async function seedToolGrants(db: GuardedDb, ctx: CompanyContext): Promise<void> {
  // Walkthrough bulgusu (2026-08-19): grant yalnız BİLİNEN sluglara iniyordu —
  // Founder'ın elle kurduğu "Yönetim" gibi birimlerin ajanları ilk araçta
  // NO_PERMISSION_GRANT duvarına çarpıyordu. Temel araç seti artık ŞİRKETİN
  // TÜM birimlerine tohumlanır; güvenlik kapısı zaten otonomi × risk
  // matrisi + R3 Founder onayıdır, grant listesi değil.
  const units = await db
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(eq(orgUnits.companyId, ctx.companyId));
  for (const unit of units) {
    for (const toolName of SEED_GRANT_TOOLS) {
      await db
        .insert(toolPermissions)
        .values({
          companyId: ctx.companyId,
          toolName,
          subjectKind: "org_unit",
          subjectId: unit.id,
        })
        .onConflictDoNothing();
    }
  }
}

/**
 * Ensure web.search credential (ABACUS_API_KEY) — idempotent, seed'den ve
 * runtime'dan çağrılabilir. Master key yoksa sessizce skip eder.
 */
async function ensureSearchCredential(
  db: GuardedDb,
  companyId: string,
  founderUserId: string,
): Promise<void> {
  const masterKey = process.env.MASTER_KEY?.trim();
  if (!masterKey) return; // encryption unavailable — skip silently
  const apiKey = process.env.ABACUS_API_KEY?.trim();
  if (!apiKey) return; // no key configured — skip

  // Idempotent: zaten varsa tekrar yazma
  const [existing] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.companyId, companyId), eq(secrets.name, "search.api_key")));
  if (existing) return; // already seeded

  // Seal and store
  const ciphertext = await sealSecret(masterKey, apiKey);
  await db
    .insert(secrets)
    .values({
      companyId,
      name: "search.api_key",
      scope: "company",
      ciphertext,
      createdByUserId: founderUserId,
    })
    .onConflictDoNothing();
}


/**
 * Yeni şirketin çalışır doğması (2026-08-19, sıfırlama bulgusu): şirket
 * sihirbazla kurulunca LLM zinciri (model_profiles), günlük bütçe ve
 * web.search kimliği ancak SEED şirketinde vardı — taze kurulumda ilk şirket
 * beyinsiz doğuyordu. create rotası commit sonrası bunu çağırır; her parça
 * idempotent. Araç izinleri org birimleri kurulunca (org rotası) verilir.
 */
export async function provisionCompanyDefaults(
  db: GuardedDb,
  input: { companyId: string; founderUserId: string },
): Promise<void> {
  await ensureLiveModelRouting(db, input.companyId);
  await ensureCompanyDailyBudget(db, input.companyId);
  await ensureSearchCredential(db, input.companyId, input.founderUserId);
}
