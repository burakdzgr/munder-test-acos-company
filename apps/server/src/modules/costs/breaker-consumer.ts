// Devre kesici consumer'ı (26 §5). A4'ün canlı kanıtı sırasında çıkan boşluk:
//
// 26 §5 madde 3 kesiciyi şöyle tarif ediyor — "a daily company-level hard
// budget breach emits budget.exceeded {scope: company}; the policy engine
// consumer then pauses all non-critical agents (**sessions signalled
// `managerDirective(pause)`**, agents → paused, new workflow starts refused)".
//
// Kodda bunun yalnız veritabanı yarısı vardı: CostService.tripBreaker ajan
// satırlarını `paused` yapıyordu. Ama KOŞAN agentTaskWorkflow bu satırı
// okumuyor — bir sonraki adımını yine de başlatıyor, yine LLM parası
// harcıyordu. Kesici "duracak" derken durmuyordu.
//
// Sinyal makinesi zaten hazırdı (workflows/signals.ts + workflow'un pause/
// resume handler'ı, guards.int.test.ts kapsıyor); eksik olan tek şey
// kesiciden sinyale giden teldi. Burası o tel.
//
// Neden consumer, neden tripBreaker'ın içi değil: duraklatma bir transaction
// içinde oluyor ve o transaction geri sarılabilir. Sinyali commit'ten önce
// göndermek olmayan bir ihlal için ajanı parklardı. `budget.exceeded` olayı
// outbox'tan geçtiği için commit'i garantili, ve `cost-aggregator` durable'ı
// T21'de `co.*.budget.>` filtresiyle ZATEN provision edilmişti — tüketicisi
// yoktu. Doküman "policy engine consumer" derken tarif ettiği yer burası.
//
// Idempotency: 10 §6.1 per-company seq high-water mark, memory-trigger ile
// aynı kalıp. Sinyal zaten idempotent (aynı direktif iki kez = aynı durum).
import type { NatsConnection } from "nats";
import { STREAM_NAME } from "../events/jetstream.js";

export interface BreakerDirectiveInput {
  companyId: string;
  agentIds: string[];
  directive: "pause" | "resume";
  reason: string;
}

export interface BreakerConsumerOptions {
  nats: NatsConnection;
  /**
   * Canlı oturumlara managerDirective sinyalini taşır. Ulaşılamayan bir
   * workflow (çoktan bitmiş, hiç başlamamış) hata değildir — ajan satırı
   * zaten `paused`, yeni başlatmalar onu görür.
   */
  signal: (input: BreakerDirectiveInput) => Promise<void>;
  /**
   * `budget.restored` yalnız kesicinin duraklattıklarını devam ettirmeli;
   * hangi ajanların o kapsamda olduğunu veritabanı bilir (agent.resumed
   * olayları restoreBudget içinde basılıyor), o yüzden consumer resume
   * hedefini olaydan değil bu geri çağrıdan öğrenir.
   */
  resumedAgentIds?: ((companyId: string) => Promise<string[]>) | undefined;
  onError: (err: unknown) => void;
}

export interface BreakerConsumerHandle {
  stop: () => Promise<void>;
}

interface BudgetEnvelope {
  companyId?: string;
  seq?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

export async function startBreakerConsumer(
  options: BreakerConsumerOptions,
): Promise<BreakerConsumerHandle> {
  const js = options.nats.jetstream();
  const consumer = await js.consumers.get(STREAM_NAME, "cost-aggregator");
  const messages = await consumer.consume();
  const lastSeq = new Map<string, number>();

  async function handle(envelope: BudgetEnvelope): Promise<void> {
    const companyId = envelope.companyId;
    if (!companyId) return;

    if (envelope.type === "budget.exceeded") {
      // Yalnız şirket kapsamlı hard ihlal kesicidir (26 §5 madde 3); görev
      // kapsamlı ihlal görevin kendi guard'ının işi (08 §9a).
      if (envelope.payload?.["scope"] !== "company") return;
      const paused = envelope.payload["pausedAgentIds"];
      const agentIds = Array.isArray(paused) ? paused.filter((id): id is string => typeof id === "string") : [];
      if (agentIds.length === 0) return;
      await options.signal({
        companyId,
        agentIds,
        directive: "pause",
        reason: "company budget circuit breaker (26 §5)",
      });
      return;
    }

    if (envelope.type === "budget.restored" && options.resumedAgentIds) {
      const agentIds = await options.resumedAgentIds(companyId);
      if (agentIds.length === 0) return;
      await options.signal({
        companyId,
        agentIds,
        directive: "resume",
        reason: "budget restored (26 §5)",
      });
    }
  }

  const loop = (async () => {
    for await (const msg of messages) {
      try {
        const envelope = JSON.parse(msg.string()) as BudgetEnvelope;
        const companyId = envelope.companyId;
        if (companyId) {
          const seq = typeof envelope.seq === "number" ? envelope.seq : 0;
          const seen = lastSeq.get(companyId) ?? 0;
          if (seq === 0 || seq > seen) {
            await handle(envelope);
            if (seq > seen) lastSeq.set(companyId, seq);
          }
        }
        msg.ack();
      } catch (err) {
        options.onError(err);
        msg.nak(5_000); // yeniden dağıt; max_deliver 5 → DLQ (T21)
      }
    }
  })().catch((err) => options.onError(err));

  return {
    stop: async () => {
      messages.stop();
      await loop;
    },
  };
}
