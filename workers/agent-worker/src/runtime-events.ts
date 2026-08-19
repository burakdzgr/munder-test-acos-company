// Canlı runtime olay yayıncısı (LIVE-CONSOLE TASK 2/3). Ajan döngüsünün
// yaşam döngüsü anları (context build / llm / tool / wait / approval) buradan
// rt.<companyId> ephemeral NATS konusuna basılır; gateway runtime:<companyId>
// WS topic'ine fanout eder. Sözleşme KAYIPLIDIR: NATS yoksa ya da yayın
// başarısızsa olay düşer, döngü asla etkilenmez — truth DB'de (agent_steps,
// approvals, llm_calls). Bu kanal chain-of-thought TAŞIMAZ.
import { connect, type NatsConnection } from "nats";
import { runtimeSubjectFor, type RuntimeEventType } from "@acos/contracts";

export interface RuntimeEventInput {
  type: RuntimeEventType;
  sessionId?: string | null | undefined;
  agentId?: string | null | undefined;
  taskId?: string | null | undefined;
  stepNo?: number | null | undefined;
  opId?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface RuntimeEventPort {
  emit(companyId: string, event: RuntimeEventInput): void;
  close(): Promise<void>;
}

/** Bağlantı tembel + arkaplanda yeniden denenir; emit HİÇBİR ZAMAN throw
 *  etmez ve beklemez (fire-and-forget). */
export function createRuntimeEventPublisher(natsUrl: string): RuntimeEventPort {
  let nats: NatsConnection | null = null;
  let connecting = false;
  let closed = false;

  const ensureConnection = () => {
    if (nats || connecting || closed) return;
    connecting = true;
    void connect({ servers: natsUrl, maxReconnectAttempts: -1 })
      .then((connection) => {
        nats = connection;
        connecting = false;
        connection.closed().then(() => {
          nats = null;
        });
      })
      .catch((err: unknown) => {
        connecting = false;
        console.warn(
          JSON.stringify({ msg: "runtime-events nats connect failed", err: String(err) }),
        );
      });
  };
  ensureConnection();

  return {
    emit(companyId, event) {
      ensureConnection();
      if (!nats) return; // kayıplı sözleşme — bağlantı gelene dek olaylar düşer
      try {
        nats.publish(
          runtimeSubjectFor(companyId),
          JSON.stringify({
            v: 1,
            companyId,
            sessionId: event.sessionId ?? null,
            agentId: event.agentId ?? null,
            taskId: event.taskId ?? null,
            stepNo: event.stepNo ?? null,
            opId: event.opId ?? null,
            ts: Date.now(),
            type: event.type,
            payload: event.payload ?? {},
          }),
        );
      } catch {
        /* yayınlanamayan olay kaybolur — döngü sürer */
      }
    },
    async close() {
      closed = true;
      await nats?.drain().catch(() => {});
      nats = null;
    },
  };
}

/** TASK 3 — aktif operation heartbeat'i: uzun süren model/araç çağrısı
 *  boyunca op.heartbeat basar; dönen fonksiyon durdurur. */
export function startOperationHeartbeat(
  port: RuntimeEventPort | undefined,
  companyId: string,
  base: Omit<RuntimeEventInput, "type" | "payload"> & { operationType: string },
  intervalMs = 10_000,
): () => void {
  if (!port) return () => {};
  const startedAt = Date.now();
  const timer = setInterval(() => {
    port.emit(companyId, {
      type: "op.heartbeat",
      sessionId: base.sessionId,
      agentId: base.agentId,
      taskId: base.taskId,
      stepNo: base.stepNo,
      opId: base.opId,
      payload: {
        operationType: base.operationType,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        status: "running",
      },
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
