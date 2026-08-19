// notificationsStore (36 §9 — U11): WS-fed toasts + the top-bar bell.
// RealtimeDispatcher pushes on approval.requested / goal-level
// task.completed / memory.created / security.alert; toasts auto-expire in
// the renderer, the bell keeps an unread counter + a recent list. U14
// forwards the same pushes to Electron native notifications.
import { create } from "zustand";

export type ToastKind = "ok" | "warn" | "danger";
export interface ToastItem {
  id: string;
  kind: ToastKind;
  title: string;
  desc: string;
  at: number;
}

interface NotificationsState {
  toasts: ToastItem[];
  recent: ToastItem[];
  unread: number;
  push: (toast: { kind: ToastKind; title: string; desc: string }) => void;
  dismissToast: (id: string) => void;
  markAllRead: () => void;
}

export const useNotifications = create<NotificationsState>((set) => ({
  toasts: [],
  recent: [],
  unread: 0,
  push: ({ kind, title, desc }) =>
    set((s) => {
      const item: ToastItem = { id: crypto.randomUUID(), kind, title, desc, at: Date.now() };
      return {
        toasts: [...s.toasts.slice(-4), item],
        recent: [item, ...s.recent].slice(0, 20),
        unread: s.unread + 1,
      };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markAllRead: () => set({ unread: 0 }),
}));
