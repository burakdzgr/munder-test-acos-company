// D3 — kuyruk + adapter birlikte (30 §, ADR-017).
//
// Ayrı ayrı ikisi de test edildi: kuyruğun durum makinesi (@acos/db
// publishing.int) ve adapter'ın sözleşmesi (integrations/registry.test).
// Burada kanıtlanan şey ARADAKİ TEL: zamanı gelen iş sahipleniliyor,
// platforma gidiyor, dönen dış kimlik kuyruğa yazılıyor ve içerik
// `published` oluyor — publish→metrik→öğren döngüsünün ilk halkası.
//
// Platform sahte (kayıtlı fixture'lar); Postgres, kuyruk, olaylar gerçek.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  PublishingService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import { companies, contentItems, events, publishJobs, users } from "@acos/db/schema";
import type { SocialCapability, SocialChannelPort, SocialPublishInput } from "@acos/domain";
import { createPublishDispatcher } from "../../src/modules/integrations/publish-dispatcher.js";
import { IntegrationError } from "../../src/modules/integrations/registry.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let publishing: PublishingService;
let companyId = "";
let counter = 0;

const SYSTEM = { kind: "system" as const, id: null };

/** Kaydedilmiş davranışa göre cevap veren sahte platform. */
class FakeChannel implements SocialChannelPort {
  readonly platform = "instagram";
  readonly calls: SocialPublishInput[] = [];
  constructor(private readonly behaviour: () => { externalId: string } | Error) {}
  supports(capability: SocialCapability): boolean {
    return capability === "publishPost";
  }
  async publishPost(input: SocialPublishInput) {
    this.calls.push(input);
    const result = this.behaviour();
    if (result instanceof Error) throw result;
    return { externalId: result.externalId, permalink: `https://insta/p/${result.externalId}` };
  }
}

async function queueContent(platform = "instagram"): Promise<{ jobId: string; contentId: string }> {
  counter += 1;
  const [content] = await db
    .insert(contentItems)
    .values({
      companyId,
      platform,
      kind: "post",
      title: `İçerik ${counter}`,
      status: "scheduled",
    })
    .returning();
  const job = await publishing.schedule(ctx, {
    contentItemId: content!.id,
    platform,
    scheduledAt: new Date(Date.now() - 60_000),
    actor: SYSTEM,
  });
  return { jobId: job.id, contentId: content!.id };
}

const loadContent = async (_companyId: string, contentItemId: string) => ({
  caption: `gönderi ${contentItemId.slice(0, 8)}`,
  mediaUrls: ["https://cdn/x.jpg"],
  connectionId: "conn-1",
});

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  publishing = new PublishingService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@dispatch.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "DispatchCo", slug: "dispatchco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("yayın dispatcher'ı (30 §)", { timeout: 60_000 }, () => {
  it("zamanı gelen iş platforma gider, dış kimlik kuyruğa yazılır", async () => {
    const { jobId, contentId } = await queueContent();
    const channel = new FakeChannel(() => ({ externalId: "ig-77" }));
    const dispatcher = createPublishDispatcher({
      guardedDb,
      adapters: new Map([["instagram", channel]]),
      loadContent,
    });

    const outcome = await dispatcher.runOnce(companyId);
    expect(outcome).toMatchObject({ claimed: 1, published: 1, failed: 0 });

    const [job] = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
    expect(job!.status).toBe("published");
    expect(job!.externalId).toBe("ig-77");

    const [content] = await db.select().from(contentItems).where(eq(contentItems.id, contentId));
    expect(content!.status).toBe("published");

    // idempotency anahtarı olarak İŞ KİMLİĞİ gitti — tekrar denemede
    // platformda ikinci gönderi oluşmaz
    expect(channel.calls[0]!.idempotencyKey).toBe(jobId);

    const published = await db
      .select()
      .from(events)
      .where(
        and(eq(events.companyId, companyId), eq(events.type, "marketing.content.published")),
      );
    expect(published).toHaveLength(1);
  });

  it("geçici hata işi kuyrukta tutar, kalıcı hata hemen bitirir", async () => {
    // geçici: 503 → tekrar denenecek
    const flaky = await queueContent();
    const flakyDispatcher = createPublishDispatcher({
      guardedDb,
      adapters: new Map([
        ["instagram", new FakeChannel(() => new IntegrationError("PLATFORM_ERROR", "503", true))],
      ]),
      loadContent,
      onError: () => {},
    });
    const retryOutcome = await flakyDispatcher.runOnce(companyId);
    expect(retryOutcome).toMatchObject({ published: 0, failed: 0, retried: 1 });
    const [retried] = await db.select().from(publishJobs).where(eq(publishJobs.id, flaky.jobId));
    expect(retried!.status).toBe("scheduled"); // kuyrukta

    // kalıcı: yanlış izin → deneme hakkı tüketilmeden biter
    const broken = await queueContent();
    const brokenDispatcher = createPublishDispatcher({
      guardedDb,
      adapters: new Map([
        [
          "instagram",
          new FakeChannel(() => new IntegrationError("PLATFORM_ERROR", "bad permission", false)),
        ],
      ]),
      loadContent,
      onError: () => {},
    });
    // sırayla iki iş de kuyrukta; yalnız `broken` kalıcı hata alacak
    await brokenDispatcher.runOnce(companyId);
    const [failed] = await db.select().from(publishJobs).where(eq(publishJobs.id, broken.jobId));
    expect(failed!.status).toBe("failed");
    expect(failed!.attempts).toBe(1); // üç kez denenmedi
  });

  it("adapter'ı olmayan platform sessizce beklemez — kalıcı hataya düşer", async () => {
    const { jobId } = await queueContent("tiktok");
    const dispatcher = createPublishDispatcher({
      guardedDb,
      adapters: new Map(), // hiçbir platform bağlı değil
      loadContent,
      onError: () => {},
    });
    const outcome = await dispatcher.runOnce(companyId);
    expect(outcome.failed).toBeGreaterThanOrEqual(1);
    const [job] = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("manuel yayın");
  });
});
