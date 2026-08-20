// T36 — model harcamasının defteri: llm_calls'a TEK yazma yolu.
//
// Gözlenen boşluk (E4 sırasında yeniden yüzeye çıktı): tabloya yalnız ajan
// döngüsünün `callModelActivity`'si yazıyordu. Planlama/intake yolundaki
// çağrılar — intake raporu sentezi, gereksinim analizi, sihirbazın kadro
// önerisi — ve hafıza çıkarımı hiçbir satır bırakmıyordu. Founder maliyet
// ekranında şirketin harcamasının bir bölümünü GÖRMÜYORDU; "sıfır" ile
// "ölçülmemiş" aynı görünüyordu.
//
// Ajan turu bir CLI oturumu hâline gelince (E4) bu boşluk kozmetik olmaktan
// çıktı: oturum düzeyinde ölçüm taşıyıcı hâle geldi. Bu yüzden yazma yolu tek
// bir yerde toplanır — her çağrı sahasının kendi INSERT'ünü yazması, ilk şema
// değişikliğinde sessizce ayrışan kopyalar demekti.
//
// Idempotanlık: kimlik ÇAĞIRAN tarafından belirlenir (uuidv5 ile üretilen
// deterministik bir id). Aktivite yeniden denendiğinde aynı id gelir, satır
// ikinci kez yazılmaz — yeniden deneme maliyeti ikiye katlamaz.
import { and, eq } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { llmCalls } from "./schema/index.js";

export interface LlmCallRecord {
  /** Deterministik id (uuidv5) — yeniden deneme aynı satıra düşer. */
  id: string;
  purpose: string;
  providerId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached?: number | undefined;
  costCents: number;
  latencyMs?: number | undefined;
  status?: string | undefined;
  error?: string | null | undefined;
  agentId?: string | null | undefined;
  taskId?: string | null | undefined;
  agentSessionId?: string | null | undefined;
  correlationId?: string | null | undefined;
  contextTelemetry?: Record<string, unknown> | undefined;
}

/**
 * Bir model çağrısını deftere yaz. `recorded:false` = bu id zaten vardı
 * (yeniden deneme), yani yeni maliyet EKLENMEDİ.
 */
export async function recordLlmCall(
  db: GuardedDb,
  ctx: CompanyContext,
  input: LlmCallRecord,
): Promise<{ recorded: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: llmCalls.id })
      .from(llmCalls)
      .where(and(eq(llmCalls.companyId, ctx.companyId), eq(llmCalls.id, input.id)));
    if (existing) return { recorded: false };
    await tx.insert(llmCalls).values({
      id: input.id,
      companyId: ctx.companyId,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      agentSessionId: input.agentSessionId ?? null,
      purpose: input.purpose,
      providerId: input.providerId,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      tokensCached: input.tokensCached ?? 0,
      costCents: input.costCents,
      ...(input.latencyMs !== undefined && { latencyMs: input.latencyMs }),
      status: input.status ?? "ok",
      ...(input.error !== undefined && input.error !== null && { error: input.error }),
      ...(input.correlationId !== undefined &&
        input.correlationId !== null && { correlationId: input.correlationId }),
      ...(input.contextTelemetry && { contextTelemetry: input.contextTelemetry }),
    });
    return { recorded: true };
  });
}
