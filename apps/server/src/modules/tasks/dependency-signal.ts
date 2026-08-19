// A4 — `dependencyResolved` sinyal köprüsü (07 §3, 09 §9, 10 §5).
//
// 07 §3 birebir şunu söylüyor: "When a predecessor reaches DONE, the
// state-machine service emits `task.dependency.resolved` and **signals
// `dependencyResolved` into every waiting dependent workflow** (08 §5)."
//
// Kodda emit vardı (TaskStateService.resolveDependents), workflow tarafında
// handler vardı — ama arada GÖNDEREN yoktu. Repoda tek bir
// signal("dependencyResolved", …) çağrısı bile bulunmuyordu. Sonuç: bir
// bağımlılık çözülse bile bekleyen görev uyanmıyor, yalnız kendi timeout'u
// dolduğunda devam ediyordu. DAG'ın "A bitince B başlasın" vaadi pratikte
// "A bitince B bir süre sonra fark eder"e dönüşmüştü.
//
// Köprü mesaj teslimatının (11 §4.4) aynı kalıbında: olayı durable bir
// JetStream consumer'ından oku, hedefin canlı oturumunu bul, sinyali gönder.
// Teslimat fire-and-forget (09 §9): ulaşılamayan bir workflow hata değildir —
// görev tablosundaki bağımlılık satırı zaten çözülmüş durumda ve sweep (A6)
// ölü workflow'u ayrıca toparlar.
import type { NatsConnection } from "nats";
import { STREAM_NAME } from "../events/jetstream.js";

export interface DependencySignalInput {
  companyId: string;
  /** Bekleyen (bağımlı) görev — sinyalin gideceği workflow bunun. */
  taskId: string;
  /** Biten öncül. */
  dependsOnTaskId: string;
  result: "DONE" | "FAILED" | "CANCELLED";
}

export interface DependencyBridgeOptions {
  nats: NatsConnection;
  signal: (input: DependencySignalInput) => Promise<void>;
  onError: (err: unknown) => void;
}

export interface DependencyBridgeHandle {
  stop: () => Promise<void>;
}

interface DependencyEnvelope {
  companyId?: string;
  seq?: number;
  type?: string;
  subject?: { taskId?: string | null };
  payload?: Record<string, unknown>;
}

/** Olay `result: "done"` yazıyor; sinyal sözleşmesi büyük harf bekliyor. */
function normalizeResult(raw: unknown): "DONE" | "FAILED" | "CANCELLED" {
  const value = typeof raw === "string" ? raw.toUpperCase() : "DONE";
  return value === "FAILED" || value === "CANCELLED" ? value : "DONE";
}

export async function startDependencySignalBridge(
  options: DependencyBridgeOptions,
): Promise<DependencyBridgeHandle> {
  const js = options.nats.jetstream();
  const consumer = await js.consumers.get(STREAM_NAME, "workflow-signals");
  const messages = await consumer.consume();
  const lastSeq = new Map<string, number>();

  const loop = (async () => {
    for await (const msg of messages) {
      try {
        const envelope = JSON.parse(msg.string()) as DependencyEnvelope;
        const companyId = envelope.companyId;
        const taskId = envelope.subject?.taskId ?? null;
        const dependsOnTaskId = envelope.payload?.["dependsOnTaskId"];
        if (
          companyId &&
          taskId &&
          typeof dependsOnTaskId === "string" &&
          envelope.type === "task.dependency.resolved"
        ) {
          // 10 §6.1 per-company high-water mark, memory-trigger ile aynı kalıp
          const seq = typeof envelope.seq === "number" ? envelope.seq : 0;
          const seen = lastSeq.get(companyId) ?? 0;
          if (seq === 0 || seq > seen) {
            await options.signal({
              companyId,
              taskId,
              dependsOnTaskId,
              result: normalizeResult(envelope.payload?.["result"]),
            });
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
