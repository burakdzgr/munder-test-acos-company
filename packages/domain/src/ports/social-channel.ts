// D2/D3 — `SocialChannelPort` (30-PHASE-2 §, ADR-017).
//
// 30 §'in birebir tarifi: "Port (in `packages/domain`): `SocialChannelPort`
// with capabilities: publishPost, publishReel, schedulePost, getPostMetrics,
// getAccountMetrics, listComments, replyToComment, deleteOwnPost. Adapters
// implement a capability subset and declare it (`supports()`)."
//
// Burası SAF tip katmanı: hiçbir IO, hiçbir sağlayıcı SDK'sı yok. Adapter'lar
// `apps/server`'ın integrations modülünde yaşar ve ajanlara YALNIZ Tool
// Gateway üzerinden araç olarak açılır (ADR-017; INV-3). Portun burada
// durmasının sebebi de bu: domain, hangi platformun var olduğunu bilmeden
// yetenekleri konuşabilsin.
export const SOCIAL_CAPABILITIES = [
  "publishPost",
  "publishReel",
  "schedulePost",
  "getPostMetrics",
  "getAccountMetrics",
  "listComments",
  "replyToComment",
  "deleteOwnPost",
] as const;
export type SocialCapability = (typeof SOCIAL_CAPABILITIES)[number];

export interface SocialPublishInput {
  /** Bağlantı kimliği — kimlik bilgisi sunucu tarafında çözülür (S2). */
  connectionId: string;
  /** Yayınlanacak içeriğin gövdesi (metin/başlık). */
  caption: string;
  /** Medya URL'leri; boş dizi metin gönderisi demektir. */
  mediaUrls?: string[] | undefined;
  /** Idempotency: aynı iş iki kez gönderilirse platformda tek gönderi olur. */
  idempotencyKey: string;
}

export interface SocialPublishResult {
  /** Platformun verdiği kimlik — `publish_jobs.external_id`'ye yazılır. */
  externalId: string;
  /** Varsa gönderinin herkese açık adresi. */
  permalink?: string | undefined;
}

export interface SocialMetrics {
  /** Ham metrik anahtar/değer çiftleri (`metric_snapshots` satırlarına gider). */
  values: Readonly<Record<string, number>>;
  /** Ölçümün kapsadığı pencere: "lifetime", "1d", "7d" … */
  window: string;
}

export interface SocialComment {
  id: string;
  authorHandle: string;
  /** S5: platformdan gelen metin GÜVENİLMEZDİR — çağıran çitler. */
  text: string;
  createdAt: string;
}

/**
 * Bir platform adapter'ı. Her yetenek opsiyonel; adapter hangilerini
 * gerçekten uyguladığını `supports()` ile beyan eder — çağıran, olmayan bir
 * yeteneği çağırmak yerine düşüşü (ör. Founder'a manuel yayın görevi)
 * seçebilsin diye.
 */
export interface SocialChannelPort {
  readonly platform: string;
  supports(capability: SocialCapability): boolean;
  publishPost?(input: SocialPublishInput): Promise<SocialPublishResult>;
  publishReel?(input: SocialPublishInput): Promise<SocialPublishResult>;
  schedulePost?(input: SocialPublishInput & { scheduledAt: string }): Promise<SocialPublishResult>;
  getPostMetrics?(input: { connectionId: string; externalId: string }): Promise<SocialMetrics>;
  getAccountMetrics?(input: { connectionId: string }): Promise<SocialMetrics>;
  listComments?(input: { connectionId: string; externalId: string }): Promise<SocialComment[]>;
  replyToComment?(input: {
    connectionId: string;
    commentId: string;
    text: string;
  }): Promise<{ externalId: string }>;
  deleteOwnPost?(input: { connectionId: string; externalId: string }): Promise<void>;
}

/** Beyan ile gerçeği ayrı tutmamak için: yetenek hem beyan edilmeli hem var olmalı. */
export function capabilitiesOf(adapter: SocialChannelPort): SocialCapability[] {
  return SOCIAL_CAPABILITIES.filter(
    (capability) =>
      adapter.supports(capability) && typeof adapter[capability] === "function",
  );
}
