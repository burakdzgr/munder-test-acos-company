// D3 — yayın kuyruğu (30 §, `publish_jobs`).
//
// `publish_jobs` tablosu ve `marketing.content.publish.*` olayları şemada ve
// katalogda vardı; `apps/server`, `workers` ve `services` içinde tek bir
// referansı yoktu. Yani pazarlama tarafı "içerik üret"ten öteye geçemiyordu:
// yayınlanmıyor, ölçülmüyor, öğrenilmiyordu — publish→metrik→öğren döngüsü
// hiç kapanmıyordu.
//
// Bu modül kuyruğun DURUM MAKİNESİ ve muhasebesidir; platforma giden çağrı
// adapter'ın (integrations modülü, ADR-017) işidir. Ayrım bilinçli: adapter
// değişse de "hangi iş kime ne zaman gitti, kaç kez denendi" kaydı aynı
// kalır.
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { appendEvents, type EventActor, type Tx } from "./outbox.js";
import { parseEventPayload } from "@acos/events";
import { contentItems, publishJobs } from "./schema/index.js";

/** 30 §: platform API'leri kırılgan; kalıcı hata ile geçici hatayı ayırırız. */
export const MAX_PUBLISH_ATTEMPTS = 3;

export class PublishError extends Error {
  constructor(
    readonly code: "JOB_NOT_FOUND" | "JOB_STATE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

async function emitDomainEvent(
  tx: Tx,
  ctx: CompanyContext,
  input: Parameters<typeof appendEvents>[2][number],
) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  await appendEvents(tx, ctx, [{ ...input, payload }]);
}

export interface ClaimedJob {
  id: string;
  contentItemId: string;
  platform: string;
  attempts: number;
  scheduledAt: Date;
}

export class PublishingService {
  constructor(private readonly db: GuardedDb) {}

  /** İçeriği kuyruğa al (30 §: schedulePost yeteneği olmayan platformlarda da
   *  zamanlama BİZDE tutulur — adapter yalnız "şimdi yayınla"yı bilir). */
  async schedule(
    ctx: CompanyContext,
    input: { contentItemId: string; platform: string; scheduledAt: Date; actor: EventActor },
  ) {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .insert(publishJobs)
        .values({
          companyId: ctx.companyId,
          contentItemId: input.contentItemId,
          platform: input.platform,
          scheduledAt: input.scheduledAt,
          status: "scheduled",
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "marketing.content.publish.scheduled",
        actor: input.actor,
        payload: {
          contentId: input.contentItemId,
          scheduledAt: input.scheduledAt.toISOString(),
        },
      });
      return job!;
    });
  }

  /**
   * Zamanı gelmiş işleri ATOMİK olarak sahiplen. İki dispatcher aynı anda
   * koşarsa aynı gönderi platforma iki kez gitmemeli.
   *
   * Doğruluğu sağlayan şey tek ifadelik `UPDATE … WHERE status='scheduled'`:
   * ikinci işlem kilidi bekler, kilit çözülünce yüklemi YENİDEN değerlendirir
   * ve işi artık `publishing` görüp atlar. `SKIP LOCKED` doğruluk için değil,
   * AKIŞ için: onsuz ikinci dispatcher birincinin commit'ini boş yere
   * bekler. (Kaldırıp ölçtük — çift sahiplenme yine olmuyor.)
   *
   * Kuyruk indeksi (publish_jobs_dispatcher_pidx) tam bu sorgu için var.
   */
  async claimDue(ctx: CompanyContext, now: Date, limit = 10): Promise<ClaimedJob[]> {
    const rows = await this.db.execute(sql`
      UPDATE ${publishJobs} AS j
         SET status = 'publishing', attempts = j.attempts + 1
       WHERE j.id IN (
         SELECT c.id FROM ${publishJobs} AS c
          WHERE c.company_id = ${ctx.companyId}
            AND c.status = 'scheduled'
            AND c.scheduled_at <= ${now}
          ORDER BY c.scheduled_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING j.id, j.content_item_id, j.platform, j.attempts, j.scheduled_at
    `);
    return (rows.rows as Array<{
      id: string;
      content_item_id: string;
      platform: string;
      attempts: number;
      scheduled_at: string | Date;
    }>).map((r) => ({
      id: r.id,
      contentItemId: r.content_item_id,
      platform: r.platform,
      attempts: Number(r.attempts),
      scheduledAt: new Date(r.scheduled_at),
    }));
  }

  /** Yayın başarılı: dış kimlik + içerik durumu + olay. */
  async markPublished(
    ctx: CompanyContext,
    jobId: string,
    input: { externalId: string; permalink?: string | undefined; actor: EventActor },
  ) {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(publishJobs)
        .where(and(eq(publishJobs.companyId, ctx.companyId), eq(publishJobs.id, jobId)))
        .for("update");
      if (!job) throw new PublishError("JOB_NOT_FOUND", "publish job not found");
      if (job.status === "published") return job; // idempotent tekrar
      const [updated] = await tx
        .update(publishJobs)
        .set({
          status: "published",
          externalId: input.externalId,
          publishedAt: new Date(),
          error: null,
        })
        .where(and(eq(publishJobs.companyId, ctx.companyId), eq(publishJobs.id, jobId)))
        .returning();
      await tx
        .update(contentItems)
        .set({ status: "published" })
        .where(
          and(eq(contentItems.companyId, ctx.companyId), eq(contentItems.id, job.contentItemId)),
        );
      await emitDomainEvent(tx, ctx, {
        type: "marketing.content.published",
        actor: input.actor,
        payload: {
          contentId: job.contentItemId,
          platform: job.platform,
          externalRef: input.permalink ?? input.externalId,
        },
      });
      return updated!;
    });
  }

  /**
   * Yayın başarısız. Deneme hakkı kaldıysa iş kuyruğa geri döner (geçici
   * hata varsayımı); hak bittiyse `failed` olur ve olay düşer — 30 §'in
   * "capability flags let the org degrade" düşüş yolu buradan tetiklenir
   * (Founder'a manuel yayın görevi açmak çağıranın işi).
   */
  async markFailed(
    ctx: CompanyContext,
    jobId: string,
    input: {
      error: string;
      retryAt?: Date | undefined;
      /**
       * Kalıcı hata (yanlış izin, silinmiş medya, desteklenmeyen platform):
       * deneme hakkını tüketmeden doğrudan `failed`. Üç kez denemek burada
       * yalnız kota ve para yakardı.
       */
      permanent?: boolean | undefined;
      actor: EventActor;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(publishJobs)
        .where(and(eq(publishJobs.companyId, ctx.companyId), eq(publishJobs.id, jobId)))
        .for("update");
      if (!job) throw new PublishError("JOB_NOT_FOUND", "publish job not found");
      const exhausted = input.permanent === true || job.attempts >= MAX_PUBLISH_ATTEMPTS;
      const [updated] = await tx
        .update(publishJobs)
        .set({
          status: exhausted ? "failed" : "scheduled",
          error: input.error.slice(0, 2000),
          ...(!exhausted && input.retryAt && { scheduledAt: input.retryAt }),
        })
        .where(and(eq(publishJobs.companyId, ctx.companyId), eq(publishJobs.id, jobId)))
        .returning();
      if (exhausted) {
        await emitDomainEvent(tx, ctx, {
          type: "marketing.content.publish.failed",
          actor: input.actor,
          payload: { contentId: job.contentItemId, error: input.error.slice(0, 500) },
        });
      }
      return updated!;
    });
  }

  /** Kuyruk görünümü (pano + testler). */
  async list(ctx: CompanyContext, limit = 50) {
    return this.db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.companyId, ctx.companyId))
      .orderBy(asc(publishJobs.scheduledAt))
      .limit(limit);
  }

  /** Zamanı gelmiş ama henüz sahiplenilmemiş iş sayısı (gözlemlenebilirlik). */
  async dueCount(ctx: CompanyContext, now: Date): Promise<number> {
    const rows = await this.db
      .select({ id: publishJobs.id })
      .from(publishJobs)
      .where(
        and(
          eq(publishJobs.companyId, ctx.companyId),
          eq(publishJobs.status, "scheduled"),
          lte(publishJobs.scheduledAt, now),
        ),
      );
    return rows.length;
  }
}
