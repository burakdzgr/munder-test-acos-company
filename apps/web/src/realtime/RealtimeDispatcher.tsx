// RealtimeDispatcher (24 §5): one instance per active company, mounted by the
// /c/$companyId layout. Owns the events + presence subscriptions and routes
// frames into Zustand stores + TanStack Query invalidation. Stores are the
// only WS consumers — components read stores/queries, never the socket.
import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  EventSchema,
  PresenceStateSchema,
  type Event,
  type RealtimeStatus,
  type Task,
} from "@acos/contracts";
import { getRealtimeClient } from "./client.js";
import { invalidationKeysFor } from "./invalidation.js";
import { useEventTicker } from "../stores/eventTicker.js";
import { usePresence } from "../stores/presence.js";
import { useOfficeStore } from "../stores/office.js";
import { useNotifications } from "../stores/notifications.js";

/** WS event → toast/bell mapping (36 §9 — U11). */
function notifyFor(companyId: string, event: Event, queryClient: QueryClient): void {
  const push = useNotifications.getState().push;
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "approval.requested": {
      const desc = String(payload.title ?? payload.kind ?? "yeni onay isteği");
      push({ kind: "warn", title: "Onay bekliyor", desc });
      // U14a: Electron shell → native OS notification (click opens Approvals)
      window.acosDesktop?.notify("Onay bekliyor", desc, `/c/${companyId}/approvals`);
      return;
    }
    case "task.completed": {
      // goal-level only (36 §9) — resolve the kind from the cached board
      const taskId = event.subject.taskId;
      const cached = queryClient.getQueryData<Task[]>([companyId, "tasks", "board"]);
      const task = taskId ? cached?.find((t) => t.id === taskId) : undefined;
      if (task && (task.kind === "goal" || task.kind === "initiative")) {
        push({ kind: "ok", title: "Hedef tamamlandı", desc: task.title });
      }
      return;
    }
    case "memory.created":
      push({
        kind: "ok",
        title: "Yeni anı",
        desc: String(payload.title ?? "şirket hafızasına eklendi"),
      });
      return;
    case "security.alert": {
      const desc = String(payload.reason ?? payload.kind ?? "detay için Events'e bak");
      push({ kind: "danger", title: "Güvenlik uyarısı", desc });
      window.acosDesktop?.notify("Güvenlik uyarısı", desc, `/c/${companyId}/events`);
      return;
    }
    default:
      return;
  }
}

export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>(() => getRealtimeClient().getStatus());
  useEffect(() => getRealtimeClient().onStatus(setStatus), []);
  return status;
}

export function RealtimeDispatcher({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const pushEvents = useEventTicker((s) => s.push);
  const resetTicker = useEventTicker((s) => s.reset);
  const applySnapshot = usePresence((s) => s.applySnapshot);
  const setBadge = usePresence((s) => s.setBadge);
  const resetPresence = usePresence((s) => s.reset);
  const officeSnapshot = useOfficeStore((s) => s.applySnapshot);
  const officeEnqueue = useOfficeStore((s) => s.enqueue);
  const officeReset = useOfficeStore((s) => s.reset);

  useEffect(() => {
    const client = getRealtimeClient();
    resetTicker();
    resetPresence();
    officeReset();

    const unsubscribeEvents = client.subscribe(`events:${companyId}`, (batch) => {
      const parsed: Event[] = [];
      for (const raw of batch) {
        const result = EventSchema.safeParse(raw);
        if (result.success) parsed.push(result.data);
      }
      if (parsed.length === 0) return;
      pushEvents(parsed);
      const invalidated = new Set<string>();
      for (const event of parsed) {
        for (const key of invalidationKeysFor(companyId, event)) {
          const cacheKey = JSON.stringify(key);
          if (invalidated.has(cacheKey)) continue;
          invalidated.add(cacheKey);
          void queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }
        notifyFor(companyId, event, queryClient);
      }
    });

    const unsubscribePresence = client.subscribe(`presence:${companyId}`, (batch, meta) => {
      if (meta.kind === "snapshot" && batch[0]) {
        const parsed = PresenceStateSchema.safeParse(batch[0]);
        if (parsed.success) {
          applySnapshot(parsed.data);
          officeSnapshot(parsed.data);
        }
        return;
      }
      // deltas: office.* instructions → officeStore (invariant enforced there);
      // status changes also refresh the Agent Monitor badge map
      for (const instruction of batch) {
        officeEnqueue(instruction);
        const status = instruction as { type?: string; agentId?: string; badge?: string };
        if (status.type === "office.status.changed" && status.agentId && status.badge) {
          setBadge(status.agentId, status.badge as never);
        }
      }
    });

    return () => {
      unsubscribeEvents();
      unsubscribePresence();
    };
  }, [
    companyId,
    queryClient,
    pushEvents,
    resetTicker,
    applySnapshot,
    setBadge,
    resetPresence,
    officeSnapshot,
    officeEnqueue,
    officeReset,
  ]);

  return null;
}
