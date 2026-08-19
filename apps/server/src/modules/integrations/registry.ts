// D2 — entegrasyon adapter kaydı (ADR-017, 30 §).
//
// ADR-017'nin kuralı: "integrations are adapters in the `integrations` module
// of `apps/server`, exposed to agents ONLY as tools in `packages/tools` (risk
// classes enforced by the Tool Gateway)". Yani bu modül ajanlara doğrudan
// açılmaz; Tool Gateway'in dispatch kolundan çağrılır (INV-3).
//
// Kimlik bilgisi buraya PARAMETRE OLARAK GELMEZ: adapter, bağlantı kimliğini
// alır ve token'ı sunucu tarafında çözer (S2). Böylece bir ajan girdisi hiçbir
// zaman token taşıyamaz.
import type {
  SocialCapability,
  SocialChannelPort,
  SocialPublishInput,
  SocialPublishResult,
} from "@acos/domain";

export interface IntegrationContext {
  /** Bağlantı kimliğinden erişim token'ını çözer (S2 — sunucu tarafı). */
  resolveToken(connectionId: string): Promise<string | null>;
  /** Tüm dış çağrılar egress allowlist proxy'sinden geçer (27 §12, S8). */
  fetch: typeof fetch;
}

export class IntegrationError extends Error {
  constructor(
    readonly code: "NOT_CONNECTED" | "UNSUPPORTED" | "PLATFORM_ERROR",
    message: string,
    /** Geçici hata: kuyruk yeniden denemeli (30 § "platform API instability"). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/**
 * Instagram Graph API adapter'ı — 30 §'in ilk adapter'ı.
 *
 * Yayın iki adımlıdır (Graph API'nin kendi akışı): önce medya konteyneri
 * oluşturulur, sonra publish edilir. Bu yüzden `publishPost` tek bir HTTP
 * çağrısı değildir ve ilk adım başarılı olup ikincisi düşerse iş YARIM kalır
 * — kuyruk bu yüzden `idempotencyKey` taşıyor ve tekrar denemede aynı
 * konteyner yeniden kullanılabilsin diye anahtar Graph API'ye geçiriliyor.
 */
export class InstagramAdapter implements SocialChannelPort {
  readonly platform = "instagram";
  private static readonly SUPPORTED: ReadonlySet<SocialCapability> = new Set([
    "publishPost",
    "publishReel",
    "getPostMetrics",
    "getAccountMetrics",
  ]);

  constructor(
    private readonly ctx: IntegrationContext,
    private readonly baseUrl = "https://graph.instagram.com/v21.0",
  ) {}

  supports(capability: SocialCapability): boolean {
    return InstagramAdapter.SUPPORTED.has(capability);
  }

  private async call(
    connectionId: string,
    path: string,
    init: { method: "GET" | "POST"; body?: Record<string, string> },
  ): Promise<Record<string, unknown>> {
    const token = await this.ctx.resolveToken(connectionId);
    if (!token) {
      throw new IntegrationError(
        "NOT_CONNECTED",
        `instagram bağlantısı çözülemedi (${connectionId}) — Founder hesabı bağlamalı`,
      );
    }
    const url = new URL(`${this.baseUrl}${path}`);
    const res = await this.ctx.fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body && { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(init.body && { body: new URLSearchParams(init.body).toString() }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // 5xx ve 429 geçicidir; 4xx kalıcıdır (yanlış izin, silinmiş medya…)
      const retryable = res.status >= 500 || res.status === 429;
      const detail =
        (payload.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      throw new IntegrationError("PLATFORM_ERROR", `instagram: ${detail}`, retryable);
    }
    return payload;
  }

  async publishPost(input: SocialPublishInput): Promise<SocialPublishResult> {
    return this.publishMedia(input, "IMAGE");
  }

  async publishReel(input: SocialPublishInput): Promise<SocialPublishResult> {
    return this.publishMedia(input, "REELS");
  }

  private async publishMedia(
    input: SocialPublishInput,
    mediaType: "IMAGE" | "REELS",
  ): Promise<SocialPublishResult> {
    const media = input.mediaUrls?.[0];
    if (!media) {
      throw new IntegrationError("PLATFORM_ERROR", "instagram gönderisi medya URL'i ister");
    }
    // 1) konteyner
    const container = await this.call(input.connectionId, "/me/media", {
      method: "POST",
      body: {
        [mediaType === "REELS" ? "video_url" : "image_url"]: media,
        caption: input.caption,
        ...(mediaType === "REELS" && { media_type: "REELS" }),
        // aynı anahtarla ikinci deneme yeni gönderi ÜRETMESİN
        client_business_id: input.idempotencyKey,
      },
    });
    const creationId = String(container.id ?? "");
    if (!creationId) {
      throw new IntegrationError("PLATFORM_ERROR", "instagram konteyner kimliği dönmedi", true);
    }
    // 2) yayın
    const published = await this.call(input.connectionId, "/me/media_publish", {
      method: "POST",
      body: { creation_id: creationId },
    });
    const externalId = String(published.id ?? "");
    if (!externalId) {
      throw new IntegrationError("PLATFORM_ERROR", "instagram gönderi kimliği dönmedi", true);
    }
    return {
      externalId,
      ...(typeof published.permalink === "string" && { permalink: published.permalink }),
    };
  }

  async getPostMetrics(input: { connectionId: string; externalId: string }) {
    const payload = await this.call(
      input.connectionId,
      `/${input.externalId}/insights?metric=impressions,reach,likes,comments`,
      { method: "GET" },
    );
    const values: Record<string, number> = {};
    for (const item of (payload.data as Array<Record<string, unknown>>) ?? []) {
      const name = String(item.name ?? "");
      const value = (item.values as Array<{ value?: unknown }> | undefined)?.[0]?.value;
      if (name && typeof value === "number") values[name] = value;
    }
    return { values, window: "lifetime" };
  }

  async getAccountMetrics(input: { connectionId: string }) {
    const payload = await this.call(
      input.connectionId,
      "/me/insights?metric=follower_count,reach&period=day",
      { method: "GET" },
    );
    const values: Record<string, number> = {};
    for (const item of (payload.data as Array<Record<string, unknown>>) ?? []) {
      const name = String(item.name ?? "");
      const value = (item.values as Array<{ value?: unknown }> | undefined)?.[0]?.value;
      if (name && typeof value === "number") values[name] = value;
    }
    return { values, window: "1d" };
  }
}

/**
 * Platform → adapter. Bilinmeyen platform sessizce atlanmaz: kuyruk
 * `UNSUPPORTED` görüp işi kalıcı hataya düşürür ve org düşüş yolunu
 * (Founder'a manuel yayın görevi) seçebilir.
 */
export function createIntegrationRegistry(
  ctx: IntegrationContext,
  overrides: Record<string, SocialChannelPort> = {},
): Map<string, SocialChannelPort> {
  const registry = new Map<string, SocialChannelPort>();
  registry.set("instagram", new InstagramAdapter(ctx));
  for (const [platform, adapter] of Object.entries(overrides)) registry.set(platform, adapter);
  return registry;
}
