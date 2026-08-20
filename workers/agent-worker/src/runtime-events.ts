// Canlı runtime olay yayıncısı (LIVE-CONSOLE TASK 2/3). Ajan döngüsünün
// yaşam döngüsü anları (context build / llm / tool / wait / approval) buradan
// rt.<companyId> ephemeral NATS konusuna basılır; gateway runtime:<companyId>
// WS topic'ine fanout eder. Sözleşme KAYIPLIDIR: NATS yoksa ya da yayın
// başarısızsa olay düşer, döngü asla etkilenmez — truth DB'de (agent_steps,
// approvals, llm_calls). Bu kanal chain-of-thought TAŞIMAZ.
import { connect, type NatsConnection } from "nats";
import { runtimeSubjectFor } from "@acos/contracts";

// Sözleşme (port arayüzü + op nabzı) ORTAK EVDE yaşar: dağıtıcı da aynı
// şekli kullanıyor ve iki ayrı tanım kaçınılmaz olarak ayrışırdı. Burada
// yalnız NATS'e basan SOMUT yayıncı kalır.
export {
  startOperationHeartbeat,
  type RuntimeEventInput,
  type RuntimeEventPort,
} from "@acos/agent-actions";
import type { RuntimeEventPort } from "@acos/agent-actions";

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
