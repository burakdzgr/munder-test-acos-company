// D3 — yayın kuyruğu (30 §, `publish_jobs`).
//
// Tablo ve `marketing.content.publish.*` olayları vardı; kodda tek bir
// referansı yoktu. Pazarlama tarafı "içerik üret"ten öteye geçemiyordu:
// yayınlanmıyor, ölçülmüyor, öğrenilmiyordu.
//
// En kritik iddia ÇİFT YAYIN: iki dispatcher aynı anda koşarsa aynı iş
// platforma iki kez gitmemeli. Bunu gerçek eşzamanlılıkla ölçüyoruz.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  MAX_PUBLISH_ATTEMPTS,
  PublishingService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  companies,
  contentItems,
  events,
  publishJobs,
  users,
} from "../../src/schema/index.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let service: PublishingService;
let companyId = "";
let counter = 0;

const SYSTEM = { kind: "system" as const, id: null };

async function newContent(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(contentItems)
    .values({
      companyId,
      platform: "instagram",
      kind: "post",
      title: `İçerik ${counter}`,
      status: "scheduled", // 30 §: kuyruğa giren içerik zamanlanmış sayılır
    })
    .returning();
  return row!.id;
}

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.companyId, companyId), eq(events.type, type)));
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  service = new PublishingService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@publish.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "PublishCo", slug: "publishco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("yayın kuyruğu (30 §)", { timeout: 60_000 }, () => {
  it("zamanla → sahiplen → yayınla: içerik published, olay düşüyor", async () => {
    const contentItemId = await newContent();
    const past = new Date(Date.now() - 60_000);
    const job = await service.schedule(ctx, {
      contentItemId,
      platform: "instagram",
      scheduledAt: past,
      actor: SYSTEM,
    });
    expect(job.status).toBe("scheduled");
    expect((await eventsOfType("marketing.content.publish.scheduled")).length).toBe(1);

    const claimed = await service.claimDue(ctx, new Date());
    expect(claimed.map((c) => c.id)).toContain(job.id);
    expect(claimed[0]!.attempts).toBe(1); // sahiplenme denemeyi sayar

    await service.markPublished(ctx, job.id, {
      externalId: "ig-123",
      permalink: "https://instagram.com/p/ig-123",
      actor: SYSTEM,
    });

    const [after] = await db.select().from(publishJobs).where(eq(publishJobs.id, job.id));
    expect(after!.status).toBe("published");
    expect(after!.externalId).toBe("ig-123");
    expect(after!.publishedAt).not.toBeNull();

    const [content] = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId));
    expect(content!.status).toBe("published");

    const published = await eventsOfType("marketing.content.published");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      platform: "instagram",
      externalRef: "https://instagram.com/p/ig-123",
    });
  });

  // Asıl risk: aynı gönderi platformda iki kez belirmesin.
  it("iki dispatcher aynı anda koşsa da iş TEK KEZ sahiplenilir", async () => {
    const contentItemId = await newContent();
    await service.schedule(ctx, {
      contentItemId,
      platform: "instagram",
      scheduledAt: new Date(Date.now() - 60_000),
      actor: SYSTEM,
    });

    const now = new Date();
    const [a, b] = await Promise.all([
      service.claimDue(ctx, now),
      service.claimDue(ctx, now),
    ]);
    const claimedIds = [...a, ...b].map((j) => j.id);
    // toplamda bir kez sahiplenildi — çift yayın imkânsız
    expect(claimedIds).toHaveLength(1);
  });

  it("zamanı gelmemiş iş sahiplenilmez", async () => {
    const contentItemId = await newContent();
    const future = new Date(Date.now() + 60 * 60_000);
    const job = await service.schedule(ctx, {
      contentItemId,
      platform: "instagram",
      scheduledAt: future,
      actor: SYSTEM,
    });
    const claimed = await service.claimDue(ctx, new Date());
    expect(claimed.map((c) => c.id)).not.toContain(job.id);
    expect(await service.dueCount(ctx, new Date())).toBe(0);
  });

  it("geçici hata kuyruğa geri koyar, hak bitince failed + olay", async () => {
    const contentItemId = await newContent();
    const job = await service.schedule(ctx, {
      contentItemId,
      platform: "instagram",
      scheduledAt: new Date(Date.now() - 60_000),
      actor: SYSTEM,
    });

    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt += 1) {
      const claimed = await service.claimDue(ctx, new Date());
      expect(claimed.map((c) => c.id)).toContain(job.id);
      await service.markFailed(ctx, job.id, {
        error: `platform 503 (deneme ${attempt})`,
        retryAt: new Date(Date.now() - 60_000),
        actor: SYSTEM,
      });
    }

    const [after] = await db.select().from(publishJobs).where(eq(publishJobs.id, job.id));
    expect(after!.status).toBe("failed");
    expect(after!.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(after!.error).toContain("503");

    // olay YALNIZ hak bitince düşer — her denemede bildirim spam olurdu
    const failed = await eventsOfType("marketing.content.publish.failed");
    expect(failed).toHaveLength(1);

    // …ve artık sahiplenilmiyor
    expect((await service.claimDue(ctx, new Date())).map((c) => c.id)).not.toContain(job.id);
  });

  it("aynı işi iki kez published yapmak idempotent", async () => {
    const contentItemId = await newContent();
    const job = await service.schedule(ctx, {
      contentItemId,
      platform: "x",
      scheduledAt: new Date(Date.now() - 60_000),
      actor: SYSTEM,
    });
    await service.claimDue(ctx, new Date());
    await service.markPublished(ctx, job.id, { externalId: "x-1", actor: SYSTEM });
    await service.markPublished(ctx, job.id, { externalId: "x-1", actor: SYSTEM });
    const published = (await eventsOfType("marketing.content.published")).filter(
      (e) => (e.payload as { contentId?: string }).contentId === contentItemId,
    );
    expect(published).toHaveLength(1);
  });
});
