// D3 — yayın dispatcher'ı (30 §): kuyruk ile platform adapter'ı arasındaki tel.
//
// Kuyruk (`PublishingService`) "hangi iş, ne zaman, kaç deneme" sorusunu
// yönetiyor; adapter (ADR-017) platforma gidiyor. Bu döngü ikisini birleştirip
// publish→metrik→öğren zincirinin ilk halkasını kapatıyor.
//
// Tasarım kararları:
// - Adapter'ın hata sınıflaması kuyruğa BİREBİR taşınır: geçici hata işi
//   kuyruğa geri koyar, kalıcı hata denemeleri tüketir. Aksi hâlde yanlış
//   izinli bir hesap üç kez denenip üç kez para/kota yakardı.
// - Desteklenmeyen platform sessizce beklemez: iş kalıcı hataya düşer ki
//   30 §'in düşüş yolu (Founder'a manuel yayın görevi) tetiklenebilsin.
// - Yayın çağrısı idempotency anahtarı olarak İŞ KİMLİĞİNİ taşır; aynı iş
//   tekrar denendiğinde platformda ikinci gönderi oluşmaz.
import type { SocialChannelPort } from "@acos/domain";
import { PublishingService, companyContext, type GuardedDb } from "@acos/db";
import { IntegrationError } from "./registry.js";

export interface PublishDispatcherDeps {
  guardedDb: GuardedDb;
  /** platform → adapter (createIntegrationRegistry). */
  adapters: Map<string, SocialChannelPort>;
  /** İçeriğin gövdesini ve medyasını okur — kuyruk yalnız kimlik taşır. */
  loadContent: (
    companyId: string,
    contentItemId: string,
  ) => Promise<{ caption: string; mediaUrls: string[]; connectionId: string | null } | null>;
  onError?: ((err: unknown) => void) | undefined;
}

export interface DispatchOutcome {
  claimed: number;
  published: number;
  failed: number;
  retried: number;
}

export function createPublishDispatcher(deps: PublishDispatcherDeps) {
  const publishing = new PublishingService(deps.guardedDb);

  return {
    /** Zamanı gelmiş işleri bir tur işler. */
    async runOnce(companyId: string, now = new Date()): Promise<DispatchOutcome> {
      const ctx = companyContext(companyId);
      const jobs = await publishing.claimDue(ctx, now);
      const outcome: DispatchOutcome = {
        claimed: jobs.length,
        published: 0,
        failed: 0,
        retried: 0,
      };
      const actor = { kind: "system" as const, id: null };

      for (const job of jobs) {
        try {
          const adapter = deps.adapters.get(job.platform);
          if (!adapter || !adapter.supports("publishPost") || !adapter.publishPost) {
            throw new IntegrationError(
              "UNSUPPORTED",
              `"${job.platform}" için yayın adapter'ı yok — manuel yayın gerekiyor`,
            );
          }
          const content = await deps.loadContent(companyId, job.contentItemId);
          if (!content) {
            throw new IntegrationError("UNSUPPORTED", "içerik bulunamadı");
          }
          if (!content.connectionId) {
            throw new IntegrationError(
              "NOT_CONNECTED",
              `${job.platform} hesabı bağlı değil — Founder bağlamalı`,
            );
          }
          const result = await adapter.publishPost({
            connectionId: content.connectionId,
            caption: content.caption,
            mediaUrls: content.mediaUrls,
            // aynı iş tekrar denenirse platformda ikinci gönderi oluşmasın
            idempotencyKey: job.id,
          });
          await publishing.markPublished(ctx, job.id, {
            externalId: result.externalId,
            ...(result.permalink && { permalink: result.permalink }),
            actor,
          });
          outcome.published += 1;
        } catch (err) {
          const retryable = err instanceof IntegrationError ? err.retryable : true;
          const message = err instanceof Error ? err.message : String(err);
          deps.onError?.(err);
          const updated = await publishing.markFailed(ctx, job.id, {
            error: message,
            // geçici hata bir sonraki tura ötelenir; kalıcı hata deneme
            // hakkını tüketmeden doğrudan sonuçlanır (üç kez denemek yalnız
            // kota ve para yakardı)
            ...(retryable ? { retryAt: new Date(now.getTime() + 60_000) } : { permanent: true }),
            actor,
          });
          if (updated.status === "failed") outcome.failed += 1;
          else outcome.retried += 1;
        }
      }
      return outcome;
    },
  };
}
