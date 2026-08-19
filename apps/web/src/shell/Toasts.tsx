// Toast stack (36 §9 — U11): bottom-right, WS-fed via notificationsStore
// (approval.requested / goal task.completed / memory.created /
// security.alert). Each toast auto-expires; the bell keeps the history.
import { useEffect } from "react";
import { useNotifications, type ToastItem } from "../stores/notifications.js";

const KIND_COLOR: Record<ToastItem["kind"], string> = {
  ok: "#2ec26a",
  warn: "#ffcb47",
  danger: "#ff4d4d",
};

function Toast({ toast }: { toast: ToastItem }) {
  const dismiss = useNotifications((s) => s.dismissToast);
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), 5000);
    return () => window.clearTimeout(timer);
  }, [toast.id, dismiss]);
  return (
    <button
      onClick={() => dismiss(toast.id)}
      data-testid="toast"
      className="toast-slide-in block min-w-[220px] max-w-[300px] rounded-md border border-acos-line bg-acos-bg2 px-3 py-2 text-left shadow-lg"
      style={{ borderLeft: `3px solid ${KIND_COLOR[toast.kind]}` }}
    >
      <div className="text-[11px] font-semibold text-acos-fg0">{toast.title}</div>
      <div className="mt-0.5 truncate text-[9.5px] text-acos-fg2">{toast.desc}</div>
    </button>
  );
}

export function Toasts() {
  const toasts = useNotifications((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-8 right-3 z-40 flex flex-col gap-1.5" data-testid="toasts">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
